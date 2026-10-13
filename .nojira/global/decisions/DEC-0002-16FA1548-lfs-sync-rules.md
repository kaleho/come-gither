---
id: DEC-0002-16FA1548
status: active
created: '2026-10-13T19:14:35+00:00'
updated: '2026-10-13T19:14:35+00:00'
supersedes: null
derived_from: [SES-0001]
related: [FEAT-0009]
branches:
- records/lfs-sync-feat
external: {}
---

# lfs-sync-rules

# LFS sync rules: 100 MB cutoff, LFS stays LFS, append-only .gitattributes

## Context
Real LFS sync (FEAT-0009) needs rules for which files go to LFS and how `.gitattributes` is kept. The iPad spike (SES-0001) proved a 114.5 MiB single `requestUrl` PUT; `fetch` is blocked by storage CORS. Decided with the user on 2026-10-13.

## Decision
1. **Cutoff fixed at 100 MB.** A file goes to LFS when it is over GitHub's 100 MB object limit. Files at or under 100 MB stay normal git blobs, which desktop git reads without git-lfs. The "Largest upload (MB)" setting still caps what the plugin uploads at all; nothing over 2 GB is uploaded (GitHub's LFS per-file limit on Free/Pro).
2. **LFS stays LFS.** A file that is an LFS pointer in the repository stays in LFS when the plugin pushes an edit, at any size. A new file goes to LFS only when it is over 100 MB. Pattern rules from desktop `.gitattributes` (e.g. `*.pdf filter=lfs`) are not interpreted in this version.
3. **Append-only `.gitattributes`.** The plugin adds one exact-path line (`gitattributesLine`) for each file it puts into LFS, and never removes or rewrites lines. A line left after a delete or rename is harmless.
4. **Uploads use `requestUrl`** (one PUT of the whole file); `fetch` is not used for storage PUTs.

## Alternatives
- Cutoff follows the upload-limit setting: rejected; files under 100 MB would need git-lfs on desktop for no gain.
- Interpret desktop `.gitattributes` patterns: deferred; a later version can add it.
- Remove `.gitattributes` lines on delete: rejected; edits a file the user or desktop may also edit, inviting conflicts, for no functional gain.

## Consequences
- Desktop clients need git-lfs installed to see LFS files.
- A new file under 100 MB that matches a desktop LFS pattern is pushed as a normal blob; desktop git may warn.
- iPad memory above ~114 MB is unproven; files near 1–2 GB may fail on mobile.
