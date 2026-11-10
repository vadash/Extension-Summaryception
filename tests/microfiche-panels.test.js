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
import { readSealedMicrofichePlans } from '../src/core/microfiche-pages.js';
import { buildMicroficheRawSlice } from '../src/core/microfiche-raw-slice.js';
import { describeMicroficheBilling, estimateContextPreview } from '../src/core/token-budget.js';
import { getChatStore } from '../src/foundation/chat-store.js';
import { getEffectiveSettings, getSettings } from '../src/foundation/settings.js';
import { SETTINGS_HELP } from '../src/entry/settings-help-data.js';
import { syncDataSettingElements } from '../src/entry/ui-bind.js';
import {
    createJQueryHarness,
    installSummaryContext,
    makeForegroundGate,
    makeMemoryInjectionWriter,
    makeMessages,
    makeSummaryStore,
} from './test-helpers.js';

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

    it('documents Old Chat Photos and always-on memory imaging', () => {
        const photos = SETTINGS_HELP.microfiche_frozen_raw_images;
        expect(photos.title).toBe('Old Chat Photos');
        expect(photos.detail).not.toMatch(/three quarters/i);
        expect(photos.detail).toContain('Keep Raw leaves the newest whole messages as text');
        const mode = SETTINGS_HELP.memory_mode_microfiche;
        expect(mode.detail).toContain('images memory without a toggle');
        expect(mode.detail).not.toMatch(/three quarters/i);
    });

    it('renders the Old Chat Photos toggle under the mode radios in both panels', () => {
        for (const [id, radios] of [
            ['sc_easy_microfiche_frozen_raw_images', 'Easy Memory Mode'],
            ['sc_microfiche_frozen_raw_images', 'Memory Mode'],
        ]) {
            const start = HTML.indexOf(`aria-label="${radios}"`);
            const section = HTML.slice(start, HTML.indexOf('</section>', start));
            expect(section, `#${id} sits in the mode section`).toContain(`id="${id}"`);
            expect(section, `#${id} microfiche row`).toContain('sc-microfiche-mode-row');
        }
        expect(HTML).not.toContain('sc_microfiche_memory_images');
        expect(HTML).not.toContain('>Memory Images<');
        const systemTag =
            HTML.match(/<input\b[^>]*id="sc_microfiche_system_images"[^>]*>/)?.[0] ?? '';
        expect(systemTag).toContain('disabled');
        expect(systemTag).not.toContain('data-sc-setting');
    });

    it('renders Keep Raw under the mode radios in both panels', () => {
        for (const [id, radios] of [
            ['sc_easy_microfiche_keep_raw', 'Easy Memory Mode'],
            ['sc_microfiche_keep_raw', 'Memory Mode'],
        ]) {
            const start = HTML.indexOf(`aria-label="${radios}"`);
            const section = HTML.slice(start, HTML.indexOf('</section>', start));
            expect(section, `#${id} sits in the mode section`).toContain(`id="${id}"`);
            expect(section, `#${id} hint`).toContain(
                'Newest N chat messages stay text, newest first. Slides each turn.',
            );
        }
    });

    it('locks the Old Chat Photos hint copy in both panels', () => {
        const hint =
            'Photos of older chat (not yet summarized) to save context. Off keeps old chat as text.';
        expect(HTML.split(hint).length - 1).toBe(2);
    });

    it('saves the Old Chat Photos toggle on change and restores it on the next sync', async () => {
        installSummaryContext({ settings: { microficheFrozenRawImages: false } });
        globalThis.document = {};
        const dom = createJQueryHarness({
            attributes: {
                '#sc_easy_microfiche_frozen_raw_images': {
                    type: 'checkbox',
                    'data-sc-setting': 'microficheFrozenRawImages',
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

        for (const id of [
            'sc_easy_microfiche_frozen_raw_images',
            'sc_microfiche_frozen_raw_images',
        ]) {
            const $toggle = dom.element(`#${id}`);
            expect($toggle.prop('checked'), id).toBe(false);
            $toggle.prop('checked', true);
            dom.trigger('change', `#${id}`);
            expect(getSettings().microficheFrozenRawImages, id).toBe(true);
            expect(getEffectiveSettings().microficheFrozenRawImages, id).toBe(true);
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
            microficheGeometry: 'google',
            microficheImageCap: 8,
            microficheKeepRaw: 0,
        };
        const injection = buildInjection([[{ text: 'word '.repeat(5000) }]], settings);
        expect(injection.microfiche.imageTexts).toHaveLength(2);
        const billing = describeMicroficheBilling(injection, settings);
        expect(billing).toMatchObject({
            images: 2,
            heldTokens: 6958,
            imageTokens: 2240,
            netTokens: -4718,
            bucketTokens: 48000,
            bucketAfterImages: 45760,
        });
        const preview = estimateContextPreview(settings, injection);
        expect(preview.rawChatMax).toBe(billing.bucketTokens - billing.imageTokens);

        globalThis.$ = createJQueryHarness().$;
        const { syncMicroficheBilling } = await import('../src/entry/ui.js');
        syncMicroficheBilling(injection, settings);
        for (const selector of ['#sc_microfiche_cost', '#sc_llm_context_microfiche']) {
            const line = globalThis.$(selector).text();
            expect(line, selector).toContain('6k');
            expect(line, selector).toContain('2k');
            expect(line, selector).toContain('-4k');
            expect(line, selector).toContain('48k');
        }
        delete globalThis.$;
    });

    it('bills the re-sealed pages after the writer follows memory-less chat growth', async () => {
        const settings = {
            ...defaultSettings,
            memoryMode: MEMORY_MODES.MICROFICHE,
            microficheGeometry: 'google',
            microficheFrameSize: 512,
            microficheImageCap: 8,
            microficheKeepRaw: 0,
            microficheFrozenRawImages: true,
            verbatimTokenBudget: 20000,
            queuedTokenBudget: 16000,
        };
        const chat = makeMessages(1, { mes: 'lorem ipsum dolor sit amet '.repeat(170) });
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore({ layers: [] }) },
            settings,
        });
        const writer = makeMemoryInjectionWriter();
        writer.update();
        const { buildUiInjection } = await import('../src/entry/ui.js');
        const before = buildUiInjection(getChatStore(), getEffectiveSettings());
        const sealedBefore = before.microficheRaw.imageTexts.length;

        chat.push(...makeMessages(12, { mes: 'lorem ipsum dolor sit amet '.repeat(170) }));
        writer.update();
        const after = buildUiInjection(getChatStore(), getEffectiveSettings());

        expect(sealedBefore).toBeGreaterThan(0);
        expect(after.microficheRaw.imageTexts.length).toBeGreaterThan(sealedBefore);
    });

    it('bills the writer-sealed frozen raw pages, not a longer fresh slice', async () => {
        const settings = {
            ...defaultSettings,
            memoryMode: MEMORY_MODES.MICROFICHE,
            microficheGeometry: 'google',
            microficheFrameSize: 512,
            microficheImageCap: 8,
            microficheKeepRaw: 0,
            microficheFrozenRawImages: true,
            verbatimTokenBudget: 20000,
            queuedTokenBudget: 16000,
        };
        const chat = makeMessages(1, { mes: 'lorem ipsum dolor sit amet '.repeat(170) });
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore({ layers: [] }) },
            settings,
        });
        const writer = makeMemoryInjectionWriter();
        writer.update();
        const sealed = readSealedMicrofichePlans();
        expect(sealed.microficheRaw.imageTexts.length).toBeGreaterThan(0);

        // Chat growth after the seal: the writer has not updated, so billing
        // must keep the sealed pages even though a fresh slice is now longer.
        chat.push(...makeMessages(12, { mes: 'lorem ipsum dolor sit amet '.repeat(170) }));
        const { buildUiInjection, syncMicroficheBilling } = await import('../src/entry/ui.js');
        const injection = buildUiInjection(getChatStore(), getEffectiveSettings());

        expect(injection.microficheRaw.imageTexts).toEqual(sealed.microficheRaw.imageTexts);
        const fresh = buildInjection(getChatStore().layers, getEffectiveSettings(), null, {
            rawTexts: buildMicroficheRawSlice(chat, getChatStore(), getEffectiveSettings()),
        });
        expect(fresh.microficheRaw.imageTexts.length).toBeGreaterThan(
            sealed.microficheRaw.imageTexts.length,
        );

        const billing = describeMicroficheBilling(injection, getEffectiveSettings());
        expect(billing.images).toBe(sealed.microficheRaw.imageTexts.length);
        const frameEstimate = MICROFICHE_GEOMETRY_PRESETS.google.frameTokenEstimate;
        const bucket =
            getEffectiveSettings().verbatimTokenBudget + getEffectiveSettings().queuedTokenBudget;
        expect(billing.imageTokens).toBe(billing.images * frameEstimate);
        expect(billing.bucketAfterImages).toBe(bucket - billing.imageTokens);

        globalThis.$ = createJQueryHarness().$;
        syncMicroficheBilling(injection, getEffectiveSettings());
        const line = globalThis.$('#sc_microfiche_cost').text();
        expect(line).toContain('to images');
        expect(line).not.toContain('No images billed');
        delete globalThis.$;
    });
    it('bills memory with no toggle and nulls raw when Old Chat Photos is off', async () => {
        const chat = makeMessages(8, { mes: 'lorem ipsum dolor sit amet '.repeat(170) });
        const layers = [
            [{ text: `Snippet ${'word '.repeat(1200)}`, sourceMessageIds: [chat[0].sc_id] }],
        ];
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore({ layers }) },
            settings: {
                ...defaultSettings,
                memoryMode: MEMORY_MODES.MICROFICHE,
                microficheGeometry: 'google',
                microficheFrameSize: 512,
                microficheImageCap: 8,
                microficheKeepRaw: 0,
                microficheFrozenRawImages: true,
                verbatimTokenBudget: 20000,
                queuedTokenBudget: 16000,
            },
        });
        const writer = makeMemoryInjectionWriter();
        writer.update();
        const sealed = readSealedMicrofichePlans();
        expect(sealed.microfiche.imageTexts.length).toBeGreaterThan(0);
        expect(sealed.microficheRaw.imageTexts.length).toBeGreaterThan(0);

        const { buildUiInjection } = await import('../src/entry/ui.js');
        const off = { ...getEffectiveSettings(), microficheFrozenRawImages: false };
        const billed = buildUiInjection(getChatStore(), off);
        expect(billed.microfiche.imageTexts).toEqual(sealed.microfiche.imageTexts);
        expect(billed.microficheRaw).toBeNull();
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
    it('stamps the Google family preset into the explicit knobs', () => {
        const settings = { ...defaultSettings, microficheGeometry: 'custom' };
        expect(applyMicroficheGeometryPreset(settings, 'google')).toBe(true);
        expect(settings).toMatchObject({
            microficheGeometry: 'google',
            microficheFont: '8x13',
            microficheCellWidth: 8,
            microficheCellHeight: 22,
            microficheVariant: 'bw',
            microficheStopwordDim: false,
            microficheColumns: 1,
            microficheLineRepeat: 1,
            microficheFrameSize: 1568,
        });
        expect(settings).not.toHaveProperty('microficheStretch');
    });

    it('keeps values when switching to custom and when the preset repeats', () => {
        const settings = { ...defaultSettings, microficheGeometry: 'anthropic' };
        expect(applyMicroficheGeometryPreset(settings, 'custom')).toBe(true);
        expect(settings.microficheGeometry).toBe('custom');
        expect(settings.microficheFont).toBe(defaultSettings.microficheFont);
        expect(applyMicroficheGeometryPreset(settings, 'custom')).toBe(false);
        const stamped = { ...settings };
        expect(applyMicroficheGeometryPreset(stamped, 'anthropic')).toBe(true);
        expect(applyMicroficheGeometryPreset(stamped, 'anthropic')).toBe(false);
    });

    it('loads a looked-up shape as the custom starting point', () => {
        const [shape] = lookupModelShapes('deep');
        expect(shape.preset).toBe('openai');
        const settings = { ...defaultSettings, microficheGeometry: 'anthropic' };
        expect(applyMicroficheShapeAsCustom(settings, shape.preset)).toBe(true);
        expect(settings.microficheGeometry).toBe('custom');
        expect(settings.microficheFrameSize).toBe(MICROFICHE_GEOMETRY_PRESETS.openai.frameSize);
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
            microficheGeometry: 'google',
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
            '#sc_microfiche_variant',
            '#sc_microfiche_stopword_dim',
            '#sc_microfiche_columns',
            '#sc_microfiche_line_repeat',
            '#sc_microfiche_frame_size',
        ];
        syncMemoryModeControls({ memoryMode: MEMORY_MODES.BALANCED, microficheGeometry: 'google' });
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
            settings: { microficheModelName: '', microficheGeometry: 'google' },
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
            'anthropic',
            'google',
            'openai',
        ]);
        const anthropicButton = created.find(
            (button) => button.attr('data-sc-microfiche-shape') === 'anthropic',
        );
        dom.trigger('click', '[data-sc-microfiche-shape]', anthropicButton);
        expect(getSettings().microficheGeometry).toBe('custom');
        expect(getSettings().microficheFrameSize).toBe(
            MICROFICHE_GEOMETRY_PRESETS.anthropic.frameSize,
        );
        delete globalThis.$;
        delete globalThis.document;
    });

    it('bills preview images at the injected page count, not the image cap', () => {
        const settings = {
            ...defaultSettings,
            memoryMode: MEMORY_MODES.MICROFICHE,
            microficheGeometry: 'anthropic',
            microficheFrameSize: 512,
            microficheImageCap: 80,
            microficheKeepRaw: 0,
        };
        const layers = [[{ text: 'word '.repeat(1200) }]];
        const injection = buildInjection(layers, settings);
        expect(injection.microfiche).not.toBeNull();
        expect(injection.microfiche.imageTexts).toHaveLength(5);
        const noImages = estimateContextPreview(settings, null);
        const preview = estimateContextPreview(settings, injection);
        const billedFrameTokens =
            injection.microfiche.imageTexts.length *
            MICROFICHE_GEOMETRY_PRESETS.anthropic.frameTokenEstimate;
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
