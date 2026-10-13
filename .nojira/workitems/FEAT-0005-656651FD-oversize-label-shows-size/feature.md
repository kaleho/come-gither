---
id: FEAT-0005-656651FD
status: in-progress
created: '2026-10-13T17:50:10+00:00'
updated: '2026-10-13T17:50:51+00:00'
advances: []
verifies: []
derived_from: []
related: []
branches:
- feat/oversize-label-size
external: {}
---

# oversize-label-shows-size

# Show the file size on "too large to push"

## Why
The preview label "Skipped: too large to push" gives no size. A user who raised the upload limit (FEAT-0004) cannot tell why a file is still skipped.

## Acceptance criteria
- The sync plan's `skip-oversize` item carries the local file size in bytes.
- The preview label reads "Skipped: too large to push (<size>)", for example "(52.3 MB)".
- The size format matches the download prompt (MB to one decimal at 1 MB or more, else KB), from one shared helper.
