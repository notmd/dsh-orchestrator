/**
 * Durable board state, on DSH's host-side structured storage.
 *
 * ## The real API, after getting it wrong once
 *
 * An earlier version of this file called `ctx.storage.form('kv')`. **Neither half
 * existed.** `ctx.storage` is a *form hub* reached as `ctx.storage.<form>`, the
 * only form is `domain`, and `KvFacet`/`KvUnit` are *backend* interfaces a plugin
 * does not call. The tests were green throughout, because a fake implements
 * whatever interface its author imagined. See STATUS.md §3.
 *
 * What is actually true, read from the installed types:
 *
 *   - `ctx.storageDomain` **is** the facility (`StorageForms.domain` is the same
 *     object reached through the hub), and `DomainFacility.open(spec)` returns a
 *     `Domain`.
 *   - `Domain.table(name)` returns a `KvTable` whose `get`/`entries`/`keys` are
 *     **synchronous** — the domain holds the data in memory and is itself the
 *     cache. A hand-rolled cache here would duplicate it and could diverge.
 *   - `DomainTableSpec.valueSchema` is a **`ZodType`**, so zod is required. It is a
 *     normal public package, so the symlink-resolution problem that rules out
 *     other DSH imports does not apply to it; it is pinned to the profile's
 *     version in `package.json` so the schemas are the same `ZodType` the host
 *     validates with.
 *   - Domain and table names must match `/^[a-z][a-z0-9_]*$/`. That is why the
 *     table values below are snake_case while the keys stay camelCase for callers.
 *
 * ## Persistence is host-provided; this module is a thin typed facade
 *
 * {@link FactStore} exists so the rest of the plugin never sees a `KvTable`, and so
 * a test can supply {@link createMemoryFactStore}. It deliberately adds **no**
 * caching, validation, or retry of its own: the domain already caches, and the
 * ported normalizers (`prFacts`, `sessionFacts`, `reviewRunFacts`) already fill
 * Go's zero values on every read, which is exactly how a record predating a field
 * is supposed to behave.
 *
 * @module dsho/host/store
 */

/** A domain or table name must satisfy the backend's `UNIT_NAME_RE`. */
export const UNIT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/

/** A name the backend would refuse. */
export class InvalidUnitNameError extends Error {
  constructor(kind: string, name: string) {
    super(`${kind} name ${JSON.stringify(name)} must match ${UNIT_NAME_PATTERN}`)
    this.name = 'InvalidUnitNameError'
  }
}

/** Rejects a name the backend would reject, at module load rather than at open. */
export function assertUnitName(kind: string, name: string): string {
  if (!UNIT_NAME_PATTERN.test(name)) throw new InvalidUnitNameError(kind, name)
  return name
}

/**
 * The tables the board owns.
 *
 * Keys are for callers; **values are the storage names** and must satisfy
 * `UNIT_NAME_RE` — lowercase, digits and underscores only. `prSnapshots` would
 * have thrown at load, which is why there is a test asserting every value.
 */
export const FACT_TABLES = Object.freeze({
  repos: 'repos',
  issues: 'issues',
  workers: 'workers',
  prSnapshots: 'pr_snapshots',
  reviewRuns: 'review_runs',
  reports: 'reports',
})

/** The domain name. Also the backend unit name. */
export const FACT_DOMAIN_NAME = 'dsho'

/** The domain format version. Bump when a stored shape changes incompatibly. */
export const FACT_DOMAIN_VERSION = 1

/** The table storage names, in declaration order. */
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

/** Rejects a key the backend would reject, before the caller has done the work. */
export function assertRecordKey(key: string): string {
  if (typeof key !== 'string' || !SAFE_KEY.test(key)) throw new UnsafeRecordKeyError(key)
  return key
}

/** One table of records, as the domain exposes it. Reads are synchronous. */
export interface KvTableLike<K extends string = string, V = unknown> {
  get(key: K): V | undefined
  entries(): IterableIterator<[K, V]>
  keys(): IterableIterator<K>
  put(key: K, value: V): Promise<void>
  /** Resolves `false` when the key was already absent. */
  delete(key: K): Promise<boolean>
  update(key: K, fn: (current: V) => V): Promise<V>
}

/** The slice of `Domain` this module uses. */
export interface DomainLike {
  table(name: string): KvTableLike
  close(): Promise<void>
}

/**
 * The slice of `ctx.storageDomain` this module uses.
 *
 * `open` takes a real `DomainSpec`, but the schemas are the caller's — this module
 * never imports zod, so its own tests need no schema library.
 */
export interface DomainFacilityLike {
  open<S>(spec: {
    name: string
    version: number
    tables: Record<string, { valueSchema: unknown }>
    layout?: 'single' | 'per-record'
  }): Promise<DomainLike & { readonly __spec?: S }>
}

/** One table of JSON records, keyed by record id. */
export interface RecordStore<T> {
  /** Every record. */
  list(): Promise<T[]>
  get(key: string): Promise<T | undefined>
  /** Upserts, resolving after durability. */
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  /** How many records the table holds. */
  size(): number
}

/** The board's tables. */
export interface FactStore {
  readonly repos: RecordStore<unknown>
  readonly issues: RecordStore<unknown>
  readonly workers: RecordStore<unknown>
  readonly prSnapshots: RecordStore<unknown>
  readonly reviewRuns: RecordStore<unknown>
  readonly reports: RecordStore<unknown>
  /** Every record in one table, by storage name. */
  table(name: string): RecordStore<unknown>
  close(): Promise<void>
}

/**
 * Opens the board's domain.
 *
 * `schemas` maps each table's storage name to the `ZodType` that validates its
 * records at the durable boundary. It is a parameter rather than an import so this
 * module has no schema dependency; `./schemas.ts` supplies the real ones and a test
 * can supply plain objects.
 */
export async function openFactStore(options: {
  facility: DomainFacilityLike
  schemas: Readonly<Record<string, unknown>>
  name?: string
  version?: number
  layout?: 'single' | 'per-record'
}): Promise<FactStore> {
  const domainName = assertUnitName('domain', options.name ?? FACT_DOMAIN_NAME)

  const tables: Record<string, { valueSchema: unknown }> = {}
  for (const tableName of FACT_TABLE_NAMES) {
    assertUnitName('table', tableName)
    const valueSchema = options.schemas[tableName]
    if (valueSchema === undefined) {
      throw new Error(`openFactStore: no schema supplied for table ${JSON.stringify(tableName)}`)
    }
    tables[tableName] = { valueSchema }
  }

  const domain = await options.facility.open({
    name: domainName,
    version: options.version ?? FACT_DOMAIN_VERSION,
    tables,
    ...(options.layout ? { layout: options.layout } : {}),
  })

  const storeFor = (tableName: string): RecordStore<unknown> => {
    assertUnitName('table', tableName)
    assertDeclared(tableName)
    const table = domain.table(tableName)
    return {
      async list() {
        return [...table.entries()].map(([, value]) => value)
      },
      async get(key) {
        return table.get(key)
      },
      async put(key, value) {
        assertRecordKey(key)
        await table.put(key, value)
      },
      async delete(key) {
        assertRecordKey(key)
        await table.delete(key)
      },
      size() {
        return [...table.keys()].length
      },
    }
  }

  /**
   * Refuses an undeclared table **here** rather than passing it to the host.
   *
   * The name-shape check is not enough: `nope` is a perfectly valid unit name, so
   * it would reach `domain.table('nope')` and surface as whatever the host does
   * with an undeclared table — a failure that says nothing about the caller's
   * mistake. Declaring the set is the check that actually helps.
   */
  const assertDeclared = (tableName: string): string => {
    if (!FACT_TABLE_NAMES.includes(tableName)) {
      throw new Error(
        `unknown fact table ${JSON.stringify(tableName)}; declared tables are ${FACT_TABLE_NAMES.join(', ')}`,
      )
    }
    return tableName
  }

  const stores = new Map<string, RecordStore<unknown>>()
  const table = (tableName: string): RecordStore<unknown> => {
    assertDeclared(tableName)
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
    reports: table(FACT_TABLES.reports),
    table,
    close: () => domain.close(),
  }
}

/** A store that is opened on first use rather than at activation. */
export interface LazyFactStore {
  /** The open store, opening it once. A failure does not poison later calls. */
  get(): Promise<FactStore>
  /** True once the store has been opened successfully. */
  readonly opened: boolean
  /**
   * Releases the domain if it was opened, and does nothing if it was not.
   * Unload must not *cause* an open: an unused plugin should dispose without
   * touching storage.
   */
  close(): Promise<void>
}

/**
 * Defers opening the store until something needs it.
 *
 * **This is what keeps `apply()` synchronous.** Opening is `async`, and doing it
 * during activation would either force `apply` to return a promise — putting an
 * await between activation and registration, which the loader's expectations do
 * not obviously tolerate — or register the tools late. Neither is necessary, since
 * registering a tool and *using* storage are separable.
 *
 * A failed open is **not** memoised: the rejected promise is discarded so the next
 * call retries. A transient backend problem must not permanently disable the
 * plugin, which is what a cached rejection would do.
 */
export function lazyFactStore(open: () => Promise<FactStore>): LazyFactStore {
  let pending: Promise<FactStore> | undefined
  let opened = false
  return {
    get() {
      if (!pending) {
        pending = open().then(
          (store) => {
            opened = true
            return store
          },
          (error: unknown) => {
            pending = undefined
            throw error
          },
        )
      }
      return pending
    },
    get opened() {
      return opened
    },
    async close() {
      if (!pending) return
      const current = pending
      pending = undefined
      opened = false
      try {
        const store = await current
        await store.close()
      } catch {
        // A failed open has nothing to close, and a failed close must not mask an
        // unload. Either way there is nothing left to do.
      }
    },
  }
}

/**
 * An in-memory {@link FactStore}, for tests and for a host whose storage is
 * unavailable.
 *
 * A real implementation of the same interface rather than a mock, so a test that
 * passes here exercises the caller's logic. It is **not** durable, which is what
 * makes it unsuitable outside tests — and it is also the reason it cannot catch a
 * wrong host API, which is the lesson this module learned the hard way.
 */
export function createMemoryFactStore(): FactStore & { readonly writes: number } {
  const tables = new Map<string, Map<string, unknown>>()
  for (const table of FACT_TABLE_NAMES) tables.set(table, new Map())
  let writes = 0

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
    reports: table(FACT_TABLES.reports),
    table,
    async close() {},
    get writes() {
      return writes
    },
  }
}
