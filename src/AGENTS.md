# Source Rules

## Architecture

- Runtime calls to SillyTavern globals pass through the foundation host facade (ADR-0001).
- Required host APIs target the current stable SillyTavern release.
- Optional host integrations may return a safe fallback.
- Easy and Advanced views edit the same settings.
- Effective settings disable runtime behavior only when the extension is Off.
- Per-chat summaries live with chat metadata and survive extension reloads (ADR-0002).
- Global configuration lives in extension settings.
- Any summary layer or snippet mutation must bump the store mutation epoch (ADR-0003).
- Consumers cache derived data by mutation epoch.

## Memory

- Balanced and Prefix Cache are the only memory modes. Stored legacy Append Only normalizes to Prefix Cache on load.
- Layer 0 converts turns outside the verbatim window into narrative and a rolling state snapshot.
- State is a bounded snapshot. Only the newest state reaches the prompt.
- Deeper layers merge older snippets after a layer exceeds its limit.
- A promotion overflow drain stops after a fixed number of consecutive promotion failures. The failure counter resets on success.
- Promotion uses the final state snapshot in the promoted span.
- State compaction is deterministic and runs once per assembly.
- State category budgets apply independently. Date and time remain unchanged.
- Generated output outside its layer bounds triggers section-aware repair.
- Repair retries only the failed section.
- Narrative dates omit years, ISO syntax, and clock lead-ins.
- Re-derive the state weekday from the ISO date in UTC.
- Stable message identifiers own snippet provenance and hiding.
- Resolve identifiers to current chat indexes only for host commands and planning.
- Do not infer ownership from old array positions.
- Hide summarized turns through the host command.
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
- Ignore both dry-run forms before updating comparison state.
- Report one contiguous-prefix verdict for each real request.
- A broken-prefix report includes the complete first changed block.
- Treat only an explicit system flag as a system message.
- Replace every placeholder occurrence. Custom user templates may repeat a placeholder.
- Start a substituted schema block on its own line. Never concatenate it to instruction text.
- Keep structural header patterns in the shared header module. Do not define local copies.
- Section extraction rules differ by caller. One rule requires both headers; another requires only the state header.
- Keep call-label and token-range formatting in one module. Prompt logs and usage lines share them.
- Prompt preset keys and setting keys pair in one shared table. Add a new prompt field there only; both consumers derive from it.

## Connection

- Separate routes handle new summaries, deeper merges, and retryable fallback.
- Adapters cover the active host API and saved connection profiles.
- Profile requests disable host preset and instruct injection.
- Retry with exponential backoff.
- Hard network errors skip remaining primary retries and start fallback.
- Configure timeouts independently for each route.
- Retry attempts use a shorter timeout than the first attempt.
- Map all adapter failures through one shared error wrapper. Do not rebuild status or retryable per provider.
- Build the request series context once at entry and thread it down. Per-route fallback flags and retry budgets stay per-route.

## Run Control

- One engine gate owns all automatic work.
- Route every automatic trigger through the queue and engine gate.
- Put automatic run guards in the gate.
- Stop persists a pause latch and lets the queue settle.
- Resume clears the latch and starts one cycle.
- Manual engine runs ignore the pause latch and enabled state.
- The stale-cache advice toast starts the same manual run as the Force Summarize button.
- Manual runs build their route plan inside the engine; callers pass run options only.
- UI handlers still block manual actions when the extension is disabled.
- Manual run callbacks and the abort signal pass as an explicit argument. Never carry them on the task object.
- A manual run needs a numeric target boundary. Reject the run when the route plan omits it.
- Automatic work must not mutate the prompt during generation.
- The app-ready signal fires before the chat and its metadata load. Wait for the chat-changed signal to read chat state.
- Loaded-chat reconciliation runs on every chat-changed signal: normalize keys, update injection, re-apply ghosting.
- Recover stale prompt freezes at the start of an automatic cycle.

## UI

- Use jQuery for settings queries, delegated events, and rendering.
- Data attributes declare setting bindings and slider value pairs.
- Bind each control through one owner. Duplicate bindings cause double saves and double refreshes.
- Derive panel visibility in the render pass, not in change handlers.
- Compute route plans and metric counts once per refresh. Pass them to renderers as parameters.
- Sliders save on input. Text and numeric controls save on change or blur.
- Keep slider min, max, and step equal to the settings clamp bounds.
- Operating mode gates runtime behavior. Complexity mode selects the visible panel.
- Bind plain settings through the data-attribute engine. Hand-bind only controls with special semantics.
- One layer-label helper serves status panel, snippet browser, and slash commands.
- Keep the selected panel editable while the extension is Off.
- Show the Off banner beside the selected panel.
- Open the Status tab on every startup.
- A state category toggle needs both write handling and render synchronization.
- Feature modules return structured outcomes. Entry modules format user notices.
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
- Prefix Cache keeps a larger recent range and queues older chat for atomic flushes.
- Automatic summarization waits until the configured Recent + Queued raw-chat threshold is full.
- Memory below steady-state use silently truncates injected memory.
- Recall depends on prompt quality, model behavior, and chat depth.
- Cache TTL applies to Prefix Cache mode only.
- Stale-cache advice needs a queue at or above Min Turns per Batch and a readable last-message time.
- Retention clamp invariants live in one read-time normalizer. UI sliders delegate to it; keep no second enforcement.
