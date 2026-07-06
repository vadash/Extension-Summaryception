## Spec: Targeted Improvements (3 fixes, 1 session)

### Fix 1: Promotion Narrative Delimiter (`summarizer-promotion.js`)

**Problem:** When joining narratives for promotion input, `\n\n---\n\n` is used. But the LLM output from Call #20 (fallback route) shows that promoted narrative blocks can concatenate without clean separation, producing run-on text like "consequences Offering to pay for grooming."

**Current code (line ~170):**
```javascript
const storyTxt = parsed
    .map((snippet) => snippet.narrative)
    .filter(Boolean)
    .join('\n\n---\n\n');
```

**Fix:** Change the delimiter to `\n\n` (double newline only). The `---` separator is noise that the LLM may not respect on output, and it does not help the promotion model. A clean paragraph break is sufficient and matches the existing prose style.

Additionally, trim each narrative snippet individually to prevent leading/trailing whitespace from producing malformed joins.

### Fix 2: Strip Structural Markers from Promotion Output (`prompts.js`)

**Problem:** The promotion LLM can sometimes emit `[NARRATIVE]` or `[STATE]` headers in its output (observed as a risk in the review). Currently `cleanSummarizerOutput` only strips reasoning tags and thinking blocks.

**Fix:** Add regex patterns to `cleanSummarizerOutput` that strip standalone `[NARRATIVE]` and `[STATE]` lines from output. These are structural markers for L0 generation, not for L1+ promotion output.

```javascript
// Strip dual-track structural markers from promotion output
text = text.replace(/^\s*\[NARRATIVE\]\s*$/gmi, '');
text = text.replace(/^\s*\[STATE\]\s*$/gmi, '');
```

This runs after the existing block patterns, before the whitespace cleanup. Low risk: these strings only appear as standalone headers in LLM output; stripping them from narrative prose is harmless since the words "NARRATIVE" and "STATE" never appear as standalone lines in actual story text.

### Fix 3: Dynamic Timeouts + Retry Loop (`summarizer-request.js`)

**Problem:** All calls use a fixed 120s timeout. For L0 (user-facing), 120s is appropriate for the first attempt. For L1+ (background promotion), 120s wastes time when the primary API is slow. After both primary and fallback are exhausted, the system gives up entirely.

**Two sub-changes:**

#### 3a. Dynamic timeout per call type and attempt

Make `createAttemptAbortContext` receive its timeout dynamically. The timeout is currently hardcoded as `120000` in `executeSummarizerAttempt`. Pass it as a parameter computed from `metadata.kind` and `attempt` index:

- **L0, attempt 0:** 120s (full patience for user-facing first try)
- **L0, attempts 1-2:** 90s (slightly less for retries)
- **L1+, attempt 0:** 90s (background work, less patience)
- **L1+, attempts 1-2:** 60s (background retries, even less)

Add a function:
```javascript
function computeAttemptTimeoutMs(metadata, attempt) {
    const isPromotion = metadata.kind === 'promotion';
    if (!isPromotion) {
        return attempt === 0 ? 120000 : 90000;
    }
    return attempt === 0 ? 90000 : 60000;
}
```

Thread this through `runSummarizerAttemptSeries` -> `executeSummarizerAttempt` -> `createAttemptAbortContext`.

Also update the error message in `createAttemptAbortContext` from the hardcoded `'Request timed out after 120s'` to use the actual value: `'Request timed out after ${timeoutMs / 1000}s'`.

#### 3b. Retry loop after fallback exhaustion (primary -> fallback -> repeat)

**Current flow in `runSummarizerAttempts`:**
```
primary (up to 5 retries) -> fallback (up to 5 retries) -> GIVE UP
```

**New flow:**
```
LOOP:
  primary (3 retries) -> if exhausted ->
  fallback (3 retries) -> if exhausted ->
  clear health buckets -> continue LOOP
```

After both routes are exhausted, instead of returning `failSummarization`, clear the `primaryRetryExhaustedBuckets` for this health bucket and restart the primary->fallback cycle. The loop continues indefinitely until either:
- A call succeeds
- The user aborts (signal check)
- A non-retryable error occurs

This matches the user's intent: "we loop (3 primary - 3 fallback - repeat). It's not like we can skip anything."

Also reduce `RETRY_CONFIG.maxRetries` from 5 to 3 in `constants.js`, since the new loop structure provides the persistence that 5 retries used to provide within a single route. This keeps the total wait time in check while giving more chances across routes.

**Files modified:**
- `src/foundation/constants.js` -- `maxRetries: 5` -> `maxRetries: 3`
- `src/core/summarizer-request.js` -- dynamic timeout function, threaded parameter, retry loop in `runSummarizerAttempts`
- `src/core/prompts.js` -- structural marker stripping
- `src/core/summarizer-promotion.js` -- narrative delimiter change
