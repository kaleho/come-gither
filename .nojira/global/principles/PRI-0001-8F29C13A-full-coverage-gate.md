---
id: PRI-0001-8F29C13A
status: active
created: '2026-09-22T17:06:54+00:00'
updated: '2026-09-22T17:06:54+00:00'
supersedes: null
category: null
derived_from: []
related: []
branches: []
external: {}
---

# full-coverage-gate

## Source

`vitest.config.ts` lines 5–11:

> coverage: {
>     provider: "v8",
>     include: ["src/**"],
>     // main.ts and ports.ts need the Obsidian runtime; covered by hand-testing.
>     exclude: ["src/main.ts", "src/ports.ts"],
>     thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
> },

`.github/workflows/ci.yml` runs `npm run coverage` on every pull request.

`src/wire.ts` lines 1–6:

> Pure helpers for the Obsidian transport and wiring layer. They live here,
> outside main.ts, so the coverage gate applies to them

## Principle

Every source file except the Obsidian-runtime shell (`src/main.ts`, `src/ports.ts`) holds 100% line, branch, function, and statement coverage, enforced in CI. Logic that needs testing moves out of `main.ts` into a covered module (as `src/wire.ts` did).
