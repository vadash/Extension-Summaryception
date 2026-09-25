import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindManualRunControls } from '../src/entry/ui-manual-run.js';
import { TOAST_TITLE } from '../src/foundation/constants.js';
import { createJQueryHarness, installSummaryContext, makeToastrMock } from './test-helpers.js';

const summarizerMocks = vi.hoisted(() => ({
    describeManualRun: vi.fn(),
    runManual: vi.fn(),
}));

vi.mock('../src/core/summarizer-engine.js', async (importOriginal) => ({
    ...(await importOriginal()),
    describeManualRun: summarizerMocks.describeManualRun,
    runManual: summarizerMocks.runManual,
}));

/** A Summarizer Queue with no live work. */
function makeIdleQueue() {
    return { isBusy: () => false, stop: vi.fn() };
}

describe('manual run failure handling', () => {
    const forceIdleHtml = '<i class="fa-solid fa-bolt"></i><span>Force Summarize</span>';
    let dom;
    let button;

    beforeEach(() => {
        installSummaryContext();
        globalThis.toastr = makeToastrMock();
        globalThis.document = {};
        dom = createJQueryHarness();
        globalThis.$ = dom.$;
        summarizerMocks.describeManualRun.mockResolvedValue({ ready: true, backlog: 2 });
        summarizerMocks.runManual.mockRejectedValue(new Error('provider exploded'));
        bindManualRunControls({ notify: null, manualRunnerDeps: { queue: makeIdleQueue() } });
        button = dom.element('#sc_force_summarize');
    });

    afterEach(() => {
        delete globalThis.document;
    });

    it('logs a failed manual run, shows an error toast, and restores the button', async () => {
        await dom.trigger('click', '#sc_force_summarize, #sc_easy_force_summarize', button);

        expect(summarizerMocks.runManual).toHaveBeenCalledTimes(1);
        expect(globalThis.summaryceptionFoundationMocks.logger.error).toHaveBeenCalled();
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.error.mock.calls[0][1]).toBe(TOAST_TITLE);
        expect(button.prop('disabled')).toBe(false);
        expect(button.html()).toBe(forceIdleHtml);
    });
});

describe('manual run outcome notices', () => {
    let dom;
    let button;

    beforeEach(() => {
        installSummaryContext();
        globalThis.toastr = makeToastrMock();
        globalThis.document = {};
        dom = createJQueryHarness();
        globalThis.$ = dom.$;
        summarizerMocks.describeManualRun.mockResolvedValue({ ready: true, backlog: 2 });
        bindManualRunControls({ notify: null, manualRunnerDeps: { queue: makeIdleQueue() } });
        button = dom.element('#sc_force_summarize');
    });

    afterEach(() => {
        delete globalThis.document;
    });

    it('renders the notice the outcome status selects', async () => {
        summarizerMocks.runManual.mockResolvedValue({
            status: 'aborted',
            completed: 1,
            failed: 0,
            totalBatches: 4,
        });

        await dom.trigger('click', '#sc_force_summarize, #sc_easy_force_summarize', button);

        expect(globalThis.toastr.warning.mock.calls[0][0]).toContain('Progress saved');
        expect(globalThis.toastr.success).not.toHaveBeenCalled();
        expect(button.prop('disabled')).toBe(false);
    });

    it('renders the idle notice from the outcome', async () => {
        summarizerMocks.runManual.mockResolvedValue({
            status: 'idle',
            completed: 0,
            failed: 0,
            totalBatches: 0,
        });

        await dom.trigger('click', '#sc_force_summarize, #sc_easy_force_summarize', button);

        const messages = globalThis.toastr.info.mock.calls.map((call) => call[0]);
        expect(messages).toContain('Nothing eligible to summarize.');
    });

    it('stays silent for a status no notice maps', async () => {
        summarizerMocks.runManual.mockResolvedValue({
            status: 'unknown',
            completed: 0,
            failed: 0,
            totalBatches: 0,
        });

        await dom.trigger('click', '#sc_force_summarize, #sc_easy_force_summarize', button);

        expect(globalThis.toastr.success).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });
});
