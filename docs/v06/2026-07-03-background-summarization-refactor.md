# Background Summarization Refactor

## Summary

Summaryception should allow background summarization to continue while the user chats, without letting in-flight summaries change `extension_prompts` or hide messages during foreground prompt assembly.

Prompt injection must always come from the last fully committed summary state. Pending jobs and deferred commits are in-memory only and can be recomputed safely after reload.

## Requirements

- Replace the global `isSummarizing` early return with a single coalescing worker.
- `requestSummarization({ reason, mode })` marks work pending instead of dropping events.
- Only one worker may run at a time; new events during an in-flight request set `dirty = true`.
- After the active request completes, the worker recomputes against fresh chat state.
- Auto mode processes layer-0 visible-turn overflow before layer promotion.
- Auto mode must not open the blocking catch-up dialog.
- Large automatic backlog handling processes one layer-0 batch per drain/message cycle and may show only a non-blocking notice.
- Force Summarize keeps the full catch-up progress/cancel flow.
- On `GENERATION_STARTED`, synchronously reassert the current committed injection snapshot and freeze prompt-affecting mutations.
- While frozen, completed summaries are held as pending commits.
- On `GENERATION_ENDED` or `GENERATION_STOPPED`, flush pending commits, update injection, and resume work if needed.
- Commits must be transactional: capture a job snapshot before the request and revalidate it before metadata mutation.
- Stale results caused by chat change, cursor change, source edits, or summary-store changes must be discarded and requeued.
- Layer-0 commit order is append summary, save metadata, update committed injection, then ghost covered messages when not foreground-frozen.
- Default connection requests must use `generateRaw({ prompt: [{ role: 'user', content: prompt }], systemPrompt, responseLength, trimNames: false })`.
- PromptManager toggle snapshot, disable, and restore behavior must not run for default summarizer calls.
- Keep `abortSummarization()` and `getIsSummarizing()` available for UI compatibility.
- No persisted metadata schema change is required.

## Verification

- Unit test coalescing when a message arrives during an in-flight summarizer request.
- Unit test foreground freeze so a completed background summary does not call `setExtensionPrompt` or `/hide` until generation ends.
- Unit test stale-result rejection for changed chat id, changed `summarizedUpTo`, edited source messages, and changed summary layers.
- Unit test the default `generateRaw` path no longer mutates prompt toggles and sends an isolated raw message prompt.
- Manual test with an artificial long summarizer delay: keep sending messages and confirm foreground generations use stable old-or-new committed summaries, never half-applied summary or ghost state.
