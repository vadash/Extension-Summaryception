# Unified Elastic Summarization And Promotion

## Goal

Summaryception uses one elastic execution engine for automatic summarization, Force Summarize, Slop Breaker, Standard memory, Custom memory, and Cache memory. Strategy-specific code supplies boundaries and chunk plans; the engine owns execution, commits, promotion pressure, foreground freeze handling, progress, and manual completion.

## Strategies

- `AUTO`: normal chat summarization. It respects the dynamic verbatim window, `minSummaryTurns`, `minSummaryBudget`, and `maxSummaryTurns`.
- `FORCE`: uses the same live-tail boundary as `AUTO`, but ignores minimum readiness so existing overflow can be summarized immediately.
- `SLOP`: summarizes completed exchanges through the latest assistant/complete message. A trailing unmatched user message stays live.
- `CACHE`: uses the cache planner and all-or-nothing cache chunks, then enters the same Layer 0 commit and promotion path.

Custom memory does not change summarization cadence. It only changes injection placement, role, and depth.

## Promotion Budget

`memoryTokenBudget` is the injected-memory pressure target. Default is `10000`, clamped to `4000-32000` in `1000` token steps. It is not a hard truncation limit.

Dynamic layer quotas use only active non-empty layers. Layer weights halve by depth and normalize across the active set:

- L0: `100%`
- L0/L1: about `67% / 33%`
- L0/L1/L2: about `57% / 29% / 14%`

The promotion worker promotes the shallowest over-limit layer first. A layer is over-limit when it exceeds either its dynamic token quota or the `snippetsPerLayer` count guard, now shown as **Max Memories per Layer**.

Empty destination layers are created by LLM-backed merge promotion. There is no free seed promotion. The visible Maximum Layer Depth setting is removed; the internal creation safety cap is `20`. Existing imported layers deeper than the cap are preserved and still included in quota calculations.

## Manual Completion

Manual Force and Slop runs reload only after the intended target has been summarized and promotion pressure normalizes. If promotion is blocked by the foreground prompt guard, repeatedly fails, or cannot normalize because the internal depth cap is reached, committed work is kept but the run does not report complete reload eligibility.
