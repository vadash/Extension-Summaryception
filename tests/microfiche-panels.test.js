import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    MEMORY_MODES,
    MICROFICHE_GEOMETRY_PRESETS,
    applyMicroficheGeometryPreset,
    applyMicroficheShapeAsCustom,
    defaultSettings,
    lookupModelShapes,
} from '../src/foundation/constants.js';
import { buildInjection } from '../src/core/memory-injection.js';
import { describeMicroficheBilling, estimateContextPreview } from '../src/core/token-budget.js';
import { getEffectiveSettings, getSettings } from '../src/foundation/settings.js';
import { SETTINGS_HELP } from '../src/entry/settings-help-data.js';
import { syncDataSettingElements } from '../src/entry/ui-bind.js';
import { createJQueryHarness, installSummaryContext, makeForegroundGate } from './test-helpers.js';

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

    it('offers two image placement toggles and keeps the system toggle inert', () => {
        for (const [id, key] of [
            ['sc_microfiche_memory_images', 'microficheMemoryImages'],
            ['sc_microfiche_frozen_raw_images', 'microficheFrozenRawImages'],
        ]) {
            expect(HTML, `#${id}`).toContain(`id="${id}"`);
            expect(HTML, `#${id} binding`).toContain(`data-sc-setting="${key}"`);
        }
        const systemTag =
            HTML.match(/<input\b[^>]*id="sc_microfiche_system_images"[^>]*>/)?.[0] ?? '';
        expect(systemTag).toContain('disabled');
        expect(systemTag).not.toContain('data-sc-setting');
    });

    it('saves each image placement toggle on change and restores it on the next sync', async () => {
        installSummaryContext({
            settings: { microficheMemoryImages: false, microficheFrozenRawImages: false },
        });
        globalThis.document = {};
        const dom = createJQueryHarness({
            attributes: {
                '#sc_microfiche_memory_images': {
                    type: 'checkbox',
                    'data-sc-setting': 'microficheMemoryImages',
                },
                '#sc_microfiche_frozen_raw_images': {
                    type: 'checkbox',
                    'data-sc-setting': 'microficheFrozenRawImages',
                },
            },
        });
        globalThis.$ = dom.$;
        const { bindUIEvents } = await import('../src/entry/ui-events.js');
        const { gate } = makeForegroundGate();
        bindUIEvents({
            notify: null,
            gate,
            queue: { request: async () => {} },
            manualRunnerDeps: { queue: { isBusy: () => false } },
        });

        for (const [id, key] of [
            ['sc_microfiche_memory_images', 'microficheMemoryImages'],
            ['sc_microfiche_frozen_raw_images', 'microficheFrozenRawImages'],
        ]) {
            const $toggle = dom.element(`#${id}`);
            expect($toggle.prop('checked'), id).toBe(false);
            $toggle.prop('checked', true);
            dom.trigger('change', `#${id}`);
            expect(getSettings()[key], key).toBe(true);
            expect(getEffectiveSettings()[key], key).toBe(true);
            // A later render pass re-reads the saved settings into the control.
            $toggle.prop('checked', false);
            syncDataSettingElements(`#${id}`, getSettings());
            expect($toggle.prop('checked'), id).toBe(true);
        }
        delete globalThis.$;
        delete globalThis.document;
    });

    it('shows the holds-and-bills line in the microfiche panel and context preview', async () => {
        const settings = {
            ...defaultSettings,
            memoryTokenBudget: 10000,
            verbatimTokenBudget: 16000,
            queuedTokenBudget: 32000,
            memoryMode: MEMORY_MODES.MICROFICHE,
            microficheGeometry: 'gemini',
            microficheImageCap: 8,
            microficheKeepRaw: 0,
        };
        const injection = buildInjection([[{ text: 'word '.repeat(5000) }]], settings);
        expect(injection.microfiche.imageTexts).toHaveLength(1);
        const billing = describeMicroficheBilling(injection, settings);
        expect(billing).toMatchObject({
            images: 1,
            heldTokens: 5952,
            imageTokens: 1120,
            netTokens: -4832,
            bucketTokens: 48000,
            bucketAfterImages: 46880,
        });
        const preview = estimateContextPreview(settings, injection);
        expect(preview.rawChatMax).toBe(billing.bucketTokens - billing.imageTokens);

        globalThis.$ = createJQueryHarness().$;
        const { syncMicroficheBilling } = await import('../src/entry/ui.js');
        syncMicroficheBilling(injection, settings);
        for (const selector of ['#sc_microfiche_cost', '#sc_llm_context_microfiche']) {
            const line = globalThis.$(selector).text();
            expect(line, selector).toContain('5k');
            expect(line, selector).toContain('1k');
            expect(line, selector).toContain('-4k');
            expect(line, selector).toContain('48k');
        }
        delete globalThis.$;
    });

    it('reports unknown image billing instead of a zero-image split for custom geometry', async () => {
        const settings = {
            ...defaultSettings,
            memoryMode: MEMORY_MODES.MICROFICHE,
            microficheGeometry: 'custom',
            microficheFrameSize: 512,
            microficheImageCap: 8,
            microficheKeepRaw: 0,
        };
        const injection = buildInjection([[{ text: 'word '.repeat(5000) }]], settings);
        expect(injection.microfiche).not.toBeNull();
        expect(injection.microfiche.frameTokenEstimate).toBe(0);
        expect(injection.microfiche.imageTexts.length).toBeGreaterThan(0);
        const billing = describeMicroficheBilling(injection, settings);
        expect(billing.imageTokens).toBe(0);
        expect(billing.netTokens).toBeNull();

        globalThis.$ = createJQueryHarness().$;
        const { syncMicroficheBilling } = await import('../src/entry/ui.js');
        syncMicroficheBilling(injection, settings);
        for (const selector of ['#sc_microfiche_cost', '#sc_llm_context_microfiche']) {
            const line = globalThis.$(selector).text();
            expect(line, selector).toContain('image billing unknown');
            expect(line, selector).not.toContain('0 to images');
            expect(line, selector).not.toContain('left for text');
        }
        delete globalThis.$;
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
        globalThis.$ = (selector) => ({
            toggle(shown) {
                toggles[selector] = shown;
            },
            is: () => false,
            prop() {},
        });

        syncMemoryModeControls({
            memoryMode: MEMORY_MODES.MICROFICHE,
            microficheGeometry: 'gemini',
        });
        expect(toggles['.sc-microfiche-mode-row']).toBe(true);
        expect(toggles['.sc-cache-mode-row']).toBe(false);
        expect(toggles['#sc_memory_help_microfiche']).toBe(true);
        expect(toggles['#sc_memory_help_prefix_cache']).toBe(false);

        syncMemoryModeControls({ memoryMode: MEMORY_MODES.BALANCED, microficheGeometry: 'custom' });
        expect(toggles['.sc-microfiche-mode-row']).toBe(false);
        expect(toggles['#sc_memory_help_microfiche']).toBe(false);
        delete globalThis.$;
    });

    it('locks explicit geometry inputs unless the geometry is custom', async () => {
        const { syncMemoryModeControls } = await import('../src/entry/ui.js');
        const seen = {};
        globalThis.$ = (selector) => ({
            toggle() {},
            is: () => false,
            prop(name, value) {
                if (value === undefined) {
                    return seen[`${selector}:${name}`];
                }
                seen[`${selector}:${name}`] = value;
                return this;
            },
        });
        const locked = [
            '#sc_microfiche_font',
            '#sc_microfiche_cell_width',
            '#sc_microfiche_cell_height',
            '#sc_microfiche_stretch',
            '#sc_microfiche_variant',
            '#sc_microfiche_stopword_dim',
            '#sc_microfiche_columns',
            '#sc_microfiche_line_repeat',
            '#sc_microfiche_frame_size',
        ];
        syncMemoryModeControls({ memoryMode: MEMORY_MODES.BALANCED, microficheGeometry: 'gemini' });
        for (const selector of locked) {
            expect(seen[`${selector}:disabled`]).toBe(true);
        }
        expect(seen['#sc_microfiche_geometry:disabled']).toBeUndefined();
        expect(seen['#sc_microfiche_model_name:disabled']).toBeUndefined();
        syncMemoryModeControls({ memoryMode: MEMORY_MODES.BALANCED, microficheGeometry: 'custom' });
        for (const selector of locked) {
            expect(seen[`${selector}:disabled`]).toBe(false);
        }
        delete globalThis.$;
    });

    it('renders every looked-up shape and loads the clicked shape as custom', async () => {
        installSummaryContext({
            settings: { microficheModelName: '', microficheGeometry: 'gemini' },
        });
        globalThis.document = {};
        const dom = createJQueryHarness();
        const created = [];
        const inner = dom.$;
        globalThis.$ = (target) => {
            const element = inner(target);
            if (typeof target === 'string' && target.startsWith('<button')) {
                created.push(element);
            }
            return element;
        };
        const { bindUIEvents } = await import('../src/entry/ui-events.js');
        const { gate } = makeForegroundGate();
        bindUIEvents({
            notify: null,
            gate,
            queue: { request: async () => {} },
            manualRunnerDeps: { queue: { isBusy: () => false } },
        });
        dom.element('#sc_microfiche_model_name').val('');
        dom.trigger('click', '#sc_microfiche_lookup');
        expect(created.map((button) => button.attr('data-sc-microfiche-shape'))).toEqual([
            'gemini',
            'deepseek',
            'glm',
        ]);
        const glmButton = created.find(
            (button) => button.attr('data-sc-microfiche-shape') === 'glm',
        );
        dom.trigger('click', '[data-sc-microfiche-shape]', glmButton);
        expect(getSettings().microficheGeometry).toBe('custom');
        expect(getSettings().microficheFrameSize).toBe(MICROFICHE_GEOMETRY_PRESETS.glm.frameSize);
        delete globalThis.$;
        delete globalThis.document;
    });

    it('bills preview images at the injected page count, not the image cap', () => {
        const settings = {
            ...defaultSettings,
            memoryMode: MEMORY_MODES.MICROFICHE,
            microficheGeometry: 'glm',
            microficheFrameSize: 512,
            microficheImageCap: 5,
            microficheKeepRaw: 0,
        };
        const layers = [[{ text: 'word '.repeat(1200) }]];
        const injection = buildInjection(layers, settings);
        expect(injection.microfiche).not.toBeNull();
        expect(injection.microfiche.imageTexts.length).toBeGreaterThan(0);
        expect(injection.microfiche.imageTexts.length).toBeLessThan(5);
        const noImages = estimateContextPreview(settings, null);
        const preview = estimateContextPreview(settings, injection);
        const billedFrameTokens =
            injection.microfiche.imageTexts.length *
            MICROFICHE_GEOMETRY_PRESETS.glm.frameTokenEstimate;
        expect(preview.rawChatMax).toBe(noImages.rawChatMax - billedFrameTokens);
        expect(preview.mainMax).toBe(noImages.mainMax);
        expect(preview.mainMin).toBe(
            noImages.mainMin +
                Math.min(billedFrameTokens, noImages.rawChatMax - noImages.rawChatMin),
        );
        const customInjection = buildInjection(layers, {
            ...settings,
            microficheGeometry: 'custom',
            microficheImageCap: 80,
        });
        expect(customInjection.text).toBe(injection.text);
    });
});
