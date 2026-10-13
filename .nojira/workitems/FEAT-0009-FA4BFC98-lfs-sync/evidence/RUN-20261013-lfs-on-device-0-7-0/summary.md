# RUN: on-device verification of 0.7.0 beta LFS sync (iPad, 2026-10-13)

**Claim:** On the user's iPad, 0.7.0 pushed a 114.5 MiB PDF through Git LFS in a normal sync commit, GitHub recognises it as an LFS file, and the placeholder download works with progress. Satisfies the Verification criteria of FEAT-0009 and FEAT-0010.

**Evidence:**
- Vault repo commit `2784b43` ("come-gither: sync (3 changed, 0 deleted, 0 kept)"): added `.gitattributes` (`/2-sources/literature/books-and-booklets/FATHER_EN_E01.pdf filter=lfs diff=lfs merge=lfs -text`) and modified the PDF to a pointer (`oid sha256:d375f8b7…410e`, `size 120087058`) — same commit (driver, `gh api repos/<vault>/commits/<sha>`).
- Contents API reports `size=120087058` for the path on master.
- LFS batch download for the oid returned a download action; a Range 0-7 GET returned `206` and `%PDF-1.6` (driver, read-only).
- User report: GitHub's web page for the PDF shows "Stored with Git LFS".
- User report: the upload notice "Uploading FATHER_EN_E01.pdf (114.5 MB)… m:ss" appeared with a ticking timer.
- User report: after "Remove local copy (keep on GitHub)" and reopening, the download progress bar appeared and the PDF opened correctly.
