# Runtime instances are built at the composition root; Chat Persistence is the one root-initialized holder

ADR-0016 builds the Foreground Gate at the composition root, and the Summarizer Queue is built there too. Every other runtime instance — the Summarizer Dispatch, the Usage Ledger, the memory-injection slot writer, the Reroll Tail flag — follows the same rule: a `createX` factory returns functions, the root builds one, and consumers receive it as a named argument. Chat Persistence is the exception, a holder the root initializes once.

## Considered Options

- **One runtime bundle** — rejected: it re-creates the metadata bag ADR-0008 and ADR-0023 deleted.
- **Root-initialized holders for everything** — rejected: a holder keeps module state, so tests still share one instance per module.
