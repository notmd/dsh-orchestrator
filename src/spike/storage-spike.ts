/**
 * M0 storage spike — does the fact store work against the **real** backend?
 *
 * This exists because the previous storage adapter was wrong in a way its tests
 * could not see: they exercised an interface its author invented. Only a real
 * `ctx.storageDomain` can answer whether the domain opens, whether the table names
 * satisfy the backend rule, and whether a record survives a write/read round trip.
 *
 * A spike, not product code. Installed by a `--patch` overlay and kept out of the
 * shipped bundle (`tsconfig.build.json` excludes `src/spike`).
 *
 * @module dsho/spike/storage-spike
 */

import { writeFileSync } from 'node:fs'

import { FACT_SCHEMAS } from '../host/schemas.ts'
import { openFactStore } from '../host/store.ts'
import type { DomainFacilityLike } from '../host/store.ts'

export const name = 'storage-spike'

/** Only storage: the spike must not fail for an unrelated missing service. */
export const inject = ['storageDomain']

const RESULT = '/tmp/dsho-storage-spike.json'
const steps: Array<{ step: string; detail?: unknown }> = []

function record(step: string, detail?: unknown): void {
  steps.push({ step, ...(detail === undefined ? {} : { detail }) })
  try {
    writeFileSync(RESULT, JSON.stringify({ steps }, null, 2))
  } catch {
    // The spike must never take the host down over its own bookkeeping.
  }
}

interface SpikeContext {
  storageDomain: DomainFacilityLike
}

export function apply(ctx: SpikeContext): void {
  void run(ctx)
}

async function run(ctx: SpikeContext): Promise<void> {
  record('begin')
  let store: Awaited<ReturnType<typeof openFactStore>> | undefined
  try {
    store = await openFactStore({ facility: ctx.storageDomain, schemas: FACT_SCHEMAS })
    record('open:ok')

    const repo = { id: 'repo-spike', rootPath: '/tmp/spike', owner: 'acme', name: 'widgets' }
    await store.repos.put('repo-spike', repo)
    record('repos.put:ok')

    const readBack = await store.repos.get('repo-spike')
    record('repos.get', { readBack })

    await store.issues.put('iss-spike', { title: 'hello' })
    await store.workers.put('wrk-spike', { phase: 'planning' })
    await store.prSnapshots.put('pr-spike', { state: 'OPEN' })
    await store.reviewRuns.put('run-spike', { status: 'approved' })
    record('all-five-tables:ok', { repos: (await store.repos.list()).length })

    // Overwrite semantics: a snapshot is replaced, not appended.
    await store.repos.put('repo-spike', { ...repo, owner: 'changed' })
    const overwritten = await store.repos.get('repo-spike')
    record('overwrite', { overwritten })

    const deleted = await store.repos.delete('repo-spike')
    record('repos.delete', { deleted, remaining: (await store.repos.list()).length })
  } catch (error) {
    record('failed', { message: error instanceof Error ? error.message : String(error) })
    finish(false, { message: error instanceof Error ? error.message : String(error) })
    return
  }

  try {
    await store?.close()
    record('close:ok')
  } catch (error) {
    record('close:failed', { message: error instanceof Error ? error.message : String(error) })
  }
  finish(true, {})
}

function finish(ok: boolean, detail: Record<string, unknown>): void {
  try {
    writeFileSync(RESULT, JSON.stringify({ ok, detail, steps }, null, 2))
  } catch {
    // As above.
  }
}
