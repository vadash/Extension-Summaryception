# Conservative Summaryception UI/UX Pass

## Goal

Reduce settings drawer bloat without changing summarization behavior, metadata shape, settings keys, connection behavior, or stable control IDs.

## Scope

- Keep five top-level tabs: Status, Memory, Settings, Prompts, and Tools.
- Merge Layer 0 and Layer 1+ prompt editors into one Prompts tab with an internal Layer 0 / Layer 1+ segment switch.
- Keep Settings always visible with compact responsive grids rather than accordions.
- Preserve all existing prompt, connection, memory mode, and slider control IDs.
- Replace slider value spans with same-ID editable chips so exact values can be typed.
- Place Apply Regex Scripts with the summarization settings rather than diagnostics.
- Reset leaves Debug Mode enabled so follow-up integration checks have logs available.
- Show the Injection Preview token count in the Memory tab header.
- Split Settings into clearer sections for Memory Mode, Input Processing, Budgets, Batching, and Layering.
- Keep connection source selectors in the left column for both Layer 0 and Layer 1+ merge connections.

## Slider Behavior

- Range sliders save live on `input`.
- Numeric value chips save on `change` or blur.
- Typed values clamp to the paired range input's min/max and snap to its step before saving.
- 1000-step token sliders display compact `k` values while accepting full values like `12000` and compact values like `12k`.
- Minimum and maximum summary turns keep their existing mutual constraints.

## Non-Goals

- No settings schema changes.
- No persisted prompt segment state.
- No build tooling, bundler, or dependency changes.
- No changes to summarization, injection, cache, promotion, or connection runtime behavior.
