---
id: SES-0001-512FE639
status: open
created: '2026-10-13T18:13:23+00:00'
updated: '2026-10-13T18:13:23+00:00'
derived_from: []
related: []
branches:
- session/large-file-support
external: {}
---

# large-file-support

# Session: large-file-support

## Prompt
Support syncing files of any size. A 114 MB vault file is skipped because GitHub refuses git objects over 100 MB. "We were going to get here eventually and today is the day."

## Plan
1. Research: can a fine-grained PAT call the LFS batch API; current LFS per-file limits; current LFS storage/bandwidth quota and billing.
2. iPad spike: one 114 MB upload through Obsidian requestUrl (memory risk; largest tested so far is 30 MB).
3. Promote to a FEAT once both answers are in.

## Notes
- Only route past 100 MB is Git LFS: batch API → upload to returned href → commit a pointer blob through the existing blob/tree/commit flow.
- Pull side: detect pointer blobs, treat as placeholders, fetch via batch download.
- Desktop clients need `.gitattributes` `filter=lfs` rules and git-lfs installed.

## Findings (in flight)
Research lane, 2026-10-13 (sources in the lane report; summary here):
- Auth: classic PAT gets 200 on an LFS upload batch (Basic auth). Fine-grained PAT is undocumented for LFS; likely Contents: write (same as git push). UNCONFIRMED.
- Upload: batch returns a presigned S3 PUT (github-cloud.s3.amazonaws.com) with its own AWS4 Authorization header, 900 s expiry. Never send the GitHub token to S3. Multipart not offered: ONE PUT of the full body. Verify: POST to lfs.github.com with the returned RemoteAuth header.
- Download: presigned href, 3600 s, S3 supports Range (206) — chunked download is possible.
- Pointer: `version https://git-lfs.github.com/spec/v1` / `oid sha256:<hex>` / `size <n>`, LF, <1024 bytes. A pointer whose object was never uploaded: batch 404, web/raw show pointer text. Whether a REST-committed pointer is recognised as LFS, and whether `.gitattributes` is required: UNCONFIRMED; commit `.gitattributes` to be safe.
- Limits: 2 GB per file on Free/Pro (4 GB Team, 5 GB Enterprise Cloud).
- Quota: Free/Pro include 10 GiB storage + 10 GiB bandwidth per month; beyond that metered (~$0.07/GiB-month storage, ~$0.0875/GiB bandwidth; personal-account prices medium confidence). Over quota without payment: LFS push blocked, clones get pointers; normal git unaffected.
- REST reads: trees/blobs return the pointer; contents API `size` reports the real LFS size.
- Mobile: Obsidian forum report (2024) — a 100 MB `requestUrl` PUT crashed Obsidian on iPhone and Android; `fetch` did not. The mobile bridge passes bodies as base64. Our 30 MB base64 push worked on the iPad (M1 spike).

Spike must settle: (1) 114 MB single PUT to S3 on the iPad — via requestUrl, and via `fetch` if S3 answers CORS for the app origin; (2) fine-grained PAT on the batch API; (3) REST-committed pointer recognised as LFS, with/without .gitattributes; (4) verify via requestUrl; (5) ranged download + on-device SHA-256; (6) SHA-256 of 114 MB on the iPad (crypto.subtle needs the whole buffer).

iPad spike result (0.6.0 beta "Test large file support", 2026-10-13, user report): ALL 7 STEPS PASSED with the 114 MB file — hash, batch upload, upload, verify, pointer commit, download check (1 MiB range match), cleanup.
- Settled: a ~114 MB single PUT to LFS storage works on the iPad; the configured token can use the LFS batch API; on-device SHA-256 of 114 MB works; the object is stored and downloadable by range.
- Log details (vault note come-gither-log-2026-10-13.md): file 2-sources/literature/books-and-booklets/FATHER_EN_E01.pdf, 120,087,058 bytes (114.5 MiB).
  - hash: 52 ms on the iPad.
  - upload: `fetch: Load failed` (storage refuses CORS for the app origin, as expected) → `requestUrl: 200` in about 7.6 s. The forum's "100 MB requestUrl crashes mobile" did NOT reproduce on this iPad at 114.5 MiB. Real sync can use requestUrl; fetch is not usable for storage PUTs.
  - verify 200; download batch + Range 206, first 1 MiB matched.
- Pointer commit 7928521 (unreachable now): pointer text and `.gitattributes` line are as specified; the contents API reports size=120087058 (the LFS size, not the 131-byte pointer). Recognition by the web UI / media host is still UNCONFIRMED: github.com/raw (token) and media.githubusercontent.com (token) both 404 for the unreachable private commit — inconclusive. Check it on the first real LFS commit on a live branch.

## Decisions (in flight)

## Next
- iPad spike passed. Next: get the step details from the log; then scope real LFS sync (push over-limit files to LFS, pull pointers as placeholders, .gitattributes) as a FEAT.
