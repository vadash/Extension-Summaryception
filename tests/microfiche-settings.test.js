import { describe, expect, it } from 'vitest';

import {
    MEMORY_MODES,
    MEMORY_MODE_PRESETS,
    SLIDER_LIMITS,
    applyMemoryModePreset,
    defaultSettings,
} from '../src/foundation/constants.js';
import * as constants from '../src/foundation/constants.js';
import { normalizeSettings } from '../src/foundation/settings-normalizer.js';
import { getSettings, resetSettingsToDefaults } from '../src/foundation/settings.js';
import {
    SUMMARY_COMMIT_MODES,
    SUMMARY_ROUTES,
    buildAutoSummaryRoutePlan,
} from '../src/core/summarization-routes.js';
import {
    installSummaryContext,
    makeSizedChat,
    makeSummaryStore,
    readySettings,
} from './test-helpers.js';

function normalize(overrides = {}, stored = { hadMaskUserRoleMode: true }) {
    const settings = { ...defaultSettings, ...overrides };
    return { settings, changed: normalizeSettings(settings, stored) };
}

function settingsFor(overrides = {}) {
    installSummaryContext({ settings: overrides });
    return getSettings();
}

describe('microfiche memory mode', () => {
    it('registers microfiche as a selectable mode', () => {
        expect(MEMORY_MODES.MICROFICHE).toBe('microfiche');
        expect(constants.SELECTABLE_MEMORY_MODES ?? []).toContain(MEMORY_MODES.BALANCED);
        expect(constants.SELECTABLE_MEMORY_MODES ?? []).toContain(MEMORY_MODES.PREFIX_CACHE);
        expect(constants.SELECTABLE_MEMORY_MODES ?? []).toContain(MEMORY_MODES.MICROFICHE);
    });

    it('carries Prefix-Cache-equal retention budgets', () => {
        expect(MEMORY_MODE_PRESETS[MEMORY_MODES.MICROFICHE]).toEqual({
            verbatimTokenBudget: 20000,
            queuedTokenBudget: 16000,
            atomicPartitions: true,
        });
        expect(MEMORY_MODE_PRESETS[MEMORY_MODES.MICROFICHE]).toEqual(
            MEMORY_MODE_PRESETS[MEMORY_MODES.PREFIX_CACHE],
        );
    });

    it('stamps retention on balanced-to-microfiche and restores on the way back', () => {
        const settings = { ...defaultSettings, memoryMode: MEMORY_MODES.BALANCED };
        expect(applyMemoryModePreset(settings, MEMORY_MODES.MICROFICHE)).toBe(true);
        expect(settings.memoryMode).toBe(MEMORY_MODES.MICROFICHE);
        expect(settings).toMatchObject(MEMORY_MODE_PRESETS[MEMORY_MODES.MICROFICHE]);
        expect(applyMemoryModePreset(settings, MEMORY_MODES.BALANCED)).toBe(true);
        expect(settings).toMatchObject(MEMORY_MODE_PRESETS[MEMORY_MODES.BALANCED]);
    });

    it('keeps microfiche mode through normalization', () => {
        const { settings, changed } = normalize({
            memoryMode: MEMORY_MODES.MICROFICHE,
            atomicPartitions: true,
        });
        expect(settings.memoryMode).toBe(MEMORY_MODES.MICROFICHE);
        expect(settings.atomicPartitions).toBe(true);
        expect(changed).toBe(false);
    });

    it('still repairs unknown modes to the default and remaps append_only', () => {
        expect(normalize({ memoryMode: 'not-a-mode' }).settings.memoryMode).toBe(
            MEMORY_MODES.BALANCED,
        );
        expect(normalize({ memoryMode: 'append_only' }).settings.memoryMode).toBe(
            MEMORY_MODES.PREFIX_CACHE,
        );
    });

    it('preserves microfiche across a defaults reset and re-applies its preset', () => {
        const s = settingsFor({ memoryMode: MEMORY_MODES.MICROFICHE });
        s.verbatimTokenBudget = 1;
        s.queuedTokenBudget = 999999;
        s.microficheKeepRaw = 99;
        resetSettingsToDefaults();
        expect(s.memoryMode).toBe(MEMORY_MODES.MICROFICHE);
        expect(s).toMatchObject(MEMORY_MODE_PRESETS[MEMORY_MODES.MICROFICHE]);
        expect(s.microficheKeepRaw).toBe(defaultSettings.microficheKeepRaw);
    });

    it('plans the identical atomic route for microfiche and prefix_cache', async () => {
        const chat = makeSizedChat(8, { userLength: 400, assistantLength: 400 });
        const prefixPlan = await buildAutoSummaryRoutePlan(
            chat,
            makeSummaryStore(),
            readySettings(MEMORY_MODES.PREFIX_CACHE),
        );
        const microPlan = await buildAutoSummaryRoutePlan(
            chat,
            makeSummaryStore(),
            readySettings(MEMORY_MODES.MICROFICHE),
        );
        expect(microPlan).toEqual(prefixPlan);
        expect(microPlan.route).toBe(SUMMARY_ROUTES.CACHE_AUTO);
        expect(microPlan.commitMode).toBe(SUMMARY_COMMIT_MODES.ATOMIC_PARTITIONS);
    });
});

describe('microfiche defaults and bounds', () => {
    it('ships the Anthropic family winner as the default', () => {
        expect(defaultSettings).toMatchObject({
            microficheKeepRaw: 0,
            microficheImageCap: 8,
            microficheFont: '8x13',
            microficheCellWidth: 11,
            microficheCellHeight: 16,
            microficheVariant: 'bw',
            microficheStopwordDim: false,
            microficheColumns: 1,
            microficheLineRepeat: 1,
            microficheFrameSize: 1568,
            microficheModelName: '',
            microficheGeometry: 'anthropic',
            microficheMemoryImages: false,
            microficheFrozenRawImages: false,
        });
        expect(defaultSettings).not.toHaveProperty('microficheStretch');
    });

    it('declares every numeric bound once in the slider-limits map', () => {
        expect(SLIDER_LIMITS.microficheKeepRaw).toEqual({ MIN: 0, MAX: 10, STEP: 1 });
        expect(SLIDER_LIMITS.microficheImageCap).toEqual({ MIN: 1, MAX: 80, STEP: 1 });
        expect(SLIDER_LIMITS.microficheCellWidth).toEqual({ MIN: 5, MAX: 16, STEP: 1 });
        expect(SLIDER_LIMITS.microficheCellHeight).toEqual({ MIN: 6, MAX: 22, STEP: 1 });
        expect(SLIDER_LIMITS.microficheLineRepeat).toEqual({ MIN: 1, MAX: 2, STEP: 1 });
        expect(SLIDER_LIMITS.microficheFrameSize).toEqual({ MIN: 512, MAX: 2608, STEP: 8 });
    });
});

describe('microfiche normalization', () => {
    it('clamps out-of-range numerics into their slider bounds', () => {
        const { settings } = normalize({
            microficheKeepRaw: 99,
            microficheImageCap: 999,
            microficheCellWidth: 99,
            microficheCellHeight: 1,
            microficheLineRepeat: 99,
            microficheFrameSize: 99999,
            microficheColumns: 99,
        });
        expect(settings).toMatchObject({
            microficheKeepRaw: 10,
            microficheImageCap: 80,
            microficheCellWidth: 16,
            microficheCellHeight: 6,
            microficheLineRepeat: 2,
            microficheFrameSize: 2608,
            microficheColumns: 2,
        });
    });

    it('falls back to the range floor for garbage numerics', () => {
        const { settings } = normalize({
            microficheKeepRaw: 'bogus',
            microficheImageCap: 'bogus',
            microficheCellWidth: 'bogus',
            microficheCellHeight: 'bogus',
            microficheLineRepeat: 'bogus',
            microficheFrameSize: 'bogus',
            microficheColumns: 'bogus',
        });
        expect(settings).toMatchObject({
            microficheKeepRaw: 0,
            microficheImageCap: 1,
            microficheCellWidth: 5,
            microficheCellHeight: 6,
            microficheLineRepeat: 1,
            microficheFrameSize: 512,
            microficheColumns: 1,
        });
    });

    it('snaps frame size to its step', () => {
        expect(normalize({ microficheFrameSize: 2050 }).settings.microficheFrameSize).toBe(2048);
        expect(normalize({ microficheFrameSize: 2054 }).settings.microficheFrameSize).toBe(2056);
    });

    it('accepts numeric strings for columns and line repeat', () => {
        const { settings } = normalize({ microficheColumns: '2', microficheLineRepeat: '2' });
        expect(settings.microficheColumns).toBe(2);
        expect(settings.microficheLineRepeat).toBe(2);
    });

    it('keeps every listed font, variant, and geometry name', () => {
        expect(constants.MICROFICHE_FONTS).toEqual(['5x8', '8x8', '6x12', '8x13']);
        expect(constants.MICROFICHE_VARIANTS).toEqual(['bw', 'sent']);
        expect(constants.MICROFICHE_GEOMETRY_NAMES).toEqual([
            'anthropic',
            'google',
            'openai',
            'custom',
        ]);
        for (const font of constants.MICROFICHE_FONTS ?? []) {
            expect(normalize({ microficheFont: font }).settings.microficheFont).toBe(font);
        }
        for (const variant of constants.MICROFICHE_VARIANTS ?? []) {
            expect(normalize({ microficheVariant: variant }).settings.microficheVariant).toBe(
                variant,
            );
        }
        for (const geometry of constants.MICROFICHE_GEOMETRY_NAMES ?? []) {
            expect(normalize({ microficheGeometry: geometry }).settings.microficheGeometry).toBe(
                geometry,
            );
        }
    });

    it('falls back to defaults for unknown font, variant, and geometry', () => {
        const { settings } = normalize({
            microficheFont: 'bogus',
            microficheVariant: 'bogus',
            microficheGeometry: 'bogus',
        });
        expect(settings.microficheFont).toBe(defaultSettings.microficheFont);
        expect(settings.microficheVariant).toBe(defaultSettings.microficheVariant);
        expect(settings.microficheGeometry).toBe(defaultSettings.microficheGeometry);
    });

    it('coerces the image placement toggles with strict booleans', () => {
        const kept = normalize({
            microficheMemoryImages: true,
            microficheFrozenRawImages: true,
        }).settings;
        expect(kept).toMatchObject({
            microficheMemoryImages: true,
            microficheFrozenRawImages: true,
        });
        const repaired = normalize({
            microficheMemoryImages: 'true',
            microficheFrozenRawImages: 1,
        });
        expect(repaired.settings.microficheMemoryImages).toBe(false);
        expect(repaired.settings.microficheFrozenRawImages).toBe(false);
        expect(repaired.changed).toBe(true);
    });

    it('repairs stored silver to 8x13 and pins stored stretch false', () => {
        const silver = normalize({ microficheFont: 'silver' });
        expect(silver.settings.microficheFont).toBe('8x13');
        expect(silver.changed).toBe(true);
        const stretched = normalize({ microficheStretch: true });
        expect(stretched.settings.microficheStretch).toBe(false);
        expect(stretched.changed).toBe(true);
    });

    it('keeps stopword dim a strict boolean', () => {
        const kept = normalize({ microficheStopwordDim: true }).settings;
        expect(kept.microficheStopwordDim).toBe(true);
        const dropped = normalize({ microficheStopwordDim: 1 }).settings;
        expect(dropped.microficheStopwordDim).toBe(false);
    });

    it('maps each legacy geometry to its family preset and stamps its knobs', () => {
        const cases = [
            ['gemini', 'google'],
            ['deepseek', 'openai'],
            ['glm', 'anthropic'],
        ];
        for (const [stored, family] of cases) {
            const { settings, changed } = normalize({ microficheGeometry: stored });
            expect(settings.microficheGeometry).toBe(family);
            expect(settings).toMatchObject({
                microficheFont: constants.MICROFICHE_GEOMETRY_PRESETS[family].font,
                microficheCellWidth: constants.MICROFICHE_GEOMETRY_PRESETS[family].cellWidth,
                microficheCellHeight: constants.MICROFICHE_GEOMETRY_PRESETS[family].cellHeight,
                microficheVariant: constants.MICROFICHE_GEOMETRY_PRESETS[family].variant,
                microficheLineRepeat: constants.MICROFICHE_GEOMETRY_PRESETS[family].lineRepeat,
                microficheFrameSize: constants.MICROFICHE_GEOMETRY_PRESETS[family].frameSize,
            });
            expect(changed).toBe(true);
        }
    });

    it('repairs stored silver and legacy geometry on the settings load path', () => {
        const settings = settingsFor({
            microficheFont: 'silver',
            microficheGeometry: 'gemini',
        });
        expect(settings.microficheFont).toBe('8x13');
        expect(settings.microficheGeometry).toBe('google');
        expect(settings.microficheCellWidth).toBe(8);
        expect(settings.microficheCellHeight).toBe(22);
        expect(settings.microficheFrameSize).toBe(1568);
    });

    it('resets a non-string model name and leaves text untouched', () => {
        expect(normalize({ microficheModelName: 42 }).settings.microficheModelName).toBe('');
        expect(
            normalize({ microficheModelName: 'Gemini 2.0 Flash' }).settings.microficheModelName,
        ).toBe('Gemini 2.0 Flash');
    });
});

describe('microfiche geometry catalogue', () => {
    it('freezes the font, variant, and geometry name lists', () => {
        expect(Object.isFrozen(constants.MICROFICHE_FONTS)).toBe(true);
        expect(Object.isFrozen(constants.MICROFICHE_VARIANTS)).toBe(true);
        expect(Object.isFrozen(constants.MICROFICHE_GEOMETRY_NAMES)).toBe(true);
        expect(Object.isFrozen(constants.MICROFICHE_GEOMETRY_PRESETS)).toBe(true);
    });

    it('mirrors each family preset with its reader list', () => {
        expect(constants.MICROFICHE_GEOMETRY_PRESETS.anthropic).toEqual({
            font: '8x13',
            cellWidth: 11,
            cellHeight: 16,
            variant: 'bw',
            stopwordDim: false,
            columns: 1,
            lineRepeat: 1,
            frameSize: 1568,
            frameTokenEstimate: 3136,
            imageBudget: 5,
            readers: ['anthropic'],
        });
        expect(constants.MICROFICHE_GEOMETRY_PRESETS.google).toEqual({
            font: '8x13',
            cellWidth: 8,
            cellHeight: 22,
            variant: 'bw',
            stopwordDim: false,
            columns: 1,
            lineRepeat: 1,
            frameSize: 1568,
            frameTokenEstimate: 1120,
            imageBudget: 200,
            readers: ['google'],
        });
        expect(constants.MICROFICHE_GEOMETRY_PRESETS.openai).toEqual({
            font: '8x13',
            cellWidth: 8,
            cellHeight: 22,
            variant: 'bw',
            stopwordDim: false,
            columns: 1,
            lineRepeat: 1,
            frameSize: 1568,
            frameTokenEstimate: 994,
            readers: ['openai'],
        });
        expect(constants.MICROFICHE_GEOMETRY_PRESETS.custom).toBeNull();
    });

    it('resolves billing and budgets from the preset name, never from knobs', () => {
        expect(constants.MICROFICHE_GEOMETRY_PRESETS.anthropic.frameTokenEstimate).toBe(3136);
        expect(constants.MICROFICHE_GEOMETRY_PRESETS.anthropic.imageBudget).toBe(5);
        expect(constants.MICROFICHE_GEOMETRY_PRESETS.google.frameTokenEstimate).toBe(1120);
        expect(constants.MICROFICHE_GEOMETRY_PRESETS.google.imageBudget).toBe(200);
        expect(constants.MICROFICHE_GEOMETRY_PRESETS.openai.frameTokenEstimate).toBe(994);
        expect(constants.MICROFICHE_GEOMETRY_PRESETS.openai.imageBudget).toBeUndefined();
        expect(constants.MICROFICHE_GEOMETRY_PRESETS.custom).toBeNull();
    });

    it('stamps render knobs only, never billing or budget', () => {
        const settings = {
            ...defaultSettings,
            microficheGeometry: 'custom',
            microficheFrameSize: 512,
        };
        expect(constants.applyMicroficheGeometryPreset(settings, 'google')).toBe(true);
        expect(settings.microficheGeometry).toBe('google');
        expect(settings).toMatchObject({
            microficheFont: '8x13',
            microficheCellWidth: 8,
            microficheCellHeight: 22,
            microficheVariant: 'bw',
            microficheLineRepeat: 1,
            microficheFrameSize: 1568,
        });
        expect(settings).not.toHaveProperty('frameTokenEstimate');
        expect(settings).not.toHaveProperty('imageBudget');
        expect(settings).not.toHaveProperty('microficheStretch');
        const customStart = { ...defaultSettings, microficheGeometry: 'anthropic' };
        expect(constants.applyMicroficheShapeAsCustom(customStart, 'openai')).toBe(true);
        expect(customStart.microficheGeometry).toBe('custom');
        expect(customStart).not.toHaveProperty('frameTokenEstimate');
        expect(customStart).not.toHaveProperty('imageBudget');
    });

    it('holds three finder shapes mirroring the presets', () => {
        const shapes = constants.MICROFICHE_SHAPES ?? [];
        expect(shapes).toHaveLength(3);
        expect(shapes.map((shape) => shape.preset)).toEqual(['anthropic', 'google', 'openai']);
        for (const shape of shapes) {
            expect(shape.match).toContain(shape.preset);
            expect(shape).toMatchObject(constants.MICROFICHE_GEOMETRY_PRESETS[shape.preset]);
        }
    });

    it('looks up shapes by case-insensitive substring', () => {
        expect(typeof constants.lookupModelShapes).toBe('function');
        expect(constants.lookupModelShapes('').map((shape) => shape.preset)).toEqual([
            'anthropic',
            'google',
            'openai',
        ]);
        expect(constants.lookupModelShapes('GEM').map((shape) => shape.preset)).toEqual(['google']);
        expect(constants.lookupModelShapes('deep').map((shape) => shape.preset)).toEqual([
            'openai',
        ]);
        expect(constants.lookupModelShapes('glm').map((shape) => shape.preset)).toEqual([
            'anthropic',
        ]);
        expect(constants.lookupModelShapes('no-such-model')).toEqual([]);
        expect(constants.lookupModelShapes('e').length).toBeLessThanOrEqual(3);
    });
});
