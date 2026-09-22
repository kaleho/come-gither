# Architecture

## Components

**`SyncEngine` (`src/sync.ts`)** is the core. It owns pull, push, sync (pull then push, retried on a not-fast-forward), preview, revert, lazy fetch, and evict. A single promise-chain lock serializes every operation, because they all read and write the same files and state. `classifyIncoming` is the one classification of a remote change, shared by pull and preview so the preview panel can never disagree with what sync does. A deletion guard (`guardDeletions`) stops any operation that would delete more than a threshold of files until a confirmer approves.

**`GitHubClient` (`src/github.ts`)** wraps the GitHub Git Data API: refs, commits, trees, blobs. It classifies failures into `GitHubError` kinds (auth, not-found, not-fast-forward, rate-limited, too-large) and retries rate limits with an injected sleep.

**`StateStore` (`src/state.ts`)** persists `sync-state.json`: the last synced commit and a per-path entry (base blob sha, local size/mtime fingerprint, lazy flag, remote size, git mode). The file is stamped `owner/repo#branch`; a mismatch or unusable file re-baselines. Writes flush on a count/time cadence.

**`threeWayMerge` (`src/merge.ts`)** runs a diff3 merge of local, base, and remote text via `node-diff3`, returning null on overlapping edits.

**`RingLogger` (`src/log.ts`)** keeps a bounded in-memory log, flushed to the plugin folder and exportable as a note.

**The plugin shell (`src/main.ts`)** wires everything to Obsidian: settings tab, commands (sync, preview, evict, export log), the preview view, the placeholder-download and deletion-confirm modals, the status bar, and the auto-sync interval. It holds one engine and one state store per settings epoch; a settings change retires the engine and rebuilds lazily. **`src/wire.ts`** holds the testable transport helpers (cache busting, header casing, parent-dir walk, interval clamp).

## Boundaries

The hard seam is `src/ports.ts`: `Http` and `Files` interfaces. The engine never imports Obsidian; `main.ts` supplies `requestUrl` and `Vault.adapter` implementations, and tests supply `FakeHttp`, `MemFiles`, `CaseFoldMemFiles`, and `FakeGitHub` (`test/fakes.ts`). The second hard seam is the GitHub API contract, including its 422 on deleting a path absent from the base tree.

Soft seams: `SyncEngine` depends on the `GitHubApi` interface (declared in `sync.ts`), not on `GitHubClient` directly; the engine's config (`SyncConfig`) carries every policy knob, including exclusions and the deletion confirmer.

## Data flow

Pull: read the branch ref; if it moved, list the remote tree (recursive, falling back to a subtree walk when truncated), compare each blob sha with the state entry, and fetch, placeholder, adopt, merge, or park into `_conflicts/`. Remote deletions are collected, guarded, then applied. The state commit advances last.

Push: scan local files against the state fingerprints, hash changed ones, upload blobs (cached by content sha within one call), collect deletions, guard them, then create one tree and one commit on the last synced commit and fast-forward the ref. State updates only after the ref moves.

Placeholders: binaries and oversize text arrive as zero-byte files tracked `lazy`; opening one fetches it on demand; evict turns it back.

## Tech stack

TypeScript, bundled with esbuild into `main.js`; Obsidian plugin API (min app 1.7.2), desktop and mobile. Runtime dependency: `node-diff3`. Tests: vitest with v8 coverage, 100% thresholds. CI (GitHub Actions) builds and runs coverage on every PR; a tag push builds, attests, and drafts a release (see `RELEASE.md`).
