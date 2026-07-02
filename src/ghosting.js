import { LOG_PREFIX, MODULE_NAME } from './constants.js';
import { getChatStore, getSettings, saveChatStore } from './state.js';
import { log, trace } from './logger.js';

// ─── Message Hiding (Ghosting via native /hide /unhide) ──────────────
export async function repairGhostingForRange(startIdx, endIdx) {
    trace('>>> ENTERING repairGhostingForRange');
    trace(' startIdx:', startIdx, 'endIdx:', endIdx);

    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const s = getSettings();
    let repaired = 0;
    let skipped = 0;

    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        if (!m) continue;

        if (m.extra?.sc_ghosted) {
            skipped++;
            continue;
        }

        if (m.is_hidden && !m.extra?.sc_ghosted) {
            trace(' Skipping message ' + i + ' - user-hidden');
            skipped++;
            continue;
        }

        if (m.is_system || !m.mes?.trim()) {
            skipped++;
            continue;
        }

        if (m.is_user) {
            skipped++;
            continue;
        }

        trace(' Ghosting message ' + i);
        m.extra = m.extra || {};
        m.extra.sc_ghosted = true;

        if (!store.ghostedIndices.includes(i)) {
            store.ghostedIndices.push(i);
        }

        // Only visually hide if ghosting is enabled
        if (!s.disableGhosting) {
            try {
                await SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${i}`, { showOutput: false });
                repaired++;
            } catch (e) {
                console.error(LOG_PREFIX, 'Failed to ghost message ' + i + ':', e);
            }
        } else {
            repaired++;
        }
    }

    trace(' Repaired:', repaired, 'Skipped:', skipped);
    await saveChatStore();
    trace('<<< EXITING repairGhostingForRange');
    return repaired;
}

export async function ghostMessage(messageIndex) {
    const { chat } = SillyTavern.getContext();
    const msg = chat[messageIndex];
    if (!msg) return;
    if (!msg.extra) msg.extra = {};
    if (msg.extra.sc_ghosted) return;

    msg.extra.sc_ghosted = true;

    // Track that WE ghosted this message
    const store = getChatStore();
    if (!store.ghostedIndices.includes(messageIndex)) {
        store.ghostedIndices.push(messageIndex);
    }

    // Only visually hide if ghosting is enabled
    const s = getSettings();
    if (!s.disableGhosting) {
        try {
            await SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${messageIndex}`, { showOutput: false });
        } catch (e) {
            log(`Failed to hide message ${messageIndex}:`, e);
        }
    }

    log(`Ghosted message at index ${messageIndex}${s.disableGhosting ? ' (hiding disabled)' : ''}`);
}

export async function unghostAllMessages() {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    // Only unhide messages that WE ghosted, not user-hidden messages
    const toUnhide = store.ghostedIndices && store.ghostedIndices.length > 0
        ? [...store.ghostedIndices]
        : [];

    // Fallback for older saves that don't have ghostedIndices:
    // find messages with our sc_ghosted flag
    if (toUnhide.length === 0) {
        for (let i = 0; i < chat.length; i++) {
            if (chat[i]?.extra?.sc_ghosted) {
                toUnhide.push(i);
            }
        }
    }

    if (toUnhide.length === 0) return;

    const progressToast = toastr.info(
        `Unhiding messages: 0 / ${toUnhide.length}`,
        'Summaryception — Clearing',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
        }
    );

    let processed = 0;
    for (const idx of toUnhide) {
        if (idx >= 0 && idx < chat.length) {
            // Clear our ghost flag
            if (chat[idx]?.extra?.sc_ghosted) {
                delete chat[idx].extra.sc_ghosted;
            }

            try {
                await SillyTavern.getContext().executeSlashCommandsWithOptions(`/unhide ${idx}`, { showOutput: false });
            } catch (e) {
                log(`Failed to unhide message ${idx}:`, e);
            }
        }

        processed++;
        if (processed % 10 === 0) {
            const pct = Math.round((processed / toUnhide.length) * 100);
            $(progressToast).find('.toast-message').text(
                `Unhiding messages: ${processed} / ${toUnhide.length} (${pct}%)`
            );
        }
    }

    // Clear the tracking array
    store.ghostedIndices = [];

    toastr.clear(progressToast);
    log(`Unghosted ${toUnhide.length} messages (only Summaryception-hidden ones)`);
}

export async function ghostMessagesUpTo(endIndex) {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const s = getSettings();

    const progressToast = !s.disableGhosting ? toastr.info(
        `Hiding messages: 0 / ${endIndex + 1}`,
        'Summaryception — Ghosting',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
        }
    ) : null;

    let processed = 0;
    for (let i = 0; i <= endIndex; i++) {
        const msg = chat[i];
        if (!msg) continue;
        if (msg.is_system && !msg.extra?.sc_ghosted) continue;
        if (!msg.extra) msg.extra = {};
        if (msg.extra.sc_ghosted) continue;

        // Check if the message is already hidden by the user (not by us)
        if (msg.is_hidden) {
            log(`Skipping message ${i} — already hidden by user`);
            continue;
        }

        msg.extra.sc_ghosted = true;

        // Track that WE ghosted this message
        if (!store.ghostedIndices.includes(i)) {
            store.ghostedIndices.push(i);
        }

        // Only visually hide if ghosting is enabled
        if (!s.disableGhosting) {
            try {
                await SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${i}`, { showOutput: false });
            } catch (e) {
                log(`Failed to hide message ${i}:`, e);
            }
        }

        processed++;
        if (!s.disableGhosting && progressToast && processed % 10 === 0) {
            const pct = Math.round((i / (endIndex + 1)) * 100);
            $(progressToast).find('.toast-message').text(
                `Hiding messages: ${i} / ${endIndex + 1} (${pct}%)`
            );
        }
    }

    if (progressToast) toastr.clear(progressToast);
    log(`Ghosted messages from index 0 to ${endIndex}${s.disableGhosting ? ' (hiding disabled — metadata only)' : ''}`);
}

// ─── Branch Detection & Repair ───────────────────────────────────────

/**
 * Detect if the current chat was branched before the summarized point.
 * When ST creates a branch at message N, it copies messages 0..N into a new chat file.
 * But chatMetadata (including our store) is copied as-is, so summarizedUpTo might
 * point beyond the end of the new chat, and snippets may reference turns that
 * no longer exist in this branch.
 *
 * This function detects that condition and trims our store to match reality.
 */
export async function repairIfBranched() {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    if (!chat || chat.length === 0) return;
    if (store.summarizedUpTo < 0) return;

    const chatLength = chat.length;

    // If summarizedUpTo is beyond (or at) the end of the chat, we branched
    if (store.summarizedUpTo >= chatLength) {
        const oldSummarizedUpTo = store.summarizedUpTo;
        log(`Branch detected! summarizedUpTo (${oldSummarizedUpTo}) >= chat length (${chatLength}). Repairing...`);

        // Find the safe cutoff — the last message index that actually exists
        const safeCutoff = chatLength - 1;

        // Remove Layer 0 snippets whose turnRange extends beyond the branch point
        if (store.layers[0]) {
            const before = store.layers[0].length;
            store.layers[0] = store.layers[0].filter(sn => {
                if (!sn.turnRange) return true; // promoted snippets without turnRange are kept
                return sn.turnRange[1] < chatLength;
            });
            const removed = before - store.layers[0].length;
            if (removed > 0) {
                log(`Removed ${removed} Layer 0 snippets that referenced turns beyond branch point`);
            }
        }

        // Recalculate summarizedUpTo based on remaining snippets
        if (store.layers[0] && store.layers[0].length > 0) {
            const maxEnd = Math.max(...store.layers[0]
            .filter(sn => sn.turnRange)
            .map(sn => sn.turnRange[1]));
            store.summarizedUpTo = maxEnd;
        } else {
            store.summarizedUpTo = -1;
        }

        // Trim ghostedIndices to only include valid indices
        if (store.ghostedIndices) {
            store.ghostedIndices = store.ghostedIndices.filter(idx => idx < chatLength);
        }

        await saveChatStore();

        log(`Branch repair complete. summarizedUpTo: ${oldSummarizedUpTo} → ${store.summarizedUpTo}`);

        toastr.info(
            `Branch detected — trimmed ${oldSummarizedUpTo - store.summarizedUpTo} turns of stale summary data that referenced messages beyond the branch point.`,
            'Summaryception — Branch Repair',
            { timeOut: 6000 }
        );
    }
}
