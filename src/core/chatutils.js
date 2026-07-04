import { getChatStore, getSettings } from '../foundation/state.js';
import { applyRegexToMessage } from './regex-proxy.js';
import { countTextTokens } from './token-count.js';

// ─── Assistant Turn Utilities ────────────────────────────────────────

/**
 * Extract all assistant turns from the chat.
 * @param {Array} chat - The SillyTavern chat array
 * @returns {Array<{index: number, mes: string, name: string}>} Assistant turns
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
 * @param {Array} chat - The SillyTavern chat array
 * @returns {Array<{index: number, mes: string, name: string}>} Visible assistant turns
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
 * @param {Array} chat - The SillyTavern chat array
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
 * @param {Array} chat
 * @param {number} startIdx
 * @param {number} endIdx
 * @returns {Promise<PassageWithStats>}
 */
export async function buildPassageFromRangeWithStats(chat, startIdx, endIdx) {
    const rawLines = [];
    const finalLines = [];
    let changedMessageCount = 0;
    const promptDepths = getPromptDepthsByChatIndex(chat);
    const applyRegexScripts = getSettings().applyRegexScripts;

    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        if (!m) {
            continue;
        }
        if (!m.mes || !m.mes.trim()) {
            continue;
        }

        // Skip messages hidden by the user (not by us)
        // A message hidden by the user will be is_system/is_hidden but NOT sc_ghosted
        // A message hidden by us will have sc_ghosted = true
        const isUserHidden = (m.is_system || m.is_hidden) && !m.extra?.sc_ghosted;
        if (isUserHidden) {
            continue;
        }

        const rawText = m.mes.trim();
        let finalText = rawText;
        if (applyRegexScripts) {
            finalText = await applyRegexToMessage(rawText, m.is_user, promptDepths.get(i));
            if (finalText !== rawText) {
                changedMessageCount++;
            }
        }

        const speaker = m.is_user ? 'Player' : 'Assistant';
        rawLines.push(`${speaker}: ${rawText}`);
        finalLines.push(`${speaker}: ${finalText}`);
    }

    const rawText = rawLines.join('\n');
    const finalText = finalLines.join('\n');
    const [rawTokenCount, finalTokenCount] = await Promise.all([
        countTextTokens(rawText),
        countTextTokens(finalText),
    ]);
    const savedTokens = rawTokenCount.count - finalTokenCount.count;

    return {
        text: finalText,
        stats: {
            rawTokens: rawTokenCount.count,
            finalTokens: finalTokenCount.count,
            savedTokens,
            savedPercent: rawTokenCount.count > 0 ? (savedTokens / rawTokenCount.count) * 100 : 0,
            rawTokensEstimated: rawTokenCount.estimated,
            finalTokensEstimated: finalTokenCount.estimated,
            savedTokensEstimated: rawTokenCount.estimated || finalTokenCount.estimated,
            changedMessageCount,
        },
    };
}

/**
 * Build passage text from a range of chat messages.
 * @param {Array} chat
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
    const parts = [];

    for (let i = store.layers.length - 1; i >= downToLayer; i--) {
        const layer = store.layers[i];
        if (!layer || layer.length === 0) {
            continue;
        }
        for (const sn of layer) {
            parts.push(sn.text);
        }
    }

    return parts.length > 0 ? parts.join(' ') : '(none yet)';
}
