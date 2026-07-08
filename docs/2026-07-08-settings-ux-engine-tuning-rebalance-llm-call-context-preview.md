# Settings UX Overhaul: Engine Tuning + LLM Call Context Preview

## Goals
1. Make Engine Tuning sliders understandable (ELI5 labels/hints)
2. Replace hardcoded MAX_L0_SOURCE_TOKENS (8000) with a user-facing slider
3. Add a read-only "LLM Call Context" preview that reacts live to slider changes
4. Link minSummaryBudget ceiling to the new cap slider
5. Color-code resulting context sizes (green/yellow/orange/red)

## Changes

### 1. Replace hardcoded ceiling with setting (`partition-planner.js`)

- Remove `export const MAX_L0_SOURCE_TOKENS = 8000;`
- Add setting `maxL0SourceTokens` to `constants.js` defaultSettings: `maxL0SourceTokens: 8000`
- `getTargetSourceTokens()` now uses `min(maxL0SourceTokens, ...)` instead of hardcoded 8000
- `buildLayer0Partitions()` uses `settings.maxL0SourceTokens` for `maxTokens`
- `MIN_L0_SOURCE_TOKENS` stays at 2000 (internal floor, not user-facing)

### 2. New slider in settings.html

Add to "What goes into the LLM" group (new group, see #4):
- **Label:** "Max Source per Call"
- **Hint:** "Hard ceiling for raw chat sent to the LLM in a single call. Lower if your model has a small context window."
- **Slider:** `min="2000" max="16000" step="1000"`, default 8000
- **Setting key:** `maxL0SourceTokens`

### 3. Cap minSummaryBudget at maxL0SourceTokens

In `ui-events.js` `enforceRetentionConstraints()`:
- When `maxL0SourceTokens` changes, clamp `minSummaryBudget` to be <= new cap
- When `minSummaryBudget` changes, ensure it doesn't exceed `maxL0SourceTokens`
- Update the `sc_min_summary_budget` slider's `max` attribute dynamically to equal `maxL0SourceTokens`

### 4. Rename + regroup all Engine Tuning sliders

**Group 1: "What Goes into the LLM"**
| Setting | New Label | New Hint |
|---|---|---|
| `maxL0SourceTokens` | Max Source per Call | Hard ceiling for raw chat sent to the LLM in a single call. Lower if your model has a small context window. |
| `minSummaryBudget` | Batch Trigger Size | How much chat to accumulate before compressing it. Larger batches = fewer LLM calls. |
| `maxSummaryTurns` | Max Turns per Batch | Maximum assistant replies in one batch. Prevents batches from getting too large. |
| `layer0SummaryTokenTarget` | Summary Target Size | Target length of each new summary. Shorter = more compression, longer = more detail preserved. |

**Group 2: "When to Summarize"**
| Setting | New Label | New Hint |
|---|---|---|
| `minSummaryTurns` | Min Turns per Batch | Minimum assistant replies before a batch can compress. Prevents summarizing too eagerly. |

**Group 3: "Memory Structure"**
| Setting | New Label | New Hint |
|---|---|---|
| `verbatimTokenBudget` | Live Chat Window | How many recent messages stay unsummarized before they're compressed into memory. |
| `memoryTokenBudget` | Memory Size Limit | Maximum size of all summaries injected into your chat. Larger = more context history. |
| `snippetsPerLayer` | Max Memories per Layer | How many summaries each layer holds before older ones merge into deeper memory. |
| `snippetsPerPromotion` | Memories per Merge | How many summaries combine at once when merging into deeper layers. |

### 5. LLM Call Context preview panel

New sub-section at bottom of Engine Tuning, below all groups:

**HTML structure:**
```html
<div class="sc-section">
  <div class="sc-section-header">
    <h4 class="sc-section-title">
      <span class="fa-solid fa-microchip"></span>
      LLM Call Context
    </h4>
  </div>
  <div class="sc-llm-context-grid">
    <div class="sc-llm-context-row">
      <span class="sc-llm-context-label">L0 Call</span>
      <span class="sc-llm-context-value" id="sc_llm_context_l0">~10k tokens</span>
    </div>
    <div class="sc-llm-context-row">
      <span class="sc-llm-context-label">L1+ Merge Call</span>
      <span class="sc-llm-context-value" id="sc_llm_context_l1">~2k tokens</span>
    </div>
  </div>
  <small class="sc-hint">Estimated max input tokens per LLM call. Overhead is fixed estimate (L0: ~2k, L1+: ~1k).</small>
</div>
```

**Computation logic (in `ui.js`, new function `syncLLMContextPreview()`):**
- L0: `min(maxL0SourceTokens, minSummaryBudget) + 2000` overhead
- L1+: `snippetsPerPromotion * layer0SummaryTokenTarget + 1000` overhead
- Color thresholds:
  - < 24k: green (`.sc-ctx-safe`)
  - 24k-32k: yellow (`.sc-ctx-warn`)
  - 32k-48k: orange (`.sc-ctx-caution`)
  - \> 48k: red (`.sc-ctx-danger`)

**Live update:** Call `syncLLMContextPreview()` from `bindSliderHandlers()` `afterSave` callback (already calls `syncPayloadSchematic`).

### 6. CSS additions (`style.css`)

Add color classes for context preview:
```css
.sc-llm-context-value.sc-ctx-safe { color: var(--success-color, #2ecc71); }
.sc-llm-context-value.sc-ctx-warn { color: var(--warning-color, #f1c40f); }
.sc-llm-context-value.sc-ctx-caution { color: var(--caution-color, #e67e22); }
.sc-llm-context-value.sc-ctx-danger { color: var(--danger-color, #e74c3c); }
.sc-llm-context-grid { display: flex; flex-direction: column; gap: 6px; }
.sc-llm-context-row { display: flex; justify-content: space-between; align-items: center; }
```

## Files Modified
- `src/foundation/constants.js` -- add `maxL0SourceTokens: 8000` default
- `src/core/partition-planner.js` -- use setting instead of hardcoded 8000
- `settings.html` -- rename labels/hints, regroup, add new slider + preview panel
- `src/entry/ui.js` -- add `syncLLMContextPreview()` function
- `src/entry/ui-events.js` -- add minSummaryBudget cap logic, wire preview to slider afterSave
- `style.css` -- add context color classes

## Verification
- Run `npm test` to ensure no regressions
- Run `npm run lint` for style checks
- Manual: move sliders in Engine Tuning, verify preview updates live and colors change at thresholds
- Verify minSummaryBudget slider max drops when maxL0SourceTokens is lowered below it
