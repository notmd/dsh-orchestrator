/**
 * Durable board state, on DSH's host-side structured storage.
 *
 * ## Why the KV layer and not `ctx.storageDomain`
 *
 * The PRD allows either (`ctx.storage` / `ctx.storageDomain`, PRD §7.1), and
 * `storageDomain` is the higher-level option — but its `DomainSpec` validates
 * records with **zod schemas**, which would mean importing zod from a package the
 * plugin cannot resolve (it installs as a symlink; see `../host/tool.ts`) and
 * pinning a schema library the host may version differently.
 *
 * `ctx.storage`'s KV layer (`KvFacet.open()` → `KvUnit`) takes `unknown` records
 * and needs no schema library at all. That is a better fit here for a second
 * reason: **the ported normalizers are already the validators.** `prFacts()`,
 * `sessionFacts()` and `reviewRunFacts()` fill Go's zero values on every read, so
 * a record that predates a field is handled the same way a record that omits it
 * is — which is the behaviour AO's own tests pin.
 *
 * Everything is behind {@link FactStore}, so moving to `storageDomain` later is a
 * change to this file and nothing else.
 *
 * ## The log-as-truth rule still holds
 *
 * These are **application records, not session history** (Appendix A3.6): the
 * session log is the only source of truth for what the model saw, and a plugin
 * must not append events with a new `type`. Board placement in particular is
 * derived and **never stored** — only the facts it is derived from live here.
 *
 * @module dsho/host/store
 */

/** The tables the board owns. Declared once, because a name is a schema. */
export const FACT_TABLES = Object.freeze({
  repos: 'repos',
  issues: 'issues',
  workers: 'workers',
  prSnapshots: 'prSnapshots',
  reviewRuns: 'reviewRuns',
})

/** The domain format version. Bump when a stored shape changes incompatibly. */
export const FACT_DOMAIN_VERSION = 1

/** The table declarations, in the order the KV descriptor wants them. */
export const FACT_TABLE_NAMES: readonly string[] = Object.values(FACT_TABLES)

/** A record key must survive being a path segment in the `per-record` layout. */
const SAFE_KEY = /^[a-zA-Z0-9_-]+$/

/** A key that cannot be a storage path segment. */
export class UnsafeRecordKeyError extends Error {
  constructor(key: string) {
    super(`record key ${JSON.stringify(key)} must match ${SAFE_KEY} to be stored`)
    this.name = 'UnsafeRecordKeyError'
  }
}

/**
 * Rejects a key the backend would reject.
 *
 * Checked here rather than left to the backend because the failure would
 * otherwise surface as a storage error mid-write, after the caller has already
 * done work. The generated ids (`repo-<ulid>`, `iss-<ulid>`, `wrk-<ulid>`) are
 * Crockford base32 and dashes, so they pass by construction — this is a guard
 * against a future id scheme, not against today's.
 */
export function assertRecordKey(key: string): string {
  if (typeof key !== 'string' || !SAFE_KEY.test(key)) throw new UnsafeRecordKeyError(key)
  return key
}

/** One loaded unit: every table's records, and the global singleton. */
export interface KvSnapshot {
  tables: Record<string, Record<string, unknown>>
  global: unknown
}

/** The slice of `KvUnit` this module uses. */
export interface KvUnitLike {
  loadAll(): Promise<KvSnapshot>
  putRecord(table: string, key: string, value: unknown): Promise<void>
  deleteRecord(table: string, key: string): Promise<void>
  close(): Promise<void>
}

/** The slice of `ctx.storage` this module uses. */
export interface StorageLike {
  form(form: 'kv'): { open(descriptor: KvUnitDescriptorLike): Promise<KvUnitLike> }
}

/** The unit descriptor the KV facet wants. */
export interface KvUnitDescriptorLike {
  name: string
  version: number
  tables: readonly string[]
  hasGlobal: boolean
  layout?: 'single' | 'per-record'
}

/** One table of JSON records, keyed by record id. */
export interface RecordStore<T> {
  /** Every record, newest-key order unspecified. */
  list(): Promise<T[]>
  get(key: string): Promise<T | undefined>
  /** Upserts, resolving after durability. */
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  /** How many records the cache holds; useful in tests and diagnostics. */
  size(): number
}

/** The board's tables. */
export interface FactStore {
  readonly repos: RecordStore<unknown>
  readonly issues: RecordStore<unknown>
  readonly workers: RecordStore<unknown>
  readonly prSnapshots: RecordStore<unknown>
  readonly reviewRuns: RecordStore<unknown>
  /** Every record in one table, for a reducer pass. */
  table(name: string): RecordStore<unknown>
  /** Releases the unit. */
  close(): Promise<void>
}

/**
 * Opens the board's tables and returns typed accessors.
 *
 * The unit is read **once** at open and cached; writes go through to the backend
 * and update the cache in the same step, so a read after a write sees it without
 * another `loadAll`. That matters because the observer writes on every poll and a
 * full reload per read would make the board quadratic in the number of workers.
 *
 * Note the deliberate absence of a `refresh()`: a cache invalidated behind the
 * caller's back would make "read the facts, decide, write" racy for no benefit,
 * since this plugin is the only writer.
 */
export async function openFactStore(options: {
  storage: StorageLike
  /** Domain name; must match the backend's unit-name rule. */
  name?: string
  version?: number
  layout?: 'single' | 'per-record'
}): Promise<FactStore> {
  const name = options.name ?? 'dsho'
  const unit = await options.storage.form('kv').open({
    name,
    version: options.version ?? FACT_DOMAIN_VERSION,
    tables: FACT_TABLE_NAMES,
    hasGlobal: false,
    layout: options.layout ?? 'single',
  })

  const snapshot = await unit.loadAll()
  /** table -> key -> record */
  const cache = new Map<string, Map<string, unknown>>()
  for (const table of FACT_TABLE_NAMES) {
    const records = new Map<string, unknown>()
    for (const [key, value] of Object.entries(snapshot.tables[table] ?? {})) {
      records.set(key, value)
    }
    cache.set(table, records)
  }

  const storeFor = (table: string): RecordStore<unknown> => {
    const records = cache.get(table)
    if (!records) throw new Error(`unknown fact table ${JSON.stringify(table)}`)
    return {
      async list() {
        return [...records.values()]
      },
      async get(key) {
        return records.get(key)
      },
      async put(key, value) {
        assertRecordKey(key)
        await unit.putRecord(table, key, value)
        records.set(key, value)
      },
      async delete(key) {
        assertRecordKey(key)
        await unit.deleteRecord(table, key)
        records.delete(key)
      },
      size() {
        return records.size
      },
    }
  }

  const stores = new Map<string, RecordStore<unknown>>()
  const table = (tableName: string): RecordStore<unknown> => {
    let store = stores.get(tableName)
    if (!store) {
      store = storeFor(tableName)
      stores.set(tableName, store)
    }
    return store
  }

  return {
    repos: table(FACT_TABLES.repos),
    issues: table(FACT_TABLES.issues),
    workers: table(FACT_TABLES.workers),
    prSnapshots: table(FACT_TABLES.prSnapshots),
    reviewRuns: table(FACT_TABLES.reviewRuns),
    table,
    close: () => unit.close(),
  }
}

/**
 * An in-memory {@link FactStore}, for tests and for a host whose storage is
 * unavailable.
 *
 * Deliberately a real implementation of the same interface rather than a mock:
 * it exercises the same code paths, so a test that passes here is testing the
 * caller's logic rather than its idea of storage. It is **not** durable, which is
 * exactly what makes it unsuitable outside tests.
 */
export function createMemoryFactStore(): FactStore & { readonly writes: number } {
  const tables = new Map<string, Map<string, unknown>>()
  let writes = 0
  for (const table of FACT_TABLE_NAMES) tables.set(table, new Map())

  const storeFor = (tableName: string): RecordStore<unknown> => {
    const records = tables.get(tableName)
    if (!records) throw new Error(`unknown fact table ${JSON.stringify(tableName)}`)
    return {
      async list() {
        return [...records.values()]
      },
      async get(key) {
        return records.get(key)
      },
      async put(key, value) {
        assertRecordKey(key)
        writes += 1
        records.set(key, value)
      },
      async delete(key) {
        assertRecordKey(key)
        records.delete(key)
      },
      size() {
        return records.size
      },
    }
  }

  const stores = new Map<string, RecordStore<unknown>>()
  const table = (tableName: string): RecordStore<unknown> => {
    let store = stores.get(tableName)
    if (!store) {
      store = storeFor(tableName)
      stores.set(tableName, store)
    }
    return store
  }

  return {
    repos: table(FACT_TABLES.repos),
    issues: table(FACT_TABLES.issues),
    workers: table(FACT_TABLES.workers),
    prSnapshots: table(FACT_TABLES.prSnapshots),
    reviewRuns: table(FACT_TABLES.reviewRuns),
    table,
    async close() {},
    get writes() {
      return writes
    },
  }
}
