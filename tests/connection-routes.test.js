import { describe, expect, it } from 'vitest';

import {
    AUDITOR_CHAIN,
    CONNECTION_ROUTES,
    NARRATIVE_CHAIN,
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

    it('claims each setting key for exactly one route', () => {
        const claimed = new Map();
        for (const route of routes) {
            for (const key of getRouteSettingKeys(route)) {
                expect(claimed.has(key), `${key} claimed by ${claimed.get(key)}`).toBe(false);
                claimed.set(key, route.id);
            }
        }
        expect(claimed.size).toBe(routes.length * 4);
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
