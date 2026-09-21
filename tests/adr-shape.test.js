import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ADR shape contract (ADR-0025, docs/agents/domain.md).
 *
 * Pins the mechanical half of the shape only: titles, allowed sections, status
 * frontmatter, retired numbers, and that every cited number resolves. Prose and
 * length are deliberately unasserted.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ADR_DIR = join(ROOT, 'docs', 'adr');
const README_PATH = join(ADR_DIR, 'README.md');
const SCANNED_DIRS = ['src', 'tests', 'docs'];
const SCANNED_FILES = ['AGENTS.md', 'CONTEXT.md'];
const SCANNED_EXTENSIONS = ['.js', '.md'];
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'report', 'coverage']);
const OPTIONAL_SECTIONS = ['Decision', 'Considered Options', 'Consequences'];
const STATUS_PATTERN = /^(proposed|accepted|deprecated|superseded by ADR-\d{4})$/;
const CITATION_PATTERN = /\bADR-(\d{4})\b/g;
const RETIRED_ROW_PATTERN = /^\|\s*(\d{4})\s*\|([^|]*)\|([^|]*)\|/gm;

/**
 * Walk `dir` and return the absolute path of every scanned file beneath it.
 * @param {string} dir - Absolute directory to walk
 * @returns {string[]}
 */
function collectFiles(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!IGNORED_DIRS.has(entry.name)) {
                found.push(...collectFiles(join(dir, entry.name)));
                continue;
            }
        } else if (SCANNED_EXTENSIONS.includes(entry.name.slice(entry.name.lastIndexOf('.')))) {
            found.push(join(dir, entry.name));
        }
    }
    return found;
}

/**
 * Every file whose citations are checked: the ADRs, the scanned tree, and the
 * two root documents.
 * @returns {string[]}
 */
function collectCitationSources() {
    const sources = [...collectFiles(ADR_DIR)];
    for (const dir of SCANNED_DIRS) {
        sources.push(...collectFiles(join(ROOT, dir)));
    }
    for (const file of SCANNED_FILES) {
        sources.push(join(ROOT, file));
    }
    return [...new Set(sources)];
}

/**
 * Parse one ADR source into the facts the shape contract asserts.
 * @param {string} raw - Raw markdown
 * @returns {{status: string|null, title: string|null, sections: string[], body: string}}
 */
function parseAdr(raw) {
    const lines = raw.split(/\r?\n/);
    let cursor = 0;
    const status = readStatus(lines);
    if (status !== null) {
        // Skip the frontmatter block: its opening and closing fences plus its keys.
        cursor = lines.indexOf('---', 1) + 1;
    }
    const rest = lines.slice(cursor);
    return {
        status,
        title: (rest.find((line) => line.startsWith('# ')) ?? '').replace(/^#\s+/, '') || null,
        sections: rest
            .filter((line) => line.startsWith('## '))
            .map((line) => line.replace(/^##\s+/, '').trim()),
        body: rest.join('\n'),
    };
}

/**
 * Read the `status:` key from a leading YAML frontmatter block.
 * @param {string[]} lines - Raw source lines
 * @returns {string|null}
 */
function readStatus(lines) {
    if (lines[0]?.trim() !== '---') {
        return null;
    }
    const end = lines.indexOf('---', 1);
    if (end === -1) {
        return null;
    }
    const match = /^status:\s*(.+)$/m.exec(lines.slice(1, end).join('\n'));
    return match ? match[1].trim() : null;
}

/**
 * Read the retired-number table from docs/adr/README.md. A retired number has
 * no file, so this table is the only record of it and the only thing that lets
 * a live ADR cite it.
 * @returns {Map<string, {title: string, supersededBy: string|null}>}
 */
function readRetired() {
    const retired = new Map();
    if (!existsSync(README_PATH)) {
        return retired;
    }
    for (const match of readFileSync(README_PATH, 'utf8').matchAll(RETIRED_ROW_PATTERN)) {
        retired.set(match[1], {
            title: match[2].trim(),
            supersededBy: /\d{4}/.exec(match[3])?.[0] ?? null,
        });
    }
    return retired;
}

/** One ADR per file, with its number lifted from the filename. */
const adrs = readdirSync(ADR_DIR)
    .filter((name) => /^\d{4}-.+\.md$/.test(name))
    .sort()
    .map((name) => ({
        name,
        number: name.slice(0, 4),
        path: join(ADR_DIR, name),
        ...parseAdr(readFileSync(join(ADR_DIR, name), 'utf8')),
    }));

/** Retired numbers, whose files are gone. */
const retired = readRetired();

/** Live numbers, plus the retired ones a successor is allowed to cite. */
const liveNumbers = new Set(adrs.map((adr) => adr.number));
const citableViewNumbers = new Set([...liveNumbers, ...retired.keys()]);

describe('ADR shape', () => {
    it('covers the ADR directory', () => {
        expect(adrs.length).toBeGreaterThan(0);
    });

    it('gives every ADR a title that states the decision, without repeating its number', () => {
        for (const adr of adrs) {
            expect(adr.title, `${adr.name}: missing "# " title`).not.toBeNull();
            expect(adr.title, `${adr.name}: title repeats the ADR number`).not.toMatch(
                /^\d{4}\s*[—:-]/,
            );
        }
    });

    it('uses only the three optional sections', () => {
        for (const adr of adrs) {
            for (const section of adr.sections) {
                expect(OPTIONAL_SECTIONS, `${adr.name}: unexpected section "${section}"`).toContain(
                    section,
                );
            }
        }
    });

    it('records supersession as status frontmatter that resolves to a live ADR', () => {
        for (const adr of adrs) {
            if (adr.status === null) {
                continue;
            }
            expect(adr.status, `${adr.name}: illegal status "${adr.status}"`).toMatch(
                STATUS_PATTERN,
            );
            const target = /superseded by ADR-(\d{4})/.exec(adr.status)?.[1];
            if (target) {
                expect(liveNumbers, `${adr.name}: superseded by non-live ADR-${target}`).toContain(
                    target,
                );
                expect(target, `${adr.name}: superseded by itself`).not.toBe(adr.number);
            }
        }
    });

    it('states no supersession as a prose banner', () => {
        for (const adr of adrs) {
            expect(adr.body, `${adr.name}: prose supersession banner`).not.toMatch(
                /^>\s*Superseded by/im,
            );
        }
    });

    it('keeps every retired number spent and its successor live', () => {
        for (const [number, entry] of retired) {
            expect(
                liveNumbers,
                `retired ${number}: a live file claims a spent number`,
            ).not.toContain(number);
            expect(entry.title, `retired ${number}: no title recorded`).not.toBe('');
            expect(entry.supersededBy, `retired ${number}: no successor recorded`).not.toBeNull();
            expect(
                liveNumbers,
                `retired ${number}: successor ADR-${entry.supersededBy} is not a live file`,
            ).toContain(entry.supersededBy);
        }
    });

    it('resolves every cited ADR number', () => {
        for (const file of collectCitationSources()) {
            const raw = readFileSync(file, 'utf8');
            for (const [, number] of raw.matchAll(CITATION_PATTERN)) {
                expect(
                    citableViewNumbers,
                    `${relative(ROOT, file)}: cites unknown ADR-${number}`,
                ).toContain(number);
            }
        }
    });
});
