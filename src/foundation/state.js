import { MODULE_NAME, defaultSettings } from './constants.js';

/**
 * Get the extension settings object.
 * @returns {object} The current settings
 */
export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

/**
 *
 */
export function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

/**
 * Get the chat-specific store for summary data.
 * @returns {object} The chat store with layers, summarizedUpTo, ghostedIndices
 */
export function getChatStore() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata[MODULE_NAME]) {
        chatMetadata[MODULE_NAME] = {
            layers: [],
            summarizedUpTo: -1,
            ghostedIndices: [],
        };
    }
    if (!chatMetadata[MODULE_NAME].ghostedIndices) {
        chatMetadata[MODULE_NAME].ghostedIndices = [];
    }
    return chatMetadata[MODULE_NAME];
}

/**
 *
 */
export async function saveChatStore() {
    await SillyTavern.getContext().saveMetadata();
}

/**
 * Get the player's display name.
 * @returns {string} The player name from ST context, or 'User' as fallback
 */
export function getPlayerName() {
    const ctx = SillyTavern.getContext();
    return ctx.name1 || 'User';
}
