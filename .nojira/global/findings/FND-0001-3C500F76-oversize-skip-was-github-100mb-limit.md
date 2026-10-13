---
id: FND-0001-3C500F76
created: '2026-10-13T18:13:29+00:00'
updated: '2026-10-13T18:13:29+00:00'
category: null
derived_from: [SES-0001]
related: []
branches:
- session/large-file-support
external: {}
---

# oversize-skip-was-github-100mb-limit

# The "not offered after raising the limit" report was GitHub's 100 MB limit

## What happened
After 0.5.2 added "Largest upload (MB)", a user reported a file still skipped as too large after raising the limit. Engine tests (scratch, deleted) showed a skipped file is re-checked each sync and pushed once the limit rises. 0.5.3 added the size to the preview label; it showed the file is 114 MB.

## Finding
No plugin bug. The file exceeds GitHub's hard 100 MB per-object limit, which no plugin setting can lift. The "N skipped" sync notice gives no reason; the preview label (now with size) and log.txt are the places to read it.

## Consequence
Files over 100 MB need Git LFS; see SES-0001.
