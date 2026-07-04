import { executeSlashCommandsWithOptions, getChat, saveChat } from '../foundation/context.js';
import { log } from '../foundation/logger.js';

/**
 * Check whether a hidden message is no longer owned by Summaryception.
 * @param {ChatMessage | undefined} message
 * @returns {boolean}
 */
export function isOrphanedHiddenMessage(message) {
    return Boolean(
        message &&
        (message.is_system || message.is_hidden) &&
        !message.is_user &&
        !message.extra?.sc_ghosted &&
        message.mes &&
        message.mes.trim().length > 0,
    );
}

/**
 * Scan the chat for orphaned hidden messages and unhide them.
 * @param {{ onProgress?: (repaired: number) => void }} [options]
 * @returns {Promise<{ status: 'repaired' | 'none', repaired: number }>}
 */
export async function repairOrphanedMessages({ onProgress = () => {} } = {}) {
    const chat = getChat();
    let repaired = 0;

    for (let i = 0; i < chat.length; i++) {
        if (!isOrphanedHiddenMessage(chat[i])) {
            continue;
        }

        await repairOrphanedMessage(chat[i], i);
        repaired++;
        onProgress(repaired);
    }

    if (repaired === 0) {
        return { status: 'none', repaired };
    }

    await saveChatAfterRepair();
    return { status: 'repaired', repaired };
}

async function repairOrphanedMessage(message, index) {
    try {
        await executeSlashCommandsWithOptions(`/unhide ${index}`, { showOutput: false });
    } catch (e) {
        log(`Repair: failed to unhide ${index}:`, e);
    }

    message.is_system = false;
    delete message.is_hidden;
}

async function saveChatAfterRepair() {
    try {
        await saveChat();
    } catch (e) {
        log('Could not save chat:', e);
    }
}
