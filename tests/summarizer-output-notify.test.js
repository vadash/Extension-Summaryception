import { describe, expect, it } from 'vitest';

import { NOTIFY_EVENTS } from '../src/foundation/constants.js';
import { processSummarizerResponse } from '../src/core/summarizer-output.js';
import {
    installBrowserRuntimeStub,
    makeNotifyRecorder,
    makeSummarySettings,
} from './test-helpers.js';

/**
 * The summarizer output module emits structured notify events (ADR-0004) instead
 * of calling the notification library. The entry adapter renders the language-mix
 * retry warning.
 */
describe('summarizer output notify events', () => {
    it('emits a structured language-mix event when the CN policy rejects a response', async () => {
        const { toastr } = installBrowserRuntimeStub();
        const recorder = makeNotifyRecorder();
        const result = await processSummarizerResponse(
            '这是一段用于测试的中文摘要文本',
            makeSummarySettings({ stripChineseIdeographs: true }),
            { kind: 'layer0' },
            recorder,
        );

        expect(result.status).toBe('cn-rejected');
        expect(toastr.warning).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: NOTIFY_EVENTS.LANGUAGE_MIX_RETRY,
                percent: '100.0',
            },
        ]);
    });
});
