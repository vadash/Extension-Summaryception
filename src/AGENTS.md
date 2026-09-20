# Source Rules

## Architecture

- Runtime calls to SillyTavern globals pass through the foundation host facade (ADR-0001).
- Required host APIs target the current stable SillyTavern release.
- Optional host integrations may return a safe fallback.
- Easy and Advanced views edit the same settings.
- Effective settings disable runtime behavior only when the extension is Off.
- Use raw settings only for persistence and UI forms.
- Per-chat summaries live with chat metadata; global configuration in extension settings (ADR-0002).
- Any summary layer or snippet mutation must bump the store mutation epoch; consumers cache derived data keyed by it (ADR-0003).
- Snippet mutations cross the Snippet Commit seam (src/core/snippet-commit.js): mutate, Ghosting ownership, epoch bump, persist, gated injection refresh. Do not hand-roll the sequence.
- Implicit any is allowed. Annotate parameters that hold structured objects so the type gate checks property reads.

## Memory

- Balanced and Prefix Cache are the only memory modes. Stored legacy Append Only normalizes to Prefix Cache on load.
- Layer 0 converts turns outside the verbatim window into a `[NARRATIVE]` prose section plus a trailing `current_date_time` scene-time line.
- A promotion overflow drain stops after a fixed number of consecutive promotion failures. The failure counter resets on success.
- One drain driver owns Promotion overflow clearing; commit applies one merge and never re-drains.
- The drain asks the Foreground Gate before and after every attempt.
- Auto cycles tolerate one consecutive promotion failure; manual runs tolerate three.
- Promotion carries the last known scene time from the promoted span.
- Generated output outside its layer bounds triggers section-aware repair.
- Repair retries only the failed section.
- Narrative dates omit years, ISO syntax, and clock lead-ins.
- Re-derive the current_date_time weekday from the ISO date in UTC.
- Stable message identifiers own snippet provenance and hiding.
- Resolve identifiers to current chat indexes only for host commands and planning.
- Do not infer ownership from old array positions.
- Injection text and its token cost come from one Memory Injection read model (src/core/memory-injection.js). Build once and measure the built injection; never re-derive the text to count it.
- Ghosting receives the notify adapter through its options. The notify adapter enters core only through explicit arguments; entry wiring creates and distributes the instance.
- Unhide only store-owned messages.
- Clear unhides the chat and removes extension-owned chat data.
- Standard placements use the host extension prompt.
- Macro-only placement exposes assembled memory for custom prompt layouts.
- Refresh state-derived snippet metadata after any manual Layer 0 snippet edit.
- Snippet regeneration target resolution is one shared resolver for UI and runner. Keep its status set stable; UI toasts map each status.

## Prompt

- Prompt sections have a fixed order: input, schema, task rules, critical rules, trigger.
- The bare imperative trigger is the final prompt line.
- Insert dynamic budget and repair blocks above the trigger.
- Budget hints use countable units such as sentences and lines.
- State schema content follows enabled state categories.
- Keep token limits out of state category definitions.
- Strip configured output patterns before parsing.
- Dry runs may mark the payload or a separate argument.
- A broken-prefix report includes the complete first changed block.
- Keep structural header patterns in the shared header module. Do not define local copies.

## Connection

- Separate routes handle new summaries, deeper merges, and retryable fallback.
- Adapters cover the active host API and saved connection profiles.
- Profile requests disable host preset and instruct injection.
- Retry with exponential backoff.
- Hard network errors skip remaining primary retries and start fallback.
- Configure timeouts independently for each route.
- Every attempt of a route series uses the full configured timeout; retries never run shorter.
- Timeouts on uncancellable adapters are non-retryable; adapters declare `cancellable`.
- Map all adapter failures through one shared error wrapper. Do not rebuild status or retryable per provider.
- Build the request series context once at entry and thread it down. Per-route fallback flags and retry budgets stay per-route.
- Attempt-path modules never read settings; the resolved Call Profile is the call's frozen policy (ADR-0023).

## Run Control

- One engine gate owns all automatic work.
- Route every automatic trigger through the queue and engine gate.
- Put automatic run guards in the gate.
- Stop persists a pause latch behind the engine's pauseAutoSummarization seam and lets the queue settle.
- Resume clears the latch behind the engine's resumeAutoSummarization seam and starts one cycle; entry maps returned statuses to notices.
- Manual engine runs ignore the pause latch and enabled state.
- The stale-cache advice toast starts the same manual run as the Force Summarize button.
- Manual runs build their route plan inside the engine; callers pass run options only.
- Manual run previews come from the engine describe call; entry never builds route plans.
- UI handlers still block manual actions when the extension is disabled.
- Manual run callbacks and the abort signal pass as an explicit argument. Never carry them on the task object.
- A manual run needs a numeric target boundary. Reject the run when the route plan omits it.
- Automatic work must not mutate the prompt during generation.
- Every prompt mutation crosses the Foreground Gate; renderers render, they never self-check the freeze.
- Pre-freeze prompt steps cross beginForegroundGeneration's beforeFreeze hook; entry sequencing enforces no ordering.
- Loaded-chat reconciliation runs at the app-ready signal: normalize keys, update injection, re-apply ghosting.
- Chat-changed re-runs reconciliation when the store still holds the empty default.
- Recover stale prompt freezes at the start of an automatic cycle.

## UI

- Use jQuery for settings queries, delegated events, and rendering.
- Data attributes declare setting bindings and slider value pairs.
- Bind each control through one owner. Duplicate bindings cause double saves and double refreshes.
- Derive panel visibility in the render pass, not in change handlers.
- Compute route plans and metric counts once per refresh. Pass them to renderers as parameters.
- Status panels read the auto work read model; entry renders scalars.
- Sliders save on input. Text and numeric controls save on change or blur.
- Operating mode gates runtime behavior. Complexity mode selects the visible panel.
- Mode transitions cross the Operation Mode module (src/foundation/operation-mode.js). Nothing writes uiMode, configMode, or enabled by hand.
- Bind plain settings through the data-attribute engine. Hand-bind only controls with special semantics.
- Prompt Profiles bind through src/entry/ui-prompts.js; defaults reset lives in foundation/state.js resetSettingsToDefaults.
- One layer-label helper serves status panel, snippet browser, and slash commands.
- Keep the selected panel editable while the extension is Off.
- Show the Off banner beside the selected panel.
- Open the Status tab on every startup.
- A state category toggle needs both write handling and render synchronization.
- Feature modules return structured outcomes and emit notify events; entry owns all notice text, display duration, and update cadence (ADR-0019).
- Bind toast action buttons with delegated document clicks. Toast content does not exist at bind time.
- Keep user-facing text out of feature modules.
- Keep the first view focused on status, activity, and required action.
- Use compact sections and responsive grids. Collapse near 520 pixels.
- Keep navigation sticky, opaque, keyboard accessible, and text-labelled.
- Inherit host theme variables and use one restrained accent.
- Keep status and actions visible without requiring a diagnostics view.
- Import numeric clamp helpers from the foundation module. Do not reimplement clamp logic locally.
- Format token counts with the shared compact formatter. Surfaces must agree on rounding.
- Avoid horizontal scrolling, clipped labels, and missing focus states.
- Settings reset restores every default except one explicit preserve set. Extend that set, never a hand-copied field list.

## Tuning

- Do not optimize raw cost alone. Smaller context can reduce roleplay quality.
- Automatic summarization waits until the configured Recent + Queued raw-chat threshold is full.
- Prefix Cache trades some verbatim range for a much larger queued span and atomic flushes.
- Recall depends on prompt quality, model behavior, and chat depth.
- Context preview numbers come from one core estimator.
- Memory below steady-state use silently truncates injected memory.
- Cache TTL applies to Prefix Cache mode only.
- Stale-cache advice needs a queue at or above Min Turns per Batch, filling at least a quarter of the queued-token budget, and a readable last-message time.
- Numeric bounds declare once in SLIDER_LIMITS (src/foundation/constants.js); the read-time normalizer is the only enforcement. tests/settings-bounds.test.js pins settings.html attributes to the map, and the UI slider snap is an affordance fed by the same map, not a second enforcement.
