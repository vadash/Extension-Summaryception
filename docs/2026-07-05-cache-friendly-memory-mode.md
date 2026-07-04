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

Cache Friendly uses auto worker-only frozen-window planning:

- Count prompt-visible, unghosted live chat after `summarizedUpTo`.
- If live tokens are within `verbatimTokenBudget`, do nothing and do not promote layers.
- Protect a live tail of `clamp(roundTo1000(verbatimTokenBudget * 0.20), 4000, 8000)` tokens.
- Flush from `summarizedUpTo + 1` through the last assistant turn before the protected tail.
- Use token-balanced contiguous chunks ending on assistant turns.
- Use `minSummaryBudget` as the cache chunk target.
- Ignore `minSummaryTurns` and `maxSummaryTurns` in Cache Friendly.
- Summarize chunks sequentially.
- Later chunks see committed memory plus earlier draft summaries from the same flush.
- If any chunk fails, commit nothing and hide nothing.
- If all chunks succeed, append all Layer 0 snippets in one commit, refresh injection, ghost the flushed range, then run promotion immediately after the successful cache flush.

## UI

- Remove `Pause Summarization` and `Disable Message Hiding`.
- Ignore legacy saved pause/disable-hiding values.
- Repair visually hides old metadata-only Summaryception ghosts.
- Add `Memory Mode` controls in Retention with one visible help panel.
- In Cache Friendly:
  - Disable Min/Max Summary Turns.
  - Keep Minimum Summary Budget enabled as the cache chunk target.
  - Show read-only Status cache stats.
- Manual Force/Slop keeps standard behavior and warns that manual summaries update memory immediately.

## Tests

- Injection option mapping for Standard, Cache Friendly, and Custom.
- Cache planner under-budget, protected tail, flush range, balanced chunks, min/max ignored.
- Cache transaction success, draft context, and failure rollback behavior.
- Ghosting and state/UI tests updated for removed pause/disable settings.
