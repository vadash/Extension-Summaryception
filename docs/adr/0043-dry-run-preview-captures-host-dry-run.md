# Dry-run preview captures the host dry-run prompt

The Dry-Run Preview fires the host dry-run generate and clones the post-`CHAT_COMPLETION_PROMPT_READY` chat array with microfiche markers expanded, because only the real assembly reproduces prompt order, role masking, Ghosting, and prefix stability at zero LLM cost; the clone is read-only and never crosses the Foreground Gate (ADR-0016), so previewing mutates no live payload.

## Considered Options

- **Synthetic prompt reconstruction** — rejected: a second assembly path drifts from the masking, hiding, and ordering the real seam applies.
- **Live-generation intercept** — rejected: it spends a real LLM call and needs abort plumbing the dry-run path never requires.
