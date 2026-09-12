import { MEMORY_MODES } from '../src/foundation/constants.js';
import { vi } from 'vitest';

/**
 * Shared test helpers for SillyTavern extension unit tests.
 * Provides a minimal stub of the SillyTavern.getContext() contract
 * so modules can be tested without the browser runtime.
 */

let nextMessageId = 0;

/** Build a stub chat message. */
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
 *  Mirrors the "Player: "/"Assistant: " line format used by the planner modules;
 *  this is the single coupling point if speaker names ever change.
 */
export function messageLineTokens(isUser, mesLength) {
    return (isUser ? 'Player: ' : 'Assistant: ').length + mesLength;
}

/** Build common summarization settings with overrides. */
export function makeSummarySettings(overrides = {}) {
    return {
        enabled: true,
        uiMode: 'advanced',
        memoryMode: 'balanced',
        customMemoryPosition: 'in_prompt',
        customMemoryRole: 'system',
        customMemoryDepth: 0,
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

/** Build a mock toastr global. */
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
 * (ADR-0004 seam). Events are flat records: `type` plus the structured payload.
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
