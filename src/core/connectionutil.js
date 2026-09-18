/**
 * Summaryception Connection Utility
 *
 * Routes summarization requests through one of two backends:
 *   - default: SillyTavern's generateRaw() active connection
 *   - profile: ST Connection Profile via ConnectionManagerRequestService
 */

import { ConnectionError } from './connection-error.js';
import { getConnectionManagerRequestService } from '../foundation/context.js';
import { error as logError, warn } from '../foundation/logger.js';
import { DefaultProvider } from './connection-default.js';
import { ProfileProvider } from './connection-profile.js';

export { ConnectionError };

/**
 * Registered connection providers keyed by settings.connectionSource.
 * Each adapter declares a `cancellable` capability: whether it forwards an
 * AbortSignal so timeouts/Stop genuinely cancel the in-flight request.
 * @type {Readonly<Record<string, ConnectionProvider>>}
 */
export const providers = Object.freeze({
    default: DefaultProvider,
    profile: ProfileProvider,
});

/**
 * @typedef {object} SummarizerProviderRequest
 * @property {ExtensionSettings} settings - The resolved route connection settings
 * @property {string} systemPrompt - The system prompt
 * @property {string} userPrompt - The user prompt
 * @property {AbortSignal} [signal] - Optional request abort signal
 */

/**
 * Send a summarization request over the given resolved connection route.
 * @param {SummarizerProviderRequest} request
 * @returns {Promise<string>} The generated response text
 * @throws {ConnectionError|Error} If the request fails
 */
export async function sendSummarizerRequest({ settings, systemPrompt, userPrompt, signal }) {
    const provider = getConnectionProvider(settings.connectionSource);
    return await provider.generate({
        settings,
        systemPrompt,
        userPrompt,
        signal,
    });
}

/**
 * Check whether the effective route's provider can actually cancel an
 * in-flight request. The capability is read from the adapter registry;
 * unknown sources are treated as uncancellable.
 * @param {ExtensionSettings} effectiveSettings - Route-resolved connection settings
 * @returns {boolean} True only when the registered provider declares `cancellable`
 */
export function isCancellableConnection(effectiveSettings) {
    return providers[effectiveSettings?.connectionSource]?.cancellable === true;
}

/**
 * Populate a <select> element with connection profiles using ST's built-in handler.
 * @param {HTMLSelectElement} selectElement - The dropdown to populate
 * @param {string} currentValue - The currently selected profile ID
 * @returns {boolean} Whether population succeeded
 */
export function populateProfileDropdown(
    /** @type {HTMLSelectElement} */ selectElement,
    currentValue,
) {
    try {
        const service = getConnectionManagerRequestService();

        if (service && typeof service.handleDropdown === 'function') {
            service.handleDropdown(selectElement);
            if (currentValue) {
                selectElement.value = currentValue;
            }
            return true;
        }

        warn('[Connection] handleDropdown not available.');
        return false;
    } catch (error) {
        logError('[Connection] Error populating profile dropdown:', error);
        return false;
    }
}

/**
 * @param {string} [source]
 * @returns {ConnectionProvider}
 */
function getConnectionProvider(source = 'default') {
    return providers[source || 'default'] || providers.default;
}
