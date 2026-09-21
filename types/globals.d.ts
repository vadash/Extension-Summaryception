/**
 * SillyTavern browser extension globals.
 * Declared here so TypeScript's checkJs can validate their usage across src/.
 */

declare module '/script.js' {
    export function substituteParams(text: string): string;
}

interface ChatMessage {
    sc_id?: string;
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
    sourceMessageIds: string[];
    currentDateTime?: string;
    promoted?: boolean;
    seedFromLayer?: number;
    fromLayer?: number;
    mergedCount?: number;
    timestamp?: number;
    regenerated?: boolean;
}

interface SummaryceptionContinuityStep {
    current: number;
    max: number;
}

interface SummaryceptionContinuityBond {
    bond: number;
    sparks: number;
    grudge: number;
}

interface SummaryceptionAgenda {
    task: string;
    step: SummaryceptionContinuityStep;
    status: string;
}

interface SummaryceptionContinuityPhysics {
    location: string;
    environment: string;
    posture_and_position: string;
    contact_points: string;
    clothing_state: string;
}

interface SummaryceptionContinuityFlags {
    positive_interaction: boolean;
    slight: boolean;
    insult: boolean;
    betrayal: boolean;
    apology: boolean;
}

interface SummaryceptionContinuityState {
    turn_count: number;
    bonds: Record<string, SummaryceptionContinuityBond>;
    agendas: Record<string, SummaryceptionAgenda>;
    gm_notes: string[];
    physics: SummaryceptionContinuityPhysics;
}

interface SummaryceptionStore {
    layers: SummaryceptionSnippet[][];
    ghostedMessageIds: string[];
    mutationEpoch: number;
}

interface ExtensionSettings {
    enabled: boolean;
    autoPaused: boolean;
    continuityEnabled: boolean;
    configMode: string;
    uiMode: string;
    memoryMode: string;
    cacheTtlMinutes: number;
    customMemoryPosition: string;
    customMemoryRole: string;
    customMemoryDepth: number;
    minSummaryTurns: number;
    maxSummaryTurns: number;
    layer0SummaryTokenTarget: number;
    maxL0SourceTokens: number;
    advancedModelContext: number;
    minSummaryBudget: number;
    verbatimTokenBudget: number;
    queuedTokenBudget: number;
    memoryTokenBudget: number;
    snippetsPerLayer: number;
    snippetsPerPromotion: number;
    injectionTemplate: string;
    summarizerSystemPromptPreset: string;
    summarizerSystemPrompt: string;
    summarizerUserPrompt: string;
    summarizerRepairPromptPreset: string;
    summarizerRepairPrompt: string;
    promotionSystemPromptPreset: string;
    promotionSystemPrompt: string;
    promotionUserPrompt: string;
    promotionRepairPromptPreset: string;
    promotionRepairPrompt: string;
    auditorSystemPromptPreset: string;
    auditorSystemPrompt: string;
    auditorPromptPreset: string;
    auditorUserPrompt: string;
    promptPreset: string;
    applyRegexScripts: boolean;
    promotionPromptPreset: string;
    hideNonTextMessages: boolean;
    stripChineseIdeographs: boolean;
    maskUserRoleAsAssistant: boolean;
    maskUserRoleMode: 'marker_first' | 'rewrite_all' | 'marker_last' | 'keep_last_user';
    stripPatterns: string[];
    debugMode: boolean;
    traceMode: boolean;
    promptInputLogMode: boolean;
    promptOutputLogMode: boolean;
    continuityStateLogMode: boolean;
    continuityStateLogFullMode: boolean;
    connectionSource: string;
    summarizerResponseLength: number;
    connectionProfileId: string;
    requestTimeoutSeconds: number;
    mergeConnectionSource: string;
    mergeSummarizerResponseLength: number;
    mergeConnectionProfileId: string;
    mergeRequestTimeoutSeconds: number;
    fallbackConnectionSource: string;
    fallbackSummarizerResponseLength: number;
    fallbackConnectionProfileId: string;
    fallbackRequestTimeoutSeconds: number;
    auditorConnectionSource: string;
    auditorSummarizerResponseLength: number;
    auditorConnectionProfileId: string;
    auditorRequestTimeoutSeconds: number;
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

interface ConnectionProvider {
    /** Whether generate() forwards an AbortSignal (timeouts genuinely cancel). */
    cancellable: boolean;
    generate(params: ConnectionGenerateParams): Promise<string>;
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
    removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
    addEventListener?: (event: string, handler: (...args: unknown[]) => void) => void;
    removeEventListener?: (event: string, handler: (...args: unknown[]) => void) => void;
}

interface SillyTavernStreamingProcessor {
    isFinished?: boolean;
}

interface SillyTavernContext {
    chat: ChatMessage[];
    /** Active group chat id; absent or null in solo chats. */
    groupId?: string | null;
    extensionSettings: Record<string, ExtensionSettings>;
    addOneMessage?: (message: ChatMessage, options?: Record<string, unknown>) => unknown;
    updateViewMessageIds?: (startIndex?: number | null) => void;
    deleteMessage?: (
        index: number,
        swipeIndex?: number,
        askConfirmation?: boolean,
    ) => Promise<unknown>;
    extensionPrompts?: Record<string, { value?: unknown }>;
    chatMetadata: Record<string, SummaryceptionStore>;
    maxContext?: number;
    chatCompletionSettings?: { openai_max_context?: number; openai_max_tokens?: number };
    loadWorldInfo?: (name: string) => Promise<Record<string, unknown> | null>;
    saveWorldInfo?: (
        name: string,
        data: Record<string, unknown>,
        immediately?: boolean,
    ) => Promise<void>;
    getWorldInfoNames?: () => string[];
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
    generate?: (
        type: string,
        options: Record<string, unknown>,
        dryRun: boolean,
    ) => Promise<unknown>;
    getTokenCountAsync?: (text: string, padding?: number) => Promise<number>;
    getTokenizerModel?: () => string;
    powerUserSettings?: { token_padding?: number };
    promptManager?: SillyTavernPromptManager;
    saveChat?: () => Promise<void>;
    reloadCurrentChat?: () => Promise<void>;
    ConnectionManagerRequestService?: ConnectionManagerRequestService;
    SlashCommandParser?: SlashCommandParser;
    SlashCommand?: SlashCommand;
    name1?: string;
    eventSource?: SillyTavernEventSource;
    eventTypes?: Record<string, string>;
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
