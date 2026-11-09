// Microfiche Raw Seal slice: the oldest-first raw-chat span the frozen-raw
// region pages. It starts just after the summarized boundary and takes whole
// messages until the combined Recent + Queued budget fills, so everything the
// epoch did not seal keeps shipping as the text tail. The page source seals
// the result for the epoch, so this module never re-runs inside one epoch.

import { formatMessageSpeakerLine, isSummarizerConversationMessage } from './chatutils.js';
import { getCurrentSummarizedBoundary } from './snippet-provenance.js';
import { resolveRawChatBucketTokens } from './token-budget.js';
import { APPROX_TEXT_UNITS_PER_TOKEN } from './token-count.js';

/**
 * Select the Raw Seal slice: the verbatim window plus queued span, oldest
 * first. Messages after the summarized boundary are the candidate; whole
 * messages are taken in order until the combined raw-chat budget fills, so
 * later chat growth stays text. An absent or zero budget reads as unbounded,
 * so a sparse settings bag still yields a slice.
 * @param {ChatMessage[]} chat - Live chat array.
 * @param {SummaryceptionStore} store - Store carrying Layer 0 provenance.
 * @param {object | null} settings - Settings carrying the raw-chat budgets.
 * @returns {string[]} Speaker lines in chronological order.
 */
export function buildMicroficheRawSlice(chat, store, settings) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return [];
    }
    const boundary = getCurrentSummarizedBoundary(chat, store);
    const bucket = resolveRawChatBucketTokens(settings);
    const bounded = Number.isFinite(bucket) && bucket > 0;
    /** @type {string[]} */
    const lines = [];
    let tokens = 0;
    for (let index = boundary + 1; index < chat.length; index += 1) {
        const message = chat[index];
        if (!isSummarizerConversationMessage(message)) {
            continue;
        }
        const text = String(message.mes || '').trim();
        if (!text) {
            continue;
        }
        const line = formatMessageSpeakerLine(message, text);
        const lineTokens = Math.ceil(line.length / APPROX_TEXT_UNITS_PER_TOKEN);
        if (bounded && lines.length > 0 && tokens + lineTokens > bucket) {
            break;
        }
        lines.push(line);
        tokens += lineTokens;
    }
    return lines;
}
