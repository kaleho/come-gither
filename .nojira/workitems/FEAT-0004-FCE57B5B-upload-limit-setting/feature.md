---
id: FEAT-0004-FCE57B5B
status: in-progress
created: '2026-10-08T16:10:48+00:00'
updated: '2026-10-08T16:17:59+00:00'
advances: []
verifies: []
derived_from: []
related: []
branches:
- feat/upload-limit-setting
external: {}
---

# upload-limit-setting

# Configurable upload limit

## Why
The push limit is a fixed 30 MB constant (`MAX_PUSH_BYTES` in src/main.ts). Users with larger files cannot raise it without a code change.

## Acceptance criteria
- A "Largest upload (MB)" setting exists, default 30.
- The setting has no maximum. Any positive number is accepted; other input falls back to 30 (declarative) or keeps the saved value (classic tab).
- The description warns that GitHub refuses files over 100 MB.
- The sync engine uses the setting for `maxPushBytes`.
- README Settings and Limits sections describe the setting.
