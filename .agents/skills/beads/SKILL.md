---
name: beads
description: Use when a repository uses bd or Beads for durable task tracking, dependencies, blockers, current work state, or rare shared memory. Trigger when finding, claiming, creating, updating, or closing work; inspecting blockers; recovering context; maintaining issue notes; or choosing between Beads, AGENTS.md, agent_docs, and temporary handoffs.
---

# Beads

Beads owns mutable project work, not repository documentation or session
chronology.

## Startup

Use hook-injected `bd prime` context. Run `bd prime` only when missing/stale;
use `bd where` when workspace discovery is uncertain.

## Ownership

| Information                                         | Owner                       |
| --------------------------------------------------- | --------------------------- |
| Tasks, status, dependencies, blockers, acceptance   | Beads issue                 |
| Workstream state and next action                    | Active issue notes          |
| Stable architecture, invariants, evidence, runbooks | `AGENTS.md` / `agent_docs/` |
| Emergency session checkpoint                        | Temporary handoff           |
| Rare stable fact useful almost every session        | `bd remember`               |

Local plans are current-turn checklists, not shared project state.

## Workflow

1. Inspect:

```bash
bd ready
bd list --status=in_progress
bd show <id>
```

2. Claim before editing: `bd update <id> --claim`.

3. If no issue represents requested work:

```bash
bd create --title="Short title" --description="Why this exists and what must change" --type=task --priority=2
```

4. Keep notes concise/current; replace stale progress, never append a diary.

5. Close only after acceptance:

```bash
bd close <id> --reason="Completed and verified"
```

## Memory hygiene

Every `bd remember` value enters each `bd prime` context. Agent using this skill
owns memory creation, replacement, deletion, and audits; hooks only load it.
`agents-md-init`, `agents-md-sync`, and `handoff` never maintain memories.

Audit when user requests it or work reveals stale, duplicate, or relocated
facts. Before adding memory:

1. Run `bd memories`; reject duplicates.
2. Require stable, non-obvious, short, broadly useful content.
3. Reject facts owned by code, issues, `AGENTS.md`, or `agent_docs/`.
4. Use stable keys; replace via `bd remember --key <key> ...`.
5. Remove obsolete entries with `bd forget <key>`.

Never remember handoff paths/chains/prompts, task progress/next actions,
milestone chronology, copied architecture/evidence/runbooks, secrets,
credentials, private identifiers, or ignored configuration.

## Rules

- No Markdown task ledgers when Beads exists.
- Use non-interactive `bd update` flags, never `bd edit`.
- Prefer `--json` for programmatic parsing.
- Do not mutate/close issues because related code merely exists.
- Never push Beads/Dolt state without explicit authority.
