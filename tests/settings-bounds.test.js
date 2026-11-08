import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { SLIDER_LIMITS, defaultSettings } from '../src/foundation/constants.js';

const SETTINGS_HTML_URL = new URL('../settings.html', import.meta.url);

/**
 * Scan the raw source with a plain regex because the bounds checks must run
 * in plain node, with no DOM.
 * @param {string} html - Raw settings template source
 * @returns {Array<{id: string|null, type: string|null, key: string|null, min: string|null, max: string|null, step: string|null, value: string|null}>}
 */
function parseInputs(html) {
    const inputs = [];
    for (const tag of html.match(/<input\b[^>]*>/g) ?? []) {
        const attr = (name) => tag.match(new RegExp(`(?<![\\w-])${name}="([^"]*)"`))?.[1] ?? null;
        inputs.push({
            id: attr('id'),
            type: attr('type'),
            key: attr('data-sc-slider-setting') ?? attr('data-sc-setting'),
            min: attr('min'),
            max: attr('max'),
            step: attr('step'),
            value: attr('value'),
        });
    }
    return inputs;
}

/**
 * Scan select blocks with the same plain-regex approach: numeric selects carry
 * data-sc-type="number" and expose their bound as option values.
 * @param {string} html - Raw settings template source
 * @returns {Array<{id: string|null, type: string|null, key: string|null, options: Array<number>}>}
 */
function parseSelects(html) {
    const selects = [];
    for (const block of html.match(/<select\b[^>]*>[\s\S]*?<\/select>/g) ?? []) {
        const open = block.match(/<select\b[^>]*>/)?.[0] ?? '';
        const attr = (name) => open.match(new RegExp(`(?<![\\w-])${name}="([^"]*)"`))?.[1] ?? null;
        selects.push({
            id: attr('id'),
            type: attr('data-sc-type'),
            key: attr('data-sc-slider-setting') ?? attr('data-sc-setting'),
            options: [...block.matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>/g)].map((match) =>
                Number(match[1]),
            ),
        });
    }
    return selects;
}

/** @param {string|null} raw - Attribute value; absent attributes stay null */
const num = (raw) => (raw === null ? null : Number(raw));

/**
 * @param {string} raw - value attribute text
 * @returns {number}
 */
function decodeDefault(raw) {
    const kMatch = /^(\d+)k$/i.exec(raw.trim());
    return kMatch ? Number(kMatch[1]) * 1000 : Number(raw);
}

describe('settings.html bounds agreement', () => {
    const html = readFileSync(SETTINGS_HTML_URL, 'utf8');
    const inputs = parseInputs(html);
    const selects = parseSelects(html);
    // Registry-governed controls. Range sliders carry data-sc-slider-setting.
    // Numeric steppers carry data-sc-setting.
    const boundsControls = inputs.filter(
        (el) => (el.type === 'range' || el.type === 'number') && el.key !== null,
    );
    // Numeric selects carry data-sc-type="number" and expose their range as options.
    const selectBoundsControls = selects.filter((el) => el.type === 'number' && el.key !== null);
    // Sliders and their partner text displays, wherever a default is rendered.
    const defaultValueBearers = inputs.filter(
        (el) =>
            el.key !== null &&
            el.value !== null &&
            (el.type === 'range' || el.type === 'text' || el.type === 'number'),
    );

    it('covers exactly the slider keys present in settings.html, both directions', () => {
        expect(
            [...new Set([...boundsControls, ...selectBoundsControls].map((el) => el.key))].sort(),
        ).toEqual(Object.keys(SLIDER_LIMITS).sort());
    });

    it('matches every min/max/step attribute to the registry bounds', () => {
        for (const el of boundsControls) {
            const limits = SLIDER_LIMITS[el.key];
            expect(
                limits,
                `settings.html #${el.id}: key "${el.key}" missing from SLIDER_LIMITS`,
            ).toBeDefined();
            expect(num(el.min), `#${el.id} (${el.key}) min`).toBe(limits.MIN);
            expect(num(el.max), `#${el.id} (${el.key}) max`).toBe(limits.MAX);
            expect(num(el.step), `#${el.id} (${el.key}) step`).toBe(limits.STEP);
        }
    });

    it('matches every numeric select option list to the registry stepped range', () => {
        expect(selectBoundsControls.length).toBeGreaterThan(0);
        for (const el of selectBoundsControls) {
            const limits = SLIDER_LIMITS[el.key];
            expect(
                limits,
                `settings.html #${el.id}: key "${el.key}" missing from SLIDER_LIMITS`,
            ).toBeDefined();
            if (limits.MAX === null) {
                continue;
            }
            const expected = [];
            for (let value = limits.MIN; value <= limits.MAX; value += limits.STEP) {
                expected.push(value);
            }
            expect(
                [...el.options].sort((a, b) => a - b),
                `#${el.id} (${el.key}) options`,
            ).toEqual(expected);
        }
    });

    it('matches every rendered default value to defaultSettings', () => {
        expect(defaultValueBearers.length).toBeGreaterThan(0);
        for (const el of defaultValueBearers) {
            if (!Object.hasOwn(defaultSettings, el.key)) {
                continue;
            }
            expect(decodeDefault(el.value), `#${el.id} default for ${el.key}`).toBe(
                defaultSettings[el.key],
            );
        }
    });
});
