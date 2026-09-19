import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const callSummarizer = vi.hoisted(() => vi.fn());
vi.mock('../src/core/summarizer-request.js', () => ({
    callSummarizer,
    // Referenced at summarizer-queue module init, which ui.js import chains reach.
    abortAllRequests: vi.fn(),
    isRequestLive: vi.fn(() => false),
}));

import { buildSummarizerPipelineInput } from '../src/core/summarizer-pipeline.js';
import { isAuditorTriggerMessage, runAuditorExtraction } from '../src/core/continuity-runner.js';
import { defaultSettings } from '../src/foundation/constants.js';
import { installSummaryContext, makeMessage, makeSummaryStore } from './test-helpers.js';

const auditorJson = (bonds = {}) =>
    JSON.stringify({
        turn_count: 999,
        bonds,
        agendas: {},
        gm_notes: ['[T] Keep this thread'],
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

const attachCheckpoint = (message, state) => {
    message.extra.summaryception_continuity = state;
    return message;
};

function installSoloChat({
    chat = soloChat(),
    prior = priorState(),
    checkpointAt = 'a2',
    settings = {},
    groupId,
} = {}) {
    if (prior !== null) {
        attachCheckpoint(
            chat.find((message) => message.sc_id === checkpointAt),
            prior,
        );
    }
    const ctx = installSummaryContext({
        chat,
        metadata: { summaryception: makeSummaryStore() },
        settings: { continuityEnabled: true, ...settings },
        ...(groupId !== undefined ? { groupId } : {}),
    });
    return ctx;
}

const checkpointOf = (ctx, scId) =>
    ctx.chat.find((message) => message.sc_id === scId)?.extra?.summaryception_continuity;

afterEach(() => {
    vi.resetModules();
    callSummarizer.mockReset();
    delete globalThis.SillyTavern;
});

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

describe('runAuditorExtraction', () => {
    it('stays idle when continuityEnabled is off', async () => {
        installSoloChat({ settings: { continuityEnabled: false } });
        const outcome = await runAuditorExtraction();
        expect(outcome.status).toBe('idle');
        expect(callSummarizer).not.toHaveBeenCalled();
    });

    it('stays idle in a group chat', async () => {
        installSoloChat({ groupId: 'group-1' });
        const outcome = await runAuditorExtraction();
        expect(outcome.status).toBe('idle');
        expect(callSummarizer).not.toHaveBeenCalled();
    });

    it('stays idle when no assistant message follows the live checkpoint', async () => {
        installSoloChat({ chat: soloChat().slice(0, 3), checkpointAt: 'a1' });
        const outcome = await runAuditorExtraction();
        expect(outcome.status).toBe('idle');
        expect(callSummarizer).not.toHaveBeenCalled();
    });

    it('cold-starts from the chat start when no checkpoint exists', async () => {
        const ctx = installSoloChat({ prior: null });
        callSummarizer.mockResolvedValue({ status: 'completed', text: auditorJson() });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('completed');
        const payload = checkpointOf(ctx, 'a3');
        expect(payload.turn_count).toBe(3);
        expect(payload.bonds).toEqual({});
    });

    it('audits the latest exchange, applies flags, and leaves prior checkpoints intact', async () => {
        const ctx = installSoloChat();
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: auditorJson({ 'Quipsy↔User': { positive_interaction: true } }),
        });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('completed');
        expect(callSummarizer).toHaveBeenCalledTimes(1);
        const payload = checkpointOf(ctx, 'a3');
        expect(payload.turn_count).toBe(3);
        // sparks +1 from the flag; grudge decays on turnCount % 3; bond untouched.
        expect(payload.bonds['Quipsy↔User']).toEqual({ bond: 10, sparks: 7, grudge: 0 });
        expect(payload.gm_notes).toEqual(['[T] Keep this thread']);
        expect(payload.physics.location).toBe('Salon');
        expect(payload).not.toHaveProperty('anchor_sc_id');
        expect(payload).not.toHaveProperty('stale');
        expect(checkpointOf(ctx, 'a2')).toEqual(priorState());
    });

    it('lands the audit when the chat merely grows mid-flight', async () => {
        // ADR-0014 attach-by-reference: new exchanges after dispatch no
        // longer discard the audit; the checkpoint lands on the audited reply.
        const ctx = installSoloChat();
        callSummarizer.mockImplementation(async () => {
            ctx.chat.push(makeMessage({ isUser: true, scId: 'u4' }), makeMessage({ scId: 'a4' }));
            return { status: 'completed', text: auditorJson() };
        });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('completed');
        const payload = checkpointOf(ctx, 'a3');
        expect(payload.turn_count).toBe(3);
        expect(checkpointOf(ctx, 'a4')).toBeUndefined();
    });

    it('drops the write when the audited reply disappears mid-flight', async () => {
        const ctx = installSoloChat();
        callSummarizer.mockImplementation(async () => {
            ctx.chat.splice(5, 1);
            return { status: 'completed', text: auditorJson() };
        });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('aborted');
        expect(checkpointOf(ctx, 'a3')).toBeUndefined();
        expect(checkpointOf(ctx, 'a2')).toEqual(priorState());
        expect(ctx.chatMetadata.summaryception.mutationEpoch).toBe(0);
    });

    it('overwrites the checkpoint when the audited reply is swiped mid-flight', async () => {
        const ctx = installSoloChat();
        callSummarizer.mockImplementation(async () => {
            ctx.chat[5].mes = 'Swiped to draft two.';
            return { status: 'completed', text: auditorJson() };
        });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('completed');
        const payload = checkpointOf(ctx, 'a3');
        expect(payload.turn_count).toBe(3);
        expect(payload.gm_notes).toEqual(['[T] Keep this thread']);
        expect(payload.physics.location).toBe('Salon');
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
        const ctx = installSoloChat({ chat, prior: null });
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: auditorJson(),
        });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('completed');
        expect(callSummarizer).toHaveBeenCalledTimes(1);
        const storyTxt = callSummarizer.mock.calls[0][0].storyTxt;
        expect(storyTxt).toContain('[11] Assistant:'); // a6
        expect(storyTxt).toContain('[4]'); // u3
        expect(storyTxt).not.toContain('[2]'); // u2
        // turn_count is derived from the chat, not the window.
        expect(checkpointOf(ctx, 'a6').turn_count).toBe(6);
    });

    it('keeps the user line when a system message sits between the turns', async () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u1' }),
            makeMessage({ scId: 'a1' }),
            makeMessage({ isUser: true, scId: 'u2' }),
            makeMessage({ isSystem: true, scId: 's1' }),
            makeMessage({ scId: 'a2' }),
        ];
        installSoloChat({ chat, checkpointAt: 'a1' });
        callSummarizer.mockResolvedValue({ status: 'completed', text: auditorJson() });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('completed');
        const storyTxt = callSummarizer.mock.calls[0][0].storyTxt;
        expect(storyTxt).toContain('[2]'); // u2 user line survives the system message at [3]
        expect(storyTxt).toContain('[4]'); // a2
        expect(storyTxt).not.toContain('[3]'); // s1
    });

    it('feeds the prior state JSON and macro memory as context', async () => {
        installSoloChat();
        callSummarizer.mockResolvedValue({ status: 'completed', text: auditorJson() });

        await runAuditorExtraction();

        const contextStr = callSummarizer.mock.calls[0][0].contextStr;
        expect(contextStr).toContain('"Quipsy↔User"');
        expect(contextStr).toContain('10');
    });

    it('writes nothing when the draft fails validation', async () => {
        const ctx = installSoloChat();
        callSummarizer.mockResolvedValue({ status: 'completed', text: 'not json' });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('failed');
        expect(callSummarizer).toHaveBeenCalledTimes(1);
        expect(checkpointOf(ctx, 'a3')).toBeUndefined();
        expect(checkpointOf(ctx, 'a2')).toEqual(priorState());
        expect(ctx.chatMetadata.summaryception.mutationEpoch).toBe(0);
    });

    it('writes nothing after an API failure', async () => {
        const ctx = installSoloChat();
        callSummarizer.mockResolvedValue({ status: 'failed', attempts: 4 });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('failed');
        expect(callSummarizer).toHaveBeenCalledTimes(1);
        expect(checkpointOf(ctx, 'a3')).toBeUndefined();
        expect(checkpointOf(ctx, 'a2')).toEqual(priorState());
    });

    it('swallows a request throw and leaves the state untouched', async () => {
        const ctx = installSoloChat();
        callSummarizer.mockRejectedValue(new Error('connection lost'));

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('failed');
        expect(checkpointOf(ctx, 'a3')).toBeUndefined();
        expect(checkpointOf(ctx, 'a2')).toEqual(priorState());
    });
});

describe('auditor prompt routing', () => {
    it('routes the auditor kind to the auditor prompts with substitution', async () => {
        installSoloChat();
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

describe('settings normalization', () => {
    it('defaults continuityEnabled to false and coerces garbage to false', async () => {
        const { getSettings } = await import('../src/foundation/state.js');
        const ctx = installSoloChat({ settings: { continuityEnabled: undefined } });
        expect(getSettings().continuityEnabled).toBe(false);

        ctx.extensionSettings.summaryception.continuityEnabled = 'yes';
        expect(getSettings().continuityEnabled).toBe(false);

        ctx.extensionSettings.summaryception.continuityEnabled = true;
        expect(getSettings().continuityEnabled).toBe(true);
    });
});

describe('ui gating', () => {
    it('toggles the continuity section with the extension enabled state', async () => {
        const { syncEnabledContent } = await import('../src/entry/ui.js');
        const toggles = {};
        globalThis.$ = vi.fn((selector) => ({
            toggle(visible) {
                toggles[selector] = visible;
            },
        }));
        syncEnabledContent({ enabled: true, uiMode: 'advanced', autoPaused: false });
        expect(toggles['#sc_continuity_section']).toBe(true);
        syncEnabledContent({ enabled: false, uiMode: 'off', autoPaused: false });
        expect(toggles['#sc_continuity_section']).toBe(false);
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
        installSoloChat();
        logger.isContinuityStateLogEnabled.mockReturnValue(true);
        logger.isContinuityStateLogFullEnabled.mockReturnValue(false);
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: auditorJson({ 'Quipsy↔User': { positive_interaction: true } }),
        });

        const outcome = await runAuditorExtraction();

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
    });

    it('logs the full committed state in full mode instead of the diff', async () => {
        installSoloChat();
        logger.isContinuityStateLogEnabled.mockReturnValue(true);
        logger.isContinuityStateLogFullEnabled.mockReturnValue(true);
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: auditorJson({ 'Quipsy↔User': { positive_interaction: true } }),
        });

        await runAuditorExtraction();

        const payload = JSON.parse(console.log.mock.calls[1][0]);
        expect(payload.kind).toBe('success');
        expect(payload.audited_sc_id).toBe('a3');
        expect(payload.state.turn_count).toBe(3);
        expect(payload.state.bonds['Quipsy↔User']).toEqual({ bond: 10, sparks: 7, grudge: 0 });
        expect(payload.changes).toBeUndefined();
    });

    it('logs a start milestone before the completed audit group', async () => {
        installSoloChat();
        logger.isContinuityStateLogEnabled.mockReturnValue(true);
        logger.isContinuityStateLogFullEnabled.mockReturnValue(false);
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: auditorJson({ 'Quipsy↔User': { positive_interaction: true } }),
        });

        const outcome = await runAuditorExtraction();

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

    it('logs nothing when the continuity state log flag is off', async () => {
        installSoloChat();
        logger.isContinuityStateLogEnabled.mockReturnValue(false);
        callSummarizer.mockResolvedValue({ status: 'completed', text: 'not json' });

        await runAuditorExtraction();

        expect(console.groupCollapsed).not.toHaveBeenCalled();
        expect(console.log).not.toHaveBeenCalled();
    });
});
