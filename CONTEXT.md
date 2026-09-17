# Summaryception

Browser-only SillyTavern extension for recursive layered summarization. Summarized messages stay visible in chat but are hidden from model context.

## Language

**Layer**:
A container of summary snippets at one summarization depth. Layer 0 holds narratives and the state snapshot; deeper layers hold merged older snippets.
Code: `store.layers` (src/foundation/state.js)
_Avoid_: Tier, level

**Snippet**:
One summary text unit inside a layer, owned by the store and carrying stable message-identifier provenance.
Code: `SummaryceptionSnippet` (src/foundation/state.js)

**Snippet Commit**:
The single point every Snippet mutation passes through: apply the change, sync Ghosting ownership, bump the Mutation Epoch, persist. Any failing step restores the pre-commit store state.
Code: `commitSnippetMutation` (src/core/snippet-commit.js)
_Avoid_: Snippet save

**Promotion**:
Moving merged older snippets from a layer into the next deeper layer.
Code: `attemptPromotion` (src/core/summarizer-promotion.js)

**Promotion Plan**:
The read-model computed before each drain iteration: per-layer quotas, effective merge count, first over-limit candidate, and the Layer 0 retention-floor verdict.
Code: `buildPromotionPlan` (src/core/promotion-planner.js)

**Promotion Candidate**:
One proposed merged snippet awaiting validation; at most one section-aware repair pass.
Code: `generateValidatedPromotion` (src/core/promotion-candidate.js)

**Promotion Drain**:
The single loop that clears promotion overflow — repeated single-layer Promotions until layers fit, the retention floor refuses the candidate, the Foreground Gate blocks, or consecutive failures reach the budget. Returns a Run Outcome status and the attempt count.
Code: `drainPromotionOverflow` (src/core/summarizer-promotion.js)

**Regeneration**:
Rebuilding one Layer 0 Snippet from its source turns through a new summarizer request.
Code: `metadata.kind: 'regenerate'` (src/core/summarizer-usage.js)
_Avoid_: Redo, re-summarize

**Ghosting**:
Hiding summarized turns from model context through the host command while keeping them visible in chat.
Ownership sync derives the desired ghosted ids from Snippet provenance across all layers: it hides desired messages that are not covered yet and releases owned ids no longer referenced.
Code: `syncGhosting` (src/core/ghosting.js)

**Batch**:
The assistant turns one Layer 0 summarizer request covers. Batch ranges count assistant turns only; user messages between them belong to the request's Passage.
Code: `summarizeBatchFromTurns` (src/core/summarizer-batch.js)

**Passage**:
The contiguous chat-index range of raw messages one summarizer request summarizes, including the user messages interleaved with a Batch. A Passage therefore starts one or more indices before its Batch.
Code: `passageStart` / `passageText` (src/core/summarizer-batch.js)

**Chat Index**:
A message's position in the chat array. Every range in the extension — Batch, Passage, Verbatim Window — is a chat-index range; stable identity uses Summaryception IDs (`sc_id`), never indices.
Code: `AssistantTurn.index` (src/core/chatutils.js), `sc_id` (src/foundation/message-identity.js)

**Verbatim Window**:
The recent chat range kept in model context without summarization.
Code: `verbatimBudget` / `verbatimStartIdx` (src/core/chat-window-planner.js)

**State Snapshot**:
A bounded rolling snapshot of roleplay state. Only the newest snapshot reaches the prompt.
Code: `compactStateSnapshotText` (src/core/summarizer-state.js)

**Output Hygiene**:
The chain that turns a raw summarizer response into safe snippet text: cleanup, CN ideograph policy, integrity guard, Layer 0 size guard.
Code: `processSummarizerResponse` (src/core/summarizer-output.js)
_Avoid_: output sanitization, response post-processing

**Mutation Epoch**:
A counter bumped on every summary store mutation, including Ghosting ownership. Consumers use it to detect stale derived data.
Code: `getSummaryStoreMutationEpoch` (src/foundation/state.js)

**Effective Settings**:
Runtime settings with the extension-Off mode resolved to `enabled: false`. Runtime behavior reads these, never raw settings.
Code: `getEffectiveSettings` (src/foundation/state.js)

**Memory Mode**:
How raw chat converts into summaries. Either Balanced or Prefix Cache.
Code: `MEMORY_MODES` (src/foundation/constants.js)
_Avoid_: Append Only

**Route Plan**:
The plan for one summarization cycle: the selected route, readiness reason, commit mode, and the batch and partition schedule.
The new summary / deeper merge / fallback trio is the connection routes, not this.
Code: `SummaryRoutePlan` (src/core/summarization-routes.js)

**Run Outcome**:
The structured result at every run level — summarizer request, batch commit, promotion drain, auto cycle: `completed`, `aborted`, `blocked`, `failed`, or `idle` (no eligible work). Outcomes and notify events carry data only; entry renders all user-facing notices.
Code: `SummarizationRunOutcome` (src/core/run-outcome.js)

**Notify Adapter**:
The display-side receiver of core notify events. Entry owns the instance and all notice text; core receives it only by argument.
Code: `NotifyAdapter` (src/core/notify.js)
_Avoid_: Notify registry

**Refresh Port**:
The one interface that syncs visible UI and prompt injection after state changes. Entry registers the effects once at the composition root; callers pick a scope: ui, full, or preview.
Code: `initRefreshPort` (src/foundation/refresh.js)
_Avoid_: UI refresher, refresh registry

**Engine Gate**:
The single gate that owns all automatic summarization work and its guards.
Code: module src/core/summarizer-engine.js

**Work Gate**:
The one gate that owns foreground summarization work: manual runs and snippet regenerations open a lease and release it when their work settles. Stop aborts every live request, sets the stop intent on all live leases, and drops queued automatic work; it never releases leases itself.
Code: `beginRun`, `stop`, `isBusy` (src/core/summarizer-queue.js)
_Avoid_: summarizing flag, busy flag

**Summarizer Queue**:
The coalescing worker that owns automatic summarization work: request, drain, and phase. One instance exists; automatic cycles start through request, foreground runs lease the queue through the Work Gate, and stop is the one way to end live work.
Code: `SummarizerQueue` (src/core/summarizer-queue.js)
_Avoid_: job runner, work queue

**Pause Latch**:
The persisted `autoPaused` flag. Stop and Resume transitions cross the engine seam: core aborts, latches, and kicks the resume cycle; entry maps returned statuses to notices. Automatic cycles respect it; manual runs do not.
Code: `autoPaused` (src/foundation/constants.js)

**Manual Run**:
A user-triggered summarization run through the Engine Gate, driven by one strategy: Force Summarize or Slop Breaker. Manual runs ignore the Pause Latch and enabled state.
Code: `runManual` (src/core/summarizer-engine.js)

**Foreground Gate**:
The single ask that decides whether prompt-affecting work may run. Open only when no foreground freeze, no stale recovery, and no queued commits or prompt effects. The Engine Gate decides when to summarize; the Foreground Gate decides when prompt mutations are safe.
Code: `promptWorkGate`, `initCommitCallbacks` (src/core/summarizer-commit.js)
_Avoid_: Stop guard

**Prompt Profile**:
One preset select plus prompt textarea pair, joined by a `(presetKey, settingKey)` binding. Picking a preset fills the textarea; editing the textarea flips the profile to `custom`.
Code: `bindPromptProfiles` (src/entry/ui-prompts.js); defaults reset via `resetSettingsToDefaults` (src/foundation/state.js)
_Avoid_: prompt field, preset pair

**View Model**:
A DOM-free plain-data model for one UI region (Context Budget bar, Trigger Gauge). Entry renders View Models; it never computes them.
Code: `buildContextBudgetViewModel` / `buildTriggerGaugeModel` (src/entry/ui-view-models.js)
_Avoid_: presenter, view helper
