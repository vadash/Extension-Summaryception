import { beforeEach, describe, expect, it, vi } from 'vitest';

import { onChatCompletionPromptReady, onGenerateAfterData } from '../src/entry/events.js';

const { logger } = globalThis.summaryceptionFoundationMocks;

describe('onChatCompletionPromptReady', () => {
    beforeEach(() => {
        logger.trace.mockClear();
        logger.isTraceEnabled.mockReturnValue(true);
        vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
        vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('reports one prefix summary per real prompt', () => {
        onChatCompletionPromptReady({
            chat: [
                { role: 'system', content: 'fixed' },
                { role: 'user', content: 'first' },
            ],
        });
        expect(logger.trace).toHaveBeenCalledWith('Prompt prefix baseline: 2 blocks');
        logger.trace.mockClear();

        onChatCompletionPromptReady({
            chat: [
                { content: 'fixed', role: 'system' },
                { role: 'user', content: 'second' },
                { role: 'assistant', content: 'new' },
            ],
        });

        expect(logger.trace).not.toHaveBeenCalled();
        expect(console.groupCollapsed).toHaveBeenCalledTimes(1);
        expect(console.groupCollapsed.mock.calls[0][0]).toContain('[TRACE]');
        expect(console.groupCollapsed.mock.calls[0][0]).not.toContain('[DEBUG]');
        expect(JSON.parse(console.log.mock.calls[0][0])).toEqual({
            type: 'summaryception.prompt.prefix-broken.v1',
            block: 1,
            previousLength: 2,
            currentLength: 3,
            newBlock: { role: 'user', content: 'second' },
        });
        expect(console.groupEnd).toHaveBeenCalledTimes(1);
    });

    it('logs the OK verdict on trace when the prefix grows cleanly', () => {
        onChatCompletionPromptReady({
            chat: [
                { role: 'system', content: 'fixed' },
                { role: 'user', content: 'first' },
            ],
        });
        logger.trace.mockClear();
        vi.mocked(console.groupCollapsed).mockClear();

        onChatCompletionPromptReady({
            chat: [
                { role: 'system', content: 'fixed' },
                { role: 'user', content: 'first' },
                { role: 'assistant', content: 'reply' },
            ],
        });

        expect(logger.trace).toHaveBeenCalledWith(
            'Prompt prefix OK: 2 stable blocks, 1 added (assistant)',
        );
        expect(console.groupCollapsed).not.toHaveBeenCalled();
    });

    it('ignores dry-run prompt events in either event signature', () => {
        logger.trace.mockClear();
        onChatCompletionPromptReady({ chat: [{ role: 'system', content: 'dry' }] }, true);
        onChatCompletionPromptReady({ chat: [{ role: 'system', content: 'dry' }], dryRun: true });
        expect(logger.trace).not.toHaveBeenCalled();
    });

    it('does not mutate generation data during a dry run', () => {
        const payload = { prompt: [{ role: 'user', content: 'dry' }] };
        onGenerateAfterData(payload, true);
        expect(payload).toEqual({ prompt: [{ role: 'user', content: 'dry' }] });
    });
});
