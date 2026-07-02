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
        const ctx = SillyTavern.getContext();
        if (ctx.saveChat) {
            await ctx.saveChat();
        }
    } catch (e) {
        log('Could not save chat:', e);
    }
}
