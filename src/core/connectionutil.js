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
 * @type {Readonly<Record<string, ConnectionProvider>>}
 */
export const providers = Object.freeze({
    default: DefaultProvider,
    profile: ProfileProvider,
});

const ROUTE_SETTING_DEFAULTS = Object.freeze({
    summarizerResponseLength: 0,
    connectionProfileId: '',
});
const ROUTE_IDENTITY_KEYS = Object.freeze({
    profile: ['connectionProfileId'],
});

/**
 * @typedef {object} SummarizerProviderRequest
 * @property {ExtensionSettings} settings - The extension settings containing connection config
 * @property {string} systemPrompt - The system prompt
 * @property {string} userPrompt - The user prompt
 * @property {AbortSignal} [signal] - Optional request abort signal
 * @property {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata] - Call metadata
 */

/**
 * Send a summarization request using the configured connection.
 * @param {SummarizerProviderRequest} request
 * @returns {Promise<string>} The generated response text
 * @throws {ConnectionError|Error} If the request fails
 */
export async function sendSummarizerRequest({
    settings,
    systemPrompt,
    userPrompt,
    signal,
    metadata,
}) {
    const effectiveSettings = resolveSummarizerConnectionSettings(settings, metadata);
    const provider = getConnectionProvider(effectiveSettings.connectionSource);
    return await provider.generate({
        settings: effectiveSettings,
        systemPrompt,
        userPrompt,
        signal,
    });
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
 * Resolve the connection settings that should be used for one summarizer call.
 * @param {ExtensionSettings} settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {ExtensionSettings}
 */
export function resolveSummarizerConnectionSettings(settings, metadata = {}) {
    return metadata.useFallback
        ? resolveFallbackSummarizerConnectionSettings(settings, metadata) || settings
        : resolvePrimarySummarizerConnectionSettings(settings, metadata);
}

/**
 * Resolve the primary connection for one summarizer call.
 * @param {ExtensionSettings} settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {ExtensionSettings}
 */
export function resolvePrimarySummarizerConnectionSettings(settings, metadata = {}) {
    if (metadata.kind !== 'promotion' || !shouldUseMergeConnection(settings)) {
        return settings;
    }

    return extractRouteSettings(settings, 'merge');
}

/**
 * Resolve the fallback connection for one summarizer call, if configured and distinct.
 * @param {ExtensionSettings} settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {ExtensionSettings|null}
 */
export function resolveFallbackSummarizerConnectionSettings(settings, metadata = {}) {
    if (!shouldUseFallbackConnection(settings)) {
        return null;
    }

    const primary = resolvePrimarySummarizerConnectionSettings(settings, metadata);
    const fallback = extractRouteSettings(settings, 'fallback');

    return isSameConnectionRoute(primary, fallback) ? null : fallback;
}

/**
 * Resolve prefixed route override fields onto the provider-facing setting names.
 * Shared fields without route-specific prefixes, such as URLs and API keys, stay inherited.
 * @param {ExtensionSettings} settings
 * @param {string} prefix
 * @returns {ExtensionSettings}
 */
function extractRouteSettings(settings, prefix) {
    const routeSettings = { ...settings, ...ROUTE_SETTING_DEFAULTS };
    const prefixLength = prefix.length;

    for (const key of Object.keys(settings)) {
        if (!key.startsWith(prefix) || key.length === prefixLength) {
            continue;
        }

        const mappedKey = lowerFirst(key.slice(prefixLength));
        routeSettings[mappedKey] = getRouteSettingValue(mappedKey, settings[key]);
    }

    return routeSettings;
}

/**
 * Preserve existing route defaults for known override-only fields.
 * @param {string} key
 * @param {unknown} value
 * @returns {unknown}
 */
function getRouteSettingValue(key, value) {
    if (Object.hasOwn(ROUTE_SETTING_DEFAULTS, key) && !value) {
        return ROUTE_SETTING_DEFAULTS[key];
    }
    return value;
}

/**
 * Lowercase the first character of a prefixed route setting suffix.
 * @param {string} value
 * @returns {string}
 */
function lowerFirst(value) {
    return value.charAt(0).toLowerCase() + value.slice(1);
}

/**
 * Check whether the Layer 1+ override is configured.
 * @param {ExtensionSettings} settings
 * @returns {boolean}
 */
function shouldUseMergeConnection(settings) {
    return Boolean(settings.mergeConnectionSource && settings.mergeConnectionSource !== 'inherit');
}

/**
 * Check whether fallback routing is configured with a known provider.
 * @param {ExtensionSettings} settings
 * @returns {boolean}
 */
function shouldUseFallbackConnection(settings) {
    const source = settings.fallbackConnectionSource;
    return Boolean(source && source !== 'disabled' && providers[source]);
}

/**
 * Compare provider identity, ignoring tunables that do not change the backend route.
 * @param {ExtensionSettings} primary
 * @param {ExtensionSettings} fallback
 * @returns {boolean}
 */
function isSameConnectionRoute(primary, fallback) {
    const source = fallback.connectionSource || 'default';
    if ((primary.connectionSource || 'default') !== source) {
        return false;
    }

    const identityKeys = ROUTE_IDENTITY_KEYS[source] || [];
    return identityKeys.every(
        (key) => getRouteIdentityValue(primary, key) === getRouteIdentityValue(fallback, key),
    );
}

function getRouteIdentityValue(settings, key) {
    return String(settings?.[key] || '');
}

/**
 * Resolve a provider by source, falling back to the default provider.
 * @param {string} [source]
 * @returns {ConnectionProvider}
 */
function getConnectionProvider(source = 'default') {
    return providers[source || 'default'] || providers.default;
}
