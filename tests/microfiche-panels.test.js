import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    MEMORY_MODES,
    MICROFICHE_GEOMETRY_PRESETS,
    SLIDER_LIMITS,
    applyMicroficheGeometryPreset,
    applyMicroficheShapeAsCustom,
    defaultSettings,
    lookupModelShapes,
} from '../src/foundation/constants.js';
import { SETTINGS_HELP } from '../src/entry/settings-help-data.js';
import { installSummaryContext } from './test-helpers.js';

const HTML = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');

describe('microfiche panels', () => {
    it('offers microfiche as a third mode card in both panels', () => {
        for (const id of ['sc_easy_memory_mode_microfiche', 'sc_memory_mode_microfiche']) {
            expect(HTML, `#${id}`).toContain(`id="${id}"`);
        }
        expect(HTML).toContain('name="sc_easy_memory_mode" value="microfiche"');
        expect(HTML).toContain('name="sc_memory_mode" value="microfiche"');
    });

    it('binds keep-raw and image-cap sliders in both panels', () => {
        for (const id of [
            'sc_easy_microfiche_keep_raw',
            'sc_easy_microfiche_image_cap',
            'sc_microfiche_keep_raw',
            'sc_microfiche_image_cap',
        ]) {
            expect(HTML, `#${id}`).toContain(`id="${id}"`);
        }
    });

    it('types the columns select as a number for the binding reader', () => {
        const tag = HTML.match(/<select\b[^>]*id="sc_microfiche_columns"[^>]*>/)?.[0] ?? '';
        expect(tag).toContain('data-sc-type="number"');
    });

    it('keeps geometry controls advanced-only', () => {
        for (const id of [
            'sc_microfiche_geometry',
            'sc_microfiche_model_name',
            'sc_microfiche_lookup',
            'sc_microfiche_shapes',
            'sc_microfiche_font',
            'sc_microfiche_cell_width',
            'sc_microfiche_cell_height',
            'sc_microfiche_stretch',
            'sc_microfiche_variant',
            'sc_microfiche_stopword_dim',
            'sc_microfiche_columns',
            'sc_microfiche_line_repeat',
            'sc_microfiche_frame_size',
        ]) {
            expect(HTML, `#${id}`).toContain(`id="${id}"`);
        }
        expect(HTML).not.toContain('sc_easy_microfiche_geometry');
        expect(HTML).not.toContain('sc_easy_microfiche_lookup');
    });

    it('documents microfiche in both help maps', () => {
        for (const key of ['memory_mode_microfiche', 'easy_memory_mode_microfiche']) {
            expect(SETTINGS_HELP[key], key).toBeDefined();
        }
        expect(SETTINGS_HELP.memory_mode_microfiche.controls).toContain(
            '#sc_memory_mode_microfiche',
        );
    });
});

describe('microfiche geometry presets', () => {
    it('stamps a named preset into the explicit knobs', () => {
        installSummaryContext({ settings: { microficheGeometry: 'gemini' } });
        const settings = { ...defaultSettings, microficheGeometry: 'custom' };
        expect(applyMicroficheGeometryPreset(settings, 'deepseek')).toBe(true);
        expect(settings.microficheGeometry).toBe('deepseek');
        expect(settings).toMatchObject({
            microficheFont: MICROFICHE_GEOMETRY_PRESETS.deepseek.font,
            microficheCellWidth: MICROFICHE_GEOMETRY_PRESETS.deepseek.cellWidth,
            microficheCellHeight: MICROFICHE_GEOMETRY_PRESETS.deepseek.cellHeight,
            microficheVariant: MICROFICHE_GEOMETRY_PRESETS.deepseek.variant,
            microficheFrameSize: MICROFICHE_GEOMETRY_PRESETS.deepseek.frameSize,
        });
    });

    it('keeps values when switching to custom and when the preset repeats', () => {
        const settings = { ...defaultSettings, microficheGeometry: 'gemini' };
        expect(applyMicroficheGeometryPreset(settings, 'custom')).toBe(true);
        expect(settings.microficheGeometry).toBe('custom');
        expect(settings.microficheFont).toBe(defaultSettings.microficheFont);
        expect(applyMicroficheGeometryPreset(settings, 'custom')).toBe(false);
        const stamped = { ...settings };
        expect(applyMicroficheGeometryPreset(stamped, 'gemini')).toBe(true);
        expect(applyMicroficheGeometryPreset(stamped, 'gemini')).toBe(false);
    });

    it('loads a looked-up shape as the custom starting point', () => {
        const [shape] = lookupModelShapes('deep');
        expect(shape.preset).toBe('deepseek');
        const settings = { ...defaultSettings, microficheGeometry: 'gemini' };
        expect(applyMicroficheShapeAsCustom(settings, shape.preset)).toBe(true);
        expect(settings.microficheGeometry).toBe('custom');
        expect(settings.microficheFrameSize).toBe(MICROFICHE_GEOMETRY_PRESETS.deepseek.frameSize);
        expect(applyMicroficheShapeAsCustom(settings, 'bogus')).toBe(false);
    });

    it('toggles the microfiche rows only on the microfiche mode', async () => {
        const { syncMemoryModeControls } = await import('../src/entry/ui.js');
        const toggles = {};
        const visible = new Set();
        globalThis.$ = (selector) => ({
            toggle(shown) {
                toggles[selector] = shown;
                if (shown) {
                    visible.add(selector);
                }
            },
            is: () => false,
        });

        syncMemoryModeControls({ memoryMode: MEMORY_MODES.MICROFICHE });
        expect(toggles['.sc-microfiche-mode-row']).toBe(true);
        expect(toggles['.sc-cache-mode-row']).toBe(false);
        expect(toggles['#sc_memory_help_microfiche']).toBe(true);
        expect(toggles['#sc_memory_help_prefix_cache']).toBe(false);

        syncMemoryModeControls({ memoryMode: MEMORY_MODES.BALANCED });
        expect(toggles['.sc-microfiche-mode-row']).toBe(false);
        expect(toggles['#sc_memory_help_microfiche']).toBe(false);
        delete globalThis.$;
        expect(SLIDER_LIMITS.microficheKeepRaw.MIN).toBe(0);
    });
});
