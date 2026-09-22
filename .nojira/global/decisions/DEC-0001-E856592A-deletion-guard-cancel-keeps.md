---
id: DEC-0001-E856592A
status: active
created: '2026-09-22T20:20:12+00:00'
updated: '2026-09-22T20:20:12+00:00'
supersedes: null
derived_from: []
related: []
branches: []
external: {}
---

# deletion-guard-cancel-keeps

## Context

The 0.5.0 deletion guard asked before a pull or push deleted more than a threshold of files, but "Cancel" aborted the whole sync. The PR #32 bug hunt (2026-09-22) found that a declined pull wedged every later sync: the only exits (confirm, or raise the threshold) deleted the files the user wanted to keep.

## Decision

The guard decides before any write, and the answer is **delete**, **keep**, or **defer** (shipped in 0.5.1, PR #37):

- **Keep on a pull**: the files stay tracked with a `keep` mark (one atomic state write); the same sync's push re-adds each by its existing blob. The mark drops as soon as GitHub has the path in any casing.
- **Keep on a push**: the entries become placeholders in one write, then the files are restored here (large files and binaries as placeholders).
- **Escape or a tap outside the modal means Keep** — the owner's explicit choice (2026-09-22).
- **Unattended runs** (auto-sync interval, startup pull) never ask: they **defer** (change no file, one Notice) until a manual Sync now. The owner's approved option said Keep here; it was changed to defer because an unattended Keep would silently undo another device's deliberate deletions.

## Alternatives considered

- **Cancel aborts the sync** (0.5.0): rejected; it wedges sync with no file-preserving exit.
- **Keep by untracking and re-uploading**: rejected in review round 2; it downloads large placeholders, strands files over 30 MB and zero-byte files, and a kill mid-loop let the remainder fall under the threshold and be deleted.
- **Dismiss means defer**: argued by three review lanes (L5, L7, L11) — an accidental dismiss would re-add files another device deleted on purpose. Not adopted; the owner chose Keep as the safe default. Revisit if a user reports resurrected deletions.

## Consequences

Nothing a guard catches is ever lost without an explicit "Delete N files" tap. A dismissed prompt can resurrect a deliberate deletion from another device. An unattended paused pull also holds back that run's push until a manual sync.
