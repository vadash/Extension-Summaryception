import { CATCHUP_WINDOW_EXCHANGES } from '../foundation/constants.js';
import {
    findLiveCheckpoint,
    isRerollTail,
    listCheckpointIndices,
} from './continuity-checkpoint.js';
import { deriveTurnCount, isAssistantMessage } from './continuity-state.js';

/**
 * Continuity Coverage: the one read model of the chat for the Continuity
 * Engine. The audit lifecycle and the Continuity Block injection both consume
 * it, so the coverage anchor, the Catch-up Window bound, the Turn Count, and
 * the block's prompt placement derive in one place (ADR-0017).
 * @typedef {object} ContinuityCoverage
 * @property {number | null} checkpointIndex - Chat index of the live Continuity Checkpoint, or null when the chat carries no payload.
 * @property {SummaryceptionContinuityState | null} state - The live checkpoint payload, the base of the next audit and the source of the injected block.
 * @property {number} turnCount - Every assistant message in the chat. The Turn Count re-derives from the chat at every audit and never from coverage.
 * @property {number[]} unauditedIndices - Assistant messages after the checkpoint, the Exchanges the next audit covers.
 * @property {number | null} targetIndex - The newest un-audited reply the audit attaches its checkpoint to; null leaves the audit idle.
 * @property {number[]} windowIndices - Chat indices the audit reads: the last four un-audited Exchanges, their user turns included.
 * @property {boolean} stale - Whether the newest checkpoint's Exchange trails the chat's last Exchange.
 * @property {number} blockDepth - IN_CHAT depth for the Continuity Block: one message past the last covered reply, so the slot stays valid when the host appends the pending user turn.
 * @property {boolean} rerollTail - Whether the prompt view excluded the chat tail, which is why blockDepth can trail the un-audited reply count.
 */

let rerollTailInFlight = false;

/**
 * Record the reroll for the generation that is starting. The flag must outlive
 * the generation-start hook: every render inside the generation window reads it.
 * @param {unknown} generationType - ST GENERATION_STARTED type argument.
 * @param {ChatMessage[] | unknown} chat - The chat view the reroll replaces into.
 * @returns {boolean} Whether the prompt excludes the chat tail.
 */
export function beginRerollTail(generationType, chat) {
    rerollTailInFlight = isRerollTail(generationType, chat);
    return rerollTailInFlight;
}

/**
 * @returns {void}
 */
export function endRerollTail() {
    rerollTailInFlight = false;
}

/**
 * @returns {boolean}
 */
export function isRerollTailInFlight() {
    return rerollTailInFlight;
}

/**
 * @param {ChatMessage[] | unknown} chat
 * @param {{ rerollTail?: boolean }} [options] - Prompt view override; defaults to the in-flight reroll.
 * @returns {ContinuityCoverage}
 */
export function deriveContinuityCoverage(chat, options = {}) {
    const rerollTail = options.rerollTail ?? isRerollTailInFlight();
    const messages = Array.isArray(chat) ? chat : [];
    const excludedIndex = rerollTail ? messages.length - 1 : -1;
    const checkpoint = findLiveCheckpoint(messages, excludedIndex);
    const checkpointIndex = checkpoint ? checkpoint.index : null;
    const unauditedIndices = listAssistantIndicesAfter(messages, checkpointIndex);

    return {
        checkpointIndex,
        state: checkpoint ? checkpoint.state : null,
        turnCount: deriveTurnCount(messages),
        unauditedIndices,
        targetIndex:
            unauditedIndices.length > 0 ? unauditedIndices[unauditedIndices.length - 1] : null,
        windowIndices: selectCatchUpWindow(messages, unauditedIndices),
        stale: checkpointIndex !== null && unauditedIndices.length > 0,
        blockDepth: 1 + unauditedIndices.filter((index) => index !== excludedIndex).length,
        rerollTail,
    };
}

/**
 * @typedef {object} ContinuityMarks
 * @property {number[]} markedIndices - Chat indices of assistant replies whose extra carries a Continuity Checkpoint payload.
 * @property {number | null} liveIndex - Chat index holding the live Continuity Checkpoint, or null when no reply carries a payload.
 */

/**
 * The Continuity Mark read model: payload presence is the only test, no
 * freshness or coverage math. The Live Mark rides the same newest-payload-wins
 * walk as the coverage anchor, read over the full chat view: the reroll tail
 * keeps its payload mark and its Live Mark because the stale marker reads the
 * chat view, not the prompt view (ADR-0017, ADR-0022).
 * @param {ChatMessage[] | unknown} chat
 * @returns {ContinuityMarks}
 */
export function deriveContinuityMarks(chat) {
    const checkpoint = findLiveCheckpoint(chat, -1);
    const markedIndices = listCheckpointIndices(chat);
    return { markedIndices, liveIndex: checkpoint ? checkpoint.index : null };
}

/**
 * Assistant messages after the anchor, or the whole chat for null. Index-based
 * on purpose: ranges derive from current positions at read time (ADR-0017).
 * @param {ChatMessage[]} messages
 * @param {number | null} anchorIndex
 * @returns {number[]}
 */
function listAssistantIndicesAfter(messages, anchorIndex) {
    const indices = [];
    for (let index = (anchorIndex ?? -1) + 1; index < messages.length; index++) {
        const message = messages[index];
        if (isAssistantMessage(message)) {
            indices.push(index);
        }
    }
    return indices;
}

/**
 * The Catch-up Window: the last four un-audited Exchanges, each with the user
 * turn that opens it. The walk back crosses non-user messages, so a system
 * message between the turns cannot drop an Exchange's user line.
 * @param {ChatMessage[]} messages
 * @param {number[]} unauditedIndices
 * @returns {number[]}
 */
function selectCatchUpWindow(messages, unauditedIndices) {
    const windowIndices = unauditedIndices.slice(-CATCHUP_WINDOW_EXCHANGES);
    const included = new Set(windowIndices);
    for (const index of windowIndices) {
        for (let back = index - 1; back >= 0; back--) {
            if (messages[back]?.is_user) {
                included.add(back);
                break;
            }
        }
    }
    return [...included].sort((a, b) => a - b);
}
