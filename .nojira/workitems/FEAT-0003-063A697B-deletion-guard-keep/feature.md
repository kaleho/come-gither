---
id: FEAT-0003-063A697B
status: proposed
created: '2026-09-22T17:26:15+00:00'
updated: '2026-09-22T17:26:15+00:00'
advances: []
verifies: []
derived_from: []
related: []
branches: []
external: {}
---

# deletion-guard-keep

## Intent

The 2026-09-22 bug hunt of PR #32 (57 raw findings, 14 lanes) kept two Highs on the deletion guard: a declined pull guard wedges every later sync with no exit that keeps the files, and the pull guard runs after incoming changes are already written, so a declined force-push can leave rolled-back content in the vault silently. The owner chose "Cancel keeps the files" (2026-09-22).

## Acceptance

- The decision is delete / keep / defer. Keep: pull keeps the files and untracks them (they upload again on push); push restores the files locally from their last-synced blobs. Neither wedges a later sync.
- The guard decides before any write in both directions; defer (no confirmer, or an unattended run) changes nothing.
- Unattended runs (auto-sync interval, startup pull) never open the modal; they defer with one Notice until a manual sync.
- The modal text covers moves and other-device deletions; Escape keeps.
- Case-only renames and excluded paths never count, in both directions.
- A blank or invalid threshold field never turns the guard off.
- The log distinguishes delete / keep / defer and records the threshold.
- sync()-level tests cover the guard; 100% coverage holds.

## Deferred (Low)

Retry after not-fast-forward asks again; preview does not flag the guard; double hash of delete candidates; stale list after a long-open modal; modal classes share a shape (L13).
