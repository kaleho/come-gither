---
id: FEAT-0002-A1D8F3F6
status: proposed
created: '2026-09-22T17:08:50+00:00'
updated: '2026-09-22T17:08:50+00:00'
advances: []
verifies: []
derived_from: []
related: []
branches: []
external: {}
---

# community-install-and-reports

## Intent

The plugin is live in the Obsidian community registry (verified 2026-09-22 in `obsidianmd/obsidian-releases` `community-plugins.json`). The README still tells users to install through BRAT, and the repo has no issue templates, so the first bug reports will lack the sync log.

## Acceptance

- The README install section points to the community listing; BRAT is no longer required, and nothing tells users to use it.
- The README describes the deletion guard (settings list and the deletions limit), matching 0.5.0 behavior.
- A bug-report issue template asks for the plugin version, platform, and the exported sync log (*Export sync log*).
- Blank issues stay possible; a config file links to the README.
