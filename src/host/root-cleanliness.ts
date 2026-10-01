/**
 * Detecting edits made OUTSIDE a worker's worktree (R7).
 *
 * The permission preset and the worktree-scoped cwd are the primary defences, but they
 * are configured rather than enforced: a worker that ran `git` with an explicit `-C`, or
 * a tool that resolved a path upward, can still touch the shared checkout. R7 asks for a
 * post-hoc check "with `git status` in the repo root before shipping" — this is it.
 *
 * ## A DELTA, not a verdict on the whole tree
 *
 * The plugin shares the user's own checkout (`Appendix A4`), so the repo root is
 * frequently dirty for entirely legitimate reasons: the human has work in progress, an
 * untracked scratch file, a build artefact. **Refusing every dirty root would block every
 * worker on a developer's machine.**
 *
 * So the check compares against a BASELINE captured before the worker started, and only
 * paths that became dirty afterwards are evidence of anything. That is the difference
 * between a useful guard and one that gets disabled the first time it cries wolf.
 *
 * @module dsho/host/root-cleanliness
 */

import type { RunCommand } from './worktree.ts'

/** The dirty paths in a checkout, as `git status --porcelain` reports them. */
export async function dirtyPaths(run: RunCommand, rootPath: string): Promise<string[]> {
  const result = await run(['git', 'status', '--porcelain'], { cwd: rootPath })
  if (result.exitCode !== 0) return []
  return result.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((path) => path !== '')
}

/**
 * The paths that became dirty after `baseline` was taken.
 *
 * Paths already dirty at baseline are ignored, and `.dsho/` is ignored outright because
 * it is the plugin's own scratch space — the worktrees live inside it, and its state
 * changes whenever a worker does anything, so counting it would make every root look
 * freshly dirtied.
 */
export function newlyDirty(current: readonly string[], baseline: readonly string[]): string[] {
  const known = new Set(baseline)
  return current.filter((path) => !known.has(path) && !path.startsWith('.dsho/') && path !== '.dsho')
}
