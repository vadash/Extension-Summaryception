import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SETTINGS_HTML_URL = new URL('../settings.html', import.meta.url);
const BIND_OWNER_URLS = [
    new URL('../src/entry/ui-events.js', import.meta.url),
    new URL('../src/entry/ui-prompts.js', import.meta.url),
    new URL('../src/entry/ui.js', import.meta.url),
];

/**
 * Scan raw settings markup for checkbox controls bound through
 * `data-sc-setting`. Plain-regex scan, no DOM (see settings-bounds.test.js).
 * @param {string} html - Raw settings template source
 * @returns {string[]} Sorted bound checkbox ids
 */
function parseBoundCheckboxes(html) {
    const ids = new Set();
    for (const tag of html.match(/<input\b[^>]*>/g) ?? []) {
        if (/<input\b[^>]*type="checkbox"[^>]*data-sc-setting="[^"]*"[^>]*>/.test(tag)) {
            const id = tag.match(/(?<![\w-])id="([^"]*)"/)?.[1];
            if (id) {
                ids.add(id);
            }
        }
    }
    return [...ids].sort();
}

/**
 * Collect every `'#sc_*'` selector literal a bind owner references.
 * @param {string} source - Bind owner source
 * @returns {Set<string>} Referenced ids without the `#`
 */
function parseSelectorRefs(source) {
    const refs = new Set();
    for (const match of source.matchAll(/'#(sc_[a-z0-9_]+)'/g)) {
        refs.add(match[1]);
    }
    return refs;
}

describe('settings checkbox bind coverage', () => {
    const html = readFileSync(SETTINGS_HTML_URL, 'utf8');
    const checkboxes = parseBoundCheckboxes(html);
    const refs = new Set();
    for (const url of BIND_OWNER_URLS) {
        for (const id of parseSelectorRefs(readFileSync(url, 'utf8'))) {
            refs.add(id);
        }
    }

    it('binds every data-sc-setting checkbox through one owner', () => {
        expect(checkboxes.length).toBeGreaterThan(0);
        expect(checkboxes.filter((id) => !refs.has(id))).toEqual([]);
    });
});
