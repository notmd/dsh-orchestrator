/**
 * The fact store and record ids.
 *
 * Grouped because they are one concern: an id **is** a storage key, and the
 * store's only validation is that the key is safe to store. A test for one that
 * ignored the other would miss the join.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FACT_DOMAIN_VERSION,
  FACT_TABLE_NAMES,
  FACT_TABLES,
  UnsafeRecordKeyError,
  assertRecordKey,
  createMemoryFactStore,
  openFactStore,
} from '../../src/host/store.ts'
import type { KvSnapshot, KvUnitDescriptorLike, KvUnitLike, StorageLike } from '../../src/host/store.ts'
import { isRecordId, newId, timestampOf } from '../../src/domain/ids.ts'

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

test('an id is a prefix and a 26-character Crockford body', () => {
  const id = newId('iss')
  assert.match(id, /^iss-[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.ok(isRecordId(id))
})

test('the Crockford alphabet excludes the confusable letters', () => {
  // I, L, O and U are left out because they are mistaken for 1, 1, 0 and V —
  // which is what makes an id safe to read out loud.
  const ids = Array.from({ length: 200 }, () => newId('wrk'))
  for (const id of ids) {
    assert.ok(!/[ILOU]/.test(id.slice(4)), `${id} contains a confusable character`)
  }
})

test('ids are unique and increase with time', () => {
  const early = newId('iss', 1_000)
  const late = newId('iss', 2_000)
  assert.notEqual(early, late)
  assert.ok(early < late, 'lexicographic order is creation order')

  const many = new Set(Array.from({ length: 500 }, () => newId('iss')))
  assert.equal(many.size, 500, 'the random half does not collide')
})

test('an id round-trips its timestamp', () => {
  const now = 1_700_000_000_000
  assert.equal(timestampOf(newId('repo', now)), now)
  assert.equal(timestampOf('not-an-id'), undefined)
  assert.equal(timestampOf('iss-'), undefined)
})

test('a bad prefix is refused rather than producing an unusable key', () => {
  assert.throws(() => newId('Iss'), /lowercase/)
  assert.throws(() => newId('is-s'), /lowercase/)
  assert.throws(() => newId(''), /lowercase/)
})

test('generated ids are safe storage keys by construction', () => {
  for (const prefix of ['repo', 'iss', 'wrk']) {
    assert.doesNotThrow(() => assertRecordKey(newId(prefix)))
  }
})

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

test('an unsafe key is refused, because the backend would refuse it later', () => {
  // Checked here rather than at write time: the backend's rejection would surface
  // mid-write, after the caller has already done the work.
  for (const key of ['', 'a b', 'a/b', '../etc/passwd', 'a.b', 'a:b', 'a$b']) {
    assert.throws(() => assertRecordKey(key), UnsafeRecordKeyError, JSON.stringify(key))
  }
  for (const key of ['a', 'A', '0', 'a-b', 'a_b', 'AB-cd_12']) {
    assert.equal(assertRecordKey(key), key)
  }
})

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** A fake KV facet that records calls and starts from a given snapshot. */
function fakeStorage(initial: Partial<KvSnapshot> = {}): StorageLike & {
  readonly calls: string[]
  readonly descriptor: KvUnitDescriptorLike | undefined
  readonly written: Array<{ table: string; key: string; value: unknown }>
  readonly closed: number
} {
  const calls: string[] = []
  const written: Array<{ table: string; key: string; value: unknown }> = []
  let closed = 0
  let descriptor: KvUnitDescriptorLike | undefined
  const tables: Record<string, Record<string, unknown>> = { ...(initial.tables ?? {}) }
  return {
    form(form) {
      calls.push(`form:${form}`)
      return {
        async open(spec) {
          descriptor = spec
          calls.push('open')
          return {
            async loadAll(): Promise<KvSnapshot> {
              calls.push('loadAll')
              return { tables, global: initial.global ?? null }
            },
            async putRecord(table, key, value) {
              calls.push(`put:${table}:${key}`)
              written.push({ table, key, value })
              tables[table] = { ...(tables[table] ?? {}), [key]: value }
            },
            async deleteRecord(table, key) {
              calls.push(`delete:${table}:${key}`)
              delete tables[table]?.[key]
            },
            async close() {
              closed += 1
            },
          } satisfies KvUnitLike
        },
      }
    },
    get calls() {
      return calls
    },
    get descriptor() {
      return descriptor
    },
    get written() {
      return written
    },
    get closed() {
      return closed
    },
  }
}

test('opening declares every table and reads the unit exactly once', async () => {
  const storage = fakeStorage()
  const store = await openFactStore({ storage })
  assert.deepEqual(storage.descriptor?.tables, FACT_TABLE_NAMES)
  assert.equal(storage.descriptor?.hasGlobal, false, 'no global singleton is used')
  assert.equal(storage.calls.filter((call) => call === 'loadAll').length, 1)
  await store.close()
})

test('records loaded at open are visible without another read', async () => {
  const storage = fakeStorage({
    tables: { [FACT_TABLES.repos]: { 'repo-1': { owner: 'o', name: 'r' } } },
  })
  const store = await openFactStore({ storage })
  assert.deepEqual(await store.repos.get('repo-1'), { owner: 'o', name: 'r' })
  assert.deepEqual(await store.repos.list(), [{ owner: 'o', name: 'r' }])
  assert.equal(storage.calls.filter((call) => call === 'loadAll').length, 1)
})

test('a read after a write sees it, without a reload', async () => {
  // The observer writes on every poll; a full reload per read would make the board
  // quadratic in the number of workers.
  const storage = fakeStorage()
  const store = await openFactStore({ storage })
  await store.workers.put('wrk-1', { phase: 'planning' })
  assert.deepEqual(await store.workers.get('wrk-1'), { phase: 'planning' })
  assert.equal(store.workers.size(), 1)
  assert.equal(storage.calls.filter((call) => call === 'loadAll').length, 1, 'no hidden reload')
})

test('a write goes through to the backend before it resolves', async () => {
  // Durability is the contract: resolving first would let a crash lose a fact the
  // caller was told was stored.
  const storage = fakeStorage()
  const store = await openFactStore({ storage })
  await store.issues.put('iss-1', { title: 'x' })
  assert.deepEqual(storage.written, [{ table: FACT_TABLES.issues, key: 'iss-1', value: { title: 'x' } }])
})

test('delete is idempotent and visible immediately', async () => {
  const storage = fakeStorage({ tables: { [FACT_TABLES.issues]: { 'iss-1': { title: 'x' } } } })
  const store = await openFactStore({ storage })
  await store.issues.delete('iss-1')
  assert.equal(await store.issues.get('iss-1'), undefined)
  await store.issues.delete('iss-1')
})

test('an unsafe key is refused before anything is written', async () => {
  const storage = fakeStorage()
  const store = await openFactStore({ storage })
  await assert.rejects(() => store.issues.put('../escape', { a: 1 }), UnsafeRecordKeyError)
  assert.deepEqual(storage.written, [])
})

test('an unknown table is refused', () => {
  const store = createMemoryFactStore()
  assert.throws(() => store.table('nope'), /unknown fact table/)
})

test('the five tables are declared, one per record kind', () => {
  assert.deepEqual(Object.values(FACT_TABLES).sort(), [
    'issues',
    'prSnapshots',
    'repos',
    'reviewRuns',
    'workers',
  ])
  assert.equal(FACT_DOMAIN_VERSION, 1)
})

test('the in-memory store implements the same contract, so tests exercise real paths', async () => {
  const store = createMemoryFactStore()
  await store.repos.put('repo-1', { owner: 'o' })
  assert.deepEqual(await store.repos.get('repo-1'), { owner: 'o' })
  assert.equal(store.writes, 1)
  assert.equal(store.repos.size(), 1)
  await store.repos.delete('repo-1')
  assert.equal(store.repos.size(), 0)
  await store.close()
})
