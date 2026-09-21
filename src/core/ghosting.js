import { GHOST_PROGRESS } from '../foundation/constants.js';
import { executeSlashCommandsWithOptions, getChat } from '../foundation/context.js';
import {
    ensureMessageScId,
    rangesFromSortedIndices,
    resolveScIdsToIndices,
} from '../foundation/message-identity.js';
import { bumpSummaryStoreMutationEpoch, getChatStore } from '../foundation/chat-store.js';
import { getEffectiveSettings } from '../foundation/settings.js';
import { debug, error, warn } from '../foundation/logger.js';
import { persistChatState } from './persist-state.js';
import { collectSnippetSourceIds } from './snippet-provenance.js';

// Message hiding (ghosting via native /hide and /unhide)

/**
 * @typedef {object} GhostRangeOptions
 * @property {boolean} [showProgress] - Open a notify progress handle for manual work.
 * @property {string} [kind] - Prompt-effect queue label.
 * @property {'immediate' | 'deferred'} [chatSave] - Chat-file persistence mode.
 * @property {import('./notify.js').NotifyAdapter} [notify] - Adapter for progress events. When absent, the work runs silent.
 * @property {import('./foreground-gate.js').ForegroundGate} gate - The Foreground Gate every hide crosses; a hide requested mid-generation is deferred through it.
 */

/**
 * Ensure all Summaryception-eligible messages in a range are ghosted.
 * @param {number} startIdx - Start index in chat
 * @param {number} endIdx - End index in chat
 * @param {GhostRangeOptions} options
 * @returns {Promise<void>}
 */
export async function repairGhostingForRange(startIdx, endIdx, options) {
    await ghostMessagesInRange(startIdx, endIdx, { kind: 'ghost-repair', ...options });
}

/**
 * Assign Ghosting ownership and bump the Mutation Epoch when the owned id
 * list actually changed. The compare is element-wise and order-sensitive.
 * Ownership is store state, so consumers must see it move (ADR-0003).
 * @param {SummaryceptionStore} store
 * @param {string[]} nextIds
 * @returns {void}
 */
function setGhostedMessageIds(store, nextIds) {
    const current = store.ghostedMessageIds || [];
    const changed =
        current.length !== nextIds.length || nextIds.some((id, index) => current[index] !== id);
    store.ghostedMessageIds = nextIds;
    if (changed) {
        bumpSummaryStoreMutationEpoch(store);
    }
}

/**
 * Reconcile Ghosting ownership with Snippet provenance. The desired id set is
 * every sourceMessageId across all layers. Desired messages that still need
 * ownership or a visual hide go through the ranged hide engine. Owned ids no
 * longer referenced by any layer are released through the unhide path.
 * Ownership ends up exactly the desired set. Desired ids whose messages no
 * longer resolve stay owned but inert.
 * @param {GhostRangeOptions} options - Carries the notify adapter and the Foreground Gate. Without a notify adapter, the work runs silent.
 * @returns {Promise<{ hidden: number, unhidden: number }>} Messages covered by the applied hide and release ranges.
 */
export async function syncGhosting(options) {
    const chat = getChat();
    const store = getChatStore();
    const desired = collectSnippetSourceIds(store.layers);
    const desiredOwned = new Set(desired);

    const staleIds = store.ghostedMessageIds.filter((id) => !desiredOwned.has(id));
    const staleRanges = rangesFromSortedIndices(resolveScIdsToIndices(chat, staleIds));

    let hidden = 0;
    if (staleRanges.length > 0) {
        await unhideRanges({ chat, store, ranges: staleRanges, notify: options.notify });
    }

    for (const range of rangesFromSortedIndices(resolveScIdsToIndices(chat, desired))) {
        if (collectHideRanges(chat, store, range).length === 0) {
            continue;
        }
        await repairGhostingForRange(range[0], range[1], {
            notify: options.notify,
            gate: options.gate,
        });
        hidden += getRangeSize(range);
    }

    setGhostedMessageIds(store, desired);
    return { hidden, unhidden: countRangeMessages(staleRanges) };
}

/**
 * Unhide every message in the chat through the host full-range command and
 * wipe Summaryception ghost ownership.
 * @param {object} [_options] - Reserved option bag kept for parity with the other Ghosting entry points; Clear releases ownership without a gate.
 * @returns {Promise<void>}
 */
export async function clearAllGhosting(_options = {}) {
    const chat = getChat();
    if (chat.length > 0) {
        await executeSlashCommandsWithOptions(`/unhide 0-${chat.length - 1}`, {
            showOutput: false,
        });
    }
    setGhostedMessageIds(getChatStore(), []);
}

/**
 * Count chat messages under Summaryception ghost ownership.
 * @returns {number} Owned ids that still resolve in the chat. Returns 0 without a chat context.
 */
export function countGhostedMessages() {
    try {
        return resolveScIdsToIndices(getChat(), getChatStore().ghostedMessageIds).length;
    } catch (_e) {
        return 0;
    }
}

/**
 * @internal
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {GhostRangeOptions} options
 * @returns {Promise<void>}
 */
export async function ghostMessagesInRange(startIdx, endIdx, options) {
    await options.gate.runEffect({
        kind: getGhostEffectKind(startIdx, endIdx, options),
        apply: async (ctx) => await ghostMessagesInRangeEffect(startIdx, endIdx, ctx, options),
    });
}

/**
 * Apply range ghosting while the prompt guard remains open. Reporting false
 * hands the range back to the gate, which re-runs this effect once the freeze
 * lifts; a re-run recomputes the outstanding work, so a partial pass is safe.
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {import('./foreground-gate.js').PromptEffectContext} ctx
 * @param {GhostRangeOptions} options
 * @returns {Promise<boolean>} True when the range finished or needed no work.
 */
async function ghostMessagesInRangeEffect(startIdx, endIdx, ctx, options) {
    const chat = getChat();
    const range = normalizeRange(startIdx, endIdx, chat.length);

    if (!range) {
        return true;
    }

    const store = getChatStore();
    const ranges = collectHideRanges(chat, store, range);
    const total = countRangeMessages(ranges);
    const notify = options.notify;
    const progress =
        options.showProgress && total > 0 && notify
            ? notify.progress({ label: GHOST_PROGRESS.HIDE, total })
            : null;
    let processed = 0;

    for (const hideRange of ranges) {
        if (!ctx.canContinue()) {
            return deferRemainingGhosting(hideRange[0], range[1], options, progress);
        }

        const applied = await applyHideRange({
            chat,
            store,
            range: hideRange,
            canContinue: ctx.canContinue,
            chatSave: options.chatSave || 'immediate',
        });

        if (!applied) {
            return deferRemainingGhosting(hideRange[0], range[1], options, progress);
        }

        processed += getRangeSize(hideRange);
        if (notify && progress) {
            notify.update(progress, { processed });
        }
    }

    if (notify && progress) {
        notify.clear(progress);
    }
    return true;
}

/**
 * Mark a hide range as Summaryception-owned, persist it, then visually hide it.
 * @param {object} p
 * @param {ChatMessage[]} p.chat
 * @param {SummaryceptionStore} p.store
 * @param {[number, number]} p.range
 * @param {() => boolean} p.canContinue - Whether a generation replaced the one this hide started against.
 * @param {'immediate' | 'deferred'} p.chatSave
 * @returns {Promise<boolean>}
 */
async function applyHideRange({ chat, store, range, canContinue, chatSave }) {
    markGhostedRange(chat, store, range);
    await persistChatState({ chatSave });

    if (!canContinue()) {
        return false;
    }

    await executeSlashRangeCommand('hide', range, error);

    await persistChatState({ chatSave });
    return true;
}

/**
 * Hand the rest of a range back to the gate after a prompt mutation freeze.
 * @param {number} nextStart
 * @param {number} endIdx
 * @param {GhostRangeOptions} options
 * @param {unknown} progress
 * @returns {boolean} Always false; the gate re-runs the effect once the freeze lifts.
 */
function deferRemainingGhosting(nextStart, endIdx, options, progress) {
    debug(`Ghosting ${nextStart}-${endIdx} deferred; foreground generation is active.`);
    if (progress) {
        options.notify?.clear(progress);
    }
    return false;
}

/**
 * Build contiguous ranges of messages that still need ownership or visual hide work.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {[number, number]} range
 * @returns {Array<[number, number]>}
 */
function collectHideRanges(chat, store, range) {
    const indices = [];
    for (let i = range[0]; i <= range[1]; i++) {
        if (messageNeedsGhosting(chat[i], store)) {
            indices.push(i);
        }
    }
    return rangesFromSortedIndices(indices);
}

/**
 * Check whether a message needs Summaryception ownership or visual hiding.
 * @param {ChatMessage | undefined} msg
 * @param {SummaryceptionStore} store
 * @returns {boolean}
 */
function messageNeedsGhosting(msg, store) {
    if (!msg || !isGhostableMessage(msg, store)) {
        return false;
    }

    const owned = typeof msg.sc_id === 'string' && store.ghostedMessageIds.includes(msg.sc_id);
    return !owned || !isVisuallyHidden(msg);
}

/**
 * @param {ChatMessage | undefined} msg
 * @param {SummaryceptionStore} store
 * @returns {boolean}
 */
function isGhostableMessage(msg, store) {
    if (!msg) {
        return false;
    }
    const hideNonText = getEffectiveSettings().hideNonTextMessages !== false;
    if (!hideNonText && !msg.mes?.trim()) {
        return false;
    }
    return !isUserHidden(msg, store);
}

/**
 * Check whether a message is hidden outside Summaryception ownership.
 * @param {ChatMessage} msg
 * @param {SummaryceptionStore} store
 * @returns {boolean}
 */
function isUserHidden(msg, store) {
    const owned = typeof msg.sc_id === 'string' && store.ghostedMessageIds.includes(msg.sc_id);
    return isVisuallyHidden(msg) && !owned;
}

/**
 * Check whether SillyTavern is visually hiding a message.
 * @param {ChatMessage} msg
 * @returns {boolean}
 */
function isVisuallyHidden(msg) {
    return msg?.is_hidden === true || msg?.is_system === true;
}

/**
 * Record a range as ghosted in memory.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {[number, number]} range
 * @returns {void}
 */
function markGhostedRange(chat, store, range) {
    const owned = new Set(store.ghostedMessageIds);
    for (let i = range[0]; i <= range[1]; i++) {
        const id = ensureMessageScId(chat[i]);
        if (id) {
            owned.add(id);
        }
    }
    setGhostedMessageIds(store, [...owned]);
}

/**
 * Apply batched unhide commands, then clear Summaryception ownership flags.
 * @param {object} p
 * @param {ChatMessage[]} p.chat
 * @param {SummaryceptionStore} p.store
 * @param {Array<[number, number]>} p.ranges
 * @param {unknown} [p.progress]
 * @param {import('./notify.js').NotifyAdapter} [p.notify] - Adapter for progress updates
 * @returns {Promise<void>}
 */
async function unhideRanges({ chat, store, ranges, progress = null, notify }) {
    let processed = 0;
    for (const range of ranges) {
        await executeSlashRangeCommand('unhide', range, warn);
        clearGhostedRange(chat, store, range);
        processed += getRangeSize(range);
        if (notify && progress) {
            notify.update(progress, { processed });
        }
        await persistChatState();
    }
}

/**
 * Clear Summaryception ownership in a range.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {[number, number]} range
 * @returns {void}
 */
function clearGhostedRange(chat, store, range) {
    const ids = new Set();
    for (let i = range[0]; i <= range[1]; i++) {
        if (typeof chat[i]?.sc_id === 'string') {
            ids.add(chat[i].sc_id);
        }
    }
    setGhostedMessageIds(
        store,
        store.ghostedMessageIds.filter((id) => !ids.has(id)),
    );
}

/**
 * Clamp and validate a chat index range.
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {number} chatLength
 * @returns {[number, number] | null}
 */
function normalizeRange(startIdx, endIdx, chatLength) {
    if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx) || chatLength <= 0) {
        return null;
    }

    const start = Math.max(0, startIdx);
    const end = Math.min(endIdx, chatLength - 1);
    return start <= end ? /** @type {[number, number]} */ ([start, end]) : null;
}

/**
 * @param {[number, number]} range
 * @returns {string}
 */
function formatSlashRange(range) {
    return range[0] === range[1] ? String(range[0]) : `${range[0]}-${range[1]}`;
}

/**
 * @param {Array<[number, number]>} ranges
 * @returns {number}
 */
function countRangeMessages(ranges) {
    return ranges.reduce((total, range) => total + getRangeSize(range), 0);
}

/**
 * Get the number of indices in a closed range.
 * @param {[number, number]} range
 * @returns {number}
 */
function getRangeSize(range) {
    return range[1] - range[0] + 1;
}

/**
 * Build a prompt-effect queue label.
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {GhostRangeOptions} options
 * @returns {string}
 */
function getGhostEffectKind(startIdx, endIdx, options) {
    return `${options.kind || 'ghost-range'}-${startIdx}-${endIdx}`;
}

/**
 * Run a /hide or /unhide slash command for a range without output.
 * @param {'hide' | 'unhide'} command
 * @param {[number, number]} range
 * @param {(message: string, err: unknown) => void} logFailure
 * @returns {Promise<void>}
 */
async function executeSlashRangeCommand(command, range, logFailure) {
    try {
        await executeSlashCommandsWithOptions(`/${command} ${formatSlashRange(range)}`, {
            showOutput: false,
        });
    } catch (e) {
        logFailure(`Failed to ${command} messages ${formatSlashRange(range)}:`, e);
    }
}
