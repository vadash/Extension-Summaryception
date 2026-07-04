# Dual Summarizer Model Routing

## Summary

Summaryception supports two summarizer connection tiers:

- Layer 0 uses the existing connection settings for raw chat-to-summary work and Layer 0 regeneration.
- Layer 1+ promotion merges can optionally use a separate, smarter connection.
- The merge tier defaults to `inherit`, so old saves keep the previous single-connection behavior without migration.

## Implementation

- Keep existing connection settings as the Layer 0 settings.
- Add merge override settings: `mergeConnectionSource`, `mergeConnectionProfileId`, `mergeOllamaModel`, `mergeOpenaiModel`, `mergeOpenaiMaxTokens`, and `mergeSummarizerResponseLength`.
- Route only `kind: 'promotion'` summarizer calls through the merge override.
- Reuse shared provider endpoint credentials: `ollamaUrl`, `openaiUrl`, and `openaiKey`.
- Leave prompt templates, retry behavior, abort handling, and provider adapters unchanged.

## Testing

- Verify settings backfill adds `mergeConnectionSource: 'inherit'`.
- Verify promotion calls inherit Layer 0 by default.
- Verify promotion calls use merge override fields when configured.
- Verify Layer 0 and regeneration calls stay on the existing connection.
- Run `npm test`.
