import { LOG_PREFIX, listNonEmptyLayers } from '../foundation/constants.js';
import {
    isContinuityStateLogEnabled,
    isContinuityStateLogFullEnabled,
    warn,
} from '../foundation/logger.js';
import { attachCheckpoint } from './continuity-checkpoint.js';
import { deriveContinuityCoverage } from './continuity-coverage.js';
import { diffContinuityStates } from './continuity-diff.js';
import { applyPairFlags, classifyContinuity, createDefaultContinuity } from './continuity-state.js';
import { silentAdapter } from './notify.js';

const CONTINUITY_AUDIT_LOG_TYPE = 'summaryception.continuity.audit.v1';

/** Milestone titles for the audit log groups. */
const AUDIT_LOG_TITLES = Object.freeze({
    start: 'START',
    failed: 'FAILED',
    aborted: 'ABORTED',
    completed: 'COMPLETED',
});

/**
 * @typedef {object} ContinuityAuditInput
 * @property {ChatMessage[]} chat - The chat view the audit reads; coverage derives from it.
 * @property {SummaryceptionStore} store - Chat Store, for the narrative memory handed to the Auditor.
 * @property {ExtensionSettings} settings - Effective settings; the audit gates on these.
 * @property {boolean} hasGroup - Whether the host chat is a group chat, which the audit never covers.
 * @property {string} playerName - Display name of the user turns in the audit story.
 * @property {boolean} rerollTail - Whether the prompt view excludes the chat tail.
 * @property {import('./notify.js').NotifyAdapter} [notify] - Notify adapter; absent runs stay silent.
 */

/**
 * @typedef {(request: object) => Promise<import('./run-outcome.js').RunOutcome>} ContinuityAuditDispatch
 */

/**
 * @typedef {object} ContinuityAuditorDeps
 * @property {ContinuityAuditDispatch} dispatch - One summarizer call over the resolved Auditor route.
 * @property {() => Promise<void>} saveChatStore - Persists the chat metadata holding the checkpoint.
 * @property {() => void} refreshPreview - Refresh Port preview effect, fired only once the write lands.
 * @property {() => ChatMessage[]} getChat - Reads the active chat, re-read to revalidate identity around the save.
 */

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
 * Build the Continuity Audit. The composition root constructs one instance and
 * threads it to the entry layer, so the lifecycle reads the world through its
 * arguments and its injected dependencies instead of the host facade.
 * @param {ContinuityAuditorDeps} deps
 * @returns {{ audit: (input: ContinuityAuditInput) => Promise<import('./run-outcome.js').SummarizationRunOutcome> }}
 */
export function createContinuityAuditor(deps) {
    return {
        audit: (input) => runAudit(input, deps),
    };
}

/**
 * Run one Continuity Auditor lifecycle (issue #28): gate, dispatch one
 * combined extraction call over the summarizer router, validate once with
 * classifyContinuity, apply the JS flags rulebook, and overwrite
 * the Continuity State payload on the audited reply's extra (ADR-0017),
 * guarding only the chat-switch window around the host's saveMetadata wait.
 * @param {ContinuityAuditInput} input
 * @param {ContinuityAuditorDeps} deps
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>} Run Outcome per ADR-0019
 */
async function runAudit(
    { chat, store, settings, hasGroup, playerName, rerollTail, notify = silentAdapter },
    { dispatch, saveChatStore, refreshPreview, getChat },
) {
    if (!isAuditEligible(settings, hasGroup)) {
        return { status: 'idle' };
    }
    const coverage = deriveContinuityCoverage(chat, { rerollTail });
    if (coverage.targetIndex === null) {
        return { status: 'idle' };
    }
    const targetIndex = coverage.targetIndex;
    const target = chat[targetIndex];
    const turnCount = coverage.turnCount;
    const priorState = clonePriorState(coverage.state);
    const storyTxt = buildAuditStory(chat, coverage.windowIndices, playerName);
    const contextStr = buildAuditorContext(priorState, store);
    logAuditStart(turnCount, coverage.checkpointIndex);

    try {
        const round = await dispatchAuditRound(storyTxt, contextStr, { dispatch, notify });
        if (round.status !== 'ok') {
            return { status: round.status };
        }
        const audit = round.audit;
        if (audit.sectionVerdicts.length > 0 || !audit.state) {
            // Unusable draft: the live checkpoint stays as-is, so the derived
            // staleness marker keeps covering the un-audited exchanges.
            reportAudit('failed', '', {
                kind: 'failed',
                recovery_tier: audit.recoveryTier ?? undefined,
            });
            return { status: 'failed' };
        }
        // Attach to the audited reply's message object; a mid-flight chat
        // growth leaves it in place, a deletion drops the write (ADR-0017).
        const currentChat = getChat();
        if (!currentChat.includes(target)) {
            reportAudit('aborted', '(audited reply removed mid-flight)', {
                kind: 'aborted',
                reason: 'reply-removed',
            });
            return { status: 'aborted' };
        }
        const priorSnapshot = isContinuityStateLogEnabled() ? structuredClone(priorState) : null;
        applyAuditResult(priorState, { state: audit.state, flags: audit.flags }, turnCount);
        attachCheckpoint(target, priorState);
        if (!(await persistAudit(currentChat, { saveChatStore, refreshPreview, getChat }))) {
            reportAudit('aborted', '(chat switched during save)', {
                kind: 'aborted',
                reason: 'chat-switch',
            });
            return { status: 'aborted' };
        }
        logAuditCompletion({ priorSnapshot, priorState, turnCount, scId: target.sc_id, audit });
        return { status: 'completed' };
    } catch (e) {
        warn('Continuity audit failed:', e);
        return { status: 'failed' };
    }
}

/**
 * Whether the Continuity Audit runs at all: the extension and the Continuity
 * Engine must both be on, and a group chat is never audited.
 * @param {ExtensionSettings} settings
 * @param {boolean} hasGroup
 * @returns {boolean}
 */
function isAuditEligible(settings, hasGroup) {
    if (!settings.enabled || settings.continuityEnabled !== true) {
        return false;
    }
    return !hasGroup;
}

/**
 * The working state the audit merges into: a clone of the live checkpoint, or
 * a fresh default state for a chat that has never been audited.
 * @param {SummaryceptionContinuityState | null} state
 * @returns {SummaryceptionContinuityState}
 */
function clonePriorState(state) {
    return state ? structuredClone(state) : createDefaultContinuity();
}

/**
 * Log the start milestone for one audit.
 * @param {number} turnCount
 * @param {number | null} checkpointIndex - The live checkpoint's chat index, or null when the chat anchors nowhere.
 * @returns {void}
 */
function logAuditStart(turnCount, checkpointIndex) {
    reportAudit('start', `(turn ${turnCount}, coverage ${checkpointIndex ?? 'start'})`, {
        kind: 'start',
        turn_count: turnCount,
        coverage_index: checkpointIndex,
    });
}

/**
 * Dispatch one audit call and classify the reply. A non-completed response
 * or an abort yields no audit; a completed response without text is a
 * contract violation and counts as a failed draft. Validation failure means
 * no checkpoint write; the next audit re-covers the Exchanges through the
 * Catch-up Window (ADR-0017, single-call audit).
 * @param {string} storyTxt
 * @param {string} contextStr
 * @param {object} deps
 * @param {ContinuityAuditDispatch} deps.dispatch
 * @param {import('./notify.js').NotifyAdapter} deps.notify
 * @returns {Promise<{ status: 'aborted' | 'failed' } | { status: 'ok', audit: { state: SummaryceptionContinuityState | null, sectionVerdicts: string[], flags: Record<string, Record<string, unknown>>, notesTruncated: number, recoveryTier: number | null }}>}
 */
async function dispatchAuditRound(storyTxt, contextStr, { dispatch, notify }) {
    const response = await dispatch({
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
 * saveChatStore: the host save waits up to 1s on the chat-save lock and
 * silently drops on timeout, so a chat switch mid-save must not land the
 * write in another chat. Chat growth since dispatch is fine; the checkpoint
 * attach check already resolved the audited reply in the current chat.
 * @param {ChatMessage[]} currentChat - The chat the audited reply was resolved in.
 * @param {object} deps
 * @param {() => Promise<void>} deps.saveChatStore
 * @param {() => void} deps.refreshPreview
 * @param {() => ChatMessage[]} deps.getChat
 * @returns {Promise<boolean>} False when the write was dropped.
 */
async function persistAudit(currentChat, { saveChatStore, refreshPreview, getChat }) {
    const preSave = captureChatIdentity(currentChat);
    await saveChatStore();
    const persisted = isSameChatIdentity(preSave, captureChatIdentity(getChat()));
    if (persisted) {
        refreshPreview();
    }
    return persisted;
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
 * Log the completed audit against the pre-commit snapshot. Only allocated
 * when the state log is on; the full variant dumps the whole state. An
 * over-budget note count rides along, which is what makes the GM-note cap
 * observable instead of silent (ADR-0029).
 * @param {object} completed - The committed audit to log.
 * @param {SummaryceptionContinuityState | null} completed.priorSnapshot - Cloned prior state, or null when logging is off.
 * @param {SummaryceptionContinuityState} completed.priorState - The committed checkpoint state.
 * @param {number} completed.turnCount - Derived turn number of the audit.
 * @param {string | undefined} completed.scId - sc_id of the audited reply carrying the checkpoint.
 * @param {{ notesTruncated: number, recoveryTier: number | null }} completed.audit - The validated audit the commit applied.
 * @returns {void}
 */
function logAuditCompletion({ priorSnapshot, priorState, turnCount, scId, audit }) {
    if (!priorSnapshot) {
        return;
    }
    const auditedScId = String(scId ?? '');
    const overBudget = audit.notesTruncated > 0 ? { notes_truncated: audit.notesTruncated } : {};
    const recovered = audit.recoveryTier !== null ? { recovery_tier: audit.recoveryTier } : {};
    reportAudit('completed', `(turn ${turnCount}, audited ${auditedScId})`, {
        kind: 'success',
        turn_count: turnCount,
        audited_sc_id: auditedScId,
        ...overBudget,
        ...recovered,
        ...(isContinuityStateLogFullEnabled()
            ? { state: priorState }
            : { changes: diffContinuityStates(priorSnapshot, priorState) }),
    });
}

/**
 * One collapsed console group per Continuity State audit milestone. The
 * enabled guard and the group shape live here, so the lifecycle reports an
 * event instead of repeating the guard at every exit. Mirrors the
 * request-attempt-log style.
 * @param {'start' | 'failed' | 'aborted' | 'completed'} kind - Lifecycle milestone.
 * @param {string} detail - Extra title text, e.g. the turn and coverage anchors.
 * @param {Record<string, unknown>} payload - Event body, serialized into the group.
 * @returns {void}
 */
function reportAudit(kind, detail, payload) {
    if (!isContinuityStateLogEnabled()) {
        return;
    }
    const title = `${LOG_PREFIX} [Continuity] audit - ${AUDIT_LOG_TITLES[kind]}${detail ? ` ${detail}` : ''}`;
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
 * @param {string} playerName - Display name of the user turns.
 * @returns {string}
 */
function buildAuditStory(chat, windowIndices, playerName) {
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
