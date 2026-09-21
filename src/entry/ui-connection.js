import {
    CONNECTION_ROUTES,
    getRoutePanelIds,
    getRoutePanels,
    isProviderRouteSource,
    resolveRouteSource,
} from '../foundation/connection-routes.js';
import { populateProfileDropdown } from '../core/connectionutil.js';
import { refreshFull } from '../foundation/refresh.js';
import { getSettings } from '../foundation/state.js';
import { bindDataSettingElements, bindElementSetting, readString } from './ui-bind.js';

/**
 * The Auditor's dependent UI: its fallback card and the narrative-failover row
 * exist only while the Auditor runs its own connection, so they follow the
 * Auditor route's separation instead of a slot of their own.
 */
const AUDITOR_NARRATIVE_FALLBACK_ID = 'sc_auditor_narrative_fallback';

const AUDITOR_DEPENDENT_SELECTORS = [
    '#summaryception_auditor_fallback_section',
    `#${AUDITOR_NARRATIVE_FALLBACK_ID}_row`,
].join(', ');

/**
 * @typedef {import('../foundation/connection-routes.js').ConnectionRoute} ConnectionRoute
 * @typedef {import('../foundation/connection-routes.js').ConnectionRoutePanel} ConnectionRoutePanel
 */

/**
 * A slot's selectors: the catalogue's bare ids wrapped for jQuery. A row the
 * slot does not declare stays null, so the sync pass never probes a selector
 * that matches nothing.
 * @param {ConnectionRoutePanel} panel
 * @returns {{ source: string, profile: string, profilePanel: string, responseLengthRow: string | null, timeoutRow: string | null, responseLengthInput: string | null }}
 */
function routePanelSelectors(panel) {
    const ids = getRoutePanelIds(panel);
    return {
        source: `#${ids.source}`,
        profile: `#${ids.profile}`,
        profilePanel: `#${ids.profilePanel}`,
        responseLengthRow: ids.responseLengthRow === null ? null : `#${ids.responseLengthRow}`,
        timeoutRow: ids.timeoutRow === null ? null : `#${ids.timeoutRow}`,
        responseLengthInput:
            ids.responseLengthInput === null ? null : `#${ids.responseLengthInput}`,
    };
}

/**
 * @returns {void}
 */
export function initConnectionUI() {
    const settings = getSettings();

    bindConnectionRoutes(settings);
    bindConnectionInputs();
    syncConnectionPanels(settings);
}

/**
 * Bind every route's source and profile selects, one owner per control.
 * @param {ReturnType<typeof getSettings>} settings
 * @returns {void}
 */
function bindConnectionRoutes(settings) {
    for (const { route, panel } of getRoutePanels()) {
        const selectors = routePanelSelectors(panel);
        bindRouteSource(settings, route, selectors.source);
        bindRouteProfile(settings, route, selectors.profile);
    }
}

/**
 * @param {ReturnType<typeof getSettings>} settings
 * @param {ConnectionRoute} route
 * @param {string} selector
 * @returns {void}
 */
function bindRouteSource(settings, route, selector) {
    const $source = $(selector);
    if (!$source.length) {
        return;
    }
    $source.val(resolveRouteSource(settings, route));
    bindElementSetting($source, {
        eventName: 'change',
        key: route.sourceKey,
        read: readString,
        afterSave: refreshFull,
    });
}

/**
 * @param {ReturnType<typeof getSettings>} settings
 * @param {ConnectionRoute} route
 * @param {string} selector
 * @returns {void}
 */
function bindRouteProfile(settings, route, selector) {
    const $profile = $(selector);
    if (!$profile.length) {
        return;
    }
    populateProfileDropdown($profile[0], String(settings[route.profileKey] || ''));
    bindElementSetting($profile, {
        eventName: 'change',
        key: route.profileKey,
        read: readString,
    });
}

/**
 * Bind the route response-length inputs and the Auditor's narrative-failover
 * checkbox: the plain settings the route cards carry.
 * @returns {void}
 */
function bindConnectionInputs() {
    bindDataSettingElements(buildConnectionInputSelector(), {
        eventName: 'input',
    });
}

/**
 * @returns {string}
 */
function buildConnectionInputSelector() {
    const selectors = getRoutePanels()
        .map(({ panel }) => routePanelSelectors(panel).responseLengthInput)
        .filter((selector) => selector !== null);
    selectors.push(`#${AUDITOR_NARRATIVE_FALLBACK_ID}`);
    return selectors.join(', ');
}

/**
 * Sync every route card from the settings object: the profile panel shows for a
 * profile source, and a separated route also shows the rows its slots declare.
 * @param {ReturnType<typeof getSettings>} s
 * @returns {void}
 */
export function syncConnectionPanels(s) {
    for (const route of Object.values(CONNECTION_ROUTES)) {
        const separated = isProviderRouteSource(route, resolveRouteSource(s, route));
        for (const panel of route.panels) {
            syncRoutePanel(routePanelSelectors(panel), s[route.sourceKey], separated);
        }
    }

    const auditor = CONNECTION_ROUTES.auditor;
    $(AUDITOR_DEPENDENT_SELECTORS).toggle(
        isProviderRouteSource(auditor, resolveRouteSource(s, auditor)),
    );
}

/**
 * @param {{ profilePanel: string, responseLengthRow: string | null, timeoutRow: string | null }} selectors
 * @param {unknown} source - The route's stored source value.
 * @param {boolean} separated - Whether the source runs the route's own connection.
 * @returns {void}
 */
function syncRoutePanel(selectors, source, separated) {
    $(selectors.profilePanel).toggle(source === 'profile');
    if (selectors.responseLengthRow !== null) {
        $(selectors.responseLengthRow).toggle(separated);
    }
    if (selectors.timeoutRow !== null) {
        $(selectors.timeoutRow).toggle(separated);
    }
}
