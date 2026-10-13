---
id: FND-0002-30FCD8D3
created: '2026-10-13T20:11:14+00:00'
updated: '2026-10-13T20:11:14+00:00'
category: null
derived_from: []
related: []
branches:
- fix/lfs-review
external: {}
---

# lfs-review-deferred

# Deferred LFS review findings (#2, #4)

An adversarial review of the LFS engine (TASK-0018) found these two defects. TASK-0018 fixes the others; these two stay open.

## #2 The preview omits the `.gitattributes` row that the push commits

Scenario: LFS is on. A new file goes over the threshold (for example `big.bin`). `preview()` lists only `big.bin` as "new". `push()` then appends its line to `.gitattributes` and commits both paths. The panel therefore shows less than the sync does. An existing test asserts this omission ("classifies LFS changes the way sync then applies them" expects no `.gitattributes` row).

Suggested fix: in `doPreview`, compute `lfsCandidates()` over the outgoing rows. When any candidate line is missing from `.gitattributes`, add a `.gitattributes` row ("modified", or "new" when the file is absent). Do not write the file. Update the existing test to expect the row.

## #4 A case-only rename of a shrunk LFS file goes up as a normal blob plus a delete

Scenario: on a case-insensitive filesystem, `big.bin` is an LFS file. It is edited under the threshold (it stays in LFS through `entry.lfs`). The user then renames it to `Big.bin` (case only). Push sees `Big.bin` as untracked. `lfsBySize` is false and the new path has no entry, so the content is hashed as a plain blob. That sha does not match the twin's pointer sha, so the case-rename skip fails. The push commits `Big.bin` as a normal blob and deletes `big.bin`, which silently moves the file out of LFS.

Suggested fix: when an untracked path has a case twin entry with `lfs`, hash it as LFS (pass `remoteLfs`/an lfs flag from `caseTwinEntryKey` into `localState`). The virtual sha then equals the twin's `baseBlobSha` and the rename is skipped, as it is for normal files.
