# Microfiche images freeze until the next Mutation Epoch

A Frozen Page is a rendered microfiche image whose pixels stay fixed until the store's Mutation Epoch bumps (ADR-0003): the Microfiche page source re-renders on that epoch change alone and never once per generation, so everything that changed since the last render travels to the provider as a per-generation text tail instead of forcing a re-image. Re-rendering every generation rewrites the prompt prefix and destroys provider prefix-cache stability, and uncached input is the expensive path, so the image is deliberately the stable part of the prompt while the tail absorbs the churn.

## Considered Options

- **Re-render images every generation** — rejected: pixel drift breaks provider prefix-cache stability, so every turn pays uncached input cost.
