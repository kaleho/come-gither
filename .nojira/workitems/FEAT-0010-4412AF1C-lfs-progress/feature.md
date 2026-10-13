---
id: FEAT-0010-4412AF1C
status: proposed
created: '2026-10-13T19:57:33+00:00'
updated: '2026-10-13T19:57:33+00:00'
advances: []
verifies: []
derived_from: [SES-0001]
related: [FEAT-0009]
branches:
- records/lfs-progress
external: {}
---

# lfs-progress

# Beta: progress for LFS uploads and downloads

## Why
A 115 MB transfer takes seconds to minutes on a phone with no feedback. Downloads arrive in 8 MiB ranges, so real progress is possible. Uploads are one `requestUrl` PUT, which reports nothing until it ends (fetch/XHR, which have upload progress, are blocked by storage CORS — SES-0001), so uploads get a timer, not a percentage.

## Acceptance criteria
- `downloadLfsObject` accepts an optional progress callback `(doneBytes, totalBytes)`, called after each range (and once for a full 200 response). `LfsOps.download` passes it through.
- Opening an LFS placeholder shows an in-place Obsidian notice: "Downloading <name>: <done> of <total>" with a bar, updated per range, and closed when the file is written or the download fails.
- During a push, each LFS upload shows an in-place notice: "Uploading <name> (<size>)… m:ss", with "n of N" when several files go through LFS in one push; the timer ticks each second and the notice closes when the upload ends.
- No fake percentage for uploads.
- Works on mobile (notices, not the status bar). Only while beta is on.
- Pure parts (progress text/format, callback plumbing) tested at 100%.
