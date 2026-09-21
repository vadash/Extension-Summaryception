import { describe, expect, it, vi } from 'vitest';

// The host facade itself is the subject here, so the shared setup's context
// mock is lifted and the real module reads the installed SillyTavern stub.
vi.unmock('../src/foundation/context.js');

import { getName1 } from '../src/foundation/context.js';

describe('getName1', () => {
    it('returns the player name from the host context', () => {
        expect(getName1()).toBe('Player1');
    });

    it('falls back to "User" when the host exposes no name', () => {
        delete globalThis.SillyTavern.getContext().name1;
        expect(getName1()).toBe('User');
    });
});
