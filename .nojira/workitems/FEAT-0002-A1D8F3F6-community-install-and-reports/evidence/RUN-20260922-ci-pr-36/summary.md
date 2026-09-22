---
id: RUN-20260922-ci-pr-36
task: TASK-0001-5ACBA5D9
created: '2026-09-22T20:06:46+00:00'
updated: '2026-09-22T20:06:46+00:00'
branches: []
external: {}
---

# ci-pr-36

## Command

GitHub Actions `CI` workflow (`npm ci && npm run build && npm run coverage`) on PR #36, branch `docs/install-and-templates`, then on `main` after the squash merge (91b34c9).

## Output

- PR run 35759171662: success.
- main run 35760551369: success.
- The token claim in the issue template was checked in `src/github.ts`: error messages carry the HTTP status, API path, and GitHub's message; the token appears only in the `Authorization` header.

## Claim

The README install section, deletion-guard documentation, and issue templates shipped with a green build and an unchanged test suite.
