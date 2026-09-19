import {
    classifyContinuity,
    applyPairFlags,
    createDefaultContinuity,
    deriveTurnCount,
    diffContinuityStates,
    findLiveCheckpoint,
    hashMessageText,
    isRecord,
    listAssistantIndicesAfter,
} from '../foundation/continuity.js';
import { getChat, getGroupId, getName1 } from '../foundation/context.js';
import {
    isContinuityStateLogEnabled,
    isContinuityStateLogFullEnabled,
    warn,
} from '../foundation/logger.js';
import { ensureChatScIds, getMessageIndexByScId } from '../foundation/message-identity.js';
import {
    CATCHUP_WINDOW_EXCHANGES,
    listNonEmptyLayers,
    LOG_PREFIX,
} from '../foundation/constants.js';
import { AUDITOR_REPAIR_SECTIONS } from '../foundation/prompt-constants.js';
import { refreshPreview } from '../foundation/refresh.js';
import { persistChatState } from './persist-state.js';
import { getChatStore, getEffectiveSettings, saveChatStore } from '../foundation/state.js';
import {
    buildRepairDiagnostics,
    buildStructuralRepairFeedback,
    formatRepairDiagnostics,
} from './repair-diagnostics.js';
import { silentAdapter } from './notify.js';
import { callSummarizer } from './summarizer-request.js';

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
 * one section-aware repair retry, apply the JS flags rulebook, and attach the
 * Continuity Checkpoint to the audited reply's extra (ADR-0010) with a
 * chat-switch revalidation around the host's saveMetadata wait.
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
    // Backfill identity before reading it: the audit's coverage anchor and
    // audited reply both resolve through sc_id, and a fresh reply may not
    // carry one yet.
    if (ensureChatScIds(chat)) {
        await persistChatState({ chatSave: 'deferred' });
    }
    const live = findLiveCheckpoint(chat);
    const anchorScId = live ? String(live.message.sc_id ?? '') : '';
    const assistantIndices = listAssistantIndicesAfter(chat, anchorScId) ?? [];
    if (assistantIndices.length === 0) {
        return { status: 'idle' };
    }
    const turnCount = deriveTurnCount(chat);
    const target = chat[assistantIndices[assistantIndices.length - 1]];
    const targetScId = String(target.sc_id ?? '');
    const targetHash = hashMessageText(target.mes);
    const priorState = live ? structuredClone(live.state) : createDefaultContinuity();
    const store = getChatStore();
    const storyTxt = buildAuditStory(chat, anchorScId);
    const contextStr = buildAuditorContext(priorState, store);
    if (isContinuityStateLogEnabled()) {
        logContinuityAudit(
            `${LOG_PREFIX} [Continuity] audit - START (turn ${turnCount}, coverage ${anchorScId || 'start'})`,
            { kind: 'start', turn_count: turnCount, coverage_sc_id: anchorScId || '' },
        );
    }
    try {
        const round = await runAuditRounds(storyTxt, contextStr, { notify });
        if (round.status !== 'ok') {
            return { status: round.status };
        }
        const audit = round.audit;
        if (audit.sectionVerdicts.length > 0 || !audit.state) {
            // Unusable draft: the live checkpoint stays as-is, so the derived
            // staleness marker keeps covering the un-audited exchanges.
            if (isContinuityStateLogEnabled()) {
                logContinuityAudit(`${LOG_PREFIX} [Continuity] audit - FAILED`, {
                    kind: 'failed',
                });
            }
            return { status: 'failed' };
        }
        // Attach-at-settle: the chat may have grown since dispatch, but the
        // audit lands only when the audited reply still resolves here with
        // unchanged text.
        const currentChat = getChat();
        const targetIndex = getMessageIndexByScId(currentChat).get(targetScId);
        const targetMessage = targetIndex === undefined ? null : currentChat[targetIndex];
        if (!targetMessage || hashMessageText(targetMessage.mes) !== targetHash) {
            return { status: 'aborted' };
        }
        const priorSnapshot = isContinuityStateLogEnabled() ? structuredClone(priorState) : null;
        applyAuditResult(priorState, { state: audit.state, flags: audit.flags }, turnCount);
        targetMessage.extra = isRecord(targetMessage.extra) ? targetMessage.extra : {};
        targetMessage.extra.summaryception_continuity = {
            state: priorState,
            audited_sc_id: targetScId,
            text_hash: targetHash,
        };
        if (!(await persistAudit())) {
            return { status: 'aborted' };
        }
        logAuditCompletion(priorSnapshot, priorState, turnCount, targetScId);
        return { status: 'completed' };
    } catch (e) {
        warn('Continuity audit failed:', e);
        return { status: 'failed' };
    }
}

/**
 * Log the completed audit against the pre-commit snapshot. Only allocated
 * when the state log is on; the full variant dumps the whole state.
 * @param {SummaryceptionContinuityState | null} priorSnapshot - Cloned prior state, or null when logging is off.
 * @param {SummaryceptionContinuityState} state - The committed checkpoint state.
 * @param {number} turnCount - Derived turn number of the audit.
 * @param {string} auditedScId - sc_id of the audited reply carrying the checkpoint.
 * @returns {void}
 */
function logAuditCompletion(priorSnapshot, state, turnCount, auditedScId) {
    if (!priorSnapshot) {
        return;
    }
    const title =
        `${LOG_PREFIX} [Continuity] audit - COMPLETED ` +
        `(turn ${turnCount}, audited ${auditedScId})`;
    if (isContinuityStateLogFullEnabled()) {
        logContinuityAudit(title, {
            kind: 'success',
            turn_count: turnCount,
            audited_sc_id: auditedScId,
            state,
        });
    } else {
        logContinuityAudit(title, {
            kind: 'success',
            changes: diffContinuityStates(priorSnapshot, state),
        });
    }
}

/**
 * Dispatch one audit round and classify the reply. A non-completed response
 * or an abort yields no audit; a completed response without text is a
 * contract violation and counts as a failed draft.
 * @param {string} storyTxt
 * @param {string} contextStr
 * @param {object} deps
 * @param {import('./notify.js').NotifyAdapter} deps.notify
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [deps.metadata]
 * @returns {Promise<{ status: 'aborted' | 'failed' } | { status: 'ok', audit: { state: SummaryceptionContinuityState | null, sectionVerdicts: string[], flags: Record<string, Record<string, unknown>> }, text: string }>}
 */
async function dispatchAuditRound(storyTxt, contextStr, deps) {
    const response = await dispatchAuditCall(storyTxt, contextStr, deps);
    if (response.status !== 'completed') {
        return { status: response.status === 'aborted' ? 'aborted' : 'failed' };
    }
    const text = response.text;
    if (typeof text !== 'string') {
        return { status: 'failed' };
    }
    return { status: 'ok', audit: classifyContinuity(text), text };
}

/**
 * Dispatch the extraction round, then one section-aware repair round when the
 * draft carries section verdicts.
 * @param {string} storyTxt
 * @param {string} contextStr
 * @param {object} deps
 * @param {import('./notify.js').NotifyAdapter} deps.notify
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [deps.metadata] - Defaults to a plain auditor call
 * @returns {Promise<{ status: 'aborted' | 'failed' } | { status: 'ok', audit: { state: SummaryceptionContinuityState | null, sectionVerdicts: string[], flags: Record<string, Record<string, unknown>> }, text: string }>}
 */
async function runAuditRounds(storyTxt, contextStr, deps) {
    const round = await dispatchAuditRound(storyTxt, contextStr, deps);
    if (round.status !== 'ok' || round.audit.sectionVerdicts.length === 0) {
        return round;
    }
    const repairFeedback = buildAuditorRepairFeedback(round.text, round.audit.sectionVerdicts);
    return await dispatchAuditRound(storyTxt, contextStr, {
        ...deps,
        metadata: { kind: 'auditor', auditorRepair: repairFeedback },
    });
}

/**
 * Dispatch one auditor request through the summarizer router. The repair
 * retry carries its feedback via the metadata channel so the pipeline places
 * it above the execution trigger, not inside the prior-state context block.
 * @param {string} storyTxt
 * @param {string} contextStr
 * @param {object} deps
 * @param {import('./notify.js').NotifyAdapter} deps.notify
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [deps.metadata] - Defaults to a plain auditor call
 * @returns {Promise<import('./run-outcome.js').RunOutcome>}
 */
async function dispatchAuditCall(storyTxt, contextStr, { notify, metadata }) {
    const call = metadata ?? { kind: 'auditor' };
    return callSummarizer({
        storyTxt,
        contextStr,
        metadata: call,
        notify,
    });
}

/**
 * Persist the continuity write, revalidating chat identity around
 * saveMetadata: the host save waits up to 1s on the chat-save lock and
 * silently drops on timeout, so a chat switch mid-save must not land the
 * write in another chat. Chat growth since dispatch is fine; the checkpoint
 * attach check already resolved the audited reply in the current chat.
 * @returns {Promise<boolean>} False when the write was dropped.
 */
async function persistAudit() {
    const preSave = captureChatIdentity(getChat());
    await saveChatStore();
    const persisted = isSameChatIdentity(preSave, captureChatIdentity(getChat()));
    if (persisted) {
        refreshPreview();
    }
    return persisted;
}

const CONTINUITY_AUDIT_LOG_TYPE = 'summaryception.continuity.audit.v1';

/**
 * One collapsed console group per Continuity State audit event; the JSON
 * payload is the single line inside. Mirrors the request-attempt-log style.
 * @param {string} title
 * @param {Record<string, unknown>} payload
 * @returns {void}
 */
function logContinuityAudit(title, payload) {
    console.groupCollapsed(title);
    try {
        console.log(JSON.stringify({ type: CONTINUITY_AUDIT_LOG_TYPE, ...payload }, null, 2));
    } finally {
        console.groupEnd();
    }
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
 * Render the Catch-up Window: the last CATCHUP_WINDOW_EXCHANGES Exchanges past
 * the coverage anchor, each Exchange being its user line plus the assistant
 * reply.
 * @param {ChatMessage[]} chat
 * @param {string} anchorScId
 * @returns {string}
 */
function buildAuditStory(chat, anchorScId) {
    const assistantIndices = listAssistantIndicesAfter(chat, anchorScId) ?? [];
    const windowIndices = assistantIndices.slice(-CATCHUP_WINDOW_EXCHANGES);
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
 * Apply one validated audit through the JS rulebook onto the working state
 * clone: this module is the sole writer of bond/sparks/grudge; the Auditor's
 * booleans and section payloads never touch the counters directly.
 * @param {SummaryceptionContinuityState} prior - Working state clone, mutated in place.
 * @param {{ state: SummaryceptionContinuityState, flags: Record<string, Record<string, unknown>> }} audit - Validated audit; callers never pass a null-state draft.
 * @param {number} turnCount
 * @returns {void}
 */
function applyAuditResult(prior, audit, turnCount) {
    const pairs = new Set([...Object.keys(prior.bonds), ...Object.keys(audit.flags)]);
    for (const pair of pairs) {
        prior.bonds[pair] = applyPairFlags(prior.bonds[pair], audit.flags[pair], turnCount);
    }
    prior.agendas = audit.state.agendas;
    prior.gm_notes = audit.state.gm_notes;
    prior.physics = audit.state.physics;
    prior.turn_count = turnCount;
}

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
