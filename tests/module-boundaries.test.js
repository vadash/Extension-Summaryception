import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
const FOUNDATION_DIR = resolve(SRC_DIR, 'foundation');
const CONTEXT_MODULE = resolve(FOUNDATION_DIR, 'context.js');

/**
 * The pure modules: their whole point is that they run with no host context,
 * so a test of theirs needs no installed SillyTavern stub. This file holds
 * that property to account, since nothing else can: the boundary rules in
 * `eslint.config.js` allow a foundation module to import the host facade.
 */
const HOST_FREE_MODULES = [
    resolve(FOUNDATION_DIR, 'objects.js'),
    resolve(FOUNDATION_DIR, 'settings-normalizer.js'),
    resolve(SRC_DIR, 'core/snippet-provenance.js'),
];

/**
 * Every relative module specifier a file imports, resolved to a path.
 * @param {string} file
 * @returns {string[]}
 */
function importedModules(file) {
    const source = readFileSync(file, 'utf8');
    const specifiers = source.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/g);
    return [...specifiers].map((match) => resolve(dirname(file), match[1]));
}

/**
 * The transitive module graph reachable from one entry point.
 * @param {string} entry
 * @returns {Set<string>}
 */
function moduleGraph(entry) {
    const reachable = new Set();
    const pending = [entry];
    while (pending.length > 0) {
        const file = /** @type {string} */ (pending.pop());
        if (reachable.has(file)) {
            continue;
        }
        reachable.add(file);
        pending.push(...importedModules(file));
    }
    return reachable;
}

describe('module boundaries', () => {
    it('never lets a foundation module import core', () => {
        const offenders = [];
        for (const name of readdirSync(FOUNDATION_DIR)) {
            if (!name.endsWith('.js')) {
                continue;
            }
            const file = resolve(FOUNDATION_DIR, name);
            for (const imported of importedModules(file)) {
                if (relative(SRC_DIR, imported).startsWith('core/')) {
                    offenders.push(`${name} -> ${relative(SRC_DIR, imported)}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('keeps every host-free module free of the host facade, transitively', () => {
        const offenders = HOST_FREE_MODULES.filter((entry) =>
            moduleGraph(entry).has(CONTEXT_MODULE),
        );
        expect(offenders.map((file) => relative(SRC_DIR, file))).toEqual([]);
    });
});
