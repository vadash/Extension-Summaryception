import { classifyContinuity, applyPairFlags, deriveTurnCount } from '../foundation/continuity.js';
import { getChat, getGroupId, getName1 } from '../foundation/context.js';
import { debug, warn } from '../foundation/logger.js';
import { getMessageIndexByScId } from '../foundation/message-identity.js';
import { listNonEmptyLayers } from '../foundation/constants.js';
import { getChatStore, getEffectiveSettings, saveChatStore } from '../foundation/state.js';
import {
    buildRepairDiagnostics,
    buildStructuralRepairFeedback,
    formatRepairDiagnostics,
} from './repair-diagnostics.js';
import { silentAdapter } from './notify.js';
import { callSummarizer } from './summarizer-request.js';
import { isCancellableConnection } from './connectionutil.js';

/**
 * Catch-up Window: one combined Auditor call covers at most this many
 * Exchanges (most recent first); it bounds coverage, never turn_count.
 */
const AUDIT_WINDOW_EXCHANGES = 4;

/** In-flight audit controller; the runner owns cancellation when the active connection is uncancellable. @type {AbortController | null} */
let activeAudit = null;

/**
 * Abort the in-flight audit. A quiet generation start never invalidates chat
 * state, so it is ignored here; the entry layer's dry-run and own-request
 * guards run before this.
 * @param {string} reason - Generation start type or 'chat_changed'.
 * @returns {void}
 */
export function abortActiveAuditorRun(reason) {
    if (reason === 'quiet') {
        return;
    }
    if (activeAudit) {
        debug('Aborting in-flight continuity audit:', reason);
        activeAudit.abort();
    }
}

/**
 * Trigger filter for MESSAGE_RECEIVED: only a fresh or regenerated assistant
 * reply starts an audit; swipes and continues are intermediate turns that a
 * finished reply supersedes. ST messages carry no `type` field — the event
 * fires with `(messageIndex, type)` and that argument is authoritative.
 * @param {{ is_user?: unknown, is_system?: unknown } | null | undefined} message
 * @param {unknown} type - MESSAGE_RECEIVED type argument ('normal', 'swipe', 'continue', 'append').
 * @returns {boolean}
 */
export function isAuditorTriggerMessage(message, type) {
    if (!message || message.is_user || message.is_system) {
        return false;
    }
    return type === 'normal';
}

/**
 * Run one Continuity Auditor lifecycle (issue #28): gate, dispatch one
 * combined extraction call over the summarizer router, validate with at most
 * one section-aware repair retry, apply the JS flags rulebook, and persist
 * with chat-identity revalidation around the host's saveMetadata wait.
 * @param {object} [options]
 * @param {import('./notify.js').NotifyAdapter} [options.notify] - Notify adapter; defaults to the silent adapter
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>} Run Outcome per ADR-0004
 */
export async function runAuditorExtraction({ notify = silentAdapter } = {}) {
    const settings = getEffectiveSettings();
    if (!settings.enabled || settings.continuityEnabled !== true) {
        return { status: 'idle' };
    }
    if (getGroupId()) {
        return { status: 'idle' };
    }
    const chat = getChat();
    const store = getChatStore();
    const prior = store.continuity;
    const { anchor, derived, turnCount } = resolveAnchorTurns(prior, chat);
    if (derived <= 0) {
        return { status: 'idle' };
    }
    const identity = captureChatIdentity(chat);
    const storyTxt = buildAuditStory(chat, anchor);
    const contextStr = buildAuditorContext(prior, store);
    // Assigning through the slot keeps the controller visible to aborts.
    const controller = (activeAudit = new AbortController());
    try {
        const deps = { settings, notify, controller, identity };
        let round = await dispatchAuditRound(storyTxt, contextStr, deps);
        if (round.status !== 'ok') {
            return await settleRound(round, identity);
        }
        let audit = round.audit;
        if (audit.sectionVerdicts.length > 0) {
            const repairFeedback = buildAuditorRepairFeedback(round.text, audit.sectionVerdicts);
            round = await dispatchAuditRound(storyTxt, contextStr, {
                ...deps,
                metadata: { kind: 'auditor', auditorRepair: repairFeedback },
            });
            if (round.status !== 'ok') {
                return await settleRound(round, identity);
            }
            audit = round.audit;
        }
        const { state, flags } = audit;
        if (audit.sectionVerdicts.length > 0 || !state) {
            // Unusable draft: fail-safe freeze, never apply flags on a null state.
            return await freezeContinuity(identity);
        }
        applyAuditResult(prior, { state, flags }, turnCount, lastAssistantScIdAfter(chat, anchor));
        if (!(await persistAudit(identity))) {
            return { status: 'aborted' };
        }
        return { status: 'completed' };
    } catch (e) {
        if (controller.signal.aborted) {
            return { status: 'aborted' };
        }
        warn('Continuity audit failed:', e);
        return await freezeContinuity(identity);
    } finally {
        clearActiveAuditSlot(controller);
    }
}

/** Release the shared abort slot only while it still holds this run's controller. @param {AbortController} controller @returns {void} */
function clearActiveAuditSlot(controller) {
    if (activeAudit === controller) {
        activeAudit = null;
    }
}

/**
 * Resolve the audit anchor, its derived turn count, and the accumulated
 * turn_count: fresh runs derive from the chat start, continuations add the
 * derived turns past the prior anchor. An anchor pointing at a deleted or
 * forked message cold re-derives from the chat start.
 * @param {SummaryceptionContinuityState} prior
 * @param {ChatMessage[]} chat
 * @returns {{ anchor: string, derived: number, turnCount: number }}
 */
function resolveAnchorTurns(prior, chat) {
    const anchor = prior.anchor_sc_id;
    const derived = deriveTurnCount(chat, anchor);
    if (derived === null) {
        const coldDerived = deriveTurnCount(chat, '') ?? 0;
        return { anchor: '', derived: coldDerived, turnCount: coldDerived };
    }
    return { anchor, derived, turnCount: anchor ? prior.turn_count + derived : derived };
}

/**
 * Settle a round that produced no usable reply: an abort discards the attempt
 * without touching the stored state; anything else is an unusable draft and
 * freezes the previous state (fail-safe per spec §7).
 * @param {{ status: 'aborted' | 'frozen' }} round
 * @param {{ length: number, lastScId: string }} identity
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
 */
async function settleRound(round, identity) {
    if (round.status === 'aborted') {
        return { status: 'aborted' };
    }
    return await freezeContinuity(identity);
}

/**
 * Dispatch one audit round and classify the reply. A non-completed response,
 * an abort, or a chat switch yields no audit; a completed response without
 * text is a contract violation and counts as a frozen draft.
 * @param {string} storyTxt
 * @param {string} contextStr
 * @param {object} deps
 * @param {ExtensionSettings} deps.settings
 * @param {import('./notify.js').NotifyAdapter} deps.notify
 * @param {AbortController} deps.controller
 * @param {{ length: number, lastScId: string }} deps.identity
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [deps.metadata]
 * @returns {Promise<{ status: 'aborted' | 'frozen' } | { status: 'ok', audit: { state: SummaryceptionContinuityState | null, sectionVerdicts: string[], flags: Record<string, Record<string, unknown>> }, text: string }>}
 */
async function dispatchAuditRound(storyTxt, contextStr, deps) {
    const response = await dispatchAuditCall(storyTxt, contextStr, deps);
    if (settledAborted(deps.controller, deps.identity)) {
        return { status: 'aborted' };
    }
    if (response.status !== 'completed') {
        return { status: response.status === 'aborted' ? 'aborted' : 'frozen' };
    }
    const text = response.text;
    if (typeof text !== 'string') {
        return { status: 'frozen' };
    }
    return { status: 'ok', audit: classifyAuditResponse(text), text };
}

/**
 * Dispatch one auditor request through the summarizer router. The external
 * signal is threaded only over cancellable connections; otherwise the
 * runner's abort state owns cancellation between awaits. The repair retry
 * carries its feedback via the metadata channel so the pipeline places it
 * above the execution trigger, not inside the prior-state context block.
 * @param {string} storyTxt
 * @param {string} contextStr
 * @param {object} deps
 * @param {ExtensionSettings} deps.settings
 * @param {import('./notify.js').NotifyAdapter} deps.notify
 * @param {AbortController} deps.controller
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [deps.metadata] - Defaults to a plain auditor call
 * @returns {Promise<import('./request-runner.js').RunOutcome>}
 */
async function dispatchAuditCall(storyTxt, contextStr, { settings, notify, controller, metadata }) {
    return callSummarizer(
        storyTxt,
        contextStr,
        metadata ?? { kind: 'auditor' },
        notify,
        isCancellableConnection(settings) ? controller.signal : undefined,
    );
}

/**
 * True when the audit was aborted or the chat moved under it; either way the
 * attempt is discarded without touching the stored Continuity State.
 * @param {AbortController} controller
 * @param {{ length: number, lastScId: string }} identity
 * @returns {boolean}
 */
function settledAborted(controller, identity) {
    if (controller.signal.aborted) {
        return true;
    }
    return !isSameChatIdentity(identity, captureChatIdentity(getChat()));
}

/**
 * Freeze the previous Continuity State with the stale marker (fail-safe per
 * spec §7); the main model keeps reading the last valid state. Identity is
 * revalidated BEFORE the mutation: a chat switch between the response and
 * the freeze must not write a bogus stale marker into the new chat's store.
 * @param {{ length: number, lastScId: string }} identity
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
 */
async function freezeContinuity(identity) {
    const store = getChatStore();
    if (!isSameChatIdentity(identity, captureChatIdentity(getChat()))) {
        return { status: 'aborted' };
    }
    store.continuity.stale = true;
    if (!(await persistAudit(identity))) {
        return { status: 'aborted' };
    }
    return { status: 'failed' };
}

/**
 * Persist the continuity store, revalidating chat identity around
 * saveMetadata: the host save waits up to 1s on the chat-save lock and
 * silently drops on timeout, so a chat switch mid-save must not land the
 * write in another chat.
 * @param {{ length: number, lastScId: string }} identity - Identity captured before dispatch.
 * @returns {Promise<boolean>} False when the write was dropped.
 */
async function persistAudit(identity) {
    const preSave = captureChatIdentity(getChat());
    await saveChatStore();
    return (
        isSameChatIdentity(identity, preSave) &&
        isSameChatIdentity(preSave, captureChatIdentity(getChat()))
    );
}

/**
 * @param {ChatMessage[]} chat
 * @returns {{ length: number, lastScId: string }}
 */
function captureChatIdentity(chat) {
    return { length: chat.length, lastScId: String(chat[chat.length - 1]?.sc_id ?? '') };
}

/**
 * @param {{ length: number, lastScId: string }} a
 * @param {{ length: number, lastScId: string }} b
 * @returns {boolean}
 */
function isSameChatIdentity(a, b) {
    return a.length === b.length && a.lastScId === b.lastScId;
}

/**
 * Latest assistant message sc_id at or after the anchor; the success path
 * re-points the anchor here.
 * @param {ChatMessage[]} chat
 * @param {string} anchorScId
 * @returns {string}
 */
function lastAssistantScIdAfter(chat, anchorScId) {
    const indexById = getMessageIndexByScId(chat);
    let startIndex = 0;
    if (anchorScId) {
        startIndex = (indexById.get(anchorScId) ?? -1) + 1;
    }
    let lastScId = '';
    for (let index = startIndex; index < chat.length; index++) {
        const message = chat[index];
        if (message && !message.is_user && !message.is_system) {
            lastScId = String(message.sc_id ?? '');
        }
    }
    return lastScId;
}

/**
 * Render the Catch-up Window: the last AUDIT_WINDOW_EXCHANGES Exchanges past
 * the anchor, each Exchange being its user line plus the assistant reply.
 * @param {ChatMessage[]} chat
 * @param {string} anchorScId
 * @returns {string}
 */
function buildAuditStory(chat, anchorScId) {
    const indexById = getMessageIndexByScId(chat);
    let startIndex = 0;
    if (anchorScId) {
        startIndex = (indexById.get(anchorScId) ?? -1) + 1;
    }
    const assistantIndices = [];
    for (let index = startIndex; index < chat.length; index++) {
        const message = chat[index];
        if (message && !message.is_user && !message.is_system) {
            assistantIndices.push(index);
        }
    }
    const windowIndices = assistantIndices.slice(-AUDIT_WINDOW_EXCHANGES);
    const included = new Set(windowIndices);
    for (const index of windowIndices) {
        // Walk back over non-user (assistant, system, hidden) messages to the
        // Exchange's user turn; a system message between the turns must not
        // drop the user line.
        let back = index - 1;
        while (back >= 0) {
            if (chat[back]?.is_user) {
                included.add(back);
                break;
            }
            back--;
        }
    }
    const playerName = getName1();
    return [...included]
        .sort((a, b) => a - b)
        .map((index) => {
            const message = chat[index];
            const speaker = message.is_user ? playerName : String(message.name || 'Assistant');
            return `[${message.sc_id}] ${speaker}: ${String(message.mes || '')}`;
        })
        .join('\n\n');
}

/**
 * User prompt context: prior Continuity State JSON plus the macro memory.
 * @param {SummaryceptionContinuityState} prior
 * @param {SummaryceptionStore} store
 * @returns {string}
 */
function buildAuditorContext(prior, store) {
    const memory = listNonEmptyLayers(store)
        .map(({ layer }) =>
            layer
                .map((snippet) => String(snippet?.text || ''))
                .filter(Boolean)
                .join('\n\n'),
        )
        .filter(Boolean)
        .join('\n\n');
    return `Prior continuity state:\n${JSON.stringify(prior, null, 2)}\n\nNarrative memory:\n${memory || '(none yet)'}`;
}

/**
 * Parse one auditor reply: schema verdicts plus the raw per-pair flag
 * objects, which classifyContinuity's numeric normalization would drop.
 * @param {string} text
 * @returns {{ state: SummaryceptionContinuityState | null, sectionVerdicts: string[], flags: Record<string, Record<string, unknown>> }}
 */
function classifyAuditResponse(text) {
    let parsed;
    /** @type {Record<string, Record<string, unknown>>} */
    const flags = {};
    try {
        parsed = JSON.parse(text);
    } catch {
        return { state: null, sectionVerdicts: ['parse'], flags };
    }
    const { state, sectionVerdicts } = classifyContinuity(parsed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const bonds = /** @type {{ bonds?: unknown }} */ (parsed).bonds;
        if (bonds && typeof bonds === 'object' && !Array.isArray(bonds)) {
            for (const [pair, value] of Object.entries(
                /** @type {Record<string, unknown>} */ (bonds),
            )) {
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    flags[pair] = /** @type {Record<string, unknown>} */ (value);
                }
            }
        }
    }
    return { state, sectionVerdicts, flags };
}

/**
 * Apply one validated audit through the JS rulebook: this module is the sole
 * writer of bond/sparks/grudge; the Auditor's booleans and section payloads
 * never touch the counters directly.
 * @param {SummaryceptionContinuityState} prior
 * @param {{ state: SummaryceptionContinuityState, flags: Record<string, Record<string, unknown>> }} audit - Validated audit; callers never pass a null-state draft.
 * @param {number} turnCount
 * @param {string} anchorScId
 * @returns {void}
 */
function applyAuditResult(prior, audit, turnCount, anchorScId) {
    const pairs = new Set([...Object.keys(prior.bonds), ...Object.keys(audit.flags)]);
    for (const pair of pairs) {
        prior.bonds[pair] = applyPairFlags(prior.bonds[pair], audit.flags[pair], turnCount);
    }
    prior.agendas = audit.state.agendas;
    prior.gm_notes = audit.state.gm_notes;
    prior.physics = audit.state.physics;
    prior.turn_count = turnCount;
    prior.anchor_sc_id = anchorScId;
    prior.stale = false;
    debug('Continuity audit applied:', { turnCount, anchorScId });
}

const AUDITOR_REPAIR_SECTIONS = Object.freeze({
    parse: {
        id: 'parse',
        label: 'JSON object',
        repairInstruction:
            'The previous reply was not valid JSON. Reply with the complete JSON state object only.',
    },
    turn_count: {
        id: 'turn_count',
        label: 'turn_count',
        repairInstruction:
            'The "turn_count" key was missing. Emit the complete JSON state object including it.',
    },
    bonds: {
        id: 'bonds',
        label: 'bonds',
        repairInstruction:
            'The "bonds" section was missing, malformed, or named a pair outside the exchanges. Emit a complete "bonds" object keyed "<Name>↔User" with the five booleans per pair.',
    },
    agendas: {
        id: 'agendas',
        label: 'agendas',
        repairInstruction:
            'The "agendas" section was missing or malformed. Emit a complete "agendas" object (empty is valid).',
    },
    gm_notes: {
        id: 'gm_notes',
        label: 'gm_notes',
        repairInstruction:
            'The "gm_notes" section was missing, malformed, or used an unknown tag. Emit the note array using only [R], [T], and [D] tags.',
    },
    physics: {
        id: 'physics',
        label: 'physics',
        repairInstruction:
            'The "physics" section was missing or malformed. Emit all five physics fields.',
    },
});

/**
 * Section-aware repair feedback for one rejected auditor reply.
 * @param {string} rejectedDraft
 * @param {string[]} sectionVerdicts
 * @returns {string}
 */
function buildAuditorRepairFeedback(rejectedDraft, sectionVerdicts) {
    // Verdicts carry no token contract, so each failing section is rejected
    // explicitly; buildRepairDiagnostics only derives violations from bounds.
    const sections = sectionVerdicts.map((verdict) => ({
        ...(AUDITOR_REPAIR_SECTIONS[verdict] || {
            id: verdict,
            label: verdict,
            repairInstruction: `Emit the complete "${verdict}" section.`,
        }),
        violation: true,
    }));
    const diagnostics = buildRepairDiagnostics({
        scope: 'auditor',
        sections,
        rejectedDraft,
    });
    const structural = buildStructuralRepairFeedback(diagnostics);
    const formatted = formatRepairDiagnostics(diagnostics, {
        wrapperTag: 'summaryception_auditor_repair_feedback',
    });
    return structural ? `${formatted}\n${structural}` : formatted;
}
