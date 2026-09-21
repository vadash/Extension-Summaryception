import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
    AUDITOR_CHAIN,
    CONNECTION_ROUTES,
    NARRATIVE_CHAIN,
    getRoutePanelIds,
    getRoutePanels,
    getRouteSettingKeys,
    getRouteTimeoutLimits,
    isProviderRouteSource,
    resolveRouteSource,
} from '../src/foundation/connection-routes.js';
import { defaultSettings } from '../src/foundation/constants.js';
import { providers } from '../src/core/connectionutil.js';

/**
 * The route catalogue is the one declaration of the Connection Route set
 * (ADR-0026), so these tests pin the invariants every other module derives
 * its route facts from.
 */
describe('connection route catalogue', () => {
    const routes = Object.values(CONNECTION_ROUTES);

    it('keys every route by its own id', () => {
        for (const [id, route] of Object.entries(CONNECTION_ROUTES)) {
            expect(route.id, id).toBe(id);
        }
    });

    it('anchors every route setting in defaultSettings, default source included', () => {
        for (const route of routes) {
            for (const key of getRouteSettingKeys(route)) {
                expect(defaultSettings, `${route.id}.${key}`).toHaveProperty(key);
            }
            expect(route.defaultSource, route.id).toBe(defaultSettings[route.sourceKey]);
            expect(route.sourceOptions, route.id).toContain(route.defaultSource);
        }
    });

    it('offers exactly the registered provider sources, and only among its own options', () => {
        const providerSources = new Set(routes.flatMap((route) => route.providerSources));
        expect([...providerSources].sort()).toEqual(Object.keys(providers).sort());

        for (const route of routes) {
            for (const source of route.providerSources) {
                expect(route.sourceOptions, `${route.id}: ${source}`).toContain(source);
            }
            for (const source of route.sourceOptions) {
                expect(isProviderRouteSource(route, source), `${route.id}: ${source}`).toBe(
                    route.providerSources.includes(source),
                );
            }
        }
    });

    it('declares a bounded timeout for every route', () => {
        for (const route of routes) {
            const { MIN, MAX, STEP } = getRouteTimeoutLimits(route);
            expect(Number.isFinite(MIN), route.id).toBe(true);
            expect(Number.isFinite(MAX), route.id).toBe(true);
            expect(MIN, route.id).toBeLessThan(MAX);
            expect(STEP, route.id).toBeGreaterThan(0);
        }
    });

    it('rejects a route whose timeout declares no upper bound', () => {
        expect(() =>
            getRouteTimeoutLimits({
                id: 'layer0',
                timeoutKey: 'summarizerResponseLength',
            }),
        ).toThrow(/no upper bound/);
    });

    it('claims each setting key for exactly one route', () => {
        const claimed = new Map();
        for (const route of routes) {
            for (const key of getRouteSettingKeys(route)) {
                expect(claimed.has(key), `${key} claimed by ${claimed.get(key)}`).toBe(false);
                claimed.set(key, route.id);
            }
        }
    });

    it('resolves an unset source to the route default', () => {
        expect(resolveRouteSource({}, CONNECTION_ROUTES.merge)).toBe('inherit');
        expect(resolveRouteSource({}, CONNECTION_ROUTES.fallback)).toBe('disabled');
        expect(
            resolveRouteSource({ mergeConnectionSource: 'profile' }, CONNECTION_ROUTES.merge),
        ).toBe('profile');
    });

    it('declares both chains over route ids that exist', () => {
        for (const id of [
            NARRATIVE_CHAIN.primary,
            NARRATIVE_CHAIN.promotionOverride,
            NARRATIVE_CHAIN.fallback,
            AUDITOR_CHAIN.primary,
            AUDITOR_CHAIN.fallback,
        ]) {
            expect(CONNECTION_ROUTES, id).toHaveProperty(id);
        }
        expect(NARRATIVE_CHAIN.primary).not.toBe(NARRATIVE_CHAIN.promotionOverride);
        expect(AUDITOR_CHAIN.primary).not.toBe(AUDITOR_CHAIN.fallback);
        expect(defaultSettings).toHaveProperty(AUDITOR_CHAIN.narrativeFailoverKey);
        expect(typeof defaultSettings[AUDITOR_CHAIN.narrativeFailoverKey]).toBe('boolean');
    });
});

/**
 * The catalogue is also the declaration the settings markup must satisfy: a
 * renamed id would otherwise unhook a route card without failing anywhere.
 */
describe('connection route panel slots', () => {
    const html = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
    const slots = getRoutePanels();

    it('declares every id a panel slot owns', () => {
        for (const { route, panel } of slots) {
            for (const id of Object.values(getRoutePanelIds(panel))) {
                if (id === null) {
                    continue;
                }
                expect(html, `${route.id}/${panel.panel}: #${id}`).toContain(`id="${id}"`);
            }
        }
    });

    it('declares a response-length control for every route', () => {
        const routesWithControl = new Set();
        for (const { route, panel } of slots) {
            const { responseLengthInput } = getRoutePanelIds(panel);
            if (responseLengthInput === null) {
                continue;
            }
            routesWithControl.add(route.id);
            expect(html, `${route.id}: #${responseLengthInput}`).toContain(
                `id="${responseLengthInput}"`,
            );
        }
        expect([...routesWithControl].sort()).toEqual(Object.keys(CONNECTION_ROUTES).sort());
    });

    it('shows each slot once, so no control is bound twice', () => {
        const seen = new Set();
        for (const { route, panel } of slots) {
            const { source } = getRoutePanelIds(panel);
            expect(seen.has(source), `${route.id}: ${source}`).toBe(false);
            seen.add(source);
        }
    });
});
