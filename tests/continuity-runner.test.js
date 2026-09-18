import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const callSummarizer = vi.hoisted(() => vi.fn());
vi.mock('../src/core/summarizer-request.js', () => ({
    callSummarizer,
    // Referenced at summarizer-queue module init, which ui.js import chains reach.
    abortAllRequests: vi.fn(),
    isRequestLive: vi.fn(() => false),
}));

import { buildSummarizerPipelineInput } from '../src/core/summarizer-pipeline.js';
import {
    abortActiveAuditorRun,
    isAuditorTriggerMessage,
    rewindContinuityAnchor,
    runAuditorExtraction,
} from '../src/core/continuity-runner.js';
import { defaultSettings } from '../src/foundation/constants.js';
import { EXECUTION_TRIGGER_AUDITOR } from '../src/foundation/prompt-parts.js';
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

const priorContinuity = (overrides = {}) => ({
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
    anchor_sc_id: 'a2',
    stale: false,
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

function installSoloChat({
    chat = soloChat(),
    continuity = priorContinuity(),
    settings = {},
    groupId,
} = {}) {
    const ctx = installSummaryContext({
        chat,
        metadata: { summaryception: makeSummaryStore({ continuity }) },
        settings: { continuityEnabled: true, ...settings },
        ...(groupId !== undefined ? { groupId } : {}),
    });
    return ctx;
}

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

    it('stays idle when no assistant message follows the anchor', async () => {
        installSoloChat({ chat: soloChat().slice(0, 4) });
        const outcome = await runAuditorExtraction();
        expect(outcome.status).toBe('idle');
        expect(callSummarizer).not.toHaveBeenCalled();
    });

    it('audits the latest exchange and applies flags through the JS rulebook', async () => {
        const ctx = installSoloChat();
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: auditorJson({ 'Quipsy↔User': { positive_interaction: true } }),
        });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('completed');
        expect(callSummarizer).toHaveBeenCalledTimes(1);
        const continuity = ctx.chatMetadata.summaryception.continuity;
        expect(continuity.turn_count).toBe(3);
        expect(continuity.anchor_sc_id).toBe('a3');
        // sparks +1 from the flag; grudge decays on turnCount % 3; bond untouched.
        expect(continuity.bonds['Quipsy↔User']).toEqual({ bond: 10, sparks: 7, grudge: 0 });
        expect(continuity.stale).toBe(false);
        expect(continuity.gm_notes).toEqual(['[T] Keep this thread']);
        expect(continuity.physics.location).toBe('Salon');
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
        const ctx = installSoloChat({ chat, continuity: priorContinuity({ anchor_sc_id: '' }) });
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: auditorJson(),
        });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('completed');
        expect(callSummarizer).toHaveBeenCalledTimes(1);
        const storyTxt = callSummarizer.mock.calls[0][0];
        expect(storyTxt).toContain('a6');
        expect(storyTxt).toContain('u3');
        expect(storyTxt).not.toContain('u2');
        // turn_count is derived from the chat, not the window.
        expect(ctx.chatMetadata.summaryception.continuity.turn_count).toBe(6);
        expect(ctx.chatMetadata.summaryception.continuity.anchor_sc_id).toBe('a6');
    });

    it('re-derives turn_count from the chat start after a swipe rewind', async () => {
        const chat = soloChat().slice(0, 4);
        const ctx = installSoloChat({ chat, continuity: priorContinuity() });

        rewindContinuityAnchor(chat[3]);

        callSummarizer.mockResolvedValue({ status: 'completed', text: auditorJson() });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('completed');
        expect(ctx.chatMetadata.summaryception.continuity.anchor_sc_id).toBe('a2');
        expect(ctx.chatMetadata.summaryception.continuity.turn_count).toBe(2);
    });

    it('keeps the user line when a system message sits between the turns', async () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u1' }),
            makeMessage({ scId: 'a1' }),
            makeMessage({ isUser: true, scId: 'u2' }),
            makeMessage({ isSystem: true, scId: 's1' }),
            makeMessage({ scId: 'a2' }),
        ];
        installSoloChat({ chat, continuity: priorContinuity({ anchor_sc_id: 'a1' }) });
        callSummarizer.mockResolvedValue({ status: 'completed', text: auditorJson() });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('completed');
        const storyTxt = callSummarizer.mock.calls[0][0];
        expect(storyTxt).toContain('[u2]');
        expect(storyTxt).toContain('[a2]');
        expect(storyTxt).not.toContain('[s1]');
    });

    it('feeds the prior state JSON and macro memory as context', async () => {
        installSoloChat();
        callSummarizer.mockResolvedValue({ status: 'completed', text: auditorJson() });

        await runAuditorExtraction();

        const contextStr = callSummarizer.mock.calls[0][1];
        expect(contextStr).toContain('"Quipsy↔User"');
        expect(contextStr).toContain('10');
    });

    it('runs at most one section-aware repair retry and accepts the repair', async () => {
        const ctx = installSoloChat();
        callSummarizer
            .mockResolvedValueOnce({ status: 'completed', text: '{"turn_count": 3,' })
            .mockResolvedValueOnce({
                status: 'completed',
                text: auditorJson({ 'Quipsy↔User': { positive_interaction: true } }),
            });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('completed');
        expect(callSummarizer).toHaveBeenCalledTimes(2);
        // The section-aware repair text rides the metadata channel, not the
        // prior-state context block, and names the failing section.
        const repairMetadata = callSummarizer.mock.calls[1][2];
        expect(repairMetadata.auditorRepair).toContain('summaryception_auditor_repair_feedback');
        expect(repairMetadata.auditorRepair).toContain('JSON object: rejected.');
        expect(repairMetadata.auditorRepair).toContain(
            'The previous reply was not valid JSON. Reply with the complete JSON state object only.',
        );
        expect(callSummarizer.mock.calls[1][1]).not.toContain(
            'summaryception_auditor_repair_feedback',
        );
        const continuity = ctx.chatMetadata.summaryception.continuity;
        expect(continuity.anchor_sc_id).toBe('a3');
        expect(continuity.stale).toBe(false);
    });

    it('bumps the store mutation epoch after applying an audit', async () => {
        const ctx = installSoloChat();
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: auditorJson({ 'Quipsy↔User': { positive_interaction: true } }),
        });

        await runAuditorExtraction();

        expect(ctx.chatMetadata.summaryception.mutationEpoch).toBe(1);
    });

    it('bumps the store mutation epoch when the audit freezes', async () => {
        const ctx = installSoloChat();
        callSummarizer.mockResolvedValue({ status: 'completed', text: 'not json' });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('failed');
        expect(ctx.chatMetadata.summaryception.mutationEpoch).toBe(1);
        expect(ctx.chatMetadata.summaryception.continuity.stale).toBe(true);
    });

    it('freezes the previous state with a stale marker when the repair also fails', async () => {
        installSoloChat();
        callSummarizer
            .mockResolvedValueOnce({ status: 'completed', text: 'not json' })
            .mockResolvedValueOnce({ status: 'completed', text: 'still not json' });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('failed');
        expect(callSummarizer).toHaveBeenCalledTimes(2);
        const store = globalThis.SillyTavern.getContext().chatMetadata.summaryception;
        expect(store.continuity.turn_count).toBe(2);
        expect(store.continuity.anchor_sc_id).toBe('a2');
        expect(store.continuity.bonds['Quipsy↔User']).toEqual({ bond: 10, sparks: 6, grudge: 1 });
        expect(store.continuity.stale).toBe(true);
    });

    it('freezes the previous state after an API failure', async () => {
        installSoloChat();
        callSummarizer.mockResolvedValue({ status: 'failed', attempts: 4 });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('failed');
        expect(callSummarizer).toHaveBeenCalledTimes(1);
        const store = globalThis.SillyTavern.getContext().chatMetadata.summaryception;
        expect(store.continuity.turn_count).toBe(2);
        expect(store.continuity.stale).toBe(true);
    });

    it('clears the stale marker on success', async () => {
        installSoloChat({ continuity: priorContinuity({ stale: true }) });
        callSummarizer.mockResolvedValue({ status: 'completed', text: auditorJson() });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('completed');
        const continuity =
            globalThis.SillyTavern.getContext().chatMetadata.summaryception.continuity;
        expect(continuity.stale).toBe(false);
    });

    it('drops the write when the chat switches mid-audit', async () => {
        const ctx = installSoloChat();
        callSummarizer.mockImplementation(async () => {
            ctx.chat = [...ctx.chat, makeMessage({ scId: 'a4' })];
            return { status: 'completed', text: auditorJson() };
        });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('aborted');
        const store = ctx.chatMetadata.summaryception;
        expect(store.continuity.anchor_sc_id).toBe('a2');
        expect(store.continuity.stale).toBe(false);
    });

    it('writes no stale marker when the chat switched before the freeze', async () => {
        const ctx = installSoloChat();
        // The request throws after the chat already switched: the catch path
        // freezes without a prior identity check.
        callSummarizer.mockImplementation(async () => {
            ctx.chat = [...ctx.chat, makeMessage({ scId: 'a4' })];
            throw new Error('connection lost');
        });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('aborted');
        expect(ctx.chatMetadata.summaryception.continuity.stale).toBe(false);
    });

    it('aborts an in-flight audit on a foreground generation start but ignores quiet', async () => {
        const ctx = installSoloChat();
        let release;
        callSummarizer.mockReturnValue(
            new Promise((resolve) => {
                release = resolve;
            }),
        );

        const run = runAuditorExtraction();
        abortActiveAuditorRun('quiet');
        release({ status: 'completed', text: auditorJson() });
        expect((await run).status).toBe('completed');

        // The completed first run re-pointed the anchor to a3; a fresh
        // exchange arrives so the second audit actually has work to do.
        ctx.chat = [
            ...ctx.chat,
            makeMessage({ isUser: true, scId: 'u4' }),
            makeMessage({ scId: 'a4' }),
        ];
        let secondRelease;
        callSummarizer.mockReset();
        callSummarizer.mockReturnValue(
            new Promise((resolve) => {
                secondRelease = resolve;
            }),
        );
        const secondRun = runAuditorExtraction();
        abortActiveAuditorRun('swipe');
        secondRelease({ status: 'completed', text: auditorJson() });
        expect((await secondRun).status).toBe('aborted');
        const continuity =
            globalThis.SillyTavern.getContext().chatMetadata.summaryception.continuity;
        expect(continuity.anchor_sc_id).toBe('a3');
    });

    it('keeps the abort slot of a later run when an earlier run settles first', async () => {
        const ctx = installSoloChat();
        let releaseFirst;
        let releaseSecond;
        callSummarizer
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        releaseFirst = resolve;
                    }),
            )
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        releaseSecond = resolve;
                    }),
            );

        const first = runAuditorExtraction();
        const second = runAuditorExtraction();
        releaseFirst({ status: 'failed', attempts: 4 });
        expect(await first).toEqual({ status: 'failed' });

        // The first run settled; its teardown must not clear the second run's
        // slot, or this generation-start abort silently misses.
        abortActiveAuditorRun('swipe');
        releaseSecond({ status: 'completed', text: auditorJson() });
        expect((await second).status).toBe('aborted');
        expect(ctx.chatMetadata.summaryception.continuity.anchor_sc_id).toBe('a2');
    });
});

describe('rewindContinuityAnchor', () => {
    it('rewinds the anchor to the closest preceding assistant message on a swipe', () => {
        const ctx = installSoloChat();

        rewindContinuityAnchor(ctx.chat[3]);

        expect(ctx.chatMetadata.summaryception.continuity.anchor_sc_id).toBe('a1');
    });

    it('resets to cold start when no assistant message precedes the anchor', () => {
        const chat = [makeMessage({ isUser: true, scId: 'u1' }), makeMessage({ scId: 'a2' })];
        const ctx = installSoloChat({ chat, continuity: priorContinuity({ anchor_sc_id: 'a2' }) });

        rewindContinuityAnchor(chat[1]);

        expect(ctx.chatMetadata.summaryception.continuity.anchor_sc_id).toBe('');
    });

    it('treats a repeat swipe of the same message as a no-op', () => {
        const ctx = installSoloChat();

        rewindContinuityAnchor(ctx.chat[3]);
        rewindContinuityAnchor(ctx.chat[3]);

        expect(ctx.chatMetadata.summaryception.continuity.anchor_sc_id).toBe('a1');
        expect(ctx.chatMetadata.summaryception.mutationEpoch).toBe(1);
    });

    it('bumps the store mutation epoch and persists when the anchor rewinds', () => {
        const saves = [];
        const ctx = installSoloChat();
        ctx.saveMetadata = async () => {
            saves.push('metadata');
        };

        rewindContinuityAnchor(ctx.chat[3]);

        expect(ctx.chatMetadata.summaryception.mutationEpoch).toBe(1);
        expect(saves).toEqual(['metadata']);
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
        expect(request.systemPrompt).toBe(defaultSettings.auditorSystemPrompt);
        expect(request.prompt).toContain('PRIOR STATE');
        expect(request.prompt).toContain('USER TURN');
        expect(request.repairPrompt).toBe('');
    });

    it('places auditor repair feedback above the execution trigger, outside the context block', async () => {
        installSoloChat();
        const feedback =
            '<summaryception_auditor_repair_feedback>parse repair: emit JSON.</summaryception_auditor_repair_feedback>';
        const request = await buildSummarizerPipelineInput({
            storyTxt: 'USER TURN',
            contextStr: 'PRIOR STATE',
            metadata: { kind: 'auditor', auditorRepair: feedback },
        });
        const feedbackAt = request.prompt.indexOf(feedback);
        const triggerAt = request.prompt.indexOf(EXECUTION_TRIGGER_AUDITOR);
        expect(feedbackAt).toBeGreaterThanOrEqual(0);
        expect(triggerAt).toBeGreaterThanOrEqual(0);
        expect(feedbackAt).toBeLessThan(triggerAt);
        expect(request.prompt.trimEnd().endsWith(EXECUTION_TRIGGER_AUDITOR)).toBe(true);
        // The repair block must not land inside <prior_continuity_state>.
        expect(request.prompt.indexOf('PRIOR STATE')).toBeLessThan(feedbackAt);
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
        expect(console.groupCollapsed).toHaveBeenCalledTimes(1);
        expect(console.groupCollapsed.mock.calls[0][0]).toContain('[Summaryception]');
        expect(console.groupEnd).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(console.log.mock.calls[0][0]);
        expect(payload.type).toBe('summaryception.continuity.audit.v1');
        expect(payload.kind).toBe('success');
        expect(payload.changes.turn_count).toEqual([2, 3]);
        expect(payload.changes.anchor_sc_id).toEqual(['a2', 'a3']);
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

        const payload = JSON.parse(console.log.mock.calls[0][0]);
        expect(payload.kind).toBe('success');
        expect(payload.state.turn_count).toBe(3);
        expect(payload.state.bonds['Quipsy↔User']).toEqual({ bond: 10, sparks: 7, grudge: 0 });
        expect(payload.changes).toBeUndefined();
    });

    it('logs a freeze group with the failure status and stale marker', async () => {
        installSoloChat();
        logger.isContinuityStateLogEnabled.mockReturnValue(true);
        callSummarizer.mockResolvedValue({ status: 'completed', text: 'not json' });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('failed');
        expect(console.groupCollapsed).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(console.log.mock.calls[0][0]);
        expect(payload).toEqual({
            type: 'summaryception.continuity.audit.v1',
            kind: 'freeze',
            status: 'failed',
            stale: true,
            turn_count: 2,
            anchor_sc_id: 'a2',
        });
    });

    it('logs a rewind group when a swipe rewinds the anchor', () => {
        const ctx = installSoloChat();
        logger.isContinuityStateLogEnabled.mockReturnValue(true);

        rewindContinuityAnchor(ctx.chat[3]);

        expect(console.groupCollapsed).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(console.log.mock.calls[0][0]);
        expect(payload).toEqual({
            type: 'summaryception.continuity.audit.v1',
            kind: 'rewind',
            from: 'a2',
            to: 'a1',
        });
    });

    it('logs nothing when the continuity state log flag is off', async () => {
        const ctx = installSoloChat();
        logger.isContinuityStateLogEnabled.mockReturnValue(false);
        callSummarizer.mockResolvedValue({ status: 'completed', text: 'not json' });

        await runAuditorExtraction();
        rewindContinuityAnchor(ctx.chat[3]);

        expect(console.groupCollapsed).not.toHaveBeenCalled();
        expect(console.log).not.toHaveBeenCalled();
    });
});
