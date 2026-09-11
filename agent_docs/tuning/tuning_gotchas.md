# Tuning Gotchas

- Do not optimize raw cost alone. Smaller context can reduce roleplay quality.
- Prefix Cache keeps a larger recent range and queues older chat for atomic flushes.
- Automatic summarization waits until the configured Recent + Queued raw-chat threshold is full.
- Memory below steady-state use silently truncates injected memory.
- Recall depends on prompt quality, model behavior, and chat depth.
- Cache TTL applies to Prefix Cache mode only.
- Stale-cache advice needs a queue at or above Min Turns per Batch and a readable last-message time.
- Retention clamp invariants live in one read-time normalizer. UI sliders delegate to it; keep no second enforcement.
