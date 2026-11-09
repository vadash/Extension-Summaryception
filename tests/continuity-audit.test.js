import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connectionMocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
}));
vi.mock('../src/core/connectionutil.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, ...connectionMocks };
});

import { createContinuityAuditor, isAuditorTriggerMessage } from '../src/core/continuity-audit.js';
import {
    installSummaryContext,
    makeMessage,
    makeSummarizerDispatch,
    makeSummaryStore,
} from './test-helpers.js';

afterEach(() => {
    connectionMocks.sendSummarizerRequest.mockReset();
});

// The temporary guard hides this lifecycle; the mock below forces it off.
vi.mock('../src/foundation/auditor-switch.js', () => ({ AUDITOR_DISABLED: false }));

/**
 * The audit reads the world through its arguments and its injected
 * dependencies. The dispatch is the real Summarizer Dispatch over the faked
 * transport, so the rig installs the SillyTavern context the dispatch reads
 * settings from, with the same settings `audit()` receives.
 */

const auditorJson = (bonds = {}, gmNotes = ['[T] Keep this thread']) =>
    JSON.stringify({
        turn_count: 999,
        bonds,
        agendas: {},
        gm_notes: gmNotes,
        physics: {
            location: 'Salon',
            environment: 'Warm',
            posture_and_position: 'Seated',
            contact_points: 'None',
            clothing_state: 'Robe',
        },
    });

// Continuity State as of exchange 2's settled audit: the checkpoint lives on
// a2, one spark away from conversion, no notes, no scene location yet.
const priorState = (overrides = {}) => ({
    turn_count: 2,
    bonds: { 'Quipsy↔User': { bond: 10, sparks: 6, grudge: 1 } },
    agendas: {},
    gm_notes: [],
    physics: {
        location: '',
        environment: '',
        posture_and_position: '',
        contact_points: '',
        clothing_state: '',
    },
    ...overrides,
});

const soloChat = () => [
    makeMessage({ isUser: true, scId: 'u1' }),
    makeMessage({ scId: 'a1' }),
    makeMessage({ isUser: true, scId: 'u2' }),
    makeMessage({ scId: 'a2' }),
    makeMessage({ isUser: true, scId: 'u3' }),
    makeMessage({ scId: 'a3' }),
];

const withCheckpoint = (message, state) => {
    message.extra.summaryception_continuity = state;
    return message;
};

const checkpointOf = (chat, scId) =>
    chat.find((message) => message.sc_id === scId)?.extra?.summaryception_continuity;

/**
 * One audit rig: a real chat fixture, a real store, the real Summarizer
 * Dispatch over the faked transport, and fakes for the three audit-side
 * injected dependencies. `audit()` assembles the input the entry layer would.
 * @param {object} [options]
 * @param {import('vitest').Mock} [options.dispatchOverride] - Seam double for
 *   outcomes the real walk cannot produce, such as a thrown dispatch.
 */
async function makeAuditRig({
    chat = soloChat(),
    prior = priorState(),
    checkpointAt = 'a2',
    layers = [],
    settings = {},
    hasGroup = false,
    playerName = 'Player1',
    rerollTail = false,
    dispatchOverride = null,
} = {}) {
    if (prior !== null) {
        withCheckpoint(
            chat.find((message) => message.sc_id === checkpointAt),
            prior,
        );
    }
    const store = makeSummaryStore({ layers });
    const auditSettings = { enabled: true, continuityEnabled: true, ...settings };
    installSummaryContext({ metadata: { summaryception: store }, settings: auditSettings });
    const dispatch = dispatchOverride ?? (await makeRealDispatch());
    const saveChatStore = vi.fn(async () => {});
    const refreshPreview = vi.fn();
    let currentChat = chat;
    const auditor = createContinuityAuditor({
        dispatch,
        saveChatStore,
        refreshPreview,
        getChat: () => currentChat,
    });

    return {
        chat,
        store,
        dispatch,
        saveChatStore,
        refreshPreview,
        switchChat: (next) => {
            currentChat = next;
        },
        audit: (overrides = {}) =>
            auditor.audit({
                chat,
                store,
                settings: auditSettings,
                hasGroup,
                playerName,
                rerollTail,
                ...overrides,
            }),
    };
}

/** Wrap the real dispatch so tests can observe the audit's call shape. */
async function makeRealDispatch() {
    const dispatch = await makeSummarizerDispatch();
    return vi.fn((request) => dispatch.call(request));
}

describe('isAuditorTriggerMessage', () => {
    it('accepts the identical assistant message object only for the normal event type', () => {
        const assistantMessage = { is_user: false, is_system: false };
        expect(isAuditorTriggerMessage(assistantMessage, 'normal')).toBe(true);
        expect(isAuditorTriggerMessage(assistantMessage, 'swipe')).toBe(false);
        expect(isAuditorTriggerMessage(assistantMessage, 'continue')).toBe(false);
        expect(isAuditorTriggerMessage(assistantMessage, 'append')).toBe(false);
        expect(isAuditorTriggerMessage(assistantMessage, undefined)).toBe(false);
    });

    it('rejects user and system messages regardless of event type', () => {
        expect(isAuditorTriggerMessage({ is_user: true, is_system: false }, 'normal')).toBe(false);
        expect(isAuditorTriggerMessage({ is_user: false, is_system: true }, 'normal')).toBe(false);
        expect(isAuditorTriggerMessage(null, 'normal')).toBe(false);
    });
});

describe('audit gates', () => {
    it('stays idle when the extension is off', async () => {
        const rig = await makeAuditRig({ settings: { enabled: false } });

        const outcome = await rig.audit();

        expect(outcome.status).toBe('idle');
        expect(rig.dispatch).not.toHaveBeenCalled();
    });

    it('stays idle when continuityEnabled is off', async () => {
        const rig = await makeAuditRig({ settings: { continuityEnabled: false } });

        const outcome = await rig.audit();

        expect(outcome.status).toBe('idle');
        expect(rig.dispatch).not.toHaveBeenCalled();
    });

    it('stays idle in a group chat', async () => {
        const rig = await makeAuditRig({ hasGroup: true });

        const outcome = await rig.audit();

        expect(outcome.status).toBe('idle');
        expect(rig.dispatch).not.toHaveBeenCalled();
    });

    it('stays idle when no assistant message follows the live checkpoint', async () => {
        const rig = await makeAuditRig({
            chat: soloChat().slice(0, 3),
            checkpointAt: 'a1',
        });

        const outcome = await rig.audit();

        expect(outcome.status).toBe('idle');
        expect(rig.dispatch).not.toHaveBeenCalled();
    });
});

describe('audit commit', () => {
    it('cold-starts from the chat start when no checkpoint exists', async () => {
        const rig = await makeAuditRig({ prior: null });
        connectionMocks.sendSummarizerRequest.mockResolvedValue(auditorJson());

        const outcome = await rig.audit();

        expect(outcome.status).toBe('completed');
        const payload = checkpointOf(rig.chat, 'a3');
        expect(payload.turn_count).toBe(3);
        expect(payload.bonds).toEqual({});
    });

    it('audits the latest exchange, applies flags, and leaves prior checkpoints intact', async () => {
        const rig = await makeAuditRig();
        connectionMocks.sendSummarizerRequest.mockResolvedValue(
            auditorJson({ 'Quipsy↔User': { positive_interaction: true } }),
        );

        const outcome = await rig.audit();

        expect(outcome.status).toBe('completed');
        expect(rig.dispatch).toHaveBeenCalledTimes(1);
        const payload = checkpointOf(rig.chat, 'a3');
        expect(payload.turn_count).toBe(3);
        // sparks +1 from the flag; grudge decays on turnCount % 3; bond untouched.
        expect(payload.bonds['Quipsy↔User']).toEqual({ bond: 10, sparks: 7, grudge: 0 });
        expect(payload.gm_notes).toEqual(['[T] Keep this thread']);
        expect(payload.physics.location).toBe('Salon');
        expect(payload).not.toHaveProperty('anchor_sc_id');
        expect(payload).not.toHaveProperty('stale');
        expect(checkpointOf(rig.chat, 'a2')).toEqual(priorState());
    });

    it('lands the audit when the chat merely grows mid-flight', async () => {
        // ADR-0017 attach-by-reference: new exchanges after dispatch no
        // longer discard the audit; the checkpoint lands on the audited reply.
        const rig = await makeAuditRig();
        connectionMocks.sendSummarizerRequest.mockImplementation(async () => {
            rig.chat.push(makeMessage({ isUser: true, scId: 'u4' }), makeMessage({ scId: 'a4' }));
            return auditorJson();
        });

        const outcome = await rig.audit();

        expect(outcome.status).toBe('completed');
        const payload = checkpointOf(rig.chat, 'a3');
        expect(payload.turn_count).toBe(3);
        expect(checkpointOf(rig.chat, 'a4')).toBeUndefined();
    });

    it('overwrites the checkpoint when the audited reply is swiped mid-flight', async () => {
        const rig = await makeAuditRig();
        connectionMocks.sendSummarizerRequest.mockImplementation(async () => {
            rig.chat[5].mes = 'Swiped to draft two.';
            return auditorJson();
        });

        const outcome = await rig.audit();

        expect(outcome.status).toBe('completed');
        const payload = checkpointOf(rig.chat, 'a3');
        expect(payload.turn_count).toBe(3);
        expect(payload.gm_notes).toEqual(['[T] Keep this thread']);
    });

    it('sends one combined call capped at four exchanges on catch-up', async () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u1' }),
            makeMessage({ scId: 'a1' }),
            makeMessage({ isUser: true, scId: 'u2' }),
            makeMessage({ scId: 'a2' }),
            makeMessage({ isUser: true, scId: 'u3' }),
            makeMessage({ scId: 'a3' }),
            makeMessage({ isUser: true, scId: 'u4' }),
            makeMessage({ scId: 'a4' }),
            makeMessage({ isUser: true, scId: 'u5' }),
            makeMessage({ scId: 'a5' }),
            makeMessage({ isUser: true, scId: 'u6' }),
            makeMessage({ scId: 'a6' }),
        ];
        const rig = await makeAuditRig({ chat, prior: null });
        connectionMocks.sendSummarizerRequest.mockResolvedValue(auditorJson());

        const outcome = await rig.audit();

        expect(outcome.status).toBe('completed');
        expect(rig.dispatch).toHaveBeenCalledTimes(1);
        const storyTxt = rig.dispatch.mock.calls[0][0].storyTxt;
        expect(storyTxt).toContain('[11] Assistant:'); // a6
        expect(storyTxt).toContain('[4]'); // u3
        expect(storyTxt).not.toContain('[2]'); // u2
        // turn_count is derived from the chat, not the window.
        expect(checkpointOf(chat, 'a6').turn_count).toBe(6);
    });

    it('keeps the user line when a system message sits between the turns', async () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u1' }),
            makeMessage({ scId: 'a1' }),
            makeMessage({ isUser: true, scId: 'u2' }),
            makeMessage({ isSystem: true, scId: 's1' }),
            makeMessage({ scId: 'a2' }),
        ];
        const rig = await makeAuditRig({ chat, checkpointAt: 'a1' });
        connectionMocks.sendSummarizerRequest.mockResolvedValue(auditorJson());

        const outcome = await rig.audit();

        expect(outcome.status).toBe('completed');
        const storyTxt = rig.dispatch.mock.calls[0][0].storyTxt;
        expect(storyTxt).toContain('[2]'); // u2 user line survives the system message at [3]
        expect(storyTxt).toContain('[4]'); // a2
        // s1 is not the user turn, so the audit window keeps it (ADR-0028).
        expect(storyTxt).toContain('[3]');
    });

    it('feeds the prior state JSON and the narrative memory as context', async () => {
        const rig = await makeAuditRig({
            layers: [[{ text: 'A remembered scene.', sourceMessageIds: ['u1'] }]],
        });
        connectionMocks.sendSummarizerRequest.mockResolvedValue(auditorJson());

        await rig.audit();

        const contextStr = rig.dispatch.mock.calls[0][0].contextStr;
        expect(contextStr).toContain('"Quipsy↔User"');
        expect(contextStr).toContain('10');
        expect(contextStr).toContain('A remembered scene.');
    });

    it('routes the audit call through the auditor call category', async () => {
        const rig = await makeAuditRig();
        connectionMocks.sendSummarizerRequest.mockResolvedValue(auditorJson());

        await rig.audit();

        expect(rig.dispatch.mock.calls[0][0].metadata).toEqual({ kind: 'auditor' });
    });

    it('refreshes the preview only after a write lands', async () => {
        const rig = await makeAuditRig();
        connectionMocks.sendSummarizerRequest.mockResolvedValue(auditorJson());

        await rig.audit();

        expect(rig.saveChatStore).toHaveBeenCalledTimes(1);
        expect(rig.refreshPreview).toHaveBeenCalledTimes(1);
    });
});

describe('audit drops', () => {
    it('drops the write when the audited reply disappears mid-flight', async () => {
        const rig = await makeAuditRig();
        connectionMocks.sendSummarizerRequest.mockImplementation(async () => {
            rig.chat.splice(5, 1);
            return auditorJson();
        });

        const outcome = await rig.audit();

        expect(outcome.status).toBe('aborted');
        expect(checkpointOf(rig.chat, 'a3')).toBeUndefined();
        expect(checkpointOf(rig.chat, 'a2')).toEqual(priorState());
        expect(rig.store.mutationEpoch).toBe(0);
        expect(rig.saveChatStore).not.toHaveBeenCalled();
    });

    it('drops the write when the chat switches during the save', async () => {
        const rig = await makeAuditRig();
        connectionMocks.sendSummarizerRequest.mockResolvedValue(auditorJson());
        rig.saveChatStore.mockImplementation(async () => {
            rig.switchChat([makeMessage({ isUser: true, scId: 'other-u1' })]);
        });

        const outcome = await rig.audit();

        expect(outcome.status).toBe('aborted');
        expect(rig.refreshPreview).not.toHaveBeenCalled();
    });

    it('writes nothing when the draft fails validation', async () => {
        const rig = await makeAuditRig();
        connectionMocks.sendSummarizerRequest.mockResolvedValue('not json');

        const outcome = await rig.audit();

        expect(outcome.status).toBe('failed');
        expect(rig.dispatch).toHaveBeenCalledTimes(1);
        expect(checkpointOf(rig.chat, 'a3')).toBeUndefined();
        expect(checkpointOf(rig.chat, 'a2')).toEqual(priorState());
        expect(rig.store.mutationEpoch).toBe(0);
    });

    it('commits a draft the Parse Recovery waterfall rescues', async () => {
        const rig = await makeAuditRig();
        connectionMocks.sendSummarizerRequest.mockResolvedValue(
            '```json\n' + auditorJson() + '\n```',
        );

        const outcome = await rig.audit();

        // A rescue is a successful commit: the draft was syntactically
        // damaged, not semantically empty. The next audit can still re-derive
        // everything the waterfall preserved.
        expect(outcome.status).toBe('completed');
        const payload = checkpointOf(rig.chat, 'a3');
        expect(payload.turn_count).toBe(3);
        expect(payload.gm_notes).toEqual(['[T] Keep this thread']);
    });

    it('writes nothing after an API failure', async () => {
        const rig = await makeAuditRig();
        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('bad request'));

        const outcome = await rig.audit();

        expect(outcome.status).toBe('failed');
        expect(rig.dispatch).toHaveBeenCalledTimes(1);
        expect(checkpointOf(rig.chat, 'a3')).toBeUndefined();
        expect(checkpointOf(rig.chat, 'a2')).toEqual(priorState());
    });

    it('swallows a dispatch throw and leaves the state untouched', async () => {
        // A thrown dispatch violates the seam contract: the real walk settles
        // every provider error into a Run Outcome, so this case drives the
        // audit's catch directly through a seam double.
        const rig = await makeAuditRig({
            dispatchOverride: vi.fn().mockRejectedValue(new Error('connection lost')),
        });

        const outcome = await rig.audit();

        expect(outcome.status).toBe('failed');
        expect(checkpointOf(rig.chat, 'a3')).toBeUndefined();
        expect(checkpointOf(rig.chat, 'a2')).toEqual(priorState());
    });
});

describe('continuity state audit log', () => {
    const { logger } = globalThis.summaryceptionFoundationMocks;

    beforeEach(() => {
        vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
        vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('logs one audit group with the state diff after a successful commit', async () => {
        const rig = await makeAuditRig();
        logger.isContinuityStateLogEnabled.mockReturnValue(true);
        logger.isContinuityStateLogFullEnabled.mockReturnValue(false);
        connectionMocks.sendSummarizerRequest.mockResolvedValue(
            auditorJson({ 'Quipsy↔User': { positive_interaction: true } }),
        );

        const outcome = await rig.audit();

        expect(outcome.status).toBe('completed');
        expect(console.groupCollapsed).toHaveBeenCalledTimes(2);
        expect(console.groupCollapsed.mock.calls[0][0]).toContain('[Summaryception]');
        expect(console.groupEnd).toHaveBeenCalledTimes(2);
        const payload = JSON.parse(console.log.mock.calls[1][0]);
        expect(payload.type).toBe('summaryception.continuity.audit.v1');
        expect(payload.kind).toBe('success');
        expect(payload.changes.turn_count).toEqual([2, 3]);
        expect(payload.changes.bonds['Quipsy↔User']).toEqual({ sparks: [6, 7], grudge: [1, 0] });
        expect(payload.changes.gm_notes).toEqual({ added: ['[T] Keep this thread'] });
        expect(payload.changes.physics.location).toEqual(['', 'Salon']);
        // Nothing was over budget, so the cap stays out of the log.
        expect(payload.notes_truncated).toBeUndefined();
    });

    it('reports the notes the GM-note budget dropped', async () => {
        const rig = await makeAuditRig();
        logger.isContinuityStateLogEnabled.mockReturnValue(true);
        logger.isContinuityStateLogFullEnabled.mockReturnValue(false);
        const overBudget = Array.from({ length: 14 }, (_, i) => `[S] Secret ${i + 1}`);
        connectionMocks.sendSummarizerRequest.mockResolvedValue(auditorJson({}, overBudget));

        const outcome = await rig.audit();

        expect(outcome.status).toBe('completed');
        const payload = JSON.parse(console.log.mock.calls[1][0]);
        expect(payload.notes_truncated).toBe(2);
        expect(payload.changes.gm_notes).toEqual({ added: overBudget.slice(0, 12) });
    });

    it('logs the full committed state in full mode instead of the diff', async () => {
        const rig = await makeAuditRig();
        logger.isContinuityStateLogEnabled.mockReturnValue(true);
        logger.isContinuityStateLogFullEnabled.mockReturnValue(true);
        connectionMocks.sendSummarizerRequest.mockResolvedValue(
            auditorJson({ 'Quipsy↔User': { positive_interaction: true } }),
        );

        await rig.audit();

        const payload = JSON.parse(console.log.mock.calls[1][0]);
        expect(payload.kind).toBe('success');
        expect(payload.audited_sc_id).toBe('a3');
        expect(payload.state.turn_count).toBe(3);
        expect(payload.state.bonds['Quipsy↔User']).toEqual({ bond: 10, sparks: 7, grudge: 0 });
        expect(payload.changes).toBeUndefined();
    });

    it('logs a start milestone before the completed audit group', async () => {
        const rig = await makeAuditRig();
        logger.isContinuityStateLogEnabled.mockReturnValue(true);
        logger.isContinuityStateLogFullEnabled.mockReturnValue(false);
        connectionMocks.sendSummarizerRequest.mockResolvedValue(
            auditorJson({ 'Quipsy↔User': { positive_interaction: true } }),
        );

        const outcome = await rig.audit();

        expect(outcome.status).toBe('completed');
        const titles = console.groupCollapsed.mock.calls.map((call) => call[0]);
        const startTitle = titles.find((title) => title.includes('audit - START'));
        expect(startTitle).toContain('(turn 3, coverage 3)');
        expect(titles.some((title) => title.includes('audit - COMPLETED'))).toBe(true);
        expect(JSON.parse(console.log.mock.calls[0][0])).toEqual({
            type: 'summaryception.continuity.audit.v1',
            kind: 'start',
            turn_count: 3,
            coverage_index: 3,
        });
    });

    it('logs the drop reason when the audited reply is removed mid-flight', async () => {
        const rig = await makeAuditRig();
        logger.isContinuityStateLogEnabled.mockReturnValue(true);
        connectionMocks.sendSummarizerRequest.mockImplementation(async () => {
            rig.chat.splice(5, 1);
            return auditorJson();
        });

        const outcome = await rig.audit();

        expect(outcome.status).toBe('aborted');
        const payload = JSON.parse(console.log.mock.calls[1][0]);
        expect(payload.kind).toBe('aborted');
        expect(payload.reason).toBe('reply-removed');
    });

    it('logs nothing when the continuity state log flag is off', async () => {
        const rig = await makeAuditRig();
        logger.isContinuityStateLogEnabled.mockReturnValue(false);
        connectionMocks.sendSummarizerRequest.mockResolvedValue('not json');

        await rig.audit();

        expect(console.groupCollapsed).not.toHaveBeenCalled();
        expect(console.log).not.toHaveBeenCalled();
    });

    it('reports the Parse Recovery tier in the completed audit log', async () => {
        const rig = await makeAuditRig();
        logger.isContinuityStateLogEnabled.mockReturnValue(true);
        logger.isContinuityStateLogFullEnabled.mockReturnValue(false);
        connectionMocks.sendSummarizerRequest.mockResolvedValue(
            '```json\n' + auditorJson({ 'Quipsy↔User': { positive_interaction: true } }) + '\n```',
        );

        await rig.audit();

        const payload = JSON.parse(console.log.mock.calls[1][0]);
        expect(payload.recovery_tier).toBe(2);
    });
});
