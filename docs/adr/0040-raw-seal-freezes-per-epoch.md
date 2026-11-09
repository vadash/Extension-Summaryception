# The Raw Seal freezes the raw-chat slice until the next Mutation Epoch

The Raw Seal is the raw-chat slice a Frozen Page renders from: it is computed once per Mutation Epoch and reused verbatim until the next store mutation bumps that epoch and clears it, so tail growth ships as text and a page render only reads the epoch as its cache key rather than resealing mid-epoch. This extends the Frozen Page rule (ADR-0038) from pixels to the raw slice, and the reason is the mutation epoch itself (ADR-0003): raw-chat growth does not bump it, so re-slicing each generation would re-hash page keys and break provider prefix-cache stability.

## Considered Options

- **Re-slice the raw chat each generation** — rejected: the slice and page keys would re-hash every turn, breaking provider prefix-cache stability.
