import {
    classifyContinuity,
    applyPairFlags,
    createDefaultContinuity,
    isRecord,
} from './continuity-state.js';
import { deriveContinuityCoverage } from './continuity-coverage.js';
import { diffContinuityStates } from './continuity-diff.js';
import { getChat, getGroupId, getName1 } from '../foundation/context.js';
import {
    isContinuityStateLogEnabled,
    isContinuityStateLogFullEnabled,
    trace,
    warn,
} from '../foundation/logger.js';
import { listNonEmptyLayers, LOG_PREFIX } from '../foundation/constants.js';
import { refreshPreview } from '../foundation/refresh.js';
import { getChatStore, getEffectiveSettings, saveChatStore } from '../foundation/state.js';
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
 * Host generation types that replace the last assistant message instead of
 * appending after it.
 */
const REGENERATION_TYPES = new Set(['swipe', 'regenerate']);

/**
 * Drop the live Continuity Checkpoint when the host starts regenerating its
 * message: the payload describes the exact draft being replaced, and ST keeps
 * the message with its extra in the chat during the regeneration, so
 * newest-payload-wins would otherwise ship the discarded draft's state into
 * the regenerated prompt. After the drop the read model falls back to the
 * prior checkpoint and the regenerated reply is unaudited, so the next
 * settled audit re-covers it. In-memory only: ST persists the chat when the
 * regenerated reply settles.
 * @param {unknown} generationType - ST GENERATION_STARTED type argument.
 * @returns {boolean} True when a checkpoint was dropped.
 */
export function discardRegeneratedCheckpoint(generationType) {
    if (typeof generationType !== 'string' || !REGENERATION_TYPES.has(generationType)) {
        return false;
    }
    const chat = getChat();
    const coverage = deriveContinuityCoverage(chat);
    if (coverage.checkpointIndex === null || coverage.unauditedIndices.length > 0) {
        return false;
    }
    const message = chat[coverage.checkpointIndex];
    if (!message?.extra) {
        return false;
    }
    delete message.extra.summaryception_continuity;
    trace(
        `Continuity checkpoint dropped: host ${generationType} replaces the audited reply (@${coverage.checkpointIndex})`,
    );
    return true;
}

/**
 * Run one Continuity Auditor lifecycle (issue #28): gate, dispatch one
 * combined extraction call over the summarizer router, validate once with
 * classifyContinuity, apply the JS flags rulebook, and overwrite
 * the Continuity State payload on the audited reply's extra (ADR-0014),
 * guarding only the chat-switch window around the host's saveMetadata wait.
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
    const coverage = deriveContinuityCoverage(chat);
    if (coverage.targetIndex === null) {
        return { status: 'idle' };
    }
    const targetIndex = coverage.targetIndex;
    const target = chat[targetIndex];
    const turnCount = coverage.turnCount;
    const priorState = coverage.state ? structuredClone(coverage.state) : createDefaultContinuity();
    const store = getChatStore();
    const storyTxt = buildAuditStory(chat, coverage.windowIndices);
    const contextStr = buildAuditorContext(priorState, store);
    if (isContinuityStateLogEnabled()) {
        logContinuityAudit(
            `${LOG_PREFIX} [Continuity] audit - START (turn ${turnCount}, coverage ${coverage.checkpointIndex ?? 'start'})`,
            { kind: 'start', turn_count: turnCount, coverage_index: coverage.checkpointIndex },
        );
    }
    try {
        const round = await dispatchAuditRound(storyTxt, contextStr, { notify });
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
        // Attach to the audited reply's message object; a mid-flight chat
        // growth leaves it in place, a deletion drops the write (ADR-0014).
        const currentChat = getChat();
        if (!currentChat.includes(target)) {
            if (isContinuityStateLogEnabled()) {
                logContinuityAudit(
                    `${LOG_PREFIX} [Continuity] audit - ABORTED (audited reply removed mid-flight)`,
                    {
                        kind: 'aborted',
                        reason: 'reply-removed',
                    },
                );
            }
            return { status: 'aborted' };
        }
        const priorSnapshot = isContinuityStateLogEnabled() ? structuredClone(priorState) : null;
        applyAuditResult(priorState, { state: audit.state, flags: audit.flags }, turnCount);
        target.extra = isRecord(target.extra) ? target.extra : {};
        target.extra.summaryception_continuity = priorState;
        if (!(await persistAudit())) {
            if (isContinuityStateLogEnabled()) {
                logContinuityAudit(
                    `${LOG_PREFIX} [Continuity] audit - ABORTED (chat switched during save)`,
                    {
                        kind: 'aborted',
                        reason: 'chat-switch',
                    },
                );
            }
            return { status: 'aborted' };
        }
        logAuditCompletion(priorSnapshot, priorState, turnCount, String(target.sc_id ?? ''));
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
 * Dispatch one audit call and classify the reply. A non-completed response
 * or an abort yields no audit; a completed response without text is a
 * contract violation and counts as a failed draft. Validation failure means
 * no checkpoint write; the next audit re-covers the Exchanges through the
 * Catch-up Window (ADR-0014, single-call audit).
 * @param {string} storyTxt
 * @param {string} contextStr
 * @param {object} deps
 * @param {import('./notify.js').NotifyAdapter} deps.notify
 * @returns {Promise<{ status: 'aborted' | 'failed' } | { status: 'ok', audit: { state: SummaryceptionContinuityState | null, sectionVerdicts: string[], flags: Record<string, Record<string, unknown>> }}>}
 */
async function dispatchAuditRound(storyTxt, contextStr, { notify }) {
    const response = await callSummarizer({
        storyTxt,
        contextStr,
        metadata: { kind: 'auditor' },
        notify,
    });
    if (response.status !== 'completed') {
        return { status: response.status === 'aborted' ? 'aborted' : 'failed' };
    }
    const text = response.text;
    if (typeof text !== 'string') {
        return { status: 'failed' };
    }
    return { status: 'ok', audit: classifyContinuity(text) };
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
 * Render the covered chat indices as the audit story: each Exchange is its
 * user line plus the assistant reply.
 * @param {ChatMessage[]} chat
 * @param {number[]} windowIndices - Sorted covered indices from the coverage read model.
 * @returns {string}
 */
function buildAuditStory(chat, windowIndices) {
    const playerName = getName1();
    return windowIndices
        .map((index) => {
            const message = chat[index];
            const speaker = message.is_user ? playerName : String(message.name || 'Assistant');
            return `[${index}] ${speaker}: ${String(message.mes || '')}`;
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
