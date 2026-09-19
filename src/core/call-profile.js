import { defaultSettings } from '../foundation/constants.js';
import { providers } from './connectionutil.js';

const HEALTH_BUCKETS = Object.freeze({
    layer0: 'layer0',
    l1plus: 'l1plus',
});

// Hardcoded fallbacks (ms) used when no per-route timeout setting is supplied.
// L0 (user-facing) defaults higher than L1+ (background promotion).
const HARD_FALLBACK_TIMEOUT_MS = Object.freeze({
    layer0: 120000,
    promotion: 90000,
});

const ROUTE_SETTING_DEFAULTS = Object.freeze({
    summarizerResponseLength: 0,
    connectionProfileId: '',
});
const ROUTE_IDENTITY_KEYS = Object.freeze({
    profile: ['connectionProfileId'],
});

/**
 * Resolved per-call request policy, frozen at dispatch. The request path
 * consumes only this; it never re-derives decisions from the call category
 * or the live settings object.
 * @typedef {object} CallProfilePolicy
 * @property {string} systemPrompt - System prompt sent to the summarizer
 * @property {string} userPromptTemplate - User prompt template before substitution
 * @property {string} repairPromptTemplate - Template for the in-series Layer 0 repair retry; '' when the family has none
 * @property {string} label - Human-readable call label for usage and prompt logs
 * @property {'layer0' | 'l1plus'} healthBucket - Primary retry health bucket for this call family
 * @property {CallProfileRoute[]} routes - Ordered failover series; the request runner walks it in order
 * @property {boolean} compression - Whether the prompt carries runtime compression constraints
 * @property {boolean} sizeGuard - Whether Layer 0 output size validation applies
 * @property {boolean} promotionConstraints - Whether the prompt carries the Layer 1+ promotion constraint block
 */

/**
 * One hop of the route series: the connection settings the provider adapters
 * read, and the per-attempt timeout.
 * @typedef {object} CallProfileRoute
 * @property {ExtensionSettings} connection - Provider-facing connection settings for this hop
 * @property {number} timeoutMs - Attempt timeout in milliseconds, hard fallback applied
 */

/**
 * The call's verbatim provenance from the dispatch input (already enriched
 * with token counts). Consumers read fields; nothing rewrites them.
 * @typedef {object} CallProvenance
 * @property {[number, number]} [sourceRange] - Source chat index range
 * @property {import('./chatutils.js').PassageRegexStats} [regexStats] - Passage regex stats
 * @property {number} [sourceTokensBefore] - Source text size before summarization
 * @property {boolean} [sourceTokensBeforeEstimated] - Whether sourceTokensBefore was estimated
 * @property {number} [layerIndex] - Source layer for promotion calls
 * @property {number} [mergedSnippetCount] - Snippets merged for promotion calls
 * @property {number} [memoryTokensBefore] - Source memory size before promotion
 * @property {boolean} [memoryTokensBeforeEstimated] - Whether memoryTokensBefore was estimated
 * @property {number} [overflowLayerIndex] - Layer that exceeded promotion limits
 * @property {number} [overflowMemoryCount] - Memory count in the overflowing layer
 * @property {number} [overflowMemoryLimit] - Configured memory count limit for the layer
 * @property {number} [overflowTokens] - Token count in the overflowing layer
 * @property {number} [overflowTokenQuota] - Token quota for the overflowing layer
 * @property {{ reason?: string, outputTokens?: number, targetTokens?: number, hardMaxTokens?: number, requiredMaxTokens?: number, sourceTokens?: number, rejectedSummary?: string, diagnostics?: object }} [promotionRepair] - Promotion repair feedback of this dispatch
 */

/**
 * @typedef {object} CallProfile
 * @property {CallProfilePolicy} policy - Frozen request policy
 * @property {CallProvenance} provenance - Verbatim dispatch provenance
 */

/**
 * Resolve one call's policy and provenance from settings and the call
 * category. Pure: no state imports, settings arrive as an argument. Runs once
 * inside buildSummarizerPipelineInput; the returned profile is the only thing
 * the request path consumes.
 * @param {ExtensionSettings} settings - Effective settings captured for this dispatch
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [call] - Call category plus the provenance the constructors build
 * @returns {CallProfile}
 */
export function resolveCallProfile(settings, call = {}) {
    const isPromotion = call.kind === 'promotion';
    const isLayer0Family = call.kind === 'layer0' || call.kind === 'regenerate';
    return {
        policy: {
            systemPrompt: resolveSystemPrompt(settings, call.kind),
            userPromptTemplate: resolveUserPromptTemplate(settings, call),
            repairPromptTemplate: isLayer0Family
                ? getStringSetting(
                      settings.summarizerRepairPrompt,
                      defaultSettings.summarizerRepairPrompt,
                  )
                : '',
            label: buildCallLabel(call),
            healthBucket: isPromotion ? HEALTH_BUCKETS.l1plus : HEALTH_BUCKETS.layer0,
            routes: resolveRouteSeries(settings, call.kind),
            compression: isLayer0Family || isPromotion,
            sizeGuard: isLayer0Family,
            promotionConstraints: isPromotion,
        },
        provenance: buildProvenance(call),
    };
}

/**
 * @param {ExtensionSettings} settings
 * @param {string} [kind]
 * @returns {string}
 */
function resolveSystemPrompt(settings, kind) {
    if (kind === 'promotion') {
        return getStringSetting(
            settings.promotionSystemPrompt,
            defaultSettings.promotionSystemPrompt,
        );
    }
    if (kind === 'auditor') {
        return getStringSetting(settings.auditorSystemPrompt, defaultSettings.auditorSystemPrompt);
    }
    return getStringSetting(
        settings.summarizerSystemPrompt,
        defaultSettings.summarizerSystemPrompt,
    );
}

/**
 * @param {ExtensionSettings} settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} call
 * @returns {string}
 */
function resolveUserPromptTemplate(settings, call) {
    if (call.kind === 'promotion') {
        return call.promotionRepair
            ? getStringSetting(
                  settings.promotionRepairPrompt,
                  defaultSettings.promotionRepairPrompt,
              )
            : getStringSetting(settings.promotionUserPrompt, defaultSettings.promotionUserPrompt);
    }
    if (call.kind === 'auditor') {
        return getStringSetting(settings.auditorUserPrompt, defaultSettings.auditorUserPrompt);
    }
    return getStringSetting(settings.summarizerUserPrompt, defaultSettings.summarizerUserPrompt);
}

/**
 * Return a string setting while preserving intentionally empty strings.
 * @param {unknown} value - Candidate setting value
 * @param {string} fallback - Default value for malformed legacy settings
 * @returns {string}
 */
function getStringSetting(value, fallback) {
    return typeof value === 'string' ? value : fallback;
}

/**
 * Every attempt of a route series uses the full configured timeout; a
 * non-positive or non-finite setting falls back to the family's hard default.
 * @param {unknown} configuredSeconds - Route timeout setting in seconds
 * @param {boolean} isPromotion - Picks the family hard fallback
 * @returns {number} Timeout in milliseconds
 */
function resolveRouteTimeoutMs(configuredSeconds, isPromotion) {
    const seconds = Number(configuredSeconds);
    const hardFallbackMs = isPromotion
        ? HARD_FALLBACK_TIMEOUT_MS.promotion
        : HARD_FALLBACK_TIMEOUT_MS.layer0;
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return hardFallbackMs;
    }
    return seconds * 1000;
}

/**
 * One label switch serves usage lines, prompt logs, and the Easy context
 * guard; no per-consumer label variants exist.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} call
 * @returns {string}
 */
function buildCallLabel(call) {
    if (call.kind === 'layer0') {
        return `L0 turns ${formatRange(call.sourceRange)}`;
    }
    if (call.kind === 'promotion') {
        return `promotion ${formatPromotionLabel(call)}`;
    }
    if (call.kind === 'regenerate') {
        return `regenerate turns ${formatRange(call.sourceRange)}`;
    }
    return call.kind || 'summarizer';
}

/**
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} call
 * @returns {CallProvenance}
 */
function buildProvenance(call) {
    /** @type {CallProvenance} */
    const provenance = {};
    for (const key of [
        'sourceRange',
        'regexStats',
        'sourceTokensBefore',
        'sourceTokensBeforeEstimated',
        'layerIndex',
        'mergedSnippetCount',
        'memoryTokensBefore',
        'memoryTokensBeforeEstimated',
        'overflowLayerIndex',
        'overflowMemoryCount',
        'overflowMemoryLimit',
        'overflowTokens',
        'overflowTokenQuota',
        'promotionRepair',
    ]) {
        if (call[key] !== undefined) {
            provenance[key] = call[key];
        }
    }
    return provenance;
}

/**
 * Resolve the ordered failover series for one call. Non-auditor families run
 * the Narrative Chain (Layer 0 primary, plus its fallback when configured).
 * A separated Auditor (ADR-0009) prepends its own hops and optionally appends
 * the Narrative Chain as the last-resort failover.
 * @param {ExtensionSettings} settings
 * @param {string} [kind]
 * @returns {CallProfileRoute[]}
 */
function resolveRouteSeries(settings, kind) {
    if (kind === 'auditor') {
        return resolveAuditorRouteSeries(settings);
    }
    return resolveNarrativeRouteSeries(settings, kind === 'promotion');
}

/**
 * Resolve the Narrative Chain: the Layer 0 route (promotion folds the merge
 * override into it) plus its configured distinct fallback route.
 * @param {ExtensionSettings} settings
 * @param {boolean} isPromotion
 * @returns {CallProfileRoute[]}
 */
function resolveNarrativeRouteSeries(settings, isPromotion) {
    const series = [
        {
            connection: resolvePrimaryConnection(settings, isPromotion),
            timeoutMs: resolveRouteTimeoutMs(
                isPromotion ? settings.mergeRequestTimeoutSeconds : settings.requestTimeoutSeconds,
                isPromotion,
            ),
        },
    ];
    const fallbackConnection = resolveFallbackConnection(settings, isPromotion);
    if (fallbackConnection) {
        series.push({
            connection: fallbackConnection,
            timeoutMs: resolveRouteTimeoutMs(settings.fallbackRequestTimeoutSeconds, isPromotion),
        });
    }
    return series;
}

/**
 * Resolve the Auditor series: inherit keeps the Narrative Chain identical to
 * a Layer 0 call; a separated Auditor runs its own primary and fallback hops
 * and, when auditorNarrativeFallback is on, the full Narrative Chain last.
 * @param {ExtensionSettings} settings
 * @returns {CallProfileRoute[]}
 */
function resolveAuditorRouteSeries(settings) {
    if (!isSeparatedRouteSource(settings.auditorConnectionSource)) {
        return resolveNarrativeRouteSeries(settings, false);
    }
    const primary = {
        connection: buildAuditorRouteConnection(
            settings,
            settings.auditorConnectionSource,
            settings.auditorConnectionProfileId,
            settings.auditorSummarizerResponseLength,
        ),
        timeoutMs: resolveRouteTimeoutMs(settings.auditorRequestTimeoutSeconds, false),
    };
    const series = [primary];

    const fallbackSource = settings.auditorFallbackConnectionSource;
    if (isConfiguredRouteSource(fallbackSource)) {
        const fallback = {
            connection: buildAuditorRouteConnection(
                settings,
                fallbackSource,
                settings.auditorFallbackConnectionProfileId,
                settings.auditorFallbackSummarizerResponseLength,
            ),
            timeoutMs: resolveRouteTimeoutMs(settings.auditorFallbackRequestTimeoutSeconds, false),
        };
        if (!isSameConnectionRoute(primary.connection, fallback.connection)) {
            series.push(fallback);
        }
    }

    if (settings.auditorNarrativeFallback) {
        series.push(...resolveNarrativeRouteSeries(settings, false));
    }
    return series;
}

/**
 * Check whether the source separates this route from the Narrative Chain at all.
 * @param {unknown} source
 * @returns {boolean}
 */
function isSeparatedRouteSource(source) {
    return source === 'default' || source === 'profile';
}

/**
 * Check whether the source names a usable provider, mirroring the fallback
 * configuration rule.
 * @param {string} source
 * @returns {boolean}
 */
function isConfiguredRouteSource(source) {
    return Boolean(source && source !== 'disabled' && providers[source]);
}

/**
 * Build the provider-facing connection settings for one Auditor route. Shared
 * fields such as URLs and API keys stay inherited; the route contributes its
 * source, profile id, and response length.
 * @param {ExtensionSettings} settings
 * @param {string} source
 * @param {string} profileId
 * @param {number} responseLength
 * @returns {ExtensionSettings}
 */
function buildAuditorRouteConnection(settings, source, profileId, responseLength) {
    return {
        ...settings,
        ...ROUTE_SETTING_DEFAULTS,
        connectionSource: source,
        connectionProfileId: profileId || ROUTE_SETTING_DEFAULTS.connectionProfileId,
        summarizerResponseLength: responseLength || ROUTE_SETTING_DEFAULTS.summarizerResponseLength,
    };
}

/**
 * Resolve the primary connection for one call; the promotion merge route is
 * folded into the primary decision here.
 * @param {ExtensionSettings} settings
 * @param {boolean} isPromotion
 * @returns {ExtensionSettings}
 */
function resolvePrimaryConnection(settings, isPromotion) {
    if (!isPromotion || !shouldUseMergeConnection(settings)) {
        return settings;
    }
    return extractRouteSettings(settings, 'merge');
}

/**
 * Resolve the fallback connection for one call, if configured and distinct.
 * @param {ExtensionSettings} settings
 * @param {boolean} isPromotion
 * @returns {ExtensionSettings | null}
 */
function resolveFallbackConnection(settings, isPromotion) {
    if (!shouldUseFallbackConnection(settings)) {
        return null;
    }
    const primary = resolvePrimaryConnection(settings, isPromotion);
    const fallback = extractRouteSettings(settings, 'fallback');
    return isSameConnectionRoute(primary, fallback) ? null : fallback;
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
    return isConfiguredRouteSource(settings.fallbackConnectionSource);
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
 * @param {string} value
 * @returns {string}
 */
function lowerFirst(value) {
    return value.charAt(0).toLowerCase() + value.slice(1);
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

/**
 * @param {ExtensionSettings} settings
 * @param {string} key
 * @returns {string}
 */
function getRouteIdentityValue(settings, key) {
    return String(settings?.[key] || '');
}

/**
 * @param {[number, number] | undefined} range - Source range
 * @returns {string}
 */
function formatRange(range) {
    if (!Array.isArray(range) || range.length < 2) {
        return '?';
    }
    return `${range[0]}-${range[1]}`;
}

/**
 * @param {number | undefined} count - Count value
 * @param {string} singular - Singular label
 * @returns {string}
 */
function formatCount(count, singular) {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
        return `? ${singular}s`;
    }
    return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/**
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} call
 * @returns {string}
 */
function formatPromotionLabel(call) {
    const sourceLayer = call.layerIndex ?? '?';
    const destLayer = typeof call.layerIndex === 'number' ? call.layerIndex + 1 : '?';
    const count = formatCount(call.mergedSnippetCount, 'snippet');
    return `L${sourceLayer} -> L${destLayer} (${count})`;
}
