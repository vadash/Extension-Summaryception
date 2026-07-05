# Cache Friendly Memory Mode

## Goal

Add a `Memory Mode` setting with `Standard`, `Cache Friendly`, and `Custom`.

Cache Friendly keeps the prompt shape stable as:

```text
Prompt | frozen Summaryception memory | growing live chat
```

The frozen memory segment should change infrequently so provider prefix caching can reuse the stable prefix across many turns.

## Settings

- `memoryMode`: `standard` | `cache` | `custom`, default `standard`.
- `customMemoryPosition`: `before_prompt` | `in_prompt` | `in_chat`, default `in_prompt`.
- `customMemoryRole`: `system` | `user` | `assistant`, default `system`.
- `customMemoryDepth`: number, default `0`, clamped `0..10000`.

Mode switches reset the verbatim budget:

- `cache`: `32000`
- `standard` or `custom`: `16000`

Switching modes refreshes injection/UI only and does not summarize immediately.

## Injection

- `standard` and `cache`: SillyTavern `IN_PROMPT`, depth `0`, system role.
- `custom`: uses custom position/role/depth; depth applies only to `IN_CHAT`.
- Default/reset template:

```text
<summaryception_memory>
This is condensed continuity memory from older chat turns that may be hidden from the live prompt. Use it as factual background for prior events, relationships, locations, goals, unresolved threads, and character state. Recent verbatim chat takes priority for immediate wording, tone, and next action.

{{summary}}
</summaryception_memory>
```

Existing custom templates are preserved unless reset/default-filled.

## Cache-Friendly Auto Algorithm

Standard and Custom keep the existing continuous summarization behavior.

Cache Friendly uses auto worker-only delayed-start planning:

- Count prompt-visible, unghosted live chat after `summarizedUpTo`.
- If live tokens are within `verbatimTokenBudget`, do nothing and do not promote layers.
- Protect a live tail of `clamp(roundTo1000(verbatimTokenBudget * 0.20), 4000, 8000)` tokens.
- Select flushable assistant turns before the protected tail.
- Process one capped Layer 0 batch with the same `maxSummaryTurns` limit as Standard and Custom.
- After each committed Layer 0 batch, re-evaluate promotion pressure before any new Layer 0 work.

## UI

- Remove `Pause Summarization` and `Disable Message Hiding`.
- Ignore legacy saved pause/disable-hiding values.
- Repair visually hides old metadata-only Summaryception ghosts.
- Add `Memory Mode` controls in Retention with one visible help panel.
- In Cache Friendly:
  - Keep Min/Max Summary Turns enabled because ready cache mode uses the same Layer 0 batching loop.
  - Keep Minimum Summary Budget enabled for Standard/Custom short-batch readiness.
  - Show read-only Status cache stats.
- Manual Force/Slop keeps standard behavior and warns that manual summaries update memory immediately.

## Tests

- Injection option mapping for Standard, Cache Friendly, and Custom.
- Cache planner under-budget, protected tail, flush range, and capped batch selection.
- Cache auto worker delayed-start behavior and promotion-first scheduling.
- Ghosting and state/UI tests updated for removed pause/disable settings.
