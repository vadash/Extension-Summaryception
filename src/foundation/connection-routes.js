import { SLIDER_LIMITS } from './constants.js';

/**
 * The Connection Route set (CONTEXT.md): the one declaration of every
 * connection target a summarizer call can run on. Settings normalization,
 * reset preservation, the Call Profile resolver, and the settings UI derive
 * their route facts from here, so a route's keys and options cannot disagree
 * between modules (ADR-0026).
 */

/**
 * @typedef {'layer0' | 'merge' | 'fallback' | 'auditor' | 'auditorFallback'} ConnectionRouteId
 */

/**
 * One connection route's declaration.
 * @typedef {object} ConnectionRoute
 * @property {ConnectionRouteId} id - This route's id, the key it is declared under.
 * @property {keyof ExtensionSettings} sourceKey - Settings key holding the route's source selection.
 * @property {keyof ExtensionSettings} profileKey - Settings key holding the route's Connection Profile id.
 * @property {keyof ExtensionSettings} responseLengthKey - Settings key holding the route's response-length cap.
 * @property {keyof typeof SLIDER_LIMITS} timeoutKey - Settings key holding the route's per-attempt timeout.
 * @property {ReadonlyArray<string>} sourceOptions - Every value the route's source key may hold.
 * @property {ReadonlyArray<string>} providerSources - The options among them that name a registered provider.
 * @property {string} defaultSource - Source an unset or malformed source key repairs to.
 */

/**
 * The provider-facing setting names a resolved route connection carries. The
 * adapters read these by argument only; the catalogue is what maps a route's
 * own setting keys onto them.
 * @type {Readonly<{ source: 'connectionSource', profile: 'connectionProfileId', responseLength: 'summarizerResponseLength' }>}
 */
export const PROVIDER_SETTING_KEYS = Object.freeze({
    source: 'connectionSource',
    profile: 'connectionProfileId',
    responseLength: 'summarizerResponseLength',
});

/**
 * Every connection route, keyed by id.
 * @type {Readonly<Record<ConnectionRouteId, ConnectionRoute>>}
 */
export const CONNECTION_ROUTES = Object.freeze({
    layer0: Object.freeze({
        id: 'layer0',
        sourceKey: 'connectionSource',
        profileKey: 'connectionProfileId',
        responseLengthKey: 'summarizerResponseLength',
        timeoutKey: 'requestTimeoutSeconds',
        sourceOptions: Object.freeze(['default', 'profile']),
        providerSources: Object.freeze(['default', 'profile']),
        defaultSource: 'default',
    }),
    merge: Object.freeze({
        id: 'merge',
        sourceKey: 'mergeConnectionSource',
        profileKey: 'mergeConnectionProfileId',
        responseLengthKey: 'mergeSummarizerResponseLength',
        timeoutKey: 'mergeRequestTimeoutSeconds',
        sourceOptions: Object.freeze(['inherit', 'profile']),
        providerSources: Object.freeze(['profile']),
        defaultSource: 'inherit',
    }),
    fallback: Object.freeze({
        id: 'fallback',
        sourceKey: 'fallbackConnectionSource',
        profileKey: 'fallbackConnectionProfileId',
        responseLengthKey: 'fallbackSummarizerResponseLength',
        timeoutKey: 'fallbackRequestTimeoutSeconds',
        sourceOptions: Object.freeze(['disabled', 'default', 'profile']),
        providerSources: Object.freeze(['default', 'profile']),
        defaultSource: 'disabled',
    }),
    auditor: Object.freeze({
        id: 'auditor',
        sourceKey: 'auditorConnectionSource',
        profileKey: 'auditorConnectionProfileId',
        responseLengthKey: 'auditorSummarizerResponseLength',
        timeoutKey: 'auditorRequestTimeoutSeconds',
        sourceOptions: Object.freeze(['inherit', 'default', 'profile']),
        providerSources: Object.freeze(['default', 'profile']),
        defaultSource: 'inherit',
    }),
    auditorFallback: Object.freeze({
        id: 'auditorFallback',
        sourceKey: 'auditorFallbackConnectionSource',
        profileKey: 'auditorFallbackConnectionProfileId',
        responseLengthKey: 'auditorFallbackSummarizerResponseLength',
        timeoutKey: 'auditorFallbackRequestTimeoutSeconds',
        sourceOptions: Object.freeze(['disabled', 'default', 'profile']),
        providerSources: Object.freeze(['default', 'profile']),
        defaultSource: 'disabled',
    }),
});

/**
 * The Narrative Chain (CONTEXT.md): the Layer 0 route, the merge route that
 * replaces it for promotion calls, and its configured fallback. The merge
 * route supplies the promotion hop's timeout key whether or not it replaces
 * the connection.
 * @type {Readonly<{ primary: ConnectionRouteId, promotionOverride: ConnectionRouteId, fallback: ConnectionRouteId }>}
 */
export const NARRATIVE_CHAIN = Object.freeze({
    primary: 'layer0',
    promotionOverride: 'merge',
    fallback: 'fallback',
});

/**
 * The Auditor's chain: its own primary and fallback pair, and the Narrative
 * Chain appended last when the failover setting is on.
 * @type {Readonly<{ primary: ConnectionRouteId, fallback: ConnectionRouteId, narrativeFailoverKey: keyof ExtensionSettings }>}
 */
export const AUDITOR_CHAIN = Object.freeze({
    primary: 'auditor',
    fallback: 'auditorFallback',
    narrativeFailoverKey: 'auditorNarrativeFallback',
});

/**
 * The four settings one route owns.
 * @param {ConnectionRoute} route
 * @returns {Array<keyof ExtensionSettings>}
 */
export function getRouteSettingKeys(route) {
    return [route.sourceKey, route.profileKey, route.responseLengthKey, route.timeoutKey];
}

/**
 * Every setting key owned by any route.
 * @returns {Array<keyof ExtensionSettings>}
 */
export function getAllRouteSettingKeys() {
    return Object.values(CONNECTION_ROUTES).flatMap((route) => getRouteSettingKeys(route));
}

/**
 * The route's effective source: the stored value, or the route's own default
 * when it is unset.
 * @param {ExtensionSettings} settings
 * @param {ConnectionRoute} route
 * @returns {string}
 */
export function resolveRouteSource(settings, route) {
    return String(settings?.[route.sourceKey] || route.defaultSource);
}

/**
 * Whether a source names a registered provider, as opposed to inheriting
 * ('inherit') or being switched off ('disabled').
 * @param {ConnectionRoute} route
 * @param {unknown} source
 * @returns {boolean}
 */
export function isProviderRouteSource(route, source) {
    return route.providerSources.includes(String(source));
}

/**
 * The declared bounds of a route's timeout. Bounds live in SLIDER_LIMITS
 * alone; this is the route-keyed way to read them. A route whose timeout
 * declared no upper bound would clamp every stored value to zero, so the
 * declaration is rejected instead.
 * @param {ConnectionRoute} route
 * @returns {{ MIN: number, MAX: number, STEP: number }}
 */
export function getRouteTimeoutLimits(route) {
    const limits = SLIDER_LIMITS[route.timeoutKey];
    if (limits.MAX === null) {
        throw new Error(`Connection route ${route.id} declares a timeout with no upper bound.`);
    }
    return { MIN: limits.MIN, MAX: limits.MAX, STEP: limits.STEP };
}
