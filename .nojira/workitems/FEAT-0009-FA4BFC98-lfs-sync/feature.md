---
id: FEAT-0009-FA4BFC98
status: done
created: '2026-10-13T19:14:35+00:00'
updated: '2026-10-13T20:28:28+00:00'
advances: []
verifies: []
derived_from:
- SES-0001
related:
- FND-0001
- FEAT-0008
- DEC-0002
branches:
- records/lfs-sync-feat
external: {}
---

# lfs-sync

# Beta: sync files over 100 MB through Git LFS

## Why
GitHub refuses files over 100 MB (FND-0001). The 0.6.0 beta test proved the LFS round trip on the iPad (SES-0001). This FEAT makes push and pull use LFS for those files. Rules: DEC "lfs-sync-rules".

## Acceptance criteria
**Gate**
- All LFS behavior runs only while "Enable beta features" is on, and the feature is listed in the beta manifest (name, what it does, what it writes and costs).
- With beta off, behavior is unchanged from 0.6.0.

**Push**
- A local file over 100 MB, within the upload limit and at most 2 GB, is pushed through LFS: SHA-256, batch upload (skipped upload when GitHub already has the object), one `requestUrl` PUT, verify, then the pointer blob is committed at the file's path in the normal sync commit.
- The same commit adds the file's exact-path line to `.gitattributes` when the line is not already there. Existing lines are never removed or changed.
- A file that is an LFS pointer in the repository is pushed through LFS on edit, at any size.
- A file over 2 GB is skipped with a warning that names the 2 GB limit; the preview label shows its size.
- The upload must not leave a pointer committed without its object: a failed upload or verify skips that file for this sync with a warning; other files still push.

**Pull**
- A tree entry whose blob is an LFS pointer is recognised (spec v1 format, < 1024 bytes). The plugin never writes pointer text into the vault.
- A pulled LFS file arrives as a placeholder (like binaries above the auto-download limit) and downloads when opened, through the LFS batch download, in ranges, and is checked against the pointer's SHA-256 before it is written.

**Change detection**
- An LFS file's state records its LFS oid and real size. A local file counts as unchanged when its size and SHA-256 match the recorded oid, so an untouched LFS file is never re-uploaded.
- Conflicts on an LFS file never attempt a text merge; the existing binary conflict handling applies.

**Settings and docs**
- The upload-limit description says LFS (beta) handles files over 100 MB, up to 2 GB.
- README: the beta entry, the Limits section (2 GB, desktop needs git-lfs, LFS storage quota), and the network disclosure (LFS hosts used during sync while beta is on).

**Verification**
- Unit tests at 100% coverage for the engine changes.
- An on-device run on the iPad with the 114.5 MiB file: push, then pull on another device or after evicting it, and a check that GitHub's web page shows the file as stored with Git LFS (the open question from SES-0001).
