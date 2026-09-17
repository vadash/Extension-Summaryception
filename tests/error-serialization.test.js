import { describe, expect, it, vi } from 'vitest';

// Restore the real logger module. tests/setup.js replaces it with a mock.
vi.mock('../src/foundation/logger.js', async (importOriginal) => importOriginal());
import { serializeError } from '../src/foundation/logger.js';
import { wrapConnectionError } from '../src/core/connection-error.js';

describe('serializeError', () => {
    it('resolves the cause message of an ST-shaped wrapped error', () => {
        const err = new Error('API request failed', { cause: new Error('Invalid API key') });
        expect(serializeError(err).message).toBe('Invalid API key');
    });

    it('resolves the deepest informative message in a multi-level chain', () => {
        const leaf = new Error('real reason');
        const middle = new Error('generic wrapper', { cause: leaf });
        const top = new Error('generic outer', { cause: middle });
        expect(serializeError(top).message).toBe('real reason');
    });

    it('keeps the deepest informative message when a leaf has an empty message', () => {
        const top = new Error('outer', { cause: new Error('inner', { cause: new Error('') }) });
        expect(serializeError(top).message).toBe('inner');
    });

    it('terminates on a cyclic cause chain', () => {
        const a = new Error('a');
        const b = new Error('b', { cause: a });
        // @ts-expect-error test-only cycle
        a.cause = b;
        expect(serializeError(a).message).toBe('b');
    });

    it('picks up status from anywhere in the chain', () => {
        const err = new Error('API request failed', {
            cause: Object.assign(new Error('denied'), { status: 401 }),
        });
        expect(serializeError(err).status).toBe(401);
    });

    it('prefers the deepest status in the chain', () => {
        const leaf = Object.assign(new Error('denied'), { status: 401 });
        const top = Object.assign(new Error('wrapped', { cause: leaf }), { statusCode: 502 });
        expect(serializeError(top).status).toBe(401);
    });

    it('behaves identically to before for errors without a cause', () => {
        expect(serializeError(new Error('boom'))).toEqual({
            name: 'Error',
            message: 'boom',
            status: null,
            retryable: null,
        });
        const withStatus = Object.assign(new Error('rate limited'), { status: 429 });
        expect(serializeError(withStatus)).toEqual({
            name: 'Error',
            message: 'rate limited',
            status: 429,
            retryable: null,
        });
        expect(serializeError(null)).toEqual({
            name: 'Error',
            message: 'null',
            status: null,
            retryable: null,
        });
    });
});

describe('wrapConnectionError', () => {
    it('classifies a 401 leaf through the cause chain as an auth failure', () => {
        const err = new Error('API request failed', {
            cause: new Error('Got response status 401'),
        });
        const wrapped = wrapConnectionError(err, { profileId: 'p1' }, 'Connection Profile');
        expect(wrapped.status).toBe(401);
        expect(wrapped.retryable).toBe(false);
        expect(wrapped.message).toContain('auth failed (401)');
        expect(wrapped.message).toContain('Got response status 401');
    });

    it('keeps provider leaf messages on the generic path when they are not profile errors', () => {
        const err = new Error('API request failed', {
            cause: new Error('model gpt-x not found'),
        });
        const wrapped = wrapConnectionError(err, { profileId: 'p1' }, 'Connection Profile');
        expect(wrapped.status).toBeNull();
        expect(wrapped.message).toBe('Connection Profile request failed: model gpt-x not found');
    });

    it('still routes ST missing-profile errors to the deleted-profile guidance', () => {
        const err = new Error('Profile not found. ID: abc');
        const wrapped = wrapConnectionError(err, { profileId: 'p1' }, 'Connection Profile');
        expect(wrapped.status).toBe(404);
        expect(wrapped.message).toContain('not found. It may have been deleted');
    });
});
