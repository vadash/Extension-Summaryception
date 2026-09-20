import { CATCHUP_WINDOW_EXCHANGES } from '../foundation/constants.js';
import { isRecord } from './continuity-state.js';

/**
 * Continuity Coverage: the one read model of the chat for the Continuity
 * Engine. The audit lifecycle and the Continuity Block injection both consume
 * it, so the coverage anchor, the Catch-up Window bound, the Turn Count, and
 * the block's prompt placement derive in one place (ADR-0014).
 * Pure chat in, plain data out.
 * @typedef {object} ContinuityCoverage
 * @property {number | null} checkpointIndex - Chat index of the live Continuity Checkpoint, or null when the chat carries no payload.
 * @property {SummaryceptionContinuityState | null} state - The live checkpoint payload, the base of the next audit and the source of the injected block.
 * @property {number} turnCount - Every assistant message in the chat. The Turn Count re-derives from the chat at every audit and never from coverage.
 * @property {number[]} unauditedIndices - Assistant messages after the checkpoint, the Exchanges the next audit covers.
 * @property {number | null} targetIndex - The newest un-audited reply the audit attaches its checkpoint to; null leaves the audit idle.
 * @property {number[]} windowIndices - Chat indices the audit reads: the last four un-audited Exchanges, their user turns included.
 * @property {boolean} stale - Whether the newest checkpoint's Exchange trails the chat's last Exchange.
 * @property {number} blockDepth - IN_CHAT depth for the Continuity Block: one message past the last covered reply, so the slot stays valid when the host appends the pending user turn.
 */

/**
 * @param {ChatMessage[] | unknown} chat
 * @returns {ContinuityCoverage}
 */
export function deriveContinuityCoverage(chat) {
    const messages = Array.isArray(chat) ? chat : [];
    const checkpoint = findLiveCheckpoint(messages);
    const checkpointIndex = checkpoint ? checkpoint.index : null;
    const unauditedIndices = listAssistantIndicesAfter(messages, checkpointIndex);

    return {
        checkpointIndex,
        state: checkpoint ? checkpoint.state : null,
        turnCount: listAssistantIndicesAfter(messages, -1).length,
        unauditedIndices,
        targetIndex:
            unauditedIndices.length > 0 ? unauditedIndices[unauditedIndices.length - 1] : null,
        windowIndices: selectCatchUpWindow(messages, unauditedIndices),
        stale: checkpointIndex !== null && unauditedIndices.length > 0,
        blockDepth: 1 + unauditedIndices.length,
    };
}

/**
 * Assistant messages after the anchor, or the whole chat for null. Index-based
 * on purpose: ranges derive from current positions at read time (ADR-0014).
 * @param {ChatMessage[]} messages
 * @param {number | null} anchorIndex
 * @returns {number[]}
 */
function listAssistantIndicesAfter(messages, anchorIndex) {
    const indices = [];
    for (let index = (anchorIndex ?? -1) + 1; index < messages.length; index++) {
        const message = messages[index];
        if (message && !message.is_user && !message.is_system) {
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

/**
 * The newest message whose extra carries a Continuity State payload wins; no
 * hash, no chain, no anchor rule (ADR-0014).
 * @param {ChatMessage[]} messages
 * @returns {{ state: SummaryceptionContinuityState, index: number } | null}
 */
function findLiveCheckpoint(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message || message.is_user || message.is_system) {
            continue;
        }
        const payload = message.extra?.summaryception_continuity;
        if (isRecord(payload)) {
            return {
                state: /** @type {SummaryceptionContinuityState} */ (
                    /** @type {unknown} */ (payload)
                ),
                index,
            };
        }
    }
    return null;
}
