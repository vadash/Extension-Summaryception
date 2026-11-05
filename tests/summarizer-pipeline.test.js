import { describe, expect, it } from 'vitest';

import { buildSummarizerPipelineInput } from '../src/core/summarizer-pipeline.js';
import { defaultSettings } from '../src/foundation/constants.js';
import { EXECUTION_TRIGGER_L0, EXECUTION_TRIGGER_PROMO } from '../src/foundation/prompt-parts.js';
import { installSummaryContext, makeSummarySettings } from './test-helpers.js';

function lastLine(text) {
    const lines = String(text).trimEnd().split('\n');
    return lines[lines.length - 1].trim();
}

describe('buildSummarizerPipelineInput', () => {
    it('routes the auditor call category to the auditor prompts with substitution', async () => {
        installSummaryContext();

        const request = await buildSummarizerPipelineInput({
            storyTxt: 'USER TURN',
            contextStr: 'PRIOR STATE',
            metadata: { kind: 'auditor' },
        });

        expect(request.profile.policy.systemPrompt).toBe(defaultSettings.auditorSystemPrompt);
        expect(request.prompt).toContain('PRIOR STATE');
        expect(request.prompt).toContain('USER TURN');
        expect(request.repairPrompt).toBe('');
    });

    it('gives the auditor no recall message, so its request stays two messages', async () => {
        installSummaryContext();

        const request = await buildSummarizerPipelineInput({
            storyTxt: 'USER TURN',
            contextStr: 'PRIOR STATE',
            metadata: { kind: 'auditor' },
        });

        expect(request.recall).toBe('');
        expect(request.repairRecall).toBe('');
    });

    it('closes the layer0 request with the layer0 trigger and its repair retry with the same', async () => {
        installSummaryContext();

        const request = await buildSummarizerPipelineInput({
            storyTxt: 'PASSAGE',
            contextStr: 'PRIOR',
            metadata: { kind: 'layer0', sourceRange: [3, 9] },
            settings: makeSummarySettings(),
        });

        expect(lastLine(request.recall)).toBe(EXECUTION_TRIGGER_L0);
        expect(lastLine(request.repairRecall)).toBe(EXECUTION_TRIGGER_L0);
        expect(request.recall).not.toBe(request.repairRecall);
    });

    it('closes the promotion request with the promotion trigger', async () => {
        installSummaryContext();

        const request = await buildSummarizerPipelineInput({
            storyTxt: 'MEMORIES',
            contextStr: 'PRIOR',
            metadata: { kind: 'promotion', layerIndex: 1 },
            settings: makeSummarySettings(),
        });

        expect(lastLine(request.recall)).toBe(EXECUTION_TRIGGER_PROMO);
    });

    it('keeps the system message byte-identical across a cap change and a repair dispatch', async () => {
        installSummaryContext();

        const small = await buildSummarizerPipelineInput({
            storyTxt: 'PASSAGE',
            contextStr: 'PRIOR',
            metadata: { kind: 'layer0' },
            settings: makeSummarySettings({ layer0SummaryTokenTarget: 200 }),
        });
        const large = await buildSummarizerPipelineInput({
            storyTxt: 'PASSAGE',
            contextStr: 'PRIOR',
            metadata: {
                kind: 'promotion',
                layerIndex: 0,
                promotionRepair: { reason: 'too-short', outputTokens: 20, targetTokens: 200 },
            },
            settings: makeSummarySettings({ layer0SummaryTokenTarget: 2000 }),
        });

        expect(small.systemPrompt).toBe(defaultSettings.summarizerSystemPrompt);
        expect(large.systemPrompt).toBe(defaultSettings.promotionSystemPrompt);
        expect(large.systemPrompt).not.toContain('{{max_sentences');
    });
});
