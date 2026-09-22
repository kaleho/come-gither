---
goals:
  - GOAL-0001
  - GOAL-0002
  - GOAL-0003
success_criteria:
  - SC-0001
  - SC-0002
non_goals:
  - NG-0001
  - NG-0002
---

# Product Definition

Every entry below paraphrases `README.md` (as of 0.5.0). Nothing here is inferred from code.

## Vision

Come Gither syncs an Obsidian vault with a GitHub repository through the GitHub API. It works on desktop and mobile, including iPad, and does not need git on the device (`README.md` lines 3–7). Real git implementations struggle on mobile with large repositories; talking to the API instead keeps the cost of a sync proportional to the edits, not to the vault.

## Goals

- **GOAL-0001** — Two-way sync between a vault and a GitHub repository that creates real commits, so other devices and plain git see normal history (`README.md` lines 3, 11).
- **GOAL-0002** — Work on mobile, including iPad, with no git on the device (`README.md` line 3).
- **GOAL-0003** — Handle large binaries without downloading them all: placeholders until opened, and a command to free space again (`README.md` lines 12–13).

## Success criteria

- **SC-0001** — A sync downloads and uploads only the files that changed; its cost grows with edits, not with vault size (`README.md` line 7).
- **SC-0002** — An interrupted upload leaves nothing on GitHub until the final commit lands; an interrupted pull resumes where it stopped (`README.md` line 16).

## Non-goals

- **NG-0001** — Git LFS is not supported (`README.md` line 47).
- **NG-0002** — No other network service and no telemetry: the plugin talks only to `api.github.com` (`README.md` line 21).
