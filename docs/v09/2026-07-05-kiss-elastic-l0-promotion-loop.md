# KISS Elastic L0 And Promotion Loop

## Summary

All memory modes and summarization entrypoints use the same work loop once summarization is allowed:

```text
re-evaluate state -> promote if any layer is over limit -> otherwise commit one Layer 0 batch -> repeat
```

Cache mode only changes when the first automatic batch becomes eligible. It waits until the larger cache live-window threshold is exceeded, then uses the same one-batch Layer 0 and promotion loop as Standard and Custom.

## Rules

- Never start new Layer 0 work while any active layer exceeds its dynamic token quota or `snippetsPerLayer`.
- Re-evaluate after every Layer 0 batch and every promotion merge.
- Force Summarize and Slop Breaker must promote between committed Layer 0 batches instead of summarizing the full target first.
- Cache mode must not commit multi-batch all-or-nothing Layer 0 flushes.
- Promotion keeps the existing shallowest-over-limit-first behavior and internal layer depth cap.

## Acceptance Tests

- Standard, Custom, and ready Cache automatic runs process one Layer 0 batch at a time.
- Automatic runs promote before adding Layer 0 when memory is already over limit.
- Force Summarize and Slop Breaker interleave committed Layer 0 batches with promotion normalization.
- Cache planning still waits for the cache live-window threshold and protected tail, but returns one capped batch.
