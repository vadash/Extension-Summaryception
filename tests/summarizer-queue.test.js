import { describe, expect, it, vi } from 'vitest';

import { SummarizerQueue } from '../src/core/summarizer-queue.js';

/** Build a queue with injected fake dependencies; no host context needed. */
function makeQueue(drainOneCycle) {
    return new SummarizerQueue({
        drainOneCycle,
        abortAllRequests: vi.fn(),
        isRequestLive: vi.fn(() => false),
        refreshUi: vi.fn(),
        withUsageRun: vi.fn(async (_label, work) => await work()),
        yieldCycle: vi.fn(async () => {}),
    });
}

describe('SummarizerQueue drain loop', () => {
    it('keeps draining while cycles complete', async () => {
        let calls = 0;
        const queue = makeQueue(async () =>
            ++calls <= 2 ? { status: 'completed' } : { status: 'idle' },
        );

        await queue.request();

        expect(calls).toBe(3);
    });

    it.each([['idle'], ['blocked'], ['failed']])(
        'exits the loop when a cycle is %s',
        async (status) => {
            let calls = 0;
            const queue = makeQueue(async () => {
                calls++;
                return { status };
            });

            await queue.request();

            expect(calls).toBe(1);
        },
    );

    it('drops coalesced reruns after a failed cycle', async () => {
        let calls = 0;
        const queue = makeQueue(async () => {
            if (++calls === 1) {
                queue.request(); // new work arrives mid-drain
            }
            return { status: 'failed' };
        });

        await queue.request();

        expect(calls).toBe(1);
        expect(queue.pending).toBe(false);
        expect(queue.dirty).toBe(false);
    });
});
