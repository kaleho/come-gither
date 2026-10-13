---
id: FEAT-0008-447BC47D
status: done
created: '2026-10-13T18:31:10+00:00'
updated: '2026-10-13T18:44:57+00:00'
advances: []
verifies: []
derived_from:
- SES-0001
related:
- FND-0001
- FEAT-0006
branches:
- session/large-file-support
external: {}
---

# lfs-test-command

# Beta: "Test large file support" command

## Why
Git LFS is the only route past GitHub's 100 MB limit (FND-0001). Four risks are unproven (SES-0001): a single large PUT on the iPad, fine-grained token access to the LFS API, a REST-committed pointer being recognised, and SHA-256 of a large file on device.

## Acceptance criteria
- Beta command, listed in the beta manifest, hidden while beta is off.
- The user picks a vault file (largest first, with sizes).
- Steps, each logged and flushed before it runs so a crash shows where it died:
  1. SHA-256 of the file (time reported).
  2. LFS batch upload request with the configured token (status reported).
  3. Upload via `fetch` (CORS may refuse); if it fails, via `requestUrl`. Skipped when GitHub already has the object.
  4. Verify with the returned headers.
  5. Commit `.gitattributes` + pointer on branch `come-gither-lfs-test`, check the batch download for the oid, read the first 1 MB by Range and compare with the local bytes.
  6. Delete the branch (also on failure after it was created).
- A results summary (modal + log) lists pass/fail per step.
- The LFS object stays in storage (intended: real LFS sync reuses it). The manifest says so.
