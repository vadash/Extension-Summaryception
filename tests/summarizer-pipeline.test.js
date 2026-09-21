import { describe, expect, it } from 'vitest';

import { buildSummarizerPipelineInput } from '../src/core/summarizer-pipeline.js';
import { defaultSettings } from '../src/foundation/constants.js';
import { installSummaryContext } from './test-helpers.js';

/**
 * The prompt pipeline resolves the Call Profile once at dispatch and renders
 * that profile's prompt templates.
 */

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
});
