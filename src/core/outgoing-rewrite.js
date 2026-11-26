import {
    GUARD_MASK_COT_AUTO_COUNT,
    GUARD_MASK_COT_MODES,
    MASK_USER_ROLE_MODES,
    SLIDER_LIMITS,
} from '../foundation/constants.js';
import { stripChineseIdeographs } from './cn-text.js';
import {
    maskGuardContentParts,
    maskGuardText,
    unmaskGuardContentParts,
    unmaskGuardText,
} from './guard-mask.js';
import { clampInteger } from '../foundation/numeric.js';

const COMPATIBILITY_MARKER_CONTENT = '[user-role compatibility marker]';
const DASH_SEPARATOR_REGEX = /[\u2014\u2015]/g;

/**
 * @typedef {object} OutgoingSlotIdentity
 * @property {'placed' | 'absent' | 'unresolved'} state - Structural slot state.
 * @property {object | null} message - Exact slot message reference.
 * @property {string | null} expectedText - Frozen string content for string slots.
 * @property {Array<string | null> | null} expectedParts - Frozen per-part text for multipart slots.
 * @property {string | null} [reason] - Entry-provided unresolved reason.
 */

/**
 * @typedef {object} OutgoingFrozenContext
 * @property {boolean} [enabled] - False leaves messages untouched.
 * @property {boolean} [stripChineseIdeographs] - True scrubs assistant Han ideographs.
 * @property {boolean} [maskUserRoleAsAssistant] - True rewrites user roles to assistant.
 * @property {string} [maskUserRoleMode] - Role mask mode name.
 * @property {boolean} [guardMaskMemory] - True masks the Memory Slot normally.
 * @property {string} [guardMaskCotMode] - Preset CoT exemption mode name.
 * @property {number} [guardMaskCotCount] - Preset CoT exemption window for mode on.
 * @property {boolean} [guardEnabled] - Resolved model verdict from entry.
 * @property {string | null} [chatTailAnchor] - Captured last-chat text for the Preset CoT anchor.
 * @property {OutgoingSlotIdentity | null} [slot] - Structural Memory Slot identity.
 */

/**
 * @typedef {object} OutgoingRewriteResult
 * @property {number} rewrittenCount - User messages rewritten to assistant.
 * @property {'mask' | 'unmask' | 'none'} guardBranch - Guard branch taken.
 * @property {'skipped' | 'masked' | 'absent' | 'unresolved' | 'stale'} slotStatus - Slot skip outcome.
 * @property {string | null} staleReason - Stale or unresolved reason, if any.
 */

/**
 * Pure outgoing prompt rewrite: CN scrub, user-role rewrite, then Guard Mask
 * or Guard Unmask. Mutates the supplied messages in place. Entry resolves the
 * model verdict, the chat-tail anchor, and the structural slot identity; this
 * module never reads host state. Slot skip uses only the exact message
 * reference plus frozen expected part text, never string equality, so
 * identical text outside the slot still masks. Missing, stale, or mismatched
 * identity over-masks and reports stale.
 * @param {Array<Record<string, unknown>>} messages - Prompt messages to mutate.
 * @param {OutgoingFrozenContext} [frozenContext] - Frozen explicit context.
 * @returns {OutgoingRewriteResult} Structured result.
 */
export function rewriteOutgoingPrompt(messages, frozenContext = {}) {
    const context = frozenContext || {};
    if (!Array.isArray(messages) || !context.enabled) {
        const idle = resolveSlotDecision(messages, context.slot, 'none', context);
        return {
            rewrittenCount: 0,
            guardBranch: 'none',
            slotStatus: idle.slotStatus,
            staleReason: idle.staleReason,
        };
    }

    scrubAssistantContent(messages, context);
    const rewrittenCount = rewriteUserRoles(messages, context);

    if (context.guardEnabled) {
        const decision = resolveSlotDecision(messages, context.slot, 'mask', context);
        const exempt = collectPresetCotExemptions(messages, context);
        applyGuardMask(messages, exempt, decision.shouldSkip ? decision.slotMessage : null);
        return {
            rewrittenCount,
            guardBranch: 'mask',
            slotStatus: decision.slotStatus,
            staleReason: decision.staleReason,
        };
    }

    const decision = resolveSlotDecision(messages, context.slot, 'unmask', context);
    applyGuardUnmask(messages);
    return {
        rewrittenCount,
        guardBranch: 'unmask',
        slotStatus: decision.slotStatus,
        staleReason: decision.staleReason,
    };
}

/**
 * Strip Han ideographs and dash separators from pre-existing assistant
 * content. Runs before the role rewrite so only content that started as
 * assistant is scrubbed.
 * @param {Array<Record<string, unknown>>} messages
 * @param {OutgoingFrozenContext} context
 * @returns {void}
 */
function scrubAssistantContent(messages, context) {
    if (!context.stripChineseIdeographs) {
        return;
    }
    for (const message of messages) {
        if (!message || message.role !== 'assistant') {
            continue;
        }
        const content = message.content;
        if (typeof content === 'string') {
            message.content = scrubText(content);
            continue;
        }
        if (!Array.isArray(content)) {
            continue;
        }
        for (const part of content) {
            if (!part || typeof part !== 'object') {
                continue;
            }
            const entry = /** @type {{ text?: unknown }} */ (part);
            if (typeof entry.text === 'string') {
                entry.text = scrubText(entry.text);
            }
        }
    }
}

/**
 * @param {string} text
 * @returns {string}
 */
function scrubText(text) {
    return stripChineseIdeographs(String(text).replace(DASH_SEPARATOR_REGEX, ' '));
}

/**
 * @param {Array<Record<string, unknown>>} messages
 * @param {OutgoingFrozenContext} context
 * @returns {number}
 */
function rewriteUserRoles(messages, context) {
    if (!context.maskUserRoleAsAssistant) {
        return 0;
    }
    const userMessages = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message && message.role === 'user') {
            userMessages.push({ index, message });
        }
    }
    if (userMessages.length === 0) {
        return 0;
    }

    const mode = normalizeMaskMode(context.maskUserRoleMode);
    if (mode === MASK_USER_ROLE_MODES.MARKER_FIRST) {
        messages.unshift({ role: 'user', content: COMPATIBILITY_MARKER_CONTENT });
    }

    const preservedMessage =
        mode === MASK_USER_ROLE_MODES.KEEP_LAST_USER
            ? userMessages[userMessages.length - 1].message
            : null;
    let rewritten = 0;
    for (const entry of userMessages) {
        if (entry.message === preservedMessage) {
            continue;
        }
        entry.message.role = 'assistant';
        rewritten++;
    }

    if (mode === MASK_USER_ROLE_MODES.MARKER_LAST) {
        messages.push({ role: 'user', content: COMPATIBILITY_MARKER_CONTENT });
    }
    return rewritten;
}

/**
 * @param {unknown} value
 * @returns {typeof MASK_USER_ROLE_MODES.MARKER_FIRST | typeof MASK_USER_ROLE_MODES.REWRITE_ALL | typeof MASK_USER_ROLE_MODES.MARKER_LAST | typeof MASK_USER_ROLE_MODES.KEEP_LAST_USER}
 */
function normalizeMaskMode(value) {
    const mode = String(value || '');
    if (/** @type {string[]} */ (Object.values(MASK_USER_ROLE_MODES)).includes(mode)) {
        return /** @type {typeof MASK_USER_ROLE_MODES.MARKER_FIRST | typeof MASK_USER_ROLE_MODES.REWRITE_ALL | typeof MASK_USER_ROLE_MODES.MARKER_LAST | typeof MASK_USER_ROLE_MODES.KEEP_LAST_USER} */ (
            mode
        );
    }
    return MASK_USER_ROLE_MODES.MARKER_FIRST;
}

/**
 * ENABLED branch: mask user and assistant content except the trailing Preset
 * CoT window and the verified slot reference.
 * @param {Array<Record<string, unknown>>} messages
 * @param {Set<number>} exempt - Trailing Preset CoT indexes.
 * @param {Record<string, unknown> | null} slotMessage - Exact reference to skip.
 * @returns {void}
 */
function applyGuardMask(messages, exempt, slotMessage) {
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
            continue;
        }
        if (exempt.has(index)) {
            continue;
        }
        if (slotMessage !== null && message === slotMessage) {
            continue;
        }
        if (typeof message.content === 'string') {
            message.content = maskGuardText(message.content);
            continue;
        }
        maskGuardContentParts(message.content);
    }
}

/**
 * DISABLED branch: fold every mask character back to one space. No
 * exemptions and no slot skip.
 * @param {Array<Record<string, unknown>>} messages
 * @returns {void}
 */
function applyGuardUnmask(messages) {
    for (const message of messages) {
        if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
            continue;
        }
        if (typeof message.content === 'string') {
            message.content = unmaskGuardText(message.content);
            continue;
        }
        unmaskGuardContentParts(message.content);
    }
}

/**
 * @param {Array<Record<string, unknown>> | unknown} messages
 * @param {OutgoingSlotIdentity | null | undefined} slot
 * @param {'mask' | 'unmask' | 'none'} guardBranch
 * @param {OutgoingFrozenContext} context
 * @returns {{ shouldSkip: boolean, slotMessage: Record<string, unknown> | null, slotStatus: OutgoingRewriteResult['slotStatus'], staleReason: string | null }}
 */
function resolveSlotDecision(messages, slot, guardBranch, context) {
    if (!slot || slot.state === 'absent') {
        return { shouldSkip: false, slotMessage: null, slotStatus: 'absent', staleReason: null };
    }
    if (slot.state === 'unresolved') {
        return {
            shouldSkip: false,
            slotMessage: null,
            slotStatus: 'unresolved',
            staleReason:
                typeof slot.reason === 'string' && slot.reason ? slot.reason : 'unresolved',
        };
    }
    if (slot.state !== 'placed') {
        return {
            shouldSkip: false,
            slotMessage: null,
            slotStatus: 'unresolved',
            staleReason: 'unknown-state',
        };
    }
    const candidate = /** @type {Record<string, unknown> | null} */ (slot.message);
    if (
        !candidate ||
        typeof candidate !== 'object' ||
        !Array.isArray(messages) ||
        !messages.includes(candidate)
    ) {
        return {
            shouldSkip: false,
            slotMessage: null,
            slotStatus: 'stale',
            staleReason: 'missing',
        };
    }
    if (!isSlotContentFresh(candidate, slot)) {
        return {
            shouldSkip: false,
            slotMessage: null,
            slotStatus: 'stale',
            staleReason: 'content-changed',
        };
    }
    if (guardBranch === 'mask' && !context.guardMaskMemory) {
        return {
            shouldSkip: true,
            slotMessage: candidate,
            slotStatus: 'skipped',
            staleReason: null,
        };
    }
    return { shouldSkip: false, slotMessage: null, slotStatus: 'masked', staleReason: null };
}

/**
 * Structural freshness: the exact reference still carries the frozen expected
 * part text. Any type or text mismatch is stale, which over-masks.
 * @param {Record<string, unknown>} candidate
 * @param {OutgoingSlotIdentity} slot
 * @returns {boolean}
 */
function isSlotContentFresh(candidate, slot) {
    if (typeof slot.expectedText === 'string') {
        return candidate.content === slot.expectedText;
    }
    if (Array.isArray(slot.expectedParts)) {
        if (
            !Array.isArray(candidate.content) ||
            candidate.content.length !== slot.expectedParts.length
        ) {
            return false;
        }
        for (let index = 0; index < slot.expectedParts.length; index++) {
            const part = candidate.content[index];
            const current =
                part &&
                typeof part === 'object' &&
                typeof (/** @type {{ text?: unknown }} */ (part).text) === 'string'
                    ? /** @type {{ text: string }} */ (part).text
                    : null;
            if (current !== slot.expectedParts[index]) {
                return false;
            }
        }
        return true;
    }
    return false;
}

/**
 * @param {Array<Record<string, unknown>>} messages
 * @param {OutgoingFrozenContext} context
 * @returns {Set<number>}
 */
function collectPresetCotExemptions(messages, context) {
    const count = resolvePresetCotCount(context);
    if (count === 0) {
        return new Set();
    }
    const anchorIndex = findLastChatMessageIndex(messages, context.chatTailAnchor);
    if (anchorIndex === -1) {
        return new Set();
    }
    const exempt = new Set();
    for (let index = anchorIndex + 1; index < messages.length && exempt.size < count; index++) {
        if (messages[index] && messages[index].role === 'user') {
            exempt.add(index);
        }
    }
    return exempt;
}

/**
 * @param {OutgoingFrozenContext} context
 * @returns {number}
 */
function resolvePresetCotCount(context) {
    const mode =
        context.guardMaskCotMode === GUARD_MASK_COT_MODES.OFF ||
        context.guardMaskCotMode === GUARD_MASK_COT_MODES.ON
            ? context.guardMaskCotMode
            : GUARD_MASK_COT_MODES.AUTO;
    if (mode === GUARD_MASK_COT_MODES.OFF) {
        return 0;
    }
    if (mode === GUARD_MASK_COT_MODES.AUTO) {
        return GUARD_MASK_COT_AUTO_COUNT;
    }
    const { MIN, MAX } = SLIDER_LIMITS.guardMaskCotCount;
    return clampInteger(context.guardMaskCotCount, MIN, MAX);
}

/**
 * @param {Array<Record<string, unknown>>} messages
 * @param {string | null | undefined} anchor
 * @returns {number}
 */
function findLastChatMessageIndex(messages, anchor) {
    const normalized = normalizeAnchorText(typeof anchor === 'string' ? anchor : '');
    if (!normalized) {
        return -1;
    }
    for (let index = messages.length - 1; index >= 0; index--) {
        if (
            matchesAnchor(messageText(messages[index] ? messages[index].content : ''), normalized)
        ) {
            return index;
        }
    }
    return -1;
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function messageText(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    let text = '';
    for (const part of content) {
        if (!part || typeof part !== 'object') {
            continue;
        }
        const entry = /** @type {{ type?: unknown, text?: unknown }} */ (part);
        if (entry.type === 'text' && typeof entry.text === 'string') {
            text += entry.text;
        }
    }
    return text;
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeAnchorText(text) {
    return String(text).replaceAll('\r', '').trim();
}

/**
 * @param {string} content
 * @param {string} anchor
 * @returns {boolean}
 */
function matchesAnchor(content, anchor) {
    const candidate = normalizeAnchorText(content);
    if (candidate === anchor) {
        return true;
    }
    if (!candidate.endsWith(anchor)) {
        return false;
    }
    const prefix = candidate.slice(0, candidate.length - anchor.length);
    return /^[^:\n]{1,80}:\s+$/.test(prefix);
}
