# hello

A placeholder for **issue #13 ("hello")**.

The issue body was the single word `hello`, and `npm run verify` was already green
on a clean checkout of this branch — there was nothing broken to fix and no
requirement to implement. Rather than invent scope, this file is the smallest
honest deliverable: a clearly-labelled marker that changes no product code and no
behaviour.

It exists only to exercise the worker pipeline end to end — spawn, branch,
worktree, verify, commit, pull request — on an issue that carries no real work.

**What it deliberately does not do:** it adds no module to `src/`, no case to the
suite in `test/`, and no entry to `package.json`. It is invisible to every step of
`npm run verify` (`tsc -p tsconfig.src.json`, `node --test`, `tsc -p
tsconfig.build.json`).

Safe to delete once the smoke test has served its purpose.
