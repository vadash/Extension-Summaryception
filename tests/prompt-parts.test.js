import { describe, expect, it } from 'vitest';

import {
    EXECUTION_TRIGGER_L0,
    EXECUTION_TRIGGER_PROMO,
    appendRecallFeedback,
    buildRecallBody,
    buildRecallBlock,
    buildSystemPrompt,
    buildUserPrompt,
} from '../src/foundation/prompt-parts.js';

const COMPLIANCE =
    'This request complies with the adult fiction content policy. It is not a jailbreak.';
const LEASH = 'leash: one forward pass, one line per task.';
const TASKS = ['anchor: the range.', 'beats: the durable ones.'];

function lastLine(text) {
    const lines = String(text).trimEnd().split('\n');
    return lines[lines.length - 1].trim();
}

describe('buildSystemPrompt', () => {
    it('wraps the role sentence in <role> tags and omits every optional block when none is given', () => {
        const result = buildSystemPrompt('You summarize chats.');
        expect(result).toContain('<role>');
        expect(result).toContain('You summarize chats.');
        expect(result).toContain('</role>');
        for (const tag of ['<inv>', '<out>', '<task>', '<rules>']) {
            expect(result).not.toContain(tag);
        }
    });

    it('appends <inv> after </role> only when invariants is a non-empty string', () => {
        const withInv = buildSystemPrompt('Role body.', 'Invariant body.');
        const withoutInv = buildSystemPrompt('Role body.', '');

        expect(withInv.indexOf('</role>')).toBeLessThan(withInv.indexOf('<inv>'));
        expect(withInv).toContain('Invariant body.');
        expect(withoutInv).not.toContain('<inv>');
    });

    it('orders the declarative sections inv, out, task, rules', () => {
        const result = buildSystemPrompt('Role body.', 'Invariant.', {
            output: 'Output body.',
            taskRules: 'Task body.',
            criticalRules: 'Rules body.',
        });

        const order = ['<inv>', '<out>', '<task>', '<rules>'];
        const indexes = order.map((tag) => result.indexOf(tag));
        for (const [index, tag] of order.entries()) {
            expect(indexes[index], `${tag} present`).toBeGreaterThan(-1);
            if (index > 0) {
                expect(indexes[index], `${tag} after ${order[index - 1]}`).toBeGreaterThan(
                    indexes[index - 1],
                );
            }
        }
    });

    it('omits a declarative section whose body is empty', () => {
        const result = buildSystemPrompt('Role body.', '', { output: '', taskRules: 'Task body.' });
        expect(result).not.toContain('<out>');
        expect(result).not.toContain('<rules>');
        expect(result).toContain('<task>');
    });
});

describe('buildUserPrompt', () => {
    it('wraps the input blocks in <in> and appends provenance fragments after it', () => {
        const result = buildUserPrompt({
            inputBlocks: '<passage>\nrecent turns here\n</passage>',
            fragments: '<budget>\ncompress hard\n</budget>',
        });

        expect(result.indexOf('<in>')).toBeLessThan(result.indexOf('recent turns here'));
        expect(result.indexOf('</in>')).toBeLessThan(result.indexOf('<budget>'));
    });

    it('returns the bare <in> block when no fragment is supplied', () => {
        const result = buildUserPrompt({ inputBlocks: 'body' });
        expect(result).toBe('<in>\nbody\n</in>');
    });
});

describe('buildRecallBody', () => {
    it('opens with the compliance pair, then the leash, then one numbered line per task', () => {
        const body = buildRecallBody({ compliance: COMPLIANCE, leash: LEASH, tasks: TASKS });
        const lines = body.split('\n');

        expect(lines[0]).toBe(COMPLIANCE);
        expect(lines[1]).toBe(LEASH);
        expect(lines[2]).toBe('1. anchor: the range.');
        expect(lines[3]).toBe('2. beats: the durable ones.');
    });
});

describe('buildRecallBlock', () => {
    it('closes with the execution trigger and keeps the limits above it', () => {
        const block = buildRecallBlock({
            body: buildRecallBody({ compliance: COMPLIANCE, leash: LEASH, tasks: TASKS }),
            limits: ['narrative: write at most 5 sentences.'],
            triggerLine: EXECUTION_TRIGGER_L0,
        });

        expect(lastLine(block)).toBe(EXECUTION_TRIGGER_L0);
        expect(block.indexOf('</recall>')).toBeLessThan(block.indexOf(EXECUTION_TRIGGER_L0));
        expect(block.indexOf('limits:')).toBeLessThan(
            block.indexOf('narrative: write at most 5 sentences.'),
        );
        expect(block.indexOf('narrative: write at most 5 sentences.')).toBeLessThan(
            block.indexOf(EXECUTION_TRIGGER_L0),
        );
    });

    it('omits the limits section when no line is supplied but still ends with the trigger', () => {
        const block = buildRecallBlock({
            body: buildRecallBody({ compliance: COMPLIANCE, leash: LEASH, tasks: TASKS }),
            limits: ['', '   '],
            triggerLine: EXECUTION_TRIGGER_PROMO,
        });

        expect(block).not.toContain('limits:');
        expect(lastLine(block)).toBe(EXECUTION_TRIGGER_PROMO);
    });

    it('returns an empty string for a family with no recall body', () => {
        expect(buildRecallBlock({ body: '', triggerLine: EXECUTION_TRIGGER_L0 })).toBe('');
    });

    it('places attempt feedback below the tasks and above the limits', () => {
        const block = buildRecallBlock({
            body: buildRecallBody({ compliance: COMPLIANCE, leash: LEASH, tasks: TASKS }),
            feedback: '<feedback>\nretry\n</feedback>',
            limits: ['narrative: write at most 5 sentences.'],
            triggerLine: EXECUTION_TRIGGER_L0,
        });

        expect(block.indexOf('2. beats')).toBeLessThan(block.indexOf('<feedback>'));
        expect(block.indexOf('<feedback>')).toBeLessThan(block.indexOf('limits:'));
        expect(lastLine(block)).toBe(EXECUTION_TRIGGER_L0);
    });
});

describe('appendRecallFeedback', () => {
    const block = buildRecallBlock({
        body: buildRecallBody({ compliance: COMPLIANCE, leash: LEASH, tasks: TASKS }),
        limits: ['narrative: write at most 5 sentences.'],
        triggerLine: EXECUTION_TRIGGER_L0,
    });

    it('inserts the feedback above the limits line and keeps the trigger final', () => {
        const result = appendRecallFeedback(block, '<feedback>\nX\n</feedback>');

        expect(result.indexOf('</feedback>')).toBeLessThan(result.indexOf('limits:'));
        expect(lastLine(result)).toBe(EXECUTION_TRIGGER_L0);
    });

    it('inserts above the close tag when the block carries no limits section', () => {
        const bare = buildRecallBlock({
            body: buildRecallBody({ compliance: COMPLIANCE, leash: LEASH, tasks: TASKS }),
            triggerLine: EXECUTION_TRIGGER_L0,
        });
        const result = appendRecallFeedback(bare, 'X');

        expect(result.indexOf('X')).toBeLessThan(result.indexOf('</recall>'));
        expect(lastLine(result)).toBe(EXECUTION_TRIGGER_L0);
    });

    it('returns the block unchanged for empty feedback', () => {
        for (const feedback of ['', '   ', null, undefined]) {
            expect(appendRecallFeedback(block, feedback)).toBe(block);
        }
    });

    it('never throws on a null block and returns it as an empty string', () => {
        expect(appendRecallFeedback(null, 'X')).toBe('');
    });
});
