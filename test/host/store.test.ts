/**
 * The fact store, record ids, and the two name rules the backend enforces.
 *
 * The name tests are the ones that matter most here: `UNIT_NAME_RE` is
 * `/^[a-z][a-z0-9_]*$/`, so a camelCase table name throws **at module load**. The
 * earlier version of the adapter used `prSnapshots` and `reviewRuns` and was
 * green, because the fake implemented an interface its author invented rather than
 * the one the host has.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FACT_DOMAIN_NAME,
  FACT_DOMAIN_VERSION,
  FACT_TABLE_NAMES,
  FACT_TABLES,
  InvalidUnitNameError,
  UnsafeRecordKeyError,
  UNIT_NAME_PATTERN,
  assertRecordKey,
  assertUnitName,
  createMemoryFactStore,
  lazyFactStore,
  openFactStore,
} from '../../src/host/store.ts'
import type { DomainFacilityLike, KvTableLike } from '../../src/host/store.ts'
import { FACT_SCHEMAS, recordSchema } from '../../src/host/schemas.ts'
import { isRecordId, newId, timestampOf } from '../../src/domain/ids.ts'

// ---------------------------------------------------------------------------
// The name rules
// ---------------------------------------------------------------------------

test('every table storage name satisfies the backend rule', () => {
  // The rule is /^[a-z][a-z0-9_]*$/ -- lowercase, digits, underscores. This is the
  // assertion that would have caught `prSnapshots` before it reached a user.
  for (const name of FACT_TABLE_NAMES) {
    assert.match(name, UNIT_NAME_PATTERN, `${name} would be refused by the backend`)
  }
  assert.match(FACT_DOMAIN_NAME, UNIT_NAME_PATTERN)
})

test('callers get camelCase keys and the backend gets snake_case names', () => {
  assert.equal(FACT_TABLES.prSnapshots, 'pr_snapshots')
  assert.equal(FACT_TABLES.reviewRuns, 'review_runs')
  assert.equal(FACT_TABLES.repos, 'repos')
})

test('assertUnitName rejects what the backend rejects, naming the kind', () => {
  for (const bad of ['prSnapshots', 'Pr', '1leading', 'has-dash', 'has space', '', 'UPPER']) {
    assert.throws(() => assertUnitName('table', bad), InvalidUnitNameError, bad)
  }
  for (const good of ['a', 'a1', 'a_b', 'pr_snapshots']) {
    assert.equal(assertUnitName('table', good), good)
  }
})

test('the schemas cover exactly the declared tables', () => {
  assert.deepEqual(Object.keys(FACT_SCHEMAS).sort(), [...FACT_TABLE_NAMES].sort())
})

test('the record schema accepts objects and rejects scalars, arrays and null', () => {
  // A corrupted document is far more often a scalar or array than a plausible
  // object, so this is the check that earns its keep.
  for (const good of [{}, { a: 1 }, { nested: { b: 2 } }]) {
    assert.equal(recordSchema.safeParse(good).success, true)
  }
  for (const bad of [null, 5, 'text', [1, 2], true]) {
    assert.equal(recordSchema.safeParse(bad).success, false, JSON.stringify(bad))
  }
})

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

test('an id is a prefix and a 26-character Crockford body', () => {
  const id = newId('iss')
  assert.match(id, /^iss-[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.ok(isRecordId(id))
})

test('the Crockford alphabet excludes the confusable letters', () => {
  for (const id of Array.from({ length: 200 }, () => newId('wrk'))) {
    assert.ok(!/[ILOU]/.test(id.slice(4)), `${id} contains a confusable character`)
  }
})

test('ids are unique and increase with time', () => {
  const early = newId('iss', 1_000)
  const late = newId('iss', 2_000)
  assert.ok(early < late, 'lexicographic order is creation order')
  assert.equal(new Set(Array.from({ length: 500 }, () => newId('iss'))).size, 500)
})

test('ids created in the same millisecond stay ordered, so oldest-first is real', () => {
  // The random half is otherwise random, which made two records created in the
  // same millisecond order arbitrarily -- and `byQueueOrder` tie-breaks on id to
  // express "oldest first". A flaky queue test is what surfaced it.
  const ids = Array.from({ length: 200 }, () => newId('iss', 1_700_000_000_000))
  assert.deepEqual(ids, [...ids].sort(), 'same-millisecond ids increase')
  assert.equal(new Set(ids).size, ids.length, 'and are still unique')
})

test('a clock that steps backwards does not produce a smaller id', () => {
  // A backwards clock step would otherwise break monotonicity for everything after.
  const later = newId('iss', 2_000_000)
  const earlier = newId('iss', 1_000_000)
  assert.ok(earlier > later, 'the id never goes backwards')
})

test('an id round-trips its timestamp when the clock moves forwards', () => {
  // Deliberately far ahead of anything the suite has issued: monotonicity clamps a
  // timestamp *up* to the last one issued, so a small literal here would be
  // clamped by an earlier test rather than round-tripping.
  const now = 4_102_444_800_000
  assert.equal(timestampOf(newId('repo', now)), now)
  assert.equal(timestampOf('not-an-id'), undefined)
  assert.throws(() => newId('Iss'), /lowercase/)
})

test('a backwards timestamp is clamped forwards, which is what monotonicity means', () => {
  const forward = newId('iss', 4_102_444_900_000)
  const backwards = newId('iss', 1_000)
  assert.ok(backwards > forward, 'the id still goes forwards')
  assert.equal(timestampOf(backwards), 4_102_444_900_000, 'reporting the time actually issued')
})

test('generated ids are safe storage keys by construction', () => {
  for (const prefix of ['repo', 'iss', 'wrk']) {
    assert.doesNotThrow(() => assertRecordKey(newId(prefix)))
  }
})

test('an unsafe key is refused before the table is touched', () => {
  for (const key of ['', 'a b', 'a/b', '../etc/passwd', 'a.b', 'a:b']) {
    assert.throws(() => assertRecordKey(key), UnsafeRecordKeyError, JSON.stringify(key))
  }
  for (const key of ['a', 'A', '0', 'a-b', 'a_b']) assert.equal(assertRecordKey(key), key)
})

// ---------------------------------------------------------------------------
// The store, over a fake domain facility
// ---------------------------------------------------------------------------

interface FakeDomain {
  facility: DomainFacilityLike
  readonly calls: string[]
  readonly spec: { name: string; version: number; tables: Record<string, unknown> } | undefined
  readonly closed: number
}

function fakeDomain(initial: Record<string, Record<string, unknown>> = {}): FakeDomain {
  const calls: string[] = []
  const recordsByTable: Record<string, Record<string, unknown>> = { ...initial }
  let spec: FakeDomain['spec']
  let closed = 0

  const facility: DomainFacilityLike = {
    async open(opened) {
      spec = opened
      calls.push('open')
      return {
        table(name: string): KvTableLike {
          const records = (recordsByTable[name] ??= {})
          return {
            get: (key) => records[key],
            entries: () => Object.entries(records)[Symbol.iterator](),
            keys: () => Object.keys(records)[Symbol.iterator](),
            async put(key, value) {
              calls.push(`put:${name}:${key}`)
              records[key] = value
            },
            async delete(key) {
              calls.push(`delete:${name}:${key}`)
              const had = key in records
              delete records[key]
              return had
            },
            async update(key, fn) {
              records[key] = fn(records[key])
              return records[key]
            },
          }
        },
        async close() {
          closed += 1
        },
      }
    },
  }

  return {
    facility,
    get calls() {
      return calls
    },
    get spec() {
      return spec
    },
    get closed() {
      return closed
    },
  }
}

function open(initial?: Record<string, Record<string, unknown>>) {
  const fake = fakeDomain(initial)
  return { fake, store: openFactStore({ facility: fake.facility, schemas: FACT_SCHEMAS }) }
}

test('opening declares every table with a schema, under the right domain name', async () => {
  const { fake, store } = open()
  await store
  assert.equal(fake.spec?.name, FACT_DOMAIN_NAME)
  assert.equal(fake.spec?.version, FACT_DOMAIN_VERSION)
  assert.deepEqual(Object.keys(fake.spec?.tables ?? {}).sort(), [...FACT_TABLE_NAMES].sort())
  for (const declaration of Object.values(fake.spec?.tables ?? {})) {
    assert.ok(declaration, 'each table carries a declaration')
  }
})

test('a table without a schema is refused rather than opened unvalidated', async () => {
  const fake = fakeDomain()
  await assert.rejects(
    () => openFactStore({ facility: fake.facility, schemas: {} }),
    /no schema supplied for table/,
  )
  assert.equal(fake.spec, undefined, 'the domain was never opened')
})

test('records already in the domain are readable without any extra call', async () => {
  // The domain is itself the cache, so there is nothing to load and nothing to
  // invalidate -- which is why this module has no cache of its own.
  const { store } = open({ [FACT_TABLES.repos]: { 'repo-1': { owner: 'o', name: 'r' } } })
  const facts = await store
  assert.deepEqual(await facts.repos.get('repo-1'), { owner: 'o', name: 'r' })
  assert.deepEqual(await facts.repos.list(), [{ owner: 'o', name: 'r' }])
  assert.equal(facts.repos.size(), 1)
})

test('put and delete delegate to the table and are visible immediately', async () => {
  const { fake, store } = open()
  const facts = await store
  await facts.workers.put('wrk-1', { phase: 'planning' })
  assert.deepEqual(await facts.workers.get('wrk-1'), { phase: 'planning' })
  assert.ok(fake.calls.includes(`put:${FACT_TABLES.workers}:wrk-1`))
  await facts.workers.delete('wrk-1')
  assert.equal(await facts.workers.get('wrk-1'), undefined)
  assert.equal(facts.workers.size(), 0)
})

test('an unsafe key is refused before the table is written', async () => {
  const { fake, store } = open()
  const facts = await store
  await assert.rejects(() => facts.issues.put('../escape', {}), UnsafeRecordKeyError)
  assert.ok(!fake.calls.some((call) => call.startsWith('put:')), 'nothing reached the table')
})

test('an undeclared table is refused here, not handed to the host', async () => {
  // `nope` is a valid unit NAME, so the shape check passes -- the declared-set
  // check is the one that helps, because otherwise the failure would come back as
  // whatever the host does with an undeclared table and say nothing about the
  // caller's mistake.
  const facts = await open().store
  assert.throws(() => facts.table('nope'), /unknown fact table/)
})

test('a caller name is not a storage name', async () => {
  // `prSnapshots` is a key in FACT_TABLES; the storage name is `pr_snapshots`.
  // Whichever check fires first, the message must name the declared tables, so the
  // caller can see the difference.
  const facts = await open().store
  assert.throws(() => facts.table('prSnapshots'), /pr_snapshots/)
  assert.doesNotThrow(() => facts.table(FACT_TABLES.prSnapshots))
  assert.equal(facts.table(FACT_TABLES.prSnapshots), facts.prSnapshots, 'the accessor is the same store')
})

test('close releases the domain', async () => {
  const { fake, store } = open()
  const facts = await store
  await facts.close()
  assert.equal(fake.closed, 1)
})

test('the five tables are declared, one per record kind', () => {
  assert.deepEqual(Object.keys(FACT_TABLES).sort(), [
    'issues',
    'prSnapshots',
    'repos',
    'reviewRuns',
    'workers',
  ])
  assert.equal(FACT_DOMAIN_VERSION, 1)
})

test('the in-memory store implements the same contract', async () => {
  const store = createMemoryFactStore()
  await store.repos.put('repo-1', { owner: 'o' })
  assert.deepEqual(await store.repos.get('repo-1'), { owner: 'o' })
  assert.equal(store.writes, 1)
  await store.repos.delete('repo-1')
  assert.equal(store.repos.size(), 0)
  await store.close()
})

// ---------------------------------------------------------------------------
// The lazy store
// ---------------------------------------------------------------------------

test('the lazy store opens once', async () => {
  let opens = 0
  const store = lazyFactStore(async () => {
    opens += 1
    return createMemoryFactStore()
  })
  await store.get()
  await store.get()
  assert.equal(opens, 1)
  assert.equal(store.opened, true)
})

test('the lazy store retries after a failed open rather than poisoning the plugin', async () => {
  let attempts = 0
  const store = lazyFactStore(async () => {
    attempts += 1
    if (attempts === 1) throw new Error('transient')
    return createMemoryFactStore()
  })
  await assert.rejects(() => store.get(), /transient/)
  await store.get()
  assert.equal(attempts, 2)
  assert.equal(store.opened, true)
})

test('the lazy store does not open on close if it was never used', async () => {
  let opens = 0
  const store = lazyFactStore(async () => {
    opens += 1
    return createMemoryFactStore()
  })
  await store.close()
  assert.equal(opens, 0, 'unload must not cause an open')
  assert.equal(store.opened, false)
})
