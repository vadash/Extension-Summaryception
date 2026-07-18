# Status tab: trigger gauge redesign

Date: 2026-07-18
Status: Implemented

## Problem

The Status tab (Advanced mode) opens with two low-value sections and a
capacity bar that doesn't answer the user's actual question — *when will
summarization fire?*

- **Overview** (`settings.html:260-277`) shows `Depth` and `Index`
  (`store.summarizedUpTo`). `Depth` duplicates the layer legend below;
  `Index` is an internal array cursor with no user meaning.
- **Context Payload** (`settings.html:278-329`) bundles two unrelated things
  under one heading: a decorative `ST Context → Memory → Verbatim` rail that
  never changes, plus the two real capacity bars (Verbatim Window, Memory
  Block).
- The Verbatim Window bar shows `Verbatim Window (22k) | Queued (10k)`, but
  spilling into "Queued" does **not** mean a summary is imminent. The trigger
  has two gates and neither is visible.

## Trigger model (ground truth)

From `src/core/verbatim-window.js:47-78`, a Layer 0 summary fires when
**either**:

1. `candidateTurns.length >= maxSummaryTurns` (hard cap), **or**
2. `candidateTurns.length >= minSummaryTurns` **and**
   `summaryStats.finalTokens >= minSummaryBudget`.

So there are two axes: **queued tokens** (`minSummaryBudget`) and **queued
turns** (`minSummaryTurns`), both gating condition 2. The user chose an
**effective-trigger** marker: the line sits at whichever gate fires *last*.

All inputs are already computed by `buildAutoSummaryRoutePlan(...).rawPlan`
and reachable in the UI:

- `verbatimTokenBudget` (setting) — boundary where the queued zone begins.
- `summaryStats.finalTokens` — source tokens currently queued.
- `overflowCount` / `softOverflowCount` — queued turn count.
- `minSummaryBudget`, `minSummaryTurns`, `maxSummaryTurns` (settings).

**Effective threshold in token units:**

```
triggerTokens = max(minSummaryBudget, avgTokensPerQueuedTurn * minSummaryTurns)
```

where `avgTokensPerQueuedTurn = queuedTokens / max(1, queuedTurns)`. When the
token gate binds, the line sits at `minSummaryBudget`; when turns bind, it sits
at the turn-gate's token-equivalent. This equivalent is an **estimate** (avg
tokens per turn), so the marker's tooltip names the binding gate rather than
implying an exact token count.

## Chosen layout

Delete both weak sections. The Status tab opens directly on capacity, now as
**three stacked bars** plus Operations:

```
┌ Verbatim Window ───────────── 22k / 32k ┐
│ ████████████████████░░░░░░░░░░░░░░░░░░░░ │   live vs verbatim budget (fixed scale)
└──────────────────────────────────────────┘
┌ Queued → trigger ──────────── 10k / 14k ┐
│ ██████████████████████████████╎░░░░░░░░░ │   queued fills toward red line
└──────────────────────────────────────────┘   ╎ = fires here
┌ Memory Block ─────────────────── 6k / 10k ┐
│ ████████████████████████░░░░░░░░░░░░░░░░ │   unchanged
└──────────────────────────────────────────┘
```

### Why two bars instead of one

A single rescaled bar would compress the blue "Verbatim Window" fill to make
room for the queued run-up to the red line. The most important, most stable
number (the live window) would shrink and jitter as queued content grows —
backwards. Splitting gives each bar one question and one stable scale:

- **Bar 1 — Verbatim Window.** Live context vs `verbatimTokenBudget`. Fixed
  denominator (`verbatimTokenBudget`), never rescales. Fills, then holds at
  full once saturated. Answers "how full is the live window?"
- **Bar 2 — Trigger gauge.** Starts at zero. Denominator = `triggerTokens`
  (the effective threshold). Queued tokens fill toward the red dotted line at
  100%. Crossing it = summary fires. Answers "when will it trigger?" The
  "fill to the line" metaphor is literal here because the bar is dedicated to
  it.
- **Bar 3 — Memory Block.** Unchanged (`renderMemoryBudget`).

The header already carries mode / idle / snippets / ghosted, so deleting the
Overview grid loses nothing. Follows the visual-language "capacity bar"
convention (`docs/ui-visual-language.md:73`): total beside title, label
inside, gray unused space, and — critically — the trigger point is conveyed by
a labeled line, not color alone.

## Components

### 1. `settings.html` (markup)

- **Remove** the `Overview` section (`260-277`) and the payload rail
  (`285-310`, i.e. the `sc-payload-rail` div and its `sc_payload_*` nodes).
- **Keep** the `Verbatim Window` sub-bar (`311-319`) and `Memory Block`
  sub-bar (`320-328`), promoting them under a single section header. Drop the
  now-orphaned `Context Payload` heading (`279-283`).
- **Add** a new "Queued → trigger" sub-bar between Verbatim and Memory:
  `sc_trigger_budget_total`, `sc_trigger_budget_bar`,
  `sc_trigger_budget_legend`, mirroring the existing sub-bar structure.

### 2. `src/entry/ui.js` (view model + render)

- **`buildContextBudgetViewModel`** gains an optional
  `marker?: { positionTokens: number, label: string }`. When present, the
  denominator becomes `max(normalizedBudget, used, marker.positionTokens)`
  and the returned view carries a normalized `marker.percent`
  (`positionTokens / denominator * 100`) plus `marker.label`. Absent (Memory,
  Verbatim bars) → identical behavior to today. This keeps the change additive
  and the two existing bars untouched.
- **New `renderTriggerGauge(s, store)`** — builds the queued-only view:
  - `queuedTokens` from `getRouteBudgetStats(plan)` /
    `plan.rawPlan.summaryStats.finalTokens` (queued source, not live window).
  - `triggerTokens` computed as above from plan + settings.
  - Single segment `{ label: 'Queued', kind: 'pending', count: queuedTokens }`,
    free space to `triggerTokens`, and a `marker` at `triggerTokens` labeled by
    the binding gate (`"Trigger: tokens"` or `"Trigger: N turns"`).
  - Total label: `queuedTokens / triggerTokens`.
- **`renderVerbatimBudget`** — drop `overageMode: 'pending'`; this bar no
  longer shows the "Queued" overflow segment (that moves to the trigger gauge).
  It becomes a plain live-vs-budget bar. The queued information is not lost —
  it is promoted to its own dedicated bar.
- **`renderBudgetStatus`** calls `renderTriggerGauge` between the verbatim and
  memory renders.
- **`renderOverview`** — remove `sc_status_depth` / `sc_status_index` writes
  (nodes deleted). Header-fed fields (`mode`, `worker`, `snippets`, `ghosted`)
  are rendered elsewhere and unaffected.
- **`renderBudgetView`** — render the marker: when `view.marker` is present,
  append an absolutely-positioned dashed line element into the bar at
  `left: marker.percent%`, with an accessible label / tooltip carrying
  `marker.label`.

### 3. `style.css`

- `.sc-context-bar` gains `position: relative` (safe; segments are flex
  children, marker is absolute overlay).
- New `.sc-context-trigger-marker`: `position: absolute; top/bottom: 0;
  width: 0; border-left: 2px dashed var(--sc-danger);` with a small caption
  chip. Never relies on color alone — carries the "Trigger" text label.

## Data flow

```
buildAutoSummaryRoutePlan(chat, store, settings)
  └─ rawPlan { summaryStats.finalTokens, overflowCount, softOverflowCount, ... }
        │
        ├─ renderVerbatimBudget  → live window vs verbatimTokenBudget   (bar 1)
        ├─ renderTriggerGauge    → queuedTokens vs triggerTokens + line (bar 2)
        └─ renderMemoryBudget    → memory usage vs memoryTokenBudget    (bar 3)
```

`triggerTokens` and the binding-gate label are pure functions of plan +
settings, computed inline in `renderTriggerGauge`; no core changes.

## Error handling

- Reuse the existing per-bar `try/catch` → `clearBudgetView` pattern. A plan
  failure shows "Unavailable" on the trigger gauge without affecting the other
  bars.
- `triggerTokens` guards against zero/NaN: `max(1, ...)` denominator, matching
  `normalizeBudgetCount`. Zero queued turns → `avgTokensPerQueuedTurn` falls
  back so the line still renders at `minSummaryBudget`.
- Cache memory mode (`buildCacheAutoRoutePlan`) uses a different plan shape;
  `renderTriggerGauge` reads the same `getRouteBudgetStats` accessor already
  used by `getVerbatimBudgetPart`, so it degrades to token-only if turn fields
  are absent.

## Testing strategy

`tests/ui-snippets.test.js` already covers `buildContextBudgetViewModel`
(pending/overage/free-space cases). Add:

- **Marker denominator:** `marker.positionTokens` beyond budget extends the
  denominator; segment percents rescale correctly.
- **Marker percent:** line lands at `positionTokens / denominator * 100`.
- **No marker → unchanged:** existing cases still pass (regression guard).
- **Trigger threshold selection:** token gate binds → line at
  `minSummaryBudget`; turn gate binds → line at turns-equivalent, with the
  correct `label`.

`npm test` after implementation (per AGENTS.md). Manual smoke: load a chat
near the trigger in the ST drawer, confirm the queued bar fills toward the
red line and the line label names the binding gate.

## Out of scope (YAGNI)

- Easy-mode Status layout (`renderEasyOverview`) — separate surface, not
  mentioned; unchanged.
- Animating the gauge or live-updating between events — existing `updateUI`
  cadence is sufficient.
- Exposing `minSummaryBudget` / `minSummaryTurns` editing from Status —
  they live in Settings.
```
