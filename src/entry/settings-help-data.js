const selectorFor = (id) => `label[for="${id}"]`;
const controlFor = (id) => `#${id}`;

const basicHelp = ({ selector, title, short, controls, controlsText, when, risk }) => ({
    selector,
    title,
    short,
    detail: `${controlsText} ${when} ${risk}`,
    controls,
});

const CONNECTION_GROUPS = [
    {
        key: 'layer0',
        label: 'Layer 0',
        route: 'main raw-chat summarizer route used for new Layer 0 memories and Layer 0 regeneration.',
        sourceId: 'summaryception_connection_source',
        responseLengthId: 'sc_summarizer_response_length',
        requestTimeoutId: 'sc_request_timeout',
        profileId: 'summaryception_connection_profile',
        ollamaUrlId: 'summaryception_ollama_url',
        ollamaModelId: 'summaryception_ollama_model',
        openaiUrlId: 'summaryception_openai_url',
        openaiKeyId: 'summaryception_openai_key',
        openaiModelId: 'summaryception_openai_model',
        openaiMaxTokensId: 'summaryception_openai_max_tokens',
        sourceRisk: 'A weak or misconfigured route makes every new summary worse.',
        responseDefault: '0 uses the selected provider default.',
        openaiDefault: '0 leaves the provider default.',
    },
    {
        key: 'merge',
        label: 'Merge',
        route: 'optional Layer 1+ promotion route used when lower memories are merged into deeper memory.',
        sourceId: 'summaryception_merge_connection_source',
        responseLengthId: 'sc_merge_summarizer_response_length',
        requestTimeoutId: 'sc_merge_request_timeout',
        profileId: 'summaryception_merge_connection_profile',
        ollamaUrlId: 'summaryception_merge_ollama_url',
        ollamaModelId: 'summaryception_merge_ollama_model',
        openaiUrlId: 'summaryception_merge_openai_url',
        openaiKeyId: 'summaryception_merge_openai_key',
        openaiModelId: 'summaryception_merge_openai_model',
        openaiMaxTokensId: 'summaryception_merge_openai_max_tokens',
        sourceRisk: 'A mismatched merge route can rewrite stable memory in a different style.',
        responseDefault: '0 uses the selected provider default.',
        openaiDefault: '0 leaves the provider default.',
    },
    {
        key: 'fallback',
        label: 'Fallback',
        route: 'backup summarizer route used only after retryable primary failures.',
        sourceId: 'summaryception_fallback_connection_source',
        responseLengthId: 'sc_fallback_summarizer_response_length',
        requestTimeoutId: 'sc_fallback_request_timeout',
        profileId: 'summaryception_fallback_connection_profile',
        ollamaUrlId: 'summaryception_fallback_ollama_url',
        ollamaModelId: 'summaryception_fallback_ollama_model',
        openaiUrlId: 'summaryception_fallback_openai_url',
        openaiKeyId: 'summaryception_fallback_openai_key',
        openaiModelId: 'summaryception_fallback_openai_model',
        openaiMaxTokensId: 'summaryception_fallback_openai_max_tokens',
        sourceRisk: 'It is ignored if it matches the primary route.',
        responseDefault: '0 uses the selected provider default.',
        openaiDefault: '0 leaves the provider default.',
    },
];

const CONNECTION_ENTRY_BUILDERS = [
    connectionSourceHelp,
    responseLengthHelp,
    requestTimeoutHelp,
    profileHelp,
    ollamaUrlHelp,
    ollamaModelHelp,
    openaiUrlHelp,
    openaiKeyHelp,
    openaiModelHelp,
    openaiMaxTokensHelp,
];

export const CONNECTION_HELP_ENTRIES = CONNECTION_GROUPS.flatMap((group) =>
    CONNECTION_ENTRY_BUILDERS.map((build) => build(group)).filter(Boolean),
);

function connectionSourceHelp(group) {
    return [
        `${group.key}_source`,
        basicHelp({
            selector: selectorFor(group.sourceId),
            title: `${group.label} Source`,
            short: getConnectionSourceShort(group),
            controls: [controlFor(group.sourceId)],
            controlsText: `Controls the ${group.route}`,
            when: getConnectionSourceWhen(group),
            risk: group.sourceRisk,
        }),
    ];
}

function responseLengthHelp(group) {
    return [
        `${group.key}_response_length`,
        basicHelp({
            selector: selectorFor(group.responseLengthId),
            title: `${group.label} Response Length`,
            short: 'Maximum response length for default/profile routes.',
            controls: [controlFor(group.responseLengthId)],
            controlsText: `Controls the response length cap for the ${group.route}`,
            when: 'Use it if a provider rejects large non-streaming limits or you need shorter summaries.',
            risk: `Setting it too low can cut off summaries. ${group.responseDefault}`,
        }),
    ];
}

function requestTimeoutHelp(group) {
    return [
        `${group.key}_request_timeout`,
        basicHelp({
            selector: selectorFor(group.requestTimeoutId),
            title: `${group.label} Request Timeout`,
            short: 'Per-attempt timeout in seconds before the request is aborted and retried.',
            controls: [controlFor(group.requestTimeoutId)],
            controlsText: `Controls how long a single ${group.label} summarizer attempt waits before giving up.`,
            when: 'Raise it for slow local models that legitimately exceed the default. Lower it to fail over faster.',
            risk: 'Too low aborts valid slow responses; too high stalls the chat on a hung backend.',
        }),
    ];
}

function profileHelp(group) {
    return [
        `${group.key}_profile`,
        basicHelp({
            selector: selectorFor(group.profileId),
            title: `${group.label} Profile`,
            short: 'Saved SillyTavern connection profile for this route.',
            controls: [controlFor(group.profileId)],
            controlsText: `Controls which saved SillyTavern Connection Profile powers the ${group.route}`,
            when: 'Use it if you selected Connection Profile as the source.',
            risk: 'Profile formatting and model choice can change summary quality.',
        }),
    ];
}

function ollamaUrlHelp(group) {
    return [
        `${group.key}_ollama_url`,
        basicHelp({
            selector: selectorFor(group.ollamaUrlId),
            title: `${group.label} Ollama URL`,
            short: 'Ollama server address used by this route.',
            controls: [controlFor(group.ollamaUrlId)],
            controlsText: `Controls the Ollama endpoint used by the ${group.route}`,
            when: 'Use it if your local Ollama server runs somewhere other than localhost:11434.',
            risk: 'A wrong URL or missing CORS setup makes the route fail.',
        }),
    ];
}

function ollamaModelHelp(group) {
    return [
        `${group.key}_ollama_model`,
        basicHelp({
            selector: selectorFor(group.ollamaModelId),
            title: `${group.label} Ollama Model`,
            short: 'Local Ollama model used by this route.',
            controls: [controlFor(group.ollamaModelId)],
            controlsText: `Controls which Ollama model powers the ${group.route}`,
            when: 'Use it if you want a different local summarizer model.',
            risk: 'A small or weak model may miss important memory facts.',
        }),
    ];
}

function openaiUrlHelp(group) {
    return [
        `${group.key}_openai_url`,
        basicHelp({
            selector: selectorFor(group.openaiUrlId),
            title: `${group.label} OpenAI URL`,
            short: 'OpenAI-compatible base URL for this route.',
            controls: [controlFor(group.openaiUrlId)],
            controlsText: `Controls the OpenAI-compatible endpoint used by the ${group.route}`,
            when: 'Use it for OpenRouter, local OpenAI-compatible servers, or another compatible provider.',
            risk: 'The URL should usually end at /v1; a wrong base URL makes requests fail.',
        }),
    ];
}

function openaiKeyHelp(group) {
    return [
        `${group.key}_openai_key`,
        basicHelp({
            selector: selectorFor(group.openaiKeyId),
            title: `${group.label} API Key`,
            short: 'API key for the OpenAI-compatible route.',
            controls: [controlFor(group.openaiKeyId)],
            controlsText: `Controls the API key sent to the ${group.route}`,
            when: 'Use it if your provider requires authentication.',
            risk: 'Leaving it empty fails on hosted providers, while saving a key stores it in ST settings.',
        }),
    ];
}

function openaiModelHelp(group) {
    return [
        `${group.key}_openai_model`,
        basicHelp({
            selector: selectorFor(group.openaiModelId),
            title: `${group.label} OpenAI Model`,
            short: 'Model name for the OpenAI-compatible route.',
            controls: [controlFor(group.openaiModelId)],
            controlsText: `Controls which OpenAI-compatible model powers the ${group.route}`,
            when: 'Use it if your provider exposes a different model name.',
            risk: 'Typos or unavailable models make requests fail.',
        }),
    ];
}

function openaiMaxTokensHelp(group) {
    return [
        `${group.key}_openai_max_tokens`,
        basicHelp({
            selector: selectorFor(group.openaiMaxTokensId),
            title: `${group.label} Max Tokens`,
            short: 'Output token cap for OpenAI-compatible requests.',
            controls: [controlFor(group.openaiMaxTokensId)],
            controlsText: `Controls the max_tokens value for the ${group.route}`,
            when: 'Use it if your provider needs an explicit output cap.',
            risk: `Setting it too low cuts off summaries. ${group.openaiDefault}`,
        }),
    ];
}

function getConnectionSourceShort(group) {
    if (group.key === 'fallback') {
        return 'Backup route after retryable primary failures.';
    }
    if (group.key === 'merge') {
        return 'Optional route for deeper memory merges.';
    }
    return 'Route used for raw chat to Layer 0 summaries.';
}

function getConnectionSourceWhen(group) {
    if (group.key === 'fallback') {
        return 'Only use it if you have a second working route. Leave it disabled otherwise.';
    }
    if (group.key === 'merge') {
        return 'Use it if deeper memory merges need a different or stronger model.';
    }
    return 'Use it when the default route is not the best summarizer.';
}
