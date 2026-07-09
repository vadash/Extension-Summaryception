import { getChatStore, getEffectiveSettings } from '../foundation/state.js';
import { applyRegexToMessage } from './regex-proxy.js';
import { buildMemoryInjection } from './memory-injection.js';
import { countMessageTokens } from './token-count.js';

export { buildMemoryInjection } from './memory-injection.js';

// ─── Assistant Turn Utilities ────────────────────────────────────────

/**
 * @typedef {object} AssistantTurn
 * @property {number} index - Chat index for the assistant turn.
 * @property {string} mes - Assistant message text.
 * @property {string} name - Assistant display name.
 */

/**
 * @typedef {object} IndexedChatMessage
 * @property {number} index - Chat index for the message.
 * @property {ChatMessage} message - Message at the index.
 */

/**
 * Find the latest message at or before a start index that matches a predicate.
 * @param {ChatMessage[]} chat - The SillyTavern chat array
 * @param {number} startIndex - Index to begin searching from
 * @param {(message: ChatMessage, index: number) => boolean} predicate - Match predicate
 * @param {number} [minIndex] - Lowest index to inspect
 * @returns {IndexedChatMessage|null} Matching message, or null
 */
export function findLastMessage(chat, startIndex, predicate, minIndex = 0) {
    if (!Number.isFinite(startIndex) || !Number.isFinite(minIndex) || startIndex < minIndex) {
        return null;
    }

    for (const entry of iterateChatRange(chat, startIndex, minIndex)) {
        if (predicate(entry.message, entry.index)) {
            return entry;
        }
    }

    return null;
}

/**
 * Iterate an inclusive chat range, forward or backward, clamped to existing indices.
 * @param {ChatMessage[]} chat - The SillyTavern chat array
 * @param {number} startIndex - Requested start index
 * @param {number} endIndex - Requested end index
 * @yields {IndexedChatMessage} Indexed messages in traversal order
 * @returns {IterableIterator<IndexedChatMessage>} Indexed messages in traversal order
 */
export function* iterateChatRange(chat, startIndex, endIndex) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return;
    }
    if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) {
        return;
    }

    if (startIndex <= endIndex) {
        yield* iterateForwardChatRange(chat, startIndex, endIndex);
        return;
    }

    yield* iterateBackwardChatRange(chat, startIndex, endIndex);
}

function* iterateForwardChatRange(chat, startIndex, endIndex) {
    const start = Math.max(0, Math.trunc(startIndex));
    const end = Math.min(chat.length - 1, Math.trunc(endIndex));
    if (start > end) {
        return;
    }

    for (let i = start; i <= end; i++) {
        yield { index: i, message: chat[i] };
    }
}

function* iterateBackwardChatRange(chat, startIndex, endIndex) {
    const start = Math.min(chat.length - 1, Math.trunc(startIndex));
    const end = Math.max(0, Math.trunc(endIndex));
    if (start < end) {
        return;
    }

    for (let i = start; i >= end; i--) {
        yield { index: i, message: chat[i] };
    }
}

/**
 * Extract all assistant turns from the chat.
 * @param {ChatMessage[]} chat - The SillyTavern chat array
 * @returns {AssistantTurn[]} Assistant turns
 */
export function getAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        const isOurGhost = m.extra?.sc_ghosted === true;
        const isAssistant = !m.is_user && (!m.is_system || isOurGhost);
        if (isAssistant && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

/**
 * Get assistant turns that are not ghosted or hidden.
 * @param {ChatMessage[]} chat - The SillyTavern chat array
 * @returns {AssistantTurn[]} Visible assistant turns
 */
export function getVisibleAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (
            !m.is_user &&
            !m.is_system &&
            !m.extra?.sc_ghosted &&
            m.mes &&
            m.mes.trim().length > 0
        ) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

/**
 * Map chat indices to SillyTavern prompt depth for regex min/max depth filters.
 * @param {ChatMessage[]} chat - The SillyTavern chat array
 * @returns {Map<number, number>} Prompt depth by chat index
 */
export function getPromptDepthsByChatIndex(chat) {
    const promptIndexes = [];
    const depths = new Map();

    for (let i = 0; i < chat.length; i++) {
        if (!chat[i]?.is_system) {
            promptIndexes.push(i);
        }
    }

    for (let i = 0; i < promptIndexes.length; i++) {
        depths.set(promptIndexes[i], promptIndexes.length - i - 1);
    }

    return depths;
}

/**
 * @typedef {object} PassageRegexStats
 * @property {number} rawTokens - Rendered passage tokens before regex scripts
 * @property {number} finalTokens - Rendered passage tokens after regex scripts
 * @property {number} savedTokens - Raw tokens minus final tokens
 * @property {number} savedPercent - Percent of raw tokens removed by regex scripts
 * @property {boolean} rawTokensEstimated - Whether rawTokens came from fallback estimation
 * @property {boolean} finalTokensEstimated - Whether finalTokens came from fallback estimation
 * @property {boolean} savedTokensEstimated - Whether savedTokens includes fallback estimation
 * @property {number} changedMessageCount - Number of messages changed by regex scripts
 */

/**
 * @typedef {object} PassageWithStats
 * @property {string} text - Rendered passage text after regex scripts
 * @property {PassageRegexStats} stats - Passage token stats
 */

/**
 * Build passage text and regex token stats from a range of chat messages.
 * Skips messages that are hidden (by user or system) UNLESS they were
 * hidden by Summaryception (sc_ghosted). Also skips empty messages.
 * @param {ChatMessage[]} chat
 * @param {number} startIdx
 * @param {number} endIdx
 * @returns {Promise<PassageWithStats>}
 */
export async function buildPassageFromRangeWithStats(chat, startIdx, endIdx) {
    const accumulator = createPassageStatsAccumulator();
    const promptDepths = getPromptDepthsByChatIndex(chat);
    const applyRegexScripts = getEffectiveSettings().applyRegexScripts;

    for (let i = startIdx; i <= endIdx; i++) {
        const rendered = await renderPassageMessage({
            message: chat[i],
            depth: promptDepths.get(i),
            applyRegexScripts,
        });
        if (!rendered) {
            continue;
        }

        accumulator.finalLines.push(rendered.finalLine);
        accumulator.changedMessageCount += rendered.changed ? 1 : 0;
        addPassageTokenStats(
            accumulator,
            await countMessageTokens(rendered.message, rendered.rawLine, rendered.finalLine),
        );
    }

    return buildPassageResult(accumulator);
}

function createPassageStatsAccumulator() {
    return {
        finalLines: /** @type {string[]} */ ([]),
        changedMessageCount: 0,
        rawTokens: 0,
        finalTokens: 0,
        rawTokensEstimated: false,
        finalTokensEstimated: false,
    };
}

async function renderPassageMessage({ message, depth, applyRegexScripts }) {
    if (!isMessagePassageEligible(message)) {
        return null;
    }

    const rawText = message.mes.trim();
    const finalText = await getPassageFinalText({
        message,
        rawText,
        depth,
        applyRegexScripts,
    });
    const speaker = message.is_user ? 'Player' : 'Assistant';

    return {
        message,
        rawLine: `${speaker}: ${rawText}`,
        finalLine: `${speaker}: ${finalText}`,
        changed: finalText !== rawText,
    };
}

function isMessagePassageEligible(message) {
    if (!message?.mes || !message.mes.trim()) {
        return false;
    }
    return !isUserHiddenMessage(message);
}

function isUserHiddenMessage(message) {
    return (message.is_system || message.is_hidden) && !message.extra?.sc_ghosted;
}

async function getPassageFinalText({ message, rawText, depth, applyRegexScripts }) {
    if (!applyRegexScripts) {
        return rawText;
    }
    return await applyRegexToMessage(rawText, message.is_user, depth);
}

function addPassageTokenStats(accumulator, counted) {
    accumulator.rawTokens += counted.rawTokens;
    accumulator.finalTokens += counted.finalTokens;
    accumulator.rawTokensEstimated ||= counted.rawTokensEstimated;
    accumulator.finalTokensEstimated ||= counted.finalTokensEstimated;
}

function buildPassageResult(accumulator) {
    const finalText = accumulator.finalLines.join('\n');
    const savedTokens = accumulator.rawTokens - accumulator.finalTokens;

    return {
        text: finalText,
        stats: {
            rawTokens: accumulator.rawTokens,
            finalTokens: accumulator.finalTokens,
            savedTokens,
            savedPercent:
                accumulator.rawTokens > 0 ? (savedTokens / accumulator.rawTokens) * 100 : 0,
            rawTokensEstimated: accumulator.rawTokensEstimated,
            finalTokensEstimated: accumulator.finalTokensEstimated,
            savedTokensEstimated:
                accumulator.rawTokensEstimated || accumulator.finalTokensEstimated,
            changedMessageCount: accumulator.changedMessageCount,
        },
    };
}

/**
 * Build passage text from a range of chat messages.
 * @param {ChatMessage[]} chat
 * @param {number} startIdx
 * @param {number} endIdx
 * @returns {Promise<string>}
 */
export async function buildPassageFromRange(chat, startIdx, endIdx) {
    const passage = await buildPassageFromRangeWithStats(chat, startIdx, endIdx);
    return passage.text;
}

/**
 * Build a full context string from all layers down to (and including) a target layer.
 * Deepest layers first, target layer last — gives the summarizer full awareness
 * of what's already been captured so it can avoid redundancy.
 *
 * @param {number} downToLayer - Include this layer and all layers above it
 * @returns {string} - Combined context string, or '(none yet)'
 */
export function buildFullContext(downToLayer = 0) {
    const store = getChatStore();
    const memory = buildMemoryInjection(getLayersAtOrAbove(store.layers, downToLayer));
    return memory || '(none yet)';
}

function getLayersAtOrAbove(layers, downToLayer) {
    if (!Array.isArray(layers)) {
        return [];
    }
    return layers.slice(Math.max(0, downToLayer));
}
