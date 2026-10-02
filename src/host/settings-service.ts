/**
 * Reading and writing one project's settings.
 *
 * This is the whole host half of the settings page: one read, one patch, both over
 * the store that already holds the `Repo` records. There is no cache and no second
 * copy, so a write is visible to the next spawn, the next review pass and the next
 * board build with nothing to invalidate — the same property `board-service` has for
 * derived placement.
 *
 * ## The route is a view model, not a raw record
 *
 * The payload the page receives is deliberately not the stored `Repo`. Two reasons,
 * both about what a client should be allowed to assume:
 *
 *   - **the record's identity fields are read-only on the page.** `owner`, `name` and
 *     `rootPath` are GitHub's facts and the filesystem's; a page that could write them
 *     would let a typo redirect every future worktree. They travel as
 *     {@link ProjectRef} and the write path never accepts them.
 *   - **`autoReview` is tri-state.** The wire carries `null` for "inherit", so a
 *     client round-tripping a payload it read cannot turn an inherit into a missing
 *     key that means something else.
 *
 * @module dsho/host/settings-service
 */

import { normalizeRepo } from './repo.ts'
import type { Repo } from './repo.ts'
import {
  applyProjectSettingsPatch,
  normalizeProjectSettings,
  serializeProjectSettings,
} from './repo-settings.ts'
import type { ProjectSettings } from './repo-settings.ts'
import type { LazyFactStore } from './store.ts'
import type { PluginConfig } from '../config/validate.ts'

/** A project's identity, as the page may read it and never write it. */
export interface ProjectRef {
  id: string
  /** `owner/name`. */
  repository: string
  /** The local checkout. */
  rootPath: string
  /** Whether `gh` reported the default branch when this project was connected. */
  defaultBranchDetected: boolean
}

/** The settings page's whole payload. */
export interface SettingsView {
  /** Every connected project, oldest first, so the picker has a stable order. */
  projects: ProjectRef[]
  /** The project the settings belong to, or `null` when nothing is connected. */
  project: ProjectRef | null
  /** The settings themselves, or `null` when nothing is connected. */
  settings: Record<string, unknown> | null
  /**
   * The plugin defaults an unset per-project override falls back to.
   *
   * Sent so the page can NAME what "inherit" means ("inheriting the plugin default (on)")
   * instead of leaving the user to guess, and so the client never has to know the config
   * layer. Two fields, not the whole config: what the page can display is what it needs.
   */
  defaults: {
    autoReview: boolean
    workerAgentPreset: string
    workerPermissionPreset: string
    reviewerAgentPreset: string
  }
}

/** A refusal the route answers with, rather than throwing. */
export interface SettingsRefusal {
  ok: false
  status: number
  code: string
  message: string
}

/** A successful write. */
export interface SettingsSaved {
  ok: true
  view: SettingsView
}

/** Everything the settings service needs. */
export interface SettingsDeps {
  store: LazyFactStore
  config: PluginConfig
}

/** Every connected project, normalized and ordered oldest first. */
export async function listProjects(deps: SettingsDeps): Promise<Repo[]> {
  const store = await deps.store.get()
  const repos = (await store.repos.list()).map(normalizeRepo)
  // Ordered by creation so the picker does not reshuffle between polls, and so the
  // fallback choice (the first project) is the one connected first rather than
  // whichever the store happens to yield.
  return repos.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
}

/**
 * Picks the project a request is about.
 *
 * The order is deliberate. An explicit id wins over everything, because the page
 * always knows which project it is showing. Without one, the configured
 * `defaultRepo` is preferred — that is the install's stated intent — and only then
 * does the first project serve as the fallback. A repo id that does not exist is a
 * **refusal**, never a silent fallback: answering with a different project's
 * settings than the one asked for is how a user edits the wrong repository.
 */
export function selectProject(
  projects: readonly Repo[],
  requested: string,
  config: PluginConfig,
): { repo: Repo } | { refusal: SettingsRefusal } {
  const wanted = requested.trim()
  if (wanted !== '') {
    const match = projects.find((project) => project.id === wanted || project.rootPath === wanted)
    if (!match) {
      return {
        refusal: {
          ok: false,
          status: 404,
          code: 'project-not-found',
          message: `No connected project matches ${JSON.stringify(wanted)}. Connect it with orchestrator_repo_connect first.`,
        },
      }
    }
    return { repo: match }
  }

  const configured = (config.defaultRepo ?? '').trim()
  if (configured !== '') {
    const match = projects.find((project) => project.rootPath === configured)
    if (match) return { repo: match }
  }
  const first = projects[0]
  if (!first) {
    return {
      refusal: {
        ok: false,
        status: 409,
        code: 'no-project',
        message: 'No repository is connected yet, so there are no project settings to show.',
      },
    }
  }
  return { repo: first }
}

/** The identity half of a record, for the page. */
export function toProjectRef(repo: Repo): ProjectRef {
  const repository = repo.owner !== '' && repo.name !== '' ? `${repo.owner}/${repo.name}` : repo.rootPath
  return {
    id: repo.id,
    repository,
    rootPath: repo.rootPath,
    defaultBranchDetected: repo.defaultBranchDetected,
  }
}

/** The plugin defaults the page displays against. */
export function settingsDefaults(config: PluginConfig): SettingsView['defaults'] {
  return {
    autoReview: config.autoReview,
    workerAgentPreset: config.workerAgentPreset,
    workerPermissionPreset: config.workerPermissionPreset,
    reviewerAgentPreset: config.reviewerAgentPreset,
  }
}

/**
 * Builds the payload.
 *
 * Two outcomes are deliberately NOT errors: an install with no project connected is the
 * normal first run, and a request that names no project is how the page asks the host to
 * choose. An request that names a project which does not exist IS an error, because
 * answering it with a different project's settings is how a user edits the wrong repo.
 */
export async function readSettingsView(
  deps: SettingsDeps,
  requestedRepoId = '',
): Promise<{ ok: true; view: SettingsView } | SettingsRefusal> {
  const projects = await listProjects(deps)
  const defaults = settingsDefaults(deps.config)
  const wanted = requestedRepoId.trim()

  if (wanted === '' && projects.length === 0) {
    return { ok: true, view: { projects: [], project: null, settings: null, defaults } }
  }

  const chosen = selectProject(projects, wanted, deps.config)
  if ('refusal' in chosen) return chosen.refusal

  return {
    ok: true,
    view: {
      projects: projects.map(toProjectRef),
      project: toProjectRef(chosen.repo),
      settings: serializeProjectSettings(chosen.repo),
      defaults,
    },
  }
}

/**
 * Applies a patch and persists it.
 *
 * The record is written back **whole**, from the normalized settings plus the record
 * as stored: a `put` that wrote only the patched fields would have to read-modify-write
 * anyway, and the store's `put` is the atomic unit the durable layer offers.
 */
export async function updateProjectSettings(
  deps: SettingsDeps,
  body: unknown,
): Promise<SettingsSaved | SettingsRefusal> {
  const input = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  const requestedRepoId = typeof input.repoId === 'string' ? input.repoId : ''
  const patch = input.patch

  if (patch === undefined || typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return {
      ok: false,
      status: 400,
      code: 'invalid-patch',
      message: 'Send a `patch` object with the settings to change, e.g. {"patch":{"sessionPrefix":"web"}}.',
    }
  }

  const projects = await listProjects(deps)
  const chosen = selectProject(projects, requestedRepoId, deps.config)
  if ('refusal' in chosen) return chosen.refusal

  let next: ProjectSettings
  try {
    next = applyProjectSettingsPatch(normalizeProjectSettings(chosen.repo), patch)
  } catch (error) {
    return {
      ok: false,
      status: 400,
      // The key and the problem, straight from the validator, so the page can point
      // at the row it refused instead of showing a generic failure.
      code: error instanceof Error && 'key' in error ? String((error as { key: unknown }).key) : 'invalid-settings',
      message: error instanceof Error ? error.message : String(error),
    }
  }

  const store = await deps.store.get()
  const record: Repo = { ...chosen.repo, ...next }
  await store.repos.put(record.id, record)

  return {
    ok: true,
    view: {
      projects: projects.map(toProjectRef),
      project: toProjectRef(record),
      settings: serializeProjectSettings(record),
      defaults: settingsDefaults(deps.config),
    },
  }
}
