import { describe, expect, it } from 'vitest';

import { resolveCallProfile } from '../src/core/call-profile.js';
import {
    appendLayer0PromptConstraints,
    buildLayer0SizeRepairFeedback,
} from '../src/core/layer0-compression.js';
import {
    buildRepairDiagnostics,
    buildStructuralRepairFeedback,
    formatRepairDiagnostics,
} from '../src/core/repair-diagnostics.js';
import {
    buildLayer0BudgetHint,
    buildSizeConstraintsBlock,
    buildSizeTargetLine,
} from '../src/core/token-budget.js';
import {
    DEFAULT_INJECTION_TEMPLATE,
    DEFAULT_PROMOTION_REPAIR_PROMPT,
    DEFAULT_PROMOTION_SYSTEM_PROMPT,
    DEFAULT_PROMOTION_USER_PROMPT,
    DEFAULT_SUMMARIZER_REPAIR_PROMPT,
    DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
    DEFAULT_SUMMARIZER_USER_PROMPT,
    RECALL_REPEAT_INJECTION_TEMPLATE,
} from '../src/foundation/prompt-constants.js';

/**
 * Literals the pipeline parses keep their spelling byte for byte, so the
 * grammar scan exempts them (ADR-0032). The Auditor prompts are out of scope
 * and are not scanned at all.
 */
const EXEMPT_LITERALS = [
    'current_date_time',
    '<narrative>',
    '</narrative>',
    '<declined>',
    '</declined>',
    '<summaryception_memory>',
    '</summaryception_memory>',
    'Name↔User',
    '[R]',
    '[T]',
    '[S]',
];

const ANCHOR_PATTERN = /\[[A-Z]-[A-Z]@YYYY-MM-DDTHH\]/g;
const PLACEHOLDER_PATTERN = /\{\{[a-z_]+\}\}/g;
const TAG_PATTERN = /<\/?([a-z_][a-z0-9_]*)>/g;

function stripExempt(text) {
    let out = text;
    for (const literal of EXEMPT_LITERALS) {
        out = out.split(literal).join(' ');
    }
    return out.replace(ANCHOR_PATTERN, ' ').replace(PLACEHOLDER_PATTERN, ' ');
}

/** Instruction prose only: tags and parsed literals are not prose. */
function proseOf(text) {
    return stripExempt(text).replace(TAG_PATTERN, ' ');
}

function tagNamesOf(text) {
    return Array.from(text.matchAll(TAG_PATTERN), (match) => match[1]);
}

const settings = { layer0SummaryTokenTarget: 400 };

const layer0PromptWithFragments = appendLayer0PromptConstraints(
    DEFAULT_SUMMARIZER_USER_PROMPT,
    settings,
    resolveCallProfile(settings, { kind: 'layer0', sourceRange: [12, 34] }),
);

const promotionPromptWithFragments = appendLayer0PromptConstraints(
    DEFAULT_PROMOTION_USER_PROMPT,
    settings,
    resolveCallProfile(settings, {
        kind: 'promotion',
        layerIndex: 1,
        sourceRange: [12, 34],
        promotionRepair: {
            reason: 'too-long',
            outputTokens: 400,
            targetTokens: 100,
            hardMaxTokens: 120,
            rejectedSummary: 'The ferry crossed at dawn. The party reached the tavern.',
        },
    }),
);

const defaultRepairFeedback = formatRepairDiagnostics(
    buildRepairDiagnostics({
        scope: 'Layer 0',
        totalTokens: 400,
        sections: [
            {
                id: 'narrative',
                label: '<narrative>',
                actualTokens: 400,
                targetTokens: 100,
                hardMaxTokens: 120,
                text: 'The ferry crossed at dawn.',
                repairInstruction: 'remove scene replay',
            },
        ],
        rejectedDraft: 'The ferry crossed at dawn.',
    }),
);

const structuralRepairFeedback = buildStructuralRepairFeedback(
    buildRepairDiagnostics({
        sections: [
            {
                id: 'narrative',
                actualTokens: 400,
                hardMaxTokens: 120,
                text: 'One. Two. Three. Four. Five. Six. Seven. Eight.',
            },
        ],
    }),
    { layer: 'l0', targetTokens: 100 },
);

const samples = [
    ['layer0 system prompt', DEFAULT_SUMMARIZER_SYSTEM_PROMPT],
    ['layer0 user prompt', DEFAULT_SUMMARIZER_USER_PROMPT],
    ['layer0 repair prompt', DEFAULT_SUMMARIZER_REPAIR_PROMPT],
    ['promotion system prompt', DEFAULT_PROMOTION_SYSTEM_PROMPT],
    ['promotion user prompt', DEFAULT_PROMOTION_USER_PROMPT],
    ['promotion repair prompt', DEFAULT_PROMOTION_REPAIR_PROMPT],
    ['injection template', DEFAULT_INJECTION_TEMPLATE],
    ['recall repeat injection template', RECALL_REPEAT_INJECTION_TEMPLATE],
    ['layer0 budget hint', buildLayer0BudgetHint({ targetTokens: 400 })],
    [
        'size target line',
        buildSizeTargetLine({ label: '<narrative>', verb: 'write', cap: 5, unit: 'sentences' }),
    ],
    [
        'size constraints block',
        buildSizeConstraintsBlock({
            wrapperTag: 'limits',
            targetLine: 'line',
            repairLine: 'repair',
        }),
    ],
    ['layer0 prompt with runtime fragments', layer0PromptWithFragments],
    ['promotion prompt with runtime fragments', promotionPromptWithFragments],
    ['default repair feedback', defaultRepairFeedback],
    [
        'layer0 size repair feedback',
        buildLayer0SizeRepairFeedback({
            reason: 'too-long',
            outputTokens: 400,
            bounds: { target: 200, min: 80, max: 300 },
        }),
    ],
    ['structural repair feedback', structuralRepairFeedback],
];

describe('dense prompt grammar', () => {
    it('collects every default prompt and runtime fragment we author', () => {
        for (const [name, text] of samples) {
            expect(text.length, name).toBeGreaterThan(0);
        }
    });

    it.each(samples)('%s carries no slash or plus in its prose', (_name, text) => {
        const prose = proseOf(text);
        expect(prose).not.toMatch(/\//);
        expect(prose).not.toMatch(/\+/);
    });

    it.each(samples)('%s carries no bare underscore in its prose', (_name, text) => {
        expect(proseOf(text)).not.toContain('_');
    });

    it.each(samples)('%s carries no all-caps bracket header', (_name, text) => {
        expect(proseOf(text)).not.toMatch(/(^|\s)\[[A-Z][A-Z0-9 _-]*\]/m);
    });

    it.each(samples)('%s states no ban in place of a substitution', (_name, text) => {
        expect(proseOf(text)).not.toMatch(/\b(do not|don't|never)\b/i);
    });

    it.each(samples)('%s uses single lowercase root tags', (_name, text) => {
        const kept = ['narrative', 'declined', 'summaryception_memory'];
        for (const name of tagNamesOf(text)) {
            if (kept.includes(name)) {
                continue;
            }
            expect(name, `${name} tag`).toMatch(/^[a-z]+$/);
        }
    });

    it.each(samples)('%s states each rule once', (name, text) => {
        if (name === 'recall repeat injection template') {
            // A deliberate second copy of the memory block.
            return;
        }
        const lines = proseOf(text)
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 20);
        expect(new Set(lines).size).toBe(lines.length);
    });

    it('orders the layer0 user sections input, output contract, task, rules, trigger', () => {
        const prompt = DEFAULT_SUMMARIZER_USER_PROMPT;
        const order = ['<in>', '<out>', '<task>', '<rules>'];
        const indexes = order.map((tag) => prompt.indexOf(tag));
        for (const [index, tag] of order.entries()) {
            expect(indexes[index], `${tag} present`).toBeGreaterThan(-1);
            if (index > 0) {
                expect(indexes[index], `${tag} after ${order[index - 1]}`).toBeGreaterThan(
                    indexes[index - 1],
                );
            }
        }
    });
});
