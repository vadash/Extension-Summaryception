import { readFileSync } from 'node:fs';
import {
    EXTENSION_PROMPT_POSITIONS,
    EXTENSION_PROMPT_ROLES,
    MEMORY_MODES,
    MEMORY_MODE_PRESETS,
    SLIDER_LIMITS,
    defaultSettings,
} from '../src/foundation/constants.js';
import { installMicroficheFonts } from '../src/core/microfiche-font-cache.js';
import { MICROFICHE_FONT_FILES, parseMicroficheFont } from '../src/core/microfiche-fonts.js';
import { createForegroundGate } from '../src/core/foreground-gate.js';
import { initChatPersistence } from '../src/core/persist-state.js';
import { createMemoryInjectionWriter } from '../src/features/injection.js';
import { vi } from 'vitest';

/**
 * Shared test helpers for SillyTavern extension unit tests.
 * Provides a minimal stub of the SillyTavern.getContext() contract
 * so modules can be tested without the browser runtime.
 */

let nextMessageId = 0;

/**
 * Parse the bundled bitmap fonts from disk and install them for the
 * synchronous draw and normalize paths. Tests call this once per file because
 * vitest isolates each file's module graph.
 * @returns {Record<string, import('../src/core/microfiche-fonts.js').MicroficheFont>} Installed fonts.
 */
export function installTestMicroficheFonts() {
    const fonts = Object.fromEntries(
        Object.entries(MICROFICHE_FONT_FILES).map(([name, file]) => [
            name,
            parseMicroficheFont(
                name,
                readFileSync(new URL(`../fonts/${file}`, import.meta.url), 'utf8'),
            ),
        ]),
    );
    installMicroficheFonts(fonts);
    return fonts;
}

/**
 * Build one Foreground Gate for a test, with recorded collaborators and an
 * injectable clock so the freeze grace window stays deterministic.
 * @param {{ now?: () => number }} [overrides]
 * @returns {{ gate: import('../src/core/foreground-gate.js').ForegroundGate, reassertInjection: import('vitest').Mock, requeue: import('vitest').Mock }}
 */
export function makeForegroundGate({ now } = {}) {
    const reassertInjection = vi.fn();
    const requeue = vi.fn();
    const gate = createForegroundGate({ reassertInjection, requeue, ...(now ? { now } : {}) });
    return { gate, reassertInjection, requeue };
}

/**
 * Initialize Chat Persistence with recorded host saves for one test.
 * @returns {{ saveChat: import('vitest').Mock, saveMetadata: import('vitest').Mock }}
 */
export function makeChatPersistence() {
    const saveChat = vi.fn(async () => {});
    const saveMetadata = vi.fn(async () => {});
    initChatPersistence({ saveChat, saveMetadata });
    return { saveChat, saveMetadata };
}

/**
 * Build one Memory Injection writer for a test, so the last-written key and
 * the committed snapshot stay isolated from other tests' instances.
 * @param {Parameters<typeof createMemoryInjectionWriter>[0]} [deps] - Injected canvas source, if the test renders pages.
 * @returns {ReturnType<typeof createMemoryInjectionWriter>}
 */
export function makeMemoryInjectionWriter(deps) {
    return createMemoryInjectionWriter(deps);
}

/**
 * Expected slot options for the shipped default placement: the host's deepest
 * chat slot, which lands after every preset block and before chat text.
 * @returns {{ position: number, depth: number, scan: boolean, role: number }}
 */
export function defaultSlotOptions() {
    return {
        position: EXTENSION_PROMPT_POSITIONS.IN_CHAT,
        depth: SLIDER_LIMITS.customMemoryDepth.MAX,
        scan: false,
        role: EXTENSION_PROMPT_ROLES.SYSTEM,
    };
}

/**
 * Read the slot options out of a recorded setExtensionPrompt call.
 * @param {import('vitest').Mock} setExtensionPrompt - Host setter mock.
 * @param {number} [callIndex] - Recorded call to read.
 * @returns {{ position: number, depth: number, scan: boolean, role: number }}
 */
export function injectedSlotOptions(setExtensionPrompt, callIndex = 0) {
    const [, , position, depth, scan, role] = setExtensionPrompt.mock.calls[callIndex];
    return { position, depth, scan, role };
}

/**
 * Build one Usage Ledger for a test, so run-scope state stays isolated from
 * other tests' instances.
 * Loaded lazily so files that never record usage keep their module graph
 * free of the summarizer stack.
 * @returns {Promise<import('../src/core/summarizer-usage.js').UsageLedger>}
 */
export async function makeUsageLedger() {
    const { createUsageLedger } = await import('../src/core/summarizer-usage.js');
    return createUsageLedger();
}

/**
 * Build one Summarizer Dispatch for a test, so live-request state stays
 * isolated from other tests' instances. Tests fake the transport
 * (`sendSummarizerRequest`) through their own `vi.mock` of
 * `src/core/connectionutil.js`, so the real call walk runs end to end.
 * Loaded lazily so files that never build a dispatch keep their module graph
 * free of the request stack. The dispatch builds its own Usage Ledger, so
 * every test dispatch records into an isolated instance.
 * @returns {Promise<import('../src/core/summarizer-request.js').SummarizerDispatch>}
 */
export async function makeSummarizerDispatch() {
    const [{ createSummarizerDispatch }, { createUsageLedger }] = await Promise.all([
        import('../src/core/summarizer-request.js'),
        import('../src/core/summarizer-usage.js'),
    ]);
    return createSummarizerDispatch({ usage: createUsageLedger() });
}

export function makeMessage(options = {}) {
    const {
        isUser = false,
        isSystem = false,
        isHidden = false,
        mes = 'Hello, world.',
        name = 'Assistant',
        sendDate,
    } = options;
    const scId = Object.hasOwn(options, 'scId') ? options.scId : `message-${nextMessageId++}`;
    const message = {
        sc_id: scId,
        is_user: isUser,
        is_system: isSystem,
        is_hidden: isHidden,
        mes,
        name,
        extra: {},
    };
    if (sendDate !== undefined) {
        message.send_date = sendDate;
    }
    return message;
}

export function makeMessages(count, options = {}) {
    return Array.from({ length: count }, (_value, index) => {
        const messageOptions = typeof options === 'function' ? options(index) : options;
        return makeMessage({ scId: `message-${index}`, ...messageOptions });
    });
}

/** Build repeated long assistant messages for budget-window tests. */
export function makeLongMessages(count, length = 3000) {
    return makeMessages(count, { mes: 'x'.repeat(length) });
}

/** Build an oldest-first raw-chat slice of long messages for frozen-raw imaging tests. */
export function makeRawChatSlice(count) {
    return Array.from(
        { length: count },
        (_value, index) => `Message ${index} ` + 'lorem ipsum dolor sit amet '.repeat(600),
    );
}

/** Build alternating user/assistant chat with fixed message sizes, ending on an assistant turn. */
export function makeSizedChat(turnCount, { userLength = 100, assistantLength = 100 } = {}) {
    return Array.from({ length: Math.max(0, turnCount) * 2 }, (_value, index) =>
        makeMessage({
            isUser: index % 2 === 0,
            mes: 'x'.repeat(index % 2 === 0 ? userLength : assistantLength),
        }),
    );
}

/**
 * Predict a message's token count under the default String-length test tokenizer.
 * Mirrors the "Player: "/"Assistant: " line format used by the planner modules.
 * This is the single coupling point if speaker names ever change.
 */
export function messageLineTokens(isUser, mesLength) {
    return (isUser ? 'Player: ' : 'Assistant: ').length + mesLength;
}

/** Baseline summarization settings; every preset helper overrides it. */
export function makeSummarySettings(overrides = {}) {
    return {
        enabled: true,
        uiMode: 'advanced',
        memoryMode: 'balanced',
        atomicPartitions: false,
        customMemoryPosition: defaultSettings.customMemoryPosition,
        customMemoryRole: defaultSettings.customMemoryRole,
        customMemoryDepth: defaultSettings.customMemoryDepth,
        applyRegexScripts: false,
        hideNonTextMessages: true,
        maxSummaryTurns: 5,
        minSummaryBudget: 6000,
        verbatimTokenBudget: 16000,
        queuedTokenBudget: 6000,
        memoryTokenBudget: 10000,
        snippetsPerLayer: 24,
        snippetsPerPromotion: 3,
        ...overrides,
    };
}

/** Settings preset for provider prefix-cache / stale-advice tests. */
export function cacheSettings(overrides = {}) {
    return makeSummarySettings({
        memoryMode: MEMORY_MODES.PREFIX_CACHE,
        atomicPartitions: true,
        cacheTtlMinutes: 30,
        minSummaryTurns: 3,
        ...overrides,
    });
}

/** Settings preset with tight budgets for chat-window planner tests. */
export function windowSettings(overrides = {}) {
    return makeSummarySettings({
        verbatimTokenBudget: 200,
        queuedTokenBudget: 200,
        minSummaryBudget: 200,
        maxL0SourceTokens: 400,
        minSummaryTurns: 1,
        ...overrides,
    });
}

/** Settings preset that is immediately ready to summarize, per memory mode. */
export function readySettings(memoryMode) {
    return makeSummarySettings({
        memoryMode,
        atomicPartitions: MEMORY_MODE_PRESETS[memoryMode]?.atomicPartitions === true,
        verbatimTokenBudget: 100,
        queuedTokenBudget: 500,
        minSummaryBudget: 3000,
        maxL0SourceTokens: 4000,
        minSummaryTurns: 1,
    });
}

/** Build a normalized Summaryception metadata store. */
export function makeSummaryStore(overrides = {}) {
    return {
        layers: [],
        ghostedMessageIds: [],
        mutationEpoch: 0,
        ...overrides,
    };
}

export function makeToastrMock() {
    return {
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        clear: vi.fn(),
    };
}

/**
 * Build a silent notify adapter that records every structured event
 * (ADR-0019 seam). Events are flat records: `type` plus the structured payload.
 * @returns {{ events: Array<object>, transient: (event: object) => void, progress: (event: object) => object, update: (handle: unknown, event: object) => void, clear: (handle: unknown, event?: object) => void }}
 */
export function makeNotifyRecorder() {
    const events = [];
    let nextHandleId = 0;
    return {
        events,
        transient(event) {
            events.push({ type: 'transient', ...event });
        },
        progress(event) {
            const handle = { id: ++nextHandleId };
            events.push({ type: 'progress', label: event.label, total: event.total, handle });
            return handle;
        },
        update(handle, event) {
            events.push({ type: 'update', handle, processed: event.processed });
        },
        clear(handle, event) {
            events.push({ type: 'clear', handle, event });
        },
    };
}

/** Install minimal browser globals expected by entry/UI-adjacent modules. */
export function installBrowserRuntimeStub(opts = {}) {
    const toastr = makeToastrMock();
    const $ =
        opts.$ ||
        vi.fn(() => ({
            find: () => ({ text: vi.fn() }),
            length: 1,
        }));
    globalThis.toastr = toastr;
    globalThis.$ = $;
    return { toastr, $ };
}

/** Build a reusable jQuery-like harness for UI unit tests. */
export function createJQueryHarness({ attributes = {}, collections = {} } = {}) {
    const handlers = [];
    const elements = new Map();
    const nodeElements = new Map();
    const visibility = new Map();

    const element = (selector) => {
        if (!elements.has(selector)) {
            const wrapper = createJQueryHarnessElement({
                selector,
                attributes: attributes[selector],
                handlers,
                visibility,
            });
            elements.set(selector, wrapper);
            for (const node of wrapper.nodes) {
                nodeElements.set(node, wrapper);
            }
        }
        return elements.get(selector);
    };

    const documentWrapper = {
        on(eventNames, selector, handler) {
            for (const eventName of splitEventNames(eventNames)) {
                handlers.push({ type: 'delegated', eventName, selector, handler });
            }
            return documentWrapper;
        },
    };

    const $ = vi.fn((target) => {
        if (target === globalThis.document) {
            return documentWrapper;
        }
        if (nodeElements.has(target)) {
            return nodeElements.get(target);
        }
        if (target?.__summaryceptionJqueryHarness) {
            return target;
        }
        if (typeof target === 'string') {
            if (Object.hasOwn(collections, target)) {
                return createJQueryHarnessCollection(collections[target].map(element));
            }
            const selectors = String(target)
                .split(',')
                .map((part) => part.trim())
                .filter(Boolean);
            if (selectors.length > 1) {
                return createJQueryHarnessCollection(selectors.map(element));
            }
            if (target.startsWith('<')) {
                return createJQueryHarnessElement({
                    selector: target,
                    handlers,
                    visibility,
                });
            }
            return element(target);
        }
        return target;
    });

    return {
        $,
        element,
        elements,
        visibility,
        trigger(eventName, selector, target = element(selector)) {
            const entry = handlers.find(
                (handler) =>
                    handler.eventName === eventName &&
                    handler.selector === selector &&
                    (handler.type === 'delegated' || handler.type === 'direct'),
            );
            if (!entry) {
                throw new Error(`No handler registered for ${eventName} ${selector}`);
            }
            return entry.handler.call(target, { type: eventName });
        },
    };
}

/** Build a stub SillyTavern context with configurable chat and metadata. */
export function makeContext({
    chat = [],
    metadata = {},
    settings = {},
    executeSlashCommandsWithOptions = async () => {},
    saveChat,
    setExtensionPrompt = () => {},
    getTokenCountAsync,
    ...rest
} = {}) {
    const ctx = {
        chat,
        chatMetadata: metadata,
        extensionSettings: { summaryception: settings },
        name1: 'Player1',
        saveSettingsDebounced: () => {},
        saveMetadata: async () => {},
        executeSlashCommandsWithOptions,
        setExtensionPrompt,
        ...rest,
    };
    if (saveChat) {
        ctx.saveChat = saveChat;
    }
    if (getTokenCountAsync) {
        ctx.getTokenCountAsync = getTokenCountAsync;
    }
    return ctx;
}

/** Install a fresh SillyTavern stub and return its context. */
export function installSillyTavernStub(opts = {}) {
    const ctx = makeContext(opts);
    globalThis.SillyTavern = {
        getContext: () => ctx,
    };
    return ctx;
}

/** Install a Summaryception-ready SillyTavern context. */
export function installSummaryContext(opts = {}) {
    const { chat = [], metadata, settings = {}, getTokenCountAsync, ...rest } = opts;
    return installSillyTavernStub({
        chat,
        metadata: metadata || { summaryception: makeSummaryStore() },
        settings: makeSummarySettings(settings),
        getTokenCountAsync: getTokenCountAsync || (async (text) => String(text || '').length),
        ...rest,
    });
}

/**
 * Install a context whose Layer 0 exceeds its token quota (24 ~150-char
 * snippets vs. a 2400-token quota under the length-based test tokenizer).
 */
export function installOverflowingStore() {
    const snippets = Array.from({ length: 24 }, (_, i) => ({
        text: `[NARRATIVE]\nScene ${i}: ${'memory detail '.repeat(10)}`,
        sourceMessageIds: [`msg-${i}`],
    }));
    installSummaryContext({
        metadata: { summaryception: makeSummaryStore({ layers: [snippets] }) },
        settings: makeSummarySettings({ memoryTokenBudget: 4000 }),
    });
}

/** Build a deferred promise for async coalescing tests. */
export function deferred() {
    /** @type {(value?: unknown) => void} */
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

/** Count whitespace-delimited tokens in a test-friendly way. */
export function countTokens(text) {
    const trimmed = String(text || '').trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}

function createJQueryHarnessCollection(wrappers) {
    const nodes = wrappers.flatMap((wrapper) => wrapper.nodes);
    const ids = wrappers.flatMap((wrapper) => wrapper.ids);
    const api = {
        __summaryceptionJqueryHarness: true,
        nodes,
        ids,
        length: nodes.length,
        0: nodes[0],
        add(other) {
            return createJQueryHarnessCollection([...wrappers, other]);
        },
        each(callback) {
            wrappers.forEach((wrapper, index) => {
                callback.call(wrapper[0], index, wrapper[0]);
            });
            return api;
        },
        hide() {
            for (const wrapper of wrappers) {
                wrapper.hide();
            }
            return api;
        },
        show() {
            for (const wrapper of wrappers) {
                wrapper.show();
            }
            return api;
        },
        toggle(value) {
            for (const wrapper of wrappers) {
                wrapper.toggle(value);
            }
            return api;
        },
    };
    return api;
}

function createJQueryHarnessElement({ selector, attributes = {}, handlers, visibility }) {
    const id = selector.startsWith('#') ? selector.slice(1) : selector;
    const state = {
        value: '',
        html: '',
        text: '',
        props: {},
        attrs: { ...attributes },
        css: {},
        children: [],
        visible: true,
        classes: new Set(),
    };
    const node = { id };
    const api = {
        __summaryceptionJqueryHarness: true,
        0: node,
        nodes: [node],
        ids: id ? [id] : [],
        length: 1,
        on(eventNames, handler) {
            for (const eventName of splitEventNames(eventNames)) {
                handlers.push({ type: 'direct', eventName, selector, handler });
            }
            return api;
        },
        each(callback) {
            callback.call(node, 0, node);
            return api;
        },
        val(nextValue) {
            if (arguments.length === 0) {
                return state.value;
            }
            state.value = nextValue;
            return api;
        },
        prop(name, nextValue) {
            if (arguments.length === 1) {
                return state.props[name];
            }
            state.props[name] = nextValue;
            return api;
        },
        is(selector) {
            return selector === ':checkbox' && state.attrs.type === 'checkbox';
        },
        attr(name, nextValue) {
            if (arguments.length === 1) {
                return state.attrs[name];
            }
            state.attrs[name] = nextValue;
            return api;
        },
        html(nextValue) {
            if (arguments.length === 0) {
                return state.html;
            }
            state.html = nextValue;
            return api;
        },
        text(nextValue) {
            if (arguments.length === 0) {
                return state.text;
            }
            state.text = nextValue;
            return api;
        },
        css(name, nextValue) {
            if (arguments.length === 1) {
                return state.css[name];
            }
            state.css[name] = nextValue;
            return api;
        },
        append(child) {
            state.children.push(child);
            return api;
        },
        appendTo(parent) {
            parent.append(api);
            return api;
        },
        empty() {
            state.children = [];
            state.text = '';
            state.html = '';
            return api;
        },
        addClass(classNames) {
            for (const className of splitClassNames(classNames)) {
                state.classes.add(className);
            }
            return api;
        },
        removeClass(classNames) {
            for (const className of splitClassNames(classNames)) {
                state.classes.delete(className);
            }
            return api;
        },
        toggleClass(className, force) {
            const shouldAdd = force === undefined ? !state.classes.has(className) : Boolean(force);
            if (shouldAdd) {
                state.classes.add(className);
            } else {
                state.classes.delete(className);
            }
            return api;
        },
        hasClass(className) {
            return state.classes.has(className);
        },
        add(other) {
            return createJQueryHarnessCollection([api, other]);
        },
        hide() {
            setVisible(false);
            return api;
        },
        show() {
            setVisible(true);
            return api;
        },
        toggle(value) {
            setVisible(Boolean(value));
            return api;
        },
        getValue() {
            return state.value;
        },
        isVisible() {
            return state.visible;
        },
    };

    function setVisible(value) {
        state.visible = value;
        for (const visibleId of api.ids) {
            visibility.set(visibleId, value);
        }
    }

    return api;
}

function splitEventNames(eventNames) {
    return String(eventNames).split(/\s+/).filter(Boolean);
}

function splitClassNames(classNames) {
    return String(classNames).split(/\s+/).filter(Boolean);
}
