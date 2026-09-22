---
id: RUN-20260922-release-0-5-1
task: TASK-0003-CFCC3ED6
created: '2026-09-22T20:08:44+00:00'
updated: '2026-09-22T20:08:44+00:00'
branches: []
external: {}
---

# release-0-5-1

## Command

Release PR #38 merged on green CI; `git tag 0.5.1 && git push origin 0.5.1`; the `Release` workflow built the draft; `gh release edit 0.5.1 --draft=false`.

## Output

- PR #38 CI run 35778187320: success.
- Release workflow run 35778266418: success; draft assets main.js, manifest.json, styles.css.
- The attached manifest.json reads "version": "0.5.1" (downloaded and checked before publishing).
- `gh release list`: 0.5.1 is Latest.

## Claim

Release 0.5.1 is published and is the version community installs receive.
