import { defaultSettings, UI_MODES } from '../foundation/constants.js';
import {
    AUDITOR_CHAIN,
    CONNECTION_ROUTES,
    NARRATIVE_CHAIN,
    PROVIDER_SETTING_KEYS,
    isProviderRouteSource,
    resolveRouteSource,
} from '../foundation/connection-routes.js';
import {
    getLayer0SummaryRepairCeiling,
    getLayer0SummaryTokenBounds,
} from './layer0-compression.js';

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
 * @property {{ target: number, min: number, max: number, repairCeiling: number } | null} sizeGuard - Frozen Layer 0 output-size band; null when the family validates no size
 * @property {number | null} easyContextLimit - Frozen Easy Summarizer Context cap; null when the guard does not apply
 * @property {boolean} stripChineseIdeographs - Whether the CN ideograph policy strips Han-heavy output
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
 * Resolver input for one summarizer call: the call category plus the
 * provenance the dispatch constructors build. Downstream, the request path
 * consumes the resolved CallProfile (src/core/call-profile.js) and never
 * reads `kind`.
 * @typedef {object} SummarizerCallMetadata
 * @property {'layer0' | 'promotion' | 'regenerate' | 'auditor' | string} [kind] - Call category
 * @property {[number, number]} [sourceRange] - Source chat index range
 * @property {import('./chatutils.js').PassageRegexStats} [regexStats] - Passage regex stats
 * @property {string} [passageNames] - Comma-joined census of the passage's recurring character names, for the Refusal Guard shape signal
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
 * The call's verbatim provenance from the dispatch input (already enriched
 * with token counts). Consumers read fields; nothing rewrites them.
 * @typedef {object} CallProvenance
 * @property {[number, number]} [sourceRange] - Source chat index range
 * @property {import('./chatutils.js').PassageRegexStats} [regexStats] - Passage regex stats
 * @property {string} [passageNames] - Comma-joined census of the passage's recurring character names, for the Refusal Guard shape signal
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
 * @param {SummarizerCallMetadata} [call] - Call category plus the provenance the constructors build
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
            sizeGuard: isLayer0Family ? buildLayer0SizeGuard(settings) : null,
            easyContextLimit: resolveEasyContextLimit(settings),
            stripChineseIdeographs: Boolean(settings.stripChineseIdeographs),
            promotionConstraints: isPromotion,
        },
        provenance: buildProvenance(call),
    };
}

/**
 * Freeze the Layer 0 output-size band: bounds and the narrow repair ceiling
 * resolve together with the guard at dispatch, so retries never re-read the
 * live setting (ADR-0023).
 * @param {ExtensionSettings} settings
 * @returns {{ target: number, min: number, max: number, repairCeiling: number }}
 */
function buildLayer0SizeGuard(settings) {
    return {
        ...getLayer0SummaryTokenBounds(settings),
        repairCeiling: getLayer0SummaryRepairCeiling(settings),
    };
}

/**
 * Freeze the Easy Summarizer Context cap: outside Easy mode, or with a
 * malformed cap, the guard is unset. Evaluated once per dispatch.
 * @param {ExtensionSettings} settings
 * @returns {number | null}
 */
function resolveEasyContextLimit(settings) {
    if (settings.uiMode !== UI_MODES.EASY) {
        return null;
    }
    const limit = Number(settings.advancedModelContext);
    return Number.isFinite(limit) && limit > 0 ? limit : null;
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
 * @param {SummarizerCallMetadata} call
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
 * @param {SummarizerCallMetadata} call
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
 * @param {SummarizerCallMetadata} call
 * @returns {CallProvenance}
 */
function buildProvenance(call) {
    /** @type {CallProvenance} */
    const provenance = {};
    for (const key of [
        'sourceRange',
        'regexStats',
        'passageNames',
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
 * the Narrative Chain; a separated Auditor (ADR-0009) runs its own hops and
 * optionally appends the Narrative Chain as the last-resort failover. Both
 * chain shapes come from the route catalogue (ADR-0026).
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
    const primary = resolveNarrativePrimaryHop(settings, isPromotion);
    const fallback = resolveNarrativeFallbackHop(settings, isPromotion, primary);
    return fallback ? [primary, fallback] : [primary];
}

/**
 * The Narrative Chain's primary hop. A promotion call runs the merge route:
 * that route always supplies the hop's timeout key, and replaces the
 * connection only when its source names a provider. Every other call runs the
 * Layer 0 route on the live settings object itself.
 * @param {ExtensionSettings} settings
 * @param {boolean} isPromotion
 * @returns {CallProfileRoute}
 */
function resolveNarrativePrimaryHop(settings, isPromotion) {
    const inheritedRoute = CONNECTION_ROUTES[NARRATIVE_CHAIN.primary];
    const overrideRoute = isPromotion ? CONNECTION_ROUTES[NARRATIVE_CHAIN.promotionOverride] : null;
    const timeoutRoute = overrideRoute || inheritedRoute;
    const overridden =
        overrideRoute !== null &&
        isProviderRouteSource(overrideRoute, resolveRouteSource(settings, overrideRoute));
    return {
        connection: overridden ? buildRouteConnection(settings, overrideRoute) : settings,
        timeoutMs: resolveRouteTimeoutMs(settings[timeoutRoute.timeoutKey], isPromotion),
    };
}

/**
 * The Narrative Chain's fallback hop, absent when the route is off or already
 * runs the same connection as the primary hop.
 * @param {ExtensionSettings} settings
 * @param {boolean} isPromotion
 * @param {CallProfileRoute} primary
 * @returns {CallProfileRoute | null}
 */
function resolveNarrativeFallbackHop(settings, isPromotion, primary) {
    const route = CONNECTION_ROUTES[NARRATIVE_CHAIN.fallback];
    if (!isProviderRouteSource(route, resolveRouteSource(settings, route))) {
        return null;
    }
    const connection = buildRouteConnection(settings, route);
    if (isSameConnectionRoute(primary.connection, connection)) {
        return null;
    }
    return {
        connection,
        timeoutMs: resolveRouteTimeoutMs(settings[route.timeoutKey], isPromotion),
    };
}

/**
 * Resolve the Auditor series: inherit keeps the Narrative Chain identical to
 * a Layer 0 call; a separated Auditor runs its own primary and fallback hops
 * and, when auditorNarrativeFallback is on, the full Narrative Chain last.
 * @param {ExtensionSettings} settings
 * @returns {CallProfileRoute[]}
 */
function resolveAuditorRouteSeries(settings) {
    const primaryRoute = CONNECTION_ROUTES[AUDITOR_CHAIN.primary];
    if (!isProviderRouteSource(primaryRoute, resolveRouteSource(settings, primaryRoute))) {
        return resolveNarrativeRouteSeries(settings, false);
    }
    const primaryConnection = buildRouteConnection(settings, primaryRoute);
    const series = [
        {
            connection: primaryConnection,
            timeoutMs: resolveRouteTimeoutMs(settings[primaryRoute.timeoutKey], false),
        },
    ];

    const fallbackRoute = CONNECTION_ROUTES[AUDITOR_CHAIN.fallback];
    if (isProviderRouteSource(fallbackRoute, resolveRouteSource(settings, fallbackRoute))) {
        const fallbackConnection = buildRouteConnection(settings, fallbackRoute);
        if (!isSameConnectionRoute(primaryConnection, fallbackConnection)) {
            series.push({
                connection: fallbackConnection,
                timeoutMs: resolveRouteTimeoutMs(settings[fallbackRoute.timeoutKey], false),
            });
        }
    }

    if (settings[AUDITOR_CHAIN.narrativeFailoverKey]) {
        series.push(...resolveNarrativeRouteSeries(settings, false));
    }
    return series;
}

/**
 * Build the provider-facing connection settings for one route. Shared fields
 * such as URLs and API keys stay inherited; the route contributes its source,
 * profile id, and response-length cap.
 * @param {ExtensionSettings} settings
 * @param {import('../foundation/connection-routes.js').ConnectionRoute} route
 * @returns {ExtensionSettings}
 */
function buildRouteConnection(settings, route) {
    return {
        ...settings,
        [PROVIDER_SETTING_KEYS.source]: resolveRouteSource(settings, route),
        [PROVIDER_SETTING_KEYS.profile]: String(settings[route.profileKey] || ''),
        [PROVIDER_SETTING_KEYS.responseLength]: Number(settings[route.responseLengthKey] || 0),
    };
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
 * @param {SummarizerCallMetadata} call
 * @returns {string}
 */
function formatPromotionLabel(call) {
    const sourceLayer = call.layerIndex ?? '?';
    const destLayer = typeof call.layerIndex === 'number' ? call.layerIndex + 1 : '?';
    const count = formatCount(call.mergedSnippetCount, 'snippet');
    return `L${sourceLayer} -> L${destLayer} (${count})`;
}
