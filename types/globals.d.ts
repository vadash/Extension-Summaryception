/**
 * SillyTavern browser extension globals.
 * Declared here so TypeScript's checkJs can validate their usage across src/.
 */

interface ChatMessage {
    is_user: boolean;
    is_system: boolean;
    is_hidden?: boolean;
    mes?: string;
    name?: string;
    send_date?: unknown;
    extra?: ChatMessageExtra;
    [key: string]: unknown;
}

interface ChatMessageExtra {
    sc_ghosted?: boolean;
    sc_token_count?: unknown;
    [key: string]: unknown;
}

interface SlashCommandParser {
    addCommandObject(obj: unknown): void;
}

interface SlashCommand {
    fromProps(props: Record<string, unknown>): SlashCommand;
}

interface SummaryceptionSnippet {
    text: string;
    turnRange?: [number, number];
    promoted?: boolean;
    seedFromLayer?: number;
    fromLayer?: number;
    mergedCount?: number;
    timestamp?: number;
    regenerated?: boolean;
}

interface SummaryceptionStore {
    layers: SummaryceptionSnippet[][];
    summarizedUpTo: number;
    ghostedIndices: number[];
    mutationEpoch: number;
}

interface ExtensionSettings {
    enabled: boolean;
    memoryMode: string;
    customMemoryPosition: string;
    customMemoryRole: string;
    customMemoryDepth: number;
    minSummaryTurns: number;
    maxSummaryTurns: number;
    layer0SummaryTokenTarget: number;
    minSummaryBudget: number;
    verbatimTokenBudget: number;
    memoryTokenBudget: number;
    snippetsPerLayer: number;
    snippetsPerPromotion: number;
    injectionTemplate: string;
    summarizerSystemPrompt: string;
    summarizerUserPrompt: string;
    promotionSystemPrompt: string;
    promotionUserPrompt: string;
    promptPreset: string;
    savedCustomPrompts: Record<string, string>;
    promotionPromptPreset: string;
    savedCustomPromotionPrompts: Record<string, string>;
    applyRegexScripts: boolean;
    stripChineseIdeographs: boolean;
    stripPatterns: string[];
    debugMode: boolean;
    traceMode: boolean;
    promptInputLogMode: boolean;
    promptOutputLogMode: boolean;
    promptLogMode: boolean;
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
    mergeConnectionSource: string;
    mergeSummarizerResponseLength: number;
    mergeConnectionProfileId: string;
    mergeOllamaModel: string;
    mergeOpenaiModel: string;
    mergeOpenaiMaxTokens: number;
    fallbackConnectionSource: string;
    fallbackSummarizerResponseLength: number;
    fallbackConnectionProfileId: string;
    fallbackOllamaModel: string;
    fallbackOpenaiModel: string;
    fallbackOpenaiMaxTokens: number;
}

interface GenerateRawMessage {
    role: string;
    content: unknown;
}

interface GenerateRawOptions {
    prompt?: string | GenerateRawMessage[];
    systemPrompt?: string;
    trimNames?: boolean;
    responseLength?: number;
    [key: string]: unknown;
}

interface OpenAIChatCompletionDelta {
    content?: string;
    role?: string;
    [key: string]: unknown;
}

interface OpenAIChatCompletionChoice {
    delta?: OpenAIChatCompletionDelta;
    [key: string]: unknown;
}

interface OpenAIChatCompletionChunk {
    choices?: OpenAIChatCompletionChoice[];
    [key: string]: unknown;
}

interface ConnectionProfileMessage {
    role: string;
    content: unknown;
}

interface ConnectionProfileChoice {
    message?: ConnectionProfileMessage;
    [key: string]: unknown;
}

interface ConnectionProfileResponse {
    content?: unknown;
    message?: ConnectionProfileMessage;
    choices?: ConnectionProfileChoice[];
    data?: unknown;
    [key: string]: unknown;
}

interface ConnectionManagerRequestService {
    send(messages: string[], systemPrompt: string): Promise<string>;
    sendRequest(
        profileId: string,
        messages: ConnectionProfileMessage[],
        maxTokens?: number,
        custom?: Record<string, unknown>,
        overridePayload?: Record<string, unknown>,
    ): Promise<string | ConnectionProfileResponse>;
    handleDropdown(element: HTMLSelectElement): void;
}

interface ConnectionGenerateParams {
    settings: ExtensionSettings;
    systemPrompt: string;
    userPrompt: string;
    signal?: AbortSignal;
}

interface ConnectionTestResult {
    success: boolean;
    message: string;
}

interface ConnectionProvider {
    generate(params: ConnectionGenerateParams): Promise<string>;
    testConnection(settings: ExtensionSettings): Promise<ConnectionTestResult>;
    displayName(settings: ExtensionSettings): string;
}

interface SillyTavernPromptManager {
    addPrompt(name: string, content: string): boolean;
    getPrompt(name: string): string | null;
    getPromptCollection(): { collection?: Array<{ identifier?: string; enabled?: boolean }> };
    getPromptOrderEntries(): Array<{ identifier: string; enabled: boolean }>;
}

interface SillyTavernEventSource {
    on(event: string, handler: (...args: unknown[]) => void): void;
    off(event: string, handler: (...args: unknown[]) => void): void;
}

interface SillyTavernStreamingProcessor {
    isFinished?: boolean;
}

interface SillyTavernContext {
    chat: ChatMessage[];
    extensionSettings: Record<string, ExtensionSettings>;
    chatMetadata: Record<string, SummaryceptionStore>;
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
    generateRaw(options: GenerateRawOptions): Promise<string>;
    getTokenCountAsync?: (text: string) => Promise<number>;
    promptManager?: SillyTavernPromptManager;
    saveChat?: () => Promise<void>;
    ConnectionManagerRequestService?: ConnectionManagerRequestService;
    SlashCommandParser?: SlashCommandParser;
    SlashCommand?: SlashCommand;
    name1?: string;
    eventSource?: SillyTavernEventSource;
    event_types?: Record<string, string>;
    streamingProcessor?: SillyTavernStreamingProcessor;
    renderExtensionTemplateAsync?: (
        thirdParty: string,
        template: string,
        data: Record<string, unknown>,
    ) => Promise<string>;
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
