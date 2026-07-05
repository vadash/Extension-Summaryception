/**
 * Summaryception Connection Utility
 *
 * Routes summarization requests through one of four backends:
 *   - default: SillyTavern's generateRaw() active connection
 *   - profile: ST Connection Profile via ConnectionManagerRequestService
 *   - ollama: Ollama instance through the ST CORS proxy when needed
 *   - openai: OpenAI-compatible endpoint, streaming supported
 */

import { ConnectionError } from './connection-error.js';
import { getConnectionManagerRequestService } from '../foundation/context.js';
import { error as logError, warn } from '../foundation/logger.js';
import { DefaultProvider } from './connection-default.js';
import { getLayer0ResponseTokenCap, isLayer0CompressionCall } from './layer0-compression.js';
import { OllamaProvider, fetchOllamaModels } from './connection-ollama.js';
import { OpenAIProvider, testOpenAIConnection } from './connection-openai.js';
import { ProfileProvider } from './connection-profile.js';

export { ConnectionError, fetchOllamaModels, testOpenAIConnection };

/**
 * Registered connection providers keyed by settings.connectionSource.
 * @type {Readonly<Record<string, ConnectionProvider>>}
 */
export const providers = Object.freeze({
    default: DefaultProvider,
    profile: ProfileProvider,
    ollama: OllamaProvider,
    openai: OpenAIProvider,
});

/**
 * Send a summarization request using the configured connection.
 * @param {ExtensionSettings} settings - The extension settings containing connection config
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @param {AbortSignal} [signal] - Optional request abort signal
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata] - Call metadata
 * @returns {Promise<string>} The generated response text
 * @throws {ConnectionError|Error} If the request fails
 */
export async function sendSummarizerRequest(settings, systemPrompt, userPrompt, signal, metadata) {
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
 * Test the configured connection provider.
 * @param {ExtensionSettings} settings
 * @returns {Promise<ConnectionTestResult>}
 */
export async function testSummarizerConnection(settings) {
    const provider = getConnectionProvider(settings.connectionSource);
    return await provider.testConnection(settings);
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
 * Get a human-readable name for the current connection source.
 * @param {ExtensionSettings} settings
 * @returns {string}
 */
export function getConnectionDisplayName(settings) {
    return getConnectionProvider(settings.connectionSource).displayName(settings);
}

/**
 * Resolve the connection settings that should be used for one summarizer call.
 * @param {ExtensionSettings} settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {ExtensionSettings}
 */
export function resolveSummarizerConnectionSettings(settings, metadata = {}) {
    const resolved = metadata.useFallback
        ? resolveFallbackSummarizerConnectionSettings(settings, metadata) || settings
        : resolvePrimarySummarizerConnectionSettings(settings, metadata);
    return applyLayer0ResponseCap(resolved, metadata);
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

    return {
        ...settings,
        connectionSource: settings.mergeConnectionSource,
        summarizerResponseLength: settings.mergeSummarizerResponseLength || 0,
        connectionProfileId: settings.mergeConnectionProfileId || '',
        ollamaModel: settings.mergeOllamaModel || '',
        openaiModel: settings.mergeOpenaiModel || '',
        openaiMaxTokens: settings.mergeOpenaiMaxTokens || 0,
    };
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
    const fallback = {
        ...settings,
        connectionSource: settings.fallbackConnectionSource,
        summarizerResponseLength: settings.fallbackSummarizerResponseLength || 0,
        connectionProfileId: settings.fallbackConnectionProfileId || '',
        ollamaModel: settings.fallbackOllamaModel || '',
        openaiModel: settings.fallbackOpenaiModel || '',
        openaiMaxTokens: settings.fallbackOpenaiMaxTokens || 0,
    };

    return isSameConnectionRoute(primary, fallback)
        ? null
        : applyLayer0ResponseCap(fallback, metadata);
}

/**
 * Apply the Layer 0 semantic target as a provider output cap.
 * @param {ExtensionSettings} settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {ExtensionSettings}
 */
function applyLayer0ResponseCap(settings, metadata = {}) {
    if (!isLayer0CompressionCall(metadata)) {
        return settings;
    }

    const cap = getLayer0ResponseTokenCap(settings, metadata);
    if (cap === null) {
        return settings;
    }
    if ((settings.connectionSource || 'default') === 'openai') {
        return {
            ...settings,
            openaiMaxTokens: chooseLowerPositiveCap(settings.openaiMaxTokens, cap),
        };
    }

    return {
        ...settings,
        summarizerResponseLength: chooseLowerPositiveCap(settings.summarizerResponseLength, cap),
    };
}

function chooseLowerPositiveCap(configured, fallbackCap) {
    const parsed = Number(configured);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallbackCap;
    }
    return Math.min(Math.round(parsed), fallbackCap);
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
    if ((primary.connectionSource || 'default') !== (fallback.connectionSource || 'default')) {
        return false;
    }

    if (fallback.connectionSource === 'profile') {
        return (primary.connectionProfileId || '') === (fallback.connectionProfileId || '');
    }
    if (fallback.connectionSource === 'ollama') {
        return (
            (primary.ollamaUrl || '') === (fallback.ollamaUrl || '') &&
            (primary.ollamaModel || '') === (fallback.ollamaModel || '')
        );
    }
    if (fallback.connectionSource === 'openai') {
        return (
            (primary.openaiUrl || '') === (fallback.openaiUrl || '') &&
            (primary.openaiKey || '') === (fallback.openaiKey || '') &&
            (primary.openaiModel || '') === (fallback.openaiModel || '')
        );
    }
    return true;
}

/**
 * Resolve a provider by source, falling back to the default provider.
 * @param {string} [source]
 * @returns {ConnectionProvider}
 */
function getConnectionProvider(source = 'default') {
    return providers[source || 'default'] || providers.default;
}
