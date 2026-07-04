import { saveChat } from '../foundation/context.js';
import { log } from '../foundation/logger.js';
import { saveChatStore } from '../foundation/state.js';

/**
 * Persist chat metadata and chat state in one step.
 * Equivalent to: saveChatStore() + ctx.saveChat().
 * @returns {Promise<void>}
 */
export async function persistChatState() {
    await saveChatStore();
    try {
        await saveChat();
    } catch (e) {
        log('Could not save chat:', e);
    }
}
