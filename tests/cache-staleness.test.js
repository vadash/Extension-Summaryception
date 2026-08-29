import { describe, expect, it } from 'vitest';

import {
    evaluateStaleCacheAdvice,
    getMessageTimestampMs,
    isProviderCacheMode,
} from '../src/core/cache-staleness.js';
import { MEMORY_MODES } from '../src/foundation/constants.js';
import { cacheSettings, makeMessage } from './test-helpers.js';

const NOW = Date.parse('2026-08-22T12:00:00Z');
const TTL_MINUTES = 30;

const planWithQueue = (turns = 5) => ({
    eligibleTurns: Array.from({ length: turns }),
    queuedTokens: 4000,
});

const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

describe('evaluateStaleCacheAdvice', () => {
    it.each([MEMORY_MODES.PREFIX_CACHE])(
        '%s advises summarizing when the cache is stale',
        (memoryMode) => {
            const chat = [makeMessage({ sendDate: minutesAgo(75) })];
            const advice = evaluateStaleCacheAdvice({
                chat,
                plan: planWithQueue(),
                settings: cacheSettings({ memoryMode }),
                now: NOW,
            });

            expect(advice).toMatchObject({
                advise: true,
                reason: 'stale',
                staleMinutes: 75,
                ttlMinutes: TTL_MINUTES,
                queuedTurns: 5,
                queuedTokens: 4000,
            });
        },
    );

    it('withholds advice outside the cache modes', () => {
        const chat = [makeMessage({ sendDate: minutesAgo(75) })];
        const advice = evaluateStaleCacheAdvice({
            chat,
            plan: planWithQueue(),
            settings: cacheSettings({ memoryMode: MEMORY_MODES.BALANCED }),
            now: NOW,
        });

        expect(advice.advise).toBe(false);
        expect(advice.reason).toBe('cache-mode');
    });

    it('withholds advice while the queue holds fewer than the minimum summary turns', () => {
        const chat = [makeMessage({ sendDate: minutesAgo(75) })];
        const advice = evaluateStaleCacheAdvice({
            chat,
            plan: planWithQueue(2),
            settings: cacheSettings(),
            now: NOW,
        });

        expect(advice.advise).toBe(false);
        expect(advice.reason).toBe('queue-small');
    });

    it('treats the TTL boundary as stale', () => {
        const fresh = evaluateStaleCacheAdvice({
            chat: [makeMessage({ sendDate: minutesAgo(29) })],
            plan: planWithQueue(),
            settings: cacheSettings(),
            now: NOW,
        });
        const stale = evaluateStaleCacheAdvice({
            chat: [makeMessage({ sendDate: minutesAgo(30) })],
            plan: planWithQueue(),
            settings: cacheSettings(),
            now: NOW,
        });

        expect(fresh).toMatchObject({ advise: false, reason: 'fresh', staleMinutes: 29 });
        expect(stale).toMatchObject({ advise: true, reason: 'stale', staleMinutes: 30 });
    });

    it('withholds advice when the last message time cannot be read', () => {
        const chat = [makeMessage({ sendDate: 'yesterday, maybe' })];
        const advice = evaluateStaleCacheAdvice({
            chat,
            plan: planWithQueue(),
            settings: cacheSettings(),
            now: NOW,
        });

        expect(advice.advise).toBe(false);
        expect(advice.reason).toBe('unknown-time');
    });

    it('reads legacy epoch-millisecond send_date values', () => {
        const chat = [makeMessage({ sendDate: String(NOW - 45 * 60_000) })];
        const advice = evaluateStaleCacheAdvice({
            chat,
            plan: planWithQueue(),
            settings: cacheSettings(),
            now: NOW,
        });

        expect(advice).toMatchObject({ advise: true, staleMinutes: 45 });
    });
});

describe('getMessageTimestampMs', () => {
    it('prefers send_date and falls back to generation timestamps', () => {
        const sendDate = getMessageTimestampMs({ send_date: 1000, gen_started: 2000 });
        const generated = getMessageTimestampMs({ gen_started: 3000 });
        const finished = getMessageTimestampMs({ gen_finished: 4000 });

        expect(sendDate).toBe(1000);
        expect(generated).toBe(3000);
        expect(finished).toBe(4000);
    });

    it('parses ISO strings and rejects unparseable values', () => {
        expect(getMessageTimestampMs({ send_date: '2026-08-22T12:00:00Z' })).toBe(NOW);
        expect(getMessageTimestampMs({ send_date: 'not a date' })).toBeNull();
        expect(getMessageTimestampMs({})).toBeNull();
        expect(getMessageTimestampMs(undefined)).toBeNull();
    });
});

describe('isProviderCacheMode', () => {
    it.each([MEMORY_MODES.PREFIX_CACHE])('%s relies on the provider cache', (memoryMode) => {
        expect(isProviderCacheMode(cacheSettings({ memoryMode }))).toBe(true);
    });

    it('rejects the default mode', () => {
        expect(isProviderCacheMode(cacheSettings({ memoryMode: MEMORY_MODES.BALANCED }))).toBe(
            false,
        );
    });
});
