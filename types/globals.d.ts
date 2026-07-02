/**
 * SillyTavern browser extension globals.
 * Declared here so TypeScript's checkJs can validate their usage across src/.
 */

interface ChatMessage {
    is_user: boolean;
    is_system: boolean;
    is_hidden?: boolean;
    mes?: string;
    extra?: Record<string, unknown>;
    [key: string]: unknown;
}

interface SlashCommandParser {
    addCommandObject(obj: unknown): void;
}

interface SlashCommand {
    fromProps(props: Record<string, unknown>): SlashCommand;
}

interface ChatStore {
    layers: Array<Array<Record<string, unknown>>>;
    summarizedUpTo: number;
    ghostedIndices: number[];
    [key: string]: unknown;
}

interface ExtensionSettings {
    enabled: boolean;
    verbatimTurns: number;
    turnsPerSummary: number;
    snippetsPerLayer: number;
    snippetsPerPromotion: number;
    maxLayers: number;
    injectionTemplate: string;
    summarizerSystemPrompt: string;
    summarizerUserPrompt: string;
    promptPreset: string;
    savedCustomPrompts: Record<string, string>;
    lastCustomPrompt: string;
    pauseSummarization: boolean;
    disableGhosting: boolean;
    stripPatterns: string[];
    debugMode: boolean;
    traceMode: boolean;
    connectionSource: string;
    summarizerResponseLength: number;
    connectionProfileId: string;
    ollamaUrl: string;
    ollamaModel: string;
    ollamaModelsCache: Array<{ name: string }>;
    openaiUrl: string;
    openaiKey: string;
    openaiModel: string;
    openaiMaxTokens: number;
}

interface ConnectionManagerRequestService {
    send(messages: string[], systemPrompt: string): Promise<string>;
    /**
     * @param {string} profileId
     * @param {Array<{ role: string; content: unknown }>} messages
     * @param {Record<string, unknown>} options
     * @returns {Promise<string | Record<string, unknown>>}
     */
    sendRequest(profileId: string, messages: unknown, options: Record<string, unknown>): Promise<unknown>;
    handleDropdown(element: HTMLSelectElement): void;
}

interface SillyTavernContext {
    chat: ChatMessage[];
    extensionSettings: { [key: string]: ExtensionSettings };
    chatMetadata: { [key: string]: ChatStore };
    setExtensionPrompt(
        id: string,
        text: string,
        position: number,
        depth: number,
        interpolate: boolean,
        force?: unknown,
    ): void;
    saveSettingsDebounced(): void;
    saveMetadata(): Promise<void>;
    getRequestHeaders?: () => Record<string, string>;
    executeSlashCommandsWithOptions(
        command: string,
        options: Record<string, unknown>,
    ): Promise<void>;
    generateRaw(messages: string[] | Record<string, unknown>, systemPrompt?: string): Promise<string>;
    promptManager?: {
        addPrompt(name: string, content: string): boolean;
        getPrompt(name: string): string | null;
        getPromptCollection(): { collection?: Array<{ identifier?: string; enabled?: boolean }> };
        getPromptOrderEntries(): Array<{ identifier: string; enabled: boolean }>;
    };
    saveChat?: () => Promise<void>;
    ConnectionManagerRequestService?: ConnectionManagerRequestService;
    SlashCommandParser?: SlashCommandParser;
    SlashCommand?: SlashCommand;
    name1?: string;
    getContext(): SillyTavernContext;
}

interface Toastr {
    success(message: string, title?: string, options?: Record<string, unknown>): void;
    error(message: string, title?: string, options?: Record<string, unknown>): void;
    warning(message: string, title?: string, options?: Record<string, unknown>): void;
    info(message: string, title?: string, options?: Record<string, unknown>): void;
    clear(toastInstance?: unknown): void;
}

declare const SillyTavern: {
    getContext(): SillyTavernContext;
};

declare const toastr: {
    success(message: string, title?: string, options?: Record<string, unknown>): void;
    error(message: string, title?: string, options?: Record<string, unknown>): void;
    warning(message: string, title?: string, options?: Record<string, unknown>): void;
    info(message: string, title?: string, options?: Record<string, unknown>): void;
    clear(toastInstance?: unknown): void;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const jQuery: (...args: any[]) => any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const $: (...args: any[]) => any;
