import { beforeEach, vi } from 'vitest';

const foundationMocks = vi.hoisted(() => {
    const MODULE_NAME = 'summaryception';
    const LOG_PREFIX = '[Summaryception]';
    const defaultDebugSettings = {
        debugMode: false,
        traceMode: false,
        promptInputLogMode: false,
        promptOutputLogMode: false,
    };

    function getContext() {
        return globalThis.SillyTavern.getContext();
    }

    function getDebugSettings() {
        try {
            const extensionSettings = getContext().extensionSettings;
            return extensionSettings[MODULE_NAME] || defaultDebugSettings;
        } catch {
            return defaultDebugSettings;
        }
    }

    const context = {
        getContext: vi.fn(),
        getChat: vi.fn(),
        getChatMetadata: vi.fn(),
        getExtensionSettings: vi.fn(),
        getName1: vi.fn(),
        saveSettingsDebounced: vi.fn(),
        saveMetadata: vi.fn(),
        saveChat: vi.fn(),
        executeSlashCommandsWithOptions: vi.fn(),
        setExtensionPrompt: vi.fn(),
        generateRaw: vi.fn(),
        callTokenCountAsync: vi.fn(),
        estimateMainPromptTokens: vi.fn(),
        getRequestHeaders: vi.fn(),
        getPromptManager: vi.fn(),
        getConnectionManagerRequestService: vi.fn(),
        getSlashCommandParser: vi.fn(),
        getSlashCommand: vi.fn(),
        getEventSource: vi.fn(),
        getEventTypes: vi.fn(),
        getStreamingProcessor: vi.fn(),
        isSendButtonInStopMode: vi.fn(),
    };

    const logger = {
        isDebugEnabled: vi.fn(),
        isTraceEnabled: vi.fn(),
        isPromptInputLogEnabled: vi.fn(),
        isPromptOutputLogEnabled: vi.fn(),
        isPromptLogEnabled: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debugVisibleTurns: vi.fn(),
    };

    function resetContext() {
        context.getContext.mockImplementation(getContext);
        context.getChat.mockImplementation(() => getContext().chat);
        context.getChatMetadata.mockImplementation(() => getContext().chatMetadata);
        context.getExtensionSettings.mockImplementation(() => getContext().extensionSettings);
        context.getName1.mockImplementation(() => getContext().name1 || 'User');
        context.saveSettingsDebounced.mockImplementation(() =>
            getContext().saveSettingsDebounced(),
        );
        context.saveMetadata.mockImplementation(async () => {
            await getContext().saveMetadata();
        });
        context.saveChat.mockImplementation(async () => {
            try {
                const fn = getContext().saveChat;
                if (typeof fn === 'function') {
                    await fn();
                }
            } catch {
                // Runtime context unavailable in some tests.
            }
        });
        context.executeSlashCommandsWithOptions.mockImplementation(
            async (command, options = {}) => {
                await getContext().executeSlashCommandsWithOptions(command, options);
            },
        );
        context.setExtensionPrompt.mockImplementation((name, text, options = {}) => {
            const { position = 0, depth = 0, scan = false, role = 0 } = options;
            getContext().setExtensionPrompt(name, text, position, depth, scan, role);
        });
        context.generateRaw.mockImplementation(async (options) => {
            const ctx = getContext();
            if (typeof ctx.generateRaw !== 'function') {
                throw new Error('generateRaw is not available in the current context.');
            }
            return await ctx.generateRaw(options);
        });
        context.callTokenCountAsync.mockImplementation(async (text) => {
            const ctx = getContext();
            if (typeof ctx.getTokenCountAsync !== 'function') {
                throw new Error('getTokenCountAsync is not available in the current context.');
            }
            return await ctx.getTokenCountAsync(text);
        });
        context.estimateMainPromptTokens.mockImplementation(async () => null);
        context.getRequestHeaders.mockImplementation(() => {
            try {
                const fn = getContext().getRequestHeaders;
                if (typeof fn === 'function') {
                    return fn();
                }
            } catch {
                // Fall through to the JSON default.
            }
            return { 'Content-Type': 'application/json' };
        });
        context.getPromptManager.mockImplementation(() => getContext().promptManager || null);
        context.getConnectionManagerRequestService.mockImplementation(
            () => getContext().ConnectionManagerRequestService || null,
        );
        context.getSlashCommandParser.mockImplementation(
            () => getContext().SlashCommandParser || null,
        );
        context.getSlashCommand.mockImplementation(() => getContext().SlashCommand || null);
        context.getEventSource.mockImplementation(() => getContext().eventSource || null);
        context.getEventTypes.mockImplementation(
            () => getContext().eventTypes || getContext().event_types || null,
        );
        context.getStreamingProcessor.mockImplementation(
            () => getContext().streamingProcessor || null,
        );
        context.isSendButtonInStopMode.mockImplementation(() => false);
    }

    function isDebugEnabled() {
        return Boolean(getDebugSettings().debugMode);
    }

    function isTraceEnabled() {
        const settings = getDebugSettings();
        return Boolean(settings.debugMode && settings.traceMode);
    }

    function isPromptInputLogEnabled() {
        return Boolean(getDebugSettings().promptInputLogMode);
    }

    function isPromptOutputLogEnabled() {
        return Boolean(getDebugSettings().promptOutputLogMode);
    }

    function isPromptLogEnabled() {
        return isPromptInputLogEnabled() || isPromptOutputLogEnabled();
    }

    function resetLogger() {
        logger.isDebugEnabled.mockImplementation(isDebugEnabled);
        logger.isTraceEnabled.mockImplementation(isTraceEnabled);
        logger.isPromptInputLogEnabled.mockImplementation(isPromptInputLogEnabled);
        logger.isPromptOutputLogEnabled.mockImplementation(isPromptOutputLogEnabled);
        logger.isPromptLogEnabled.mockImplementation(isPromptLogEnabled);
        logger.info.mockImplementation((...args) => {
            if (isDebugEnabled()) {
                console.log(LOG_PREFIX, ...args);
            }
        });
        logger.debug.mockImplementation((...args) => {
            if (isDebugEnabled()) {
                console.log(LOG_PREFIX, '[DEBUG]', ...args);
            }
        });
        logger.trace.mockImplementation((...args) => {
            if (!isTraceEnabled()) {
                return;
            }
            const normalized = args.map((arg, index) =>
                index === 0 && typeof arg === 'string' ? arg.toUpperCase() : arg,
            );
            console.log(LOG_PREFIX, '[TRACE]', ...normalized);
        });
        logger.warn.mockImplementation((...args) => {
            console.warn(LOG_PREFIX, ...args);
        });
        logger.error.mockImplementation((...args) => {
            console.error(LOG_PREFIX, ...args);
        });
        logger.debugVisibleTurns.mockImplementation((chat, store) => {
            logger.trace('=== DEBUG VISIBLE TURNS ===');
            logger.trace('  store.summarizedUpTo:', store.summarizedUpTo);
            logger.trace('  Total chat messages:', chat.length);
            logger.trace('=== END DEBUG ===');
        });
    }

    function reset() {
        resetContext();
        resetLogger();
    }

    reset();

    return { context, logger, reset };
});

vi.mock('../src/foundation/context.js', () => foundationMocks.context);
vi.mock('../src/foundation/logger.js', () => foundationMocks.logger);

globalThis.summaryceptionFoundationMocks = foundationMocks;

beforeEach(() => {
    foundationMocks.reset();
});
