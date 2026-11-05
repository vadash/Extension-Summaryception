import { describe, expect, it } from 'vitest';

import {
    EXECUTION_TRIGGER_L0,
    EXECUTION_TRIGGER_PROMO,
    buildSystemPrompt,
    buildUserPrompt,
    insertBeforeTrigger,
} from '../src/foundation/prompt-parts.js';

describe('buildSystemPrompt', () => {
    it('wraps the role sentence in <role> tags and omits invariants when none are given', () => {
        const result = buildSystemPrompt('You summarize chats.');
        expect(result).toContain('<role>');
        expect(result).toContain('You summarize chats.');
        expect(result).toContain('</role>');
        expect(result).not.toContain('<inv>');
    });

    it('appends an <inv> block after </role> only when invariants is a non-empty string', () => {
        const result = buildSystemPrompt('You summarize chats.', 'third person only.');
        const closeRoleIdx = result.indexOf('</role>');
        const invariantsIdx = result.indexOf('<inv>');
        expect(invariantsIdx).toBeGreaterThan(closeRoleIdx);
        expect(result).toContain('third person only.');
    });
});

describe('buildUserPrompt', () => {
    const inputBlocks = '<passage>\nrecent turns here\n</passage>';
    const schemaBlock = 'emit <narrative> only';
    const taskRules = 'be durable';

    it('preserves block ordering and keeps the trigger as the final line', () => {
        const result = buildUserPrompt({
            inputBlocks,
            schemaBlock,
            taskRules,
            criticalRules: 'keep details',
            triggerLine: EXECUTION_TRIGGER_L0,
        });

        const inputIdx = result.indexOf('recent turns here');
        const schemaIdx = result.indexOf('<out>');
        const rulesIdx = result.indexOf('<task>');
        const criticalIdx = result.indexOf('<rules>');
        const triggerIdx = result.indexOf(EXECUTION_TRIGGER_L0);

        expect(result.indexOf('<in>')).toBeLessThan(inputIdx);
        expect(inputIdx).toBeLessThan(schemaIdx);
        expect(schemaIdx).toBeLessThan(rulesIdx);
        expect(rulesIdx).toBeLessThan(criticalIdx);
        expect(criticalIdx).toBeLessThan(triggerIdx);
        expect(result.trimEnd().endsWith(EXECUTION_TRIGGER_L0)).toBe(true);
    });

    it('omits the <rules> block when criticalRules is not a non-empty string', () => {
        const omitted = buildUserPrompt({
            inputBlocks,
            schemaBlock,
            taskRules,
            triggerLine: EXECUTION_TRIGGER_L0,
        });
        const empty = buildUserPrompt({
            inputBlocks,
            schemaBlock,
            taskRules,
            criticalRules: '',
            triggerLine: EXECUTION_TRIGGER_L0,
        });
        expect(omitted).not.toContain('<rules>');
        expect(empty).not.toContain('<rules>');
    });

    it('separates each supplied block from the next with blank lines', () => {
        const withCritical = buildUserPrompt({
            inputBlocks,
            schemaBlock,
            taskRules,
            criticalRules: 'keep details',
            triggerLine: EXECUTION_TRIGGER_L0,
        });
        const withoutCritical = buildUserPrompt({
            inputBlocks,
            schemaBlock,
            taskRules,
            triggerLine: EXECUTION_TRIGGER_L0,
        });
        // in + out + task + rules + trigger = 5 parts.
        expect(withCritical.split('\n\n')).toHaveLength(5);
        // in + out + task + trigger = 4 parts.
        expect(withoutCritical.split('\n\n')).toHaveLength(4);
    });
});

describe('insertBeforeTrigger', () => {
    const basePrompt = buildUserPrompt({
        inputBlocks: '<passage>\nrecent turns here\n</passage>',
        schemaBlock: 'schema body',
        taskRules: 'task rules body',
        criticalRules: 'critical rules body',
        triggerLine: EXECUTION_TRIGGER_PROMO,
    });

    it('places an inserted block between the last content block and the trigger, preserving trigger finality', () => {
        const inserted = '<budget>\nX\n</budget>';
        const result = insertBeforeTrigger(basePrompt, inserted, EXECUTION_TRIGGER_PROMO);

        const tagCount = (result.match(/<budget>/g) || []).length;
        const tagIdx = result.indexOf('<budget>');
        const triggerIdx = result.indexOf(EXECUTION_TRIGGER_PROMO);
        expect(tagCount).toBe(1);
        expect(tagIdx).toBeLessThan(triggerIdx);
        expect(result.trimEnd().endsWith(EXECUTION_TRIGGER_PROMO)).toBe(true);
    });

    it('leaves the prompt unchanged (trigger intact, no quadruple blank lines) for empty/blank insert', () => {
        for (const insert of ['', '   ']) {
            const result = insertBeforeTrigger(basePrompt, insert, EXECUTION_TRIGGER_PROMO);
            expect(result).not.toContain('\n\n\n\n');
            expect(result.trimEnd().endsWith(EXECUTION_TRIGGER_PROMO)).toBe(true);
        }
    });

    it('appends the insert at the end when the prompt does not end with the trigger (custom-template path)', () => {
        const custom = 'system preamble\n\nuser body';
        const insert = '<budget>\nZ\n</budget>';
        const result = insertBeforeTrigger(custom, insert, EXECUTION_TRIGGER_PROMO);

        expect(result.trimEnd().endsWith(insert.trim())).toBe(true);
        expect(result).toContain('user body');
    });

    it('does not throw on a null prompt and preserves the trimmed insert in the result', () => {
        const insert = '<budget>\nY\n</budget>';
        const result = insertBeforeTrigger(null, insert, EXECUTION_TRIGGER_PROMO);
        // A null prompt coerces to ''. The empty body does not end with the
        // trigger, so the append fallback adds the insert.
        expect(result).toContain(insert);
        expect(typeof result).toBe('string');
    });
});
