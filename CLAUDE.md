<!-- nojira:start -->
```
# nojira — MANDATORY for all work in this repo

This repo uses `nojira` to keep a durable, reviewable record of every
change. There is no "small change" escape hatch. No code is written,
no PR is opened, no task is started without going through `/nojira`
first.

## Before touching anything

1. Invoke `/nojira`. It is always the first step.
2. The skill loads `.nojira/pdd.md`, `.nojira/architecture.md`,
   active principles (`nojira list prin --status active`), and
   active decisions (`nojira list dec --status active`). Active DECs
   are constraints on HOW work is done, not just historical context.
3. Run `nojira session current` to see if a session is already open.
   - If it returns an `SES-NNNN`: that's the conversation you are
     already in. Continue in it. Append your work, FNDs, DECs, and
     RUNs to that session — do not open a new one.
   - If it returns `none`: you are not currently in a session. Choose
     based on intent (next section).

4. **Run `nojira search` over the substantive terms of the user's
   request.** This is the most important context-loading step. The
   record corpus is the project's collective memory — every prior
   FEAT, DEC, FND, RUN, SES — and search is how you pull in the
   parts that bear on what the user just asked. For each meaningful
   hit (top 3–5 ranked, ones whose titles look relevant), run
   `nojira show <id>` to load the full body. **The user paying
   attention should never have to remind you of a constraint that
   was already written down.** Examples:
   - User says "let's add retry logic" → `nojira search "retry"` →
     find any DEC about backoff caps, any FND about rate limits,
     any FEAT that already shipped retry elsewhere.
   - User says "rename this column" → `nojira search "rename
     <column>"` → find any DEC or FND about the column's history.
   Strip conversational scaffolding ("can you", "I think", "let's")
   from the query; use 2–6 substantive keywords. Re-search with
   related terms if the first pass returns weak hits.

## Sessions are user-driven

A session is a **conversation thread**, not a per-task scratchpad.
One session can span many turns, many FEATs, many DECs, and many
hours or days. Sessions exist so the user can think out loud with
you, accumulate context, and decide when ideas have cooked enough
to commit.

**The user opens and closes sessions. You don't.** You may *suggest*
opening or closing one, but you act only when the user agrees.

Open a new session ONLY when both are true:
- `nojira session current` reports `none`, AND
- the user has signaled this turn is exploratory or open-ended —
  "let's think about X", "I want to explore Y", "do a dry run of Z",
  "start a session", "fresh session" — or you've reasonably proposed
  one and they agreed.

If the request already has crisp acceptance criteria — a tight bug
fix with a clear repro, a small obvious change, an explicit ticket
already shaped that way — skip the session entirely and go straight
to a FEAT (after `nojira search` for overlap).

Close a session ONLY when the user signals it: "wrap this up",
"promote this", "let's start a new session", "archive this". Then:
- `nojira promote SES-NNNN --to-feat <slug>` if it crystallised
  into committed work, or
- `nojira status set SES-NNNN archived` if it didn't pan out.

Never auto-archive, auto-promote, or auto-rotate sessions. A
multi-task conversation that flows through many DECs and FNDs is
exactly what a session is for — let it accumulate.

5. Do not start editing files until a TASK exists and its status is
   `in-progress`. (TASKs live under FEATs, not under sessions — when
   the session has cooked enough to commit, run `nojira promote
   SES-NNNN --to-feat <slug>` and create the TASK under the new FEAT.)

## While working

- Write a `FND-*` the moment you notice something non-obvious
  (surprise, constraint, gotcha).
- Write a `DEC-*` the moment you make a non-trivial choice with real
  alternatives.
- Capture a `RUN-*/summary.md` for any verification worth
  remembering — test runs that prove a claim, migrations, smoke
  checks.
- When a record is born inside a session, set its `derived_from:
  [SES-NNNN]` frontmatter so the lineage survives. Use `related:
  [...]` for sideways "see also" links. `nojira show SES-NNNN` will
  list every record born from that session under "Spawned" — the
  temporal trail of how this part of the project came to be.
- When branch traceability matters, use manual branch labels:
  `nojira branch attach <id> <branch>` or repeatable `--branch
  <branch>` on `nojira new ...` / `nojira evidence ...`. Branch labels
  are opaque metadata in `branches: []`; nojira does not read Git or
  manage branch lifecycle.

## Before closing a PR

- `nojira status set TASK-<id> done`
- If the change shifted the system's shape, update `architecture.md`
  in this PR.
- Run `nojira doctor`. It must pass.

## If you find yourself coding without nojira

Stop. Back out. Continue the open session — or create the FEAT/TASK —
first. The discipline is the product; skipping it defeats the
purpose of the repo.

## Keeping this primer fresh

When the bundled CLI ships an updated primer, a maintainer runs
`nojira update` from the repo root. That command rewrites this
block in place between the markers — your customisations above and
below are preserved. Re-running it with no upstream change is a
no-op.

Commands: `/nojira` for any work intent. `/nojira-onboard` only to
re-bootstrap if the workflow is corrupted. `nojira update` to
refresh this very block.
```
<!-- nojira:end -->
