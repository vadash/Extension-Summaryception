# Summaryception

Browser-only SillyTavern extension for recursive layered summarization. Summarized messages stay visible in chat but are hidden from model context.

## Language

**Chat Store**:
The per-chat summary store as chat metadata holds it (ADR-0002): the layers, the Ghosting ownership, and the Mutation Epoch, with the repair a persisted store needs on read.
Code: `getChatStore` (src/foundation/chat-store.js)
_Avoid_: chat state, metadata store

**Layer**:
A container of summary snippets at one summarization depth. Layer 0 holds direct narrative summaries; deeper layers hold merged older snippets.
Code: `store.layers` (src/foundation/chat-store.js)
_Avoid_: Tier, level

**Snippet**:
One summary text unit inside a layer, owned by the store and carrying stable message-identifier provenance.
Code: `SummaryceptionSnippet` (src/foundation/chat-store.js)

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
Code: `metadata.kind: 'regenerate'` (src/core/call-profile.js)
_Avoid_: Redo, re-summarize

**Ghosting**:
Hiding summarized turns from model context through the host command while keeping them visible in chat.
Ownership sync derives the desired ghosted ids from Snippet provenance across all layers: it hides desired messages that are not covered yet and releases owned ids no longer referenced.
Code: `syncGhosting` (src/core/ghosting.js)

**Batch**:
The assistant turns one Layer 0 summarizer request covers. Batch ranges count assistant turns only; user messages between them belong to the request's Passage.
Code: `SummaryRoutePlan.batchTurns` (src/core/summarization-routes.js)

**Passage**:
The contiguous chat-index range of raw messages one summarizer request summarizes, including the user messages interleaved with a Batch. A Passage therefore starts one or more indices before its Batch.
Code: `passageStart` / `passageText` (src/core/layer0-run.js)

**Layer 0 Run**:
The lifecycle that turns one or more Passages into committed Layer 0 Snippets. One run owns capture, output validation, the all-or-nothing commit with rollback, and one progress settlement; a single Batch is a one-Passage run. A run whose commit the Foreground Gate defers is blocked, and a run with no Passage to cover is idle.
Code: `runLayer0` (src/core/layer0-run.js)
_Avoid_: batch job, summarization task

**Chat Index**:
A message's position in the chat array. Every range in the extension — Batch, Passage, Verbatim Window — is a chat-index range; stable identity uses Summaryception IDs (`sc_id`), never indices.
Code: `AssistantTurn.index` (src/core/chatutils.js), `sc_id` (src/foundation/message-identity.js)

**Verbatim Window**:
The recent chat range kept in model context without summarization.
Code: `verbatimBudget` / `verbatimStartIdx` (src/core/chat-window-planner.js)

**Output Envelope**:
The `<narrative>…</narrative>` tag pair a Layer 0 or promotion response must wrap its prose in, followed only by the scene-time line. The close tag is the document-level contract: prose after it is rejectable, whatever the prose claims to be.
Code: `validateLayer0Structure` (src/core/layer0-compression.js)
_Avoid_: narrative header, [NARRATIVE] header

**Output Hygiene**:
The chain that turns a raw summarizer response into safe snippet text: cleanup, CN ideograph policy, integrity guard, Refusal Guard, Layer 0 size guard.
Code: `processSummarizerResponse` (src/core/summarizer-output.js)
_Avoid_: output sanitization, response post-processing

**Refusal**:
A summarizer response that declines the summarization task instead of performing it: a bare refusal, a deflection to other help, or a meta-description of the passage, regardless of whether it wears the output structure.
Code: `validateSummarizerOutputIntegrity` (src/core/summarizer-output.js)
_Avoid_: safety rejection, filtered output

**Refusal Guard**:
The deterministic Output Hygiene stage that classifies a Refusal: the Declined Marker, lexical refusal patterns, and the passage-shape signal. A classified Refusal is always a retryable rejection, never stored prose.
Code: `validateSummarizerOutputIntegrity` (src/core/summarizer-output.js)
_Avoid_: moderation, judge call

**Declined Marker**:
The `<declined>reason</declined>` tag a summarizer emits when it will not or cannot summarize, prompted as the sanctioned escape hatch. Code reads it as a confessed Refusal and retries without further analysis.
Code: `validateSummarizerOutputIntegrity` (src/core/summarizer-output.js)
_Avoid_: error marker, fail tag

**Mutation Epoch**:
A counter bumped on every summary store mutation, including Ghosting ownership. Consumers use it to detect stale derived data.
Code: `getSummaryStoreMutationEpoch` (src/foundation/chat-store.js)

**Operation Mode**:
Whether the extension is On or Off. On gates all runtime behavior: automatic cycles, manual runs, prompt injection, and the Continuity Engine. Off is the only state that disables runtime behavior, and turning Off never discards a stored configuration value.
Code: `readOperationMode` (src/foundation/operation-mode.js); stored in `uiMode` / `enabled`
_Avoid_: enabled flag, power state

**Complexity Mode**:
Which panel the settings UI shows: Easy or Advanced. Independent of Operation Mode, so the panel stays visible and editable while the extension is Off, and the selected Complexity Mode is remembered across an Off period.
Code: `configMode` (src/foundation/settings.js); panel flags from `buildEnabledContentModel` (src/entry/ui-view-models.js)
_Avoid_: view mode, UI level

**Effective Settings**:
Runtime settings with the Operation Mode Off resolved to `enabled: false`. Runtime behavior reads these, never raw settings.
Code: `getEffectiveSettings` (src/foundation/settings.js)

**Settings Normalization**:
The read-time pass that repairs a stored settings object to a legal one: memory placement and route sources, the role mask, the retention budgets, the per-route timeouts, the Continuity toggles, and the prompt profiles. It runs on a plain object with no host access and reports whether anything changed, which is what the load path persists on.
Code: `normalizeSettings` (src/foundation/settings-normalizer.js)
_Avoid_: settings repair, config validation

**Memory Mode**:
How raw chat converts into summaries. Either Balanced or Prefix Cache.
Code: `MEMORY_MODES` (src/foundation/constants.js)
_Avoid_: Append Only

**Memory Injection**:
The read model of what ships in the prompt slot: the chronology in compact-anchor form, wrapped in the injection template, with its token cost. The same module builds and measures it, so the preview and the injected prompt are the same string.
Code: `buildInjection` / `measureInjection` (src/core/memory-injection.js)
_Avoid_: summary block, injection preview

**Memory Body**:
The bare, unwrapped memory text handed to the summarizer as context: full anchors, one section per layer, no injection template.
Code: `buildMemoryBody` (src/core/memory-injection.js)
_Avoid_: memory injection, chronology text

**Call Metadata**:
The resolver's input for one summarizer call: the call category plus the verbatim provenance the dispatch constructors build. Consumed once by `resolveCallProfile`; the request path never reads the call category.
Code: `SummarizerCallMetadata` (src/core/call-profile.js)
_Avoid_: Raw metadata

**Call Profile**:
The per-call policy resolved once from settings and the call category at dispatch: prompts, per-route timeouts, health bucket, connection targets, output guard flags, the frozen Easy Summarizer Context cap, the frozen CN ideograph policy, the frozen Layer 0 size band, and the log label, plus the call's verbatim provenance. Request-path modules consume the resolved profile and never read the call category or live settings.
Code: `resolveCallProfile` (src/core/call-profile.js)

**Connection Route**:
One named connection target a summarizer call can run on, with its own source, profile, response length, and timeout settings. The set is the Layer 0 route, the Layer 1+ merge override, the fallback route, and the Auditor's primary and fallback routes.
Code: src/foundation/connection-routes.js
_Avoid_: connection card, provider, backend

**Connection Route Catalogue**:
The one declaration of the Connection Route set: each route's setting keys, the source options it accepts, the provider sources among them, the unset default, the ordered hops each chain runs, and the panel slots its cards appear in. Settings normalization, reset preservation, the Call Profile resolver, and the settings UI derive their route facts from it.
Code: src/foundation/connection-routes.js
_Avoid_: route registry, connection config

**Route Plan**:
The plan for one summarization cycle: the selected route, readiness reason, commit mode, and the batch and partition schedule.
The new summary / deeper merge / fallback trio is the connection routes, not this.
Code: `SummaryRoutePlan` (src/core/summarization-routes.js)

**Narrative Chain**:
The Layer 0 route plus its configured fallback route, used as one failover unit. The Auditor's optional last-resort failover runs the Narrative Chain when both Auditor routes fail.
_Avoid_: narrative models, narrative summarizer chain

**Route Series**:
One Narrative Chain hop's retry series: repeated summarizer attempts over one connection route until an attempt settles terminally or the retry budget runs out, with the repair switch and retry waits between attempts. Returns a Route Series Result — `completed`, `aborted`, `hard-failover`, `failed`, `rejected`, or `guard-stopped` — where `failed{retryable}` and `rejected` always imply the budget ran out.
Code: `session.runSeries` (src/core/request-series.js)
_Avoid_: attempt series, retry loop

**Call Session**:
One summarizer call's live execution context: the Call Profile it was built from, the prompt and repair prompt it sends, the abort signal, and the Notify Adapter it runs with — held for the whole call, across every hop. One session executes each Route Series of the Narrative Chain behind a single interface; route cycling, health buckets, and the Route Plan stay outside it.
Code: `createAttemptSession` (src/core/request-series.js)
_Avoid_: attempt context, request state

**Run Outcome**:
The structured result at every run level — summarizer request, batch commit, promotion drain, auto cycle, Manual Run: `completed`, `partial`, `aborted`, `blocked`, `failed`, or `idle` (no eligible work). A summarizer request's `completed` always carries its Call Profile and means the text already passed every output check under that profile, so callers never re-validate it. `partial` marks a run that stopped short of its intended target; an abort outranks the Foreground Gate and the Gate outranks giving up. Outcomes and notify events carry data only; entry renders all user-facing notices.
Code: `SummarizationRunOutcome` / `ManualRunOutcome` (src/core/run-outcome.js)

**Log Tier**:
The fixed channel policy for console output: Info logs one line per lifecycle milestone, Debug logs state decisions, Trace logs high-frequency internals, and Warn and Error always print. Trace needs trace mode on top of debug mode.
Code: `info` / `debug` / `trace` (src/foundation/logger.js), `debugMode` / `traceMode` (src/foundation/constants.js)
_Avoid_: verbose log, console spam

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
The one protocol every prompt mutation crosses. The gate owns the freeze boundary and decides whether prompt-affecting work runs now, queues until the freeze lifts, or re-runs when it lifts; re-running — an effect that reports it could not finish, a commit that reports itself stale — is the gate's job, never the caller's. Pre-freeze steps (a reroll's checkpoint drop and slot refresh) enter through the gate's `beforeFreeze` hook, not entry sequencing; the renderers render and never self-check the freeze. One instance exists, built at the composition root. The Engine Gate decides when to summarize; the Foreground Gate decides when prompt mutations are safe.
Code: `createForegroundGate` (src/core/foreground-gate.js); `beginGeneration` / `endGeneration` / `commitWhenSafe` / `runEffect` / `promptWorkGate` / `heal` / `isFrozen` / `reset`
_Avoid_: Stop guard, renderer freeze check

**Prompt Profile**:
One preset select plus prompt textarea pair, joined by a `(presetKey, settingKey)` binding. Picking a preset fills the textarea; editing the textarea flips the profile to `custom`.
Code: `bindPromptProfiles` (src/entry/ui-prompts.js); defaults reset via `resetSettingsToDefaults` (src/foundation/settings.js)
_Avoid_: prompt field, preset pair

**View Model**:
A DOM-free plain-data model for one UI region (Context Budget bar, Trigger Gauge). Entry renders View Models; it never computes them.
Code: `buildContextBudgetViewModel` / `buildTriggerGaugeModel` (src/entry/ui-view-models.js)
_Avoid_: presenter, view helper

**Continuity Engine**:
The opt-in subsystem that tracks live roleplay state outside the main generation stream: an Auditor extracts, deterministic code applies, the result injects in-chat.
_Avoid_: sync mode, state engine

**Auditor**:
The background extraction call that reads a finished turn and emits semantic event flags for the Continuity State. It runs one settled pass over its Connection Route — no second connection, no LLM repair call — and it never does arithmetic and never writes counters.
_Avoid_: secondary model, extractor, auditor LLM

**Continuity Audit**:
The lifecycle that turns un-audited Exchanges into a committed Continuity Checkpoint: the gate, the single Auditor call, validation, the flags rulebook, the checkpoint write, and the persist that revalidates chat identity around the host save. It reads the chat, the Chat Store, and the effective settings through its arguments and its injected dependencies, and returns a Run Outcome at the summarizer-request level.
Code: `createContinuityAuditor` / `isAuditorTriggerMessage` (src/core/continuity-audit.js)
_Avoid_: audit runner, continuity job

**Parse Recovery**:
The deterministic waterfall that turns a malformed Auditor reply into a parseable Continuity State JSON before classification. Tiers run cheapest-first; structural completion outranks block extraction because completion preserves the whole draft. The tier that rescued the reply is reported to the audit log; a reply no tier rescues is a failed draft the Catch-up Window re-covers. Never applied to stored checkpoints, which are valid by construction.
Code: `recoverContinuityJson` (src/core/parse-recovery.js)
_Avoid_: json repair, output sanitization

**Continuity State**:
The bond, agenda, GM-note, and physics JSON the Continuity Engine maintains for the chat. It exists to steer the main model: the Continuity Block is its only output, and the User never reads the state outside diagnostics.
_Avoid_: roleplay state, sync state

**Continuity Checkpoint**:
The per-message copy of the Continuity State an audit commits into the audited reply's message extra. The newest assistant message carrying a checkpoint is the live Continuity State; a newer audit overwrites the payload in place. A swipe or regenerate that replaces the chat's last message drops that reply's checkpoint at generation start, so the rerolled answer is unaudited until the next audit re-covers it; a regenerate over a trailing user turn replaces nothing and keeps it.
Code: `attachCheckpoint` / `discardCheckpoint` / `removeCheckpoints` / `findLiveCheckpoint` (src/core/continuity-checkpoint.js)
_Avoid_: snapshot, state backup

**Continuity Mark**:
The indicator the extension adds to the chat view of every assistant reply whose message extra carries a Continuity Checkpoint payload. The reply holding the live checkpoint carries a second, distinct mark.
Code: `updateContinuityMarker` (src/entry/continuity-marker.js), `deriveContinuityMarks` (src/core/continuity-coverage.js)
_Avoid_: continuity badge, audit checkmark

**Live Mark**:
The second, distinct Continuity Mark on the reply holding the live Continuity Checkpoint, the newest payload message. The Live Mark implies the base Continuity Mark.
Code: `deriveContinuityMarks` (src/core/continuity-coverage.js)
_Avoid_: current checkpoint badge, anchor dot

**Continuity Coverage**:
The one read model of the chat for the Continuity Engine: the live Continuity Checkpoint, the un-audited replies after it, the Catch-up Window, the Turn Count, the staleness verdict, and the Continuity Block's prompt placement. The Auditor's lifecycle and the block injection both consume it, so coverage derives in one place instead of twice.
Code: `deriveContinuityCoverage` (src/core/continuity-coverage.js)
_Avoid_: continuity snapshot, sync read model

**Reroll Tail**:
The chat's last message while a swipe or regenerate generation is replacing it. The host excludes that message from the prompt chat, so the Continuity Block's placement counts the prompt view, which drops the tail; the stale marker keeps reading the chat view.
Code: `isRerollTail` / `beginRerollTail` (src/core/continuity-coverage.js)
_Avoid_: swiped message, pending reply

**Continuity Block**:
The compact in-chat prompt injection rendered from the Continuity State.
_Avoid_: state block, active continuity

**Exchange**:
One user message plus its completed assistant reply. The unit the Auditor and the Catch-up Window count.
_Avoid_: message pair, turn

**Catch-up Window**:
The most recent four Exchanges a single combined Auditor call covers after missed turns. Older Exchanges stay unknown to the Continuity State; the window only bounds coverage, never `turn_count`.
_Avoid_: catch-up cap, recovery span

**Turn Count**:
The total number of Exchanges in the chat, re-derived by code from the chat at every audit. Coverage never feeds it: the Catch-up Window bounds what gets audited and the live Continuity Checkpoint anchors where coverage resumes, never the count. Ghosting never removes an Exchange from it: a reply hidden from the prompt is still an Exchange (ADR-0028).
Code: `turn_count` (src/core/continuity-state.js), `deriveTurnCount` (src/core/continuity-state.js)
_Avoid_: audited turns, covered turns

**Auditor Flags**:
The five per-pair booleans one Auditor reply carries (positive_interaction, slight, insult, betrayal, apology). All bond, sparks, grudge, and gate numbers are derived from them by code.
Code: `applyPairFlags` (src/core/continuity-state.js)
_Avoid_: sentiment scores, bond math

**Conversion**:
The modulo bookkeeping code applies to bond pairs: at every Turn Count multiple of 5 accumulated Sparks convert into Bond (Grudge dulls the gain to zero); at every multiple of 3 Grudge decays. A Conversion evaluates only on an audit whose Turn Count lands on the multiple; multiples skipped inside one Catch-up Window span do not replay.
Code: `applyPairFlags` (src/core/continuity-state.js)
_Avoid_: spark spend, bond payout

**Canonical-name Registry**:
The naming rule for Continuity State keys: copy each character's name exactly as the character card spells it (Latin spelling, never inflected prose forms); the player is always `User`, pair keys are `Name↔User`.
Code: `USER_PAIR_PATTERN` (src/core/continuity-state.js); rule text in the Auditor default prompt
_Avoid_: name normalization

**Extension Chat Data**:
Everything Summaryception writes into a chat: the Chat Store in chat metadata, the stable message identifiers, the message token cache, and the Continuity Checkpoints. Each shape is removed by the module that writes it; nothing identifies it by a key-name convention.
Code: `clearChatData` (src/core/chat-data.js)
_Avoid_: extension extras, sc_ keys

**Clear**:
The user-confirmed destructive workflow that removes all Extension Chat Data from a chat and unhides its messages, leaving the chat as if the extension had never run.
Code: `clearChatData` (src/core/chat-data.js); `#sc_clear_memory`, `/sc-clear`
_Avoid_: wipe, purge
