import { describe, expect, it } from 'vitest';

import { defaultSettings } from '../src/foundation/constants.js';

import {
    STATE_CATEGORIES,
    buildStateSchemaText,
    getActiveLineCap,
    getCategoryByKey,
    getEnabledCategories,
    getEnabledStateKeys,
    isCategoryEnabled,
} from '../src/foundation/state-categories.js';

const allEnabled = {
    stateCatDateTime: true,
    stateCatBonds: true,
    stateCatChekhov: true,
    stateCatGmNotes: true,
    stateCatInventory: true,
    stateCatLocation: true,
};

const dateTimeOnly = {
    stateCatDateTime: true,
    stateCatBonds: false,
    stateCatChekhov: false,
    stateCatGmNotes: false,
    stateCatInventory: false,
    stateCatLocation: false,
};

describe('state-categories catalog', () => {
    it('exposes a frozen six-entry catalog with the documented canonical keys', () => {
        expect(Object.isFrozen(STATE_CATEGORIES)).toBe(true);
        expect(STATE_CATEGORIES.map((c) => c.key)).toStrictEqual([
            'current_date_time',
            'bonds',
            'chekhov',
            'gm_notes',
            'inventory',
            'location',
        ]);
    });

    it('getCategoryByKey resolves known keys and returns undefined otherwise', () => {
        expect(getCategoryByKey('bonds')).toBe(STATE_CATEGORIES[1]);
        expect(getCategoryByKey('nope')).toBeUndefined();
    });

    it('default settings enable only current_date_time', () => {
        expect(getEnabledStateKeys(dateTimeOnly)).toStrictEqual(['current_date_time']);
        const text = buildStateSchemaText(dateTimeOnly);
        expect(text).toContain('current_date_time:');
        expect(text).not.toContain('bonds:');
    });

    it('all six enabled are returned in priority order (date-time first)', () => {
        expect(getEnabledStateKeys(allEnabled)).toStrictEqual([
            'current_date_time',
            'bonds',
            'chekhov',
            'gm_notes',
            'inventory',
            'location',
        ]);
        expect(getEnabledCategories(allEnabled)).toHaveLength(6);
    });

    it('getActiveLineCap sums enabled caps from the catalog and clamps to the ceiling', () => {
        const catalogSum = STATE_CATEGORIES.reduce((sum, c) => sum + c.lineCapDefault, 0);
        expect(getActiveLineCap(allEnabled)).toBe(catalogSum);
        expect(getActiveLineCap(allEnabled, 12)).toBe(12);
        expect(getActiveLineCap({})).toBe(2);
    });

    it('buildStateSchemaText fills {cap} and emits a header per enabled category key only', () => {
        const text = buildStateSchemaText(allEnabled);
        expect(text).not.toContain('{cap}');
        for (const category of STATE_CATEGORIES) {
            expect(text).toContain(`${category.key}:`);
        }

        const partial = { ...allEnabled, stateCatBonds: false, stateCatChekhov: false };
        const partialText = buildStateSchemaText(partial);
        const enabledKeys = getEnabledStateKeys(partial);
        for (const category of STATE_CATEGORIES) {
            expect(partialText.includes(`${category.key}:`)).toBe(
                enabledKeys.includes(category.key),
            );
        }
    });

    it('isCategoryEnabled handles unknown keys and always-on override of a falsey flag', () => {
        expect(isCategoryEnabled(allEnabled, 'definitely_not_a_key')).toBe(false);
        // current_date_time is alwaysOn in the catalog, so it wins over the
        // falsey persisted flag.
        expect(isCategoryEnabled({}, 'current_date_time')).toBe(true);
        expect(isCategoryEnabled({ stateCatDateTime: false }, 'current_date_time')).toBe(true);
    });

    it('an un-normalized settings object missing every stateCat* key reads as date-time-only', () => {
        // Raw objects bypass the getSettings() backfill, so only the alwaysOn
        // category survives. Normalized settings get the defaultSettings
        // flags instead.
        const legacy = { someOtherSetting: true };
        expect(getEnabledStateKeys(legacy)).toStrictEqual(['current_date_time']);
        expect(getActiveLineCap(legacy)).toBe(2);
    });

    it('ships date-time and location on; bonds, chekhov, gm-notes, inventory opt-in', () => {
        expect(defaultSettings.stateCatDateTime).toBe(true);
        expect(defaultSettings.stateCatLocation).toBe(true);
        expect(defaultSettings.stateCatBonds).toBe(false);
        expect(defaultSettings.stateCatChekhov).toBe(false);
        expect(defaultSettings.stateCatGmNotes).toBe(false);
        expect(defaultSettings.stateCatInventory).toBe(false);
    });

    it('ships with the [CURRENT STATE] injection off by default', () => {
        expect(defaultSettings.injectCurrentState).toBe(false);
    });
});
