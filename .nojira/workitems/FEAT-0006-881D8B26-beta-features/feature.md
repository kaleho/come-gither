---
id: FEAT-0006-881D8B26
status: proposed
created: '2026-10-13T18:31:10+00:00'
updated: '2026-10-13T18:31:10+00:00'
advances: []
verifies: []
derived_from: []
related: []
branches:
- session/large-file-support
external: {}
---

# beta-features

# Beta features toggle and manifest

## Why
New, unproven capabilities (first: the large-file test, FEAT-0008) must ship in a normal release without affecting users who do not opt in.

## Acceptance criteria
- Setting "Enable beta features" (toggle, default off), in both settings renderers.
- One manifest in code (`src/beta.ts`) lists each beta feature: name, what it does, and what it writes or costs.
- The settings page shows the manifest under the toggle.
- Command "Come Gither: Show beta features" opens a modal with the manifest and whether beta is on.
- Beta commands are hidden from the palette and the ribbon menu while beta is off.
