---
id: FEAT-0012-5151449A
status: in-progress
created: '2026-10-28T12:54:56+00:00'
updated: '2026-10-28T12:54:59+00:00'
advances: []
verifies: []
derived_from: []
related: []
branches:
- deps/osv-bump
external: {}
---

# osv-dependency-bump

# Clear OSV findings in package-lock.json

## Why
osv-scanner reports 24 npm advisories (3 Critical, 6 High) in the tracked package-lock.json. All are in dev dependencies (vitest, vite, esbuild, brace-expansion, source-map-js, tinypool, moment via obsidian). The shipped main.js bundles only src/ and node-diff3, so no advisory reaches users, but the scan must be clean.

## Acceptance criteria
- `osv-scanner scan source --offline-vulnerabilities -L package-lock.json` exits 0.
- Dependency bumps only; no behavior change in src/.
- `npm ci && npm run build && npm run coverage` stays green: all tests pass, 100% coverage.
- Any ignore lives in a repo-root osv-scanner.toml with ignoreUntil and a reachability reason.
