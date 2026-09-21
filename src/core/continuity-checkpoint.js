import { trace } from '../foundation/logger.js';
import { isAssistantMessage, isRecord } from './continuity-state.js';

/**
 * The Continuity Checkpoint: the per-message payload a settled audit commits,
 * and the payload rules around it (ADR-0017). Payload presence is the state, so
 * this module owns the key, the presence test, both read walks, the write, and
 * the two removals — which is what makes Clear remove the shape through its
 * writer (ADR-0027).
 */

/** The message-extra key a Continuity Checkpoint payload lives under (ADR-0017). */
const CHECKPOINT_KEY = 'summaryception_continuity';

/** Host generation types that replace the chat's last message. */
const REROLL_TYPES = new Set(['swipe', 'regenerate']);

/**
 * Whether the host reroll replaces the chat's last message. The host excludes
 * that message from the prompt chat: a swipe pops it (ST script.js coreChat.pop)
 * and a regenerate deletes it, while a regenerate over a trailing user turn
 * generates a new reply instead. A narrator or system tail diverges between the
 * two host types, so it stays out of scope here.
 * @param {unknown} generationType - ST GENERATION_STARTED type argument.
 * @param {ChatMessage[] | unknown} chat
 * @returns {boolean}
 */
export function isRerollTail(generationType, chat) {
    if (typeof generationType !== 'string' || !REROLL_TYPES.has(generationType)) {
        return false;
    }
    const messages = Array.isArray(chat) ? chat : [];
    const tail = messages[messages.length - 1];
    return Boolean(tail) && !tail.is_user && !tail.is_system;
}

/**
 * The state payload a message carries, or null for a message that carries none.
 * @param {unknown} message
 * @returns {SummaryceptionContinuityState | null}
 */
function readCheckpoint(message) {
    const target = /** @type {{ extra?: Record<string, unknown> }} */ (message);
    const payload = target?.extra?.[CHECKPOINT_KEY];
    if (!isRecord(payload)) {
        return null;
    }
    return /** @type {SummaryceptionContinuityState} */ (/** @type {unknown} */ (payload));
}

/**
 * Write a checkpoint onto the audited reply. Takes the message object rather
 * than its chat index because the attach is by reference (ADR-0017): a chat
 * that grows mid-flight leaves the reference in place, and a deleted reply
 * drops the write with it.
 * @param {unknown} message - The audited reply.
 * @param {SummaryceptionContinuityState} state
 * @returns {void}
 */
export function attachCheckpoint(message, state) {
    if (!isRecord(message)) {
        return;
    }
    const target = /** @type {{ extra?: unknown }} */ (message);
    target.extra = isRecord(target.extra) ? target.extra : {};
    /** @type {Record<string, unknown>} */ (target.extra)[CHECKPOINT_KEY] = state;
}

/**
 * Drop the Continuity Checkpoint on the reply a host reroll replaces: the
 * payload describes the exact draft being replaced, and ST keeps the message
 * with its extra in the chat during the regeneration, so newest-payload-wins
 * would otherwise ship the discarded draft's state into the regenerated prompt.
 * In-memory only: ST persists the chat when the regenerated reply settles. The
 * drop fires only when the reroll replaces the chat's last message; a regenerate
 * over a trailing user turn generates a new reply and replaces nothing.
 * @param {ChatMessage[] | unknown} chat
 * @param {unknown} generationType - ST GENERATION_STARTED type argument.
 * @returns {boolean} True when a checkpoint was dropped.
 */
export function discardCheckpoint(chat, generationType) {
    const messages = Array.isArray(chat) ? chat : [];
    if (!isRerollTail(generationType, messages)) {
        return false;
    }
    const index = messages.length - 1;
    const target = /** @type {{ extra?: Record<string, unknown> }} */ (messages[index]);
    if (!target?.extra?.[CHECKPOINT_KEY]) {
        return false;
    }
    delete target.extra[CHECKPOINT_KEY];
    trace(
        `Continuity checkpoint dropped: host ${generationType} replaces the audited reply (@${index})`,
    );
    return true;
}

/**
 * Drop every Continuity Checkpoint in the chat. Payload presence is the
 * Continuity State (ADR-0017), so a chat that keeps its payloads keeps a live
 * state, its Continuity Marks, and its injected block; Clear removes them with
 * the rest of Extension Chat Data (ADR-0027).
 * @param {ChatMessage[] | unknown} chat
 * @returns {void}
 */
export function removeCheckpoints(chat) {
    if (!Array.isArray(chat)) {
        return;
    }
    for (const message of chat) {
        if (!isRecord(message)) {
            continue;
        }
        const target = /** @type {{ extra?: unknown }} */ (message);
        if (isRecord(target.extra)) {
            delete (/** @type {Record<string, unknown>} */ (target.extra)[CHECKPOINT_KEY]);
        }
    }
}

/**
 * The Continuity Mark read model's input: every reply whose extra carries a
 * checkpoint payload, in chat order. No freshness test and no coverage math —
 * a hidden reply keeps its payload and its mark (ADR-0022, ADR-0028).
 * @param {ChatMessage[] | unknown} chat
 * @returns {number[]}
 */
export function listCheckpointIndices(chat) {
    const messages = Array.isArray(chat) ? chat : [];
    const indices = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (isAssistantMessage(message) && readCheckpoint(message) !== null) {
            indices.push(index);
        }
    }
    return indices;
}

/**
 * The newest message whose extra carries a Continuity State payload wins; no
 * hash, no chain, no anchor rule (ADR-0017). The excluded tail keeps its
 * payload but never anchors coverage: it describes the draft being replaced.
 * @param {ChatMessage[] | unknown} chat
 * @param {number} excludedIndex - Chat index excluded from the prompt, or -1.
 * @returns {{ state: SummaryceptionContinuityState, index: number } | null}
 */
export function findLiveCheckpoint(chat, excludedIndex) {
    const messages = Array.isArray(chat) ? chat : [];
    for (let index = messages.length - 1; index >= 0; index--) {
        if (index === excludedIndex) {
            continue;
        }
        const message = messages[index];
        if (!isAssistantMessage(message)) {
            continue;
        }
        const state = readCheckpoint(message);
        if (state) {
            return { state, index };
        }
    }
    return null;
}
