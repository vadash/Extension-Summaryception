import { MODULE_NAME, defaultSettings } from './constants.js';

/**
 *
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
 *
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
 *
 */
export function getPlayerName() {
    const ctx = SillyTavern.getContext();
    return ctx.name1 || 'User';
}
