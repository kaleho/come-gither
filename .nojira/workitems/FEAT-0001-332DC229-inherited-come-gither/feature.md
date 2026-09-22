---
id: FEAT-0001-332DC229
status: done
created: '2026-09-22T17:06:48+00:00'
updated: '2026-09-22T17:06:48+00:00'
advances: []
verifies: []
derived_from: []
related: []
branches: []
external: {}
---

# inherited-come-gither

## Snapshot at onboarding (0.5.0, 2026-09-22)

Obsidian community plugin that syncs a vault with GitHub through the Git Data API. Listed in the community registry; 50 downloads at onboarding.

### Entry points
- `src/main.ts` — plugin class, settings tab, commands (sync, preview, evict, export log), preview view, fetch/deletion modals.
- `src/sync.ts` — `SyncEngine`: pull, push, sync, preview, revert, lazy fetch, evict, deletion guard.

### Components
- `src/github.ts` — GitHub API client with classified errors and rate-limit retry.
- `src/state.ts` — `sync-state.json` store, stamped `owner/repo#branch`.
- `src/merge.ts` — diff3 text merge.
- `src/log.ts` — ring-buffer logger.
- `src/wire.ts` — transport helpers; `src/ports.ts` — Http/Files seams.

### Tech stack
TypeScript + esbuild, Obsidian API (min 1.7.2), `node-diff3`. vitest + v8 coverage at 100% thresholds (main.ts and ports.ts excluded). GitHub Actions CI and tag-driven release.

### Test harness
`test/fakes.ts`: `FakeHttp`, `MemFiles`, `CaseFoldMemFiles` (iPad case-insensitive fs), snapshot-addressed `FakeGitHub` that 422s invalid deletes. ~189 tests.

### Notable complexity
- Case-only renames on case-insensitive vs case-sensitive filesystems.
- Placeholders (lazy entries) must never push over real remote content.
- Interruption safety: state commits advance only after the ref moves.
- iOS `requestUrl` caching of GitHub GETs (cache-busted).
- The 0.4.0 seven-round bug hunt and the 0.5.0 deletion guard shaped most invariants.
