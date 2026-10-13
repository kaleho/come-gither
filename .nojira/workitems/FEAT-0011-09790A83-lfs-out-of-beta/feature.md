---
id: FEAT-0011-09790A83
status: done
created: '2026-10-13T20:29:21+00:00'
updated: '2026-10-13T20:32:44+00:00'
advances: []
verifies: []
derived_from:
- SES-0001
related:
- FEAT-0009
- FEAT-0010
- DEC-0002
branches:
- feat/lfs-out-of-beta
external: {}
---

# lfs-out-of-beta

# Git LFS sync out of beta

## Why
0.7.0 beta LFS sync passed the on-device check (FEAT-0009/0010). The user asked to make it a regular feature, shipped as 0.7.1.

## Acceptance criteria
- LFS sync runs for every user, without "Enable beta features": the engine always gets `lfs`.
- "Sync large files with Git LFS" is removed from the beta manifest. "Test large file support" stays in beta.
- The "Largest upload (MB)" description no longer mentions beta; it says files over 100 MB go through Git LFS (limit 2 GB) once the limit is raised above 100.
- README: LFS moves from the Beta section to the feature list; Limits, Settings and the network disclosure drop the beta condition.
- Behavior for users who keep the default 30 MB limit is unchanged on push; pull detects LFS pointers for everyone.
- Release 0.7.1.
