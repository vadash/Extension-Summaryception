## Goal
Make `readSSEStream` in `src/core/connection-openai.js` resilient to mid-stream network interruptions, reader aborts, and malformed trailing chunks (no terminating newline), so partial summaries are surfaced cleanly and unexpected disconnects are classified as retryable instead of crashing the worker.

## Current state
`readSSEStream` already wraps the read loop in `try { ... } finally { reader.releaseLock(); }`, so the lock is released on throw. However:
- A `reader.read()` rejection (network drop, abort) propagates straight to the caller. The caller (`sendViaOpenAI`) does not catch it, so it reaches `summarizer-request.js`'s `classifyAttemptError`, where `isRetryableError` may miss it (raw `TypeError: network error` is retryable via `isRetryableTypeError`, but a bare `AbortError`-shaped reject or a non-fetched stream error is not).
- The final `buffer` remainder is never parsed, so a stream that ends without a trailing `\n` (or whose last SSE event arrives without a newline) silently drops content.
- There is no partial-recovery path: even if 2KB of summary text was already assembled before the disconnect, the whole attempt fails.

## Changes

### 1. `src/core/connection-openai.js` — `readSSEStream`
- Split the existing `try/finally` so the `while (true)` loop has its own `try { ... } catch (err) { handleStreamReadError(err, fullContent); }` block. The outer `finally { reader.releaseLock(); }` stays.
- On a caught read error:
  - If it is an `AbortError` (name check, covering the `summarizer-request.js` abort path), rethrow it unchanged so the abort classification in `classifyAttemptError` still works (aborts must not be retried and must toast "aborted by user").
  - Otherwise (network drop / malformed chunk / reader rejection), flush any buffered remainder via `parseSSELine` into `fullContent`, then decide via the threshold:
    - If `fullContent.trim().length >= PARTIAL_MIN_CHARS` (new constant, **64 chars** — see decision below), log a connection warning with `CONNECTION_MODULE_NAME` and **return** the partial content. `sendViaOpenAI` already trims and rejects empty content, so a non-empty partial summary flows through normally.
    - If below the threshold, throw a `ConnectionError` with `{ retryable: true }` and a message including both the underlying error and the partial length, so the retry layer retries the whole request.
- After the loop completes normally (`done === true`), flush the residual `buffer` through `parseSSELine` before returning. This handles malformed chunks that did not terminate with a newline and also the common "final `data:` line with no trailing newline" case.

### 2. `src/core/connection-openai.js` — new constant + helper
- Add module-private `const PARTIAL_MIN_CHARS = 64;` with a short JSDoc comment explaining the threshold for accepting a truncated stream.
- Add a small private helper `handleStreamReadError(err, fullContent)` that encapsulates the abort-rethrow vs. partial-accept vs. retryable-throw logic, keeping `readSSEStream` itself under the 80-line `max-lines-per-function` lint ceiling. It returns the accepted partial string or throws.

### 3. JSDoc
- Update the `readSSEStream` JSDoc `@returns` and add `@throws {ConnectionError}` plus a line describing partial-recovery behavior, so the contract is explicit.

## No other files change
- `connection-error.js`, `connection-transport.js`, `summarizer-request.js`, and `retry.js` already support this design: `ConnectionError` carries `retryable`, `isRetryableError` checks `retryable`, and `classifyAttemptError` treats `AbortError` and the `'Aborted by user'` message sentinel as aborts. The rethrown `AbortError` continues to flow through `classifyAttemptError` unchanged.
- No new imports are needed; `ConnectionError` and `CONNECTION_MODULE_NAME` are already imported in `connection-openai.js` (CONNECTION_MODULE_NAME comes from `./connection-error.js` which is already imported — need to verify `CONNECTION_MODULE_NAME` is exported; if not, import it). **Note:** checking the import — `connection-openai.js` currently imports only `ConnectionError` from `./connection-error.js`; `CONNECTION_MODULE_NAME` is already exported from that module so I will extend the import.
- Boundary rules: `core` may import from `constants`, `context`, `logger`, `retry`, `state`, `core`. All imports stay within `core`, so the boundaries lint is satisfied.

## Design decision: partial-accept threshold
Accepting an arbitrary short fragment (e.g. 3 characters) risks writing a truncated, low-quality summary into Layer 0 and then promoting it upward, polluting higher layers with garbage. A 64-character floor is roughly one short summary sentence; summary outputs are typically 200-800 chars, so 64 chars is a conservative "we got meaningful content" signal. Below it, we reject-and-retry (treating the disconnect as a transient failure) to avoid committing junk. This mirrors how `sendViaOpenAI` already rejects *empty* streams with `retryable: true`, extending that guard to "too-short-to-be-trusted" partials.

## Tests (new file: `tests/connection-openai.test.js`)
Follow the existing `tests/connection-default.test.js` style (vitest, `vi.fn`, no JSDoc-required, no complexity limits). Cases:
1. **Happy path** — multi-chunk stream with `\n`-terminated events returns full assembled content.
2. **Trailing newline missing** — last data chunk has no `\n`; verify the residual buffer is flushed and content is returned (regression for the new flush-on-done path).
3. **Mid-stream network drop, partial >= 64 chars** — `reader.read()` rejects once with a `TypeError('network error')` after yielding partial content; verify `readSSEStream` resolves with the partial text (not throws), and that a warning is logged.
4. **Mid-stream drop, partial < 64 chars** — same scenario but partial content is shorter than the threshold; verify a retryable `ConnectionError` is thrown and its message includes the underlying error.
5. **Abort rethrow** — `reader.read()` rejects with `{ name: 'AbortError' }`; verify the `AbortError` is rethrown (not swallowed), so `classifyAttemptError` in `summarizer-request.js` still classifies it as an abort.
6. **`[DONE]` sentinel** — verify `[DONE]` produces no content and parsing of subsequent/preceding lines is unaffected.

The tests will import `readSSEStream` indirectly through `sendViaOpenAI` (it is not exported) by constructing a fake `Response` with a `ReadableStream` body and stubbing `fetch`/`fetchWithProxyFallback`. To keep the test focused on streaming behavior without touching `connection-transport.js` or `context.js`, I will mock the `fetch` global so `sendViaOpenAI` receives a controlled stream response. Where `useProxy`/`isLocalUrl` is involved, I will point the URL at a non-local host to take the direct `fetch` path.

## Verification
- Run `npm test` (Vitest) to confirm the new tests pass and existing tests are unaffected.
- Per `AGENTS.md`, I will not run lint/format/typecheck manually; husky/lint-staged handles that on commit.