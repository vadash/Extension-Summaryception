# Ghosting hides a reply from the prompt without removing it from the Turn Count

A ghosted reply is still an assistant turn: Ghosting hides through the host command, the host marks a hidden message `is_system`, and the Continuity Engine's `is_system` test — shared by `isAssistantMessage`, the Turn Count, the coverage anchor, and the Continuity Marks — read every summarized reply as a host system line. The Turn Count therefore sawtoothed against summarization instead of counting the chat (2→17, reset to 8, →15, reset to 7), which put the Spark conversion and the Grudge decay on the wrong cadence and left the Gate ladder permanently behind the fiction, while the anchor and the marks survived only on the six-to-eight Exchange verbatim window that keeps the newest Continuity Checkpoint visible. An assistant turn is any present message that is not the User turn, and a reply's visibility in the prompt is never part of its identity.

## Considered Options

- **Consult Ghosting ownership (`store.ghostedMessageIds`) instead of the host hide flag** — rejected: it couples Continuity Coverage to the Chat Store, so coverage stops being the one read model of the chat (ADR-0017), and an owned reply whose visual hide lagged drops out of the count.
- **Store a running Turn Count in the Continuity Checkpoint instead of deriving it** — rejected: this reintroduces the stored-counter invalidation ADR-0017 deleted, and the count would still be a window over prompt visibility rather than a count of the chat.
- **Keep the `is_system` test and accept the sawtooth** — rejected: the Conversion multiples are a cadence over Exchanges, so a count that falls whenever the extension does its job has no meaning.

## Consequences

A chat whose latest Continuity Checkpoint predates this decision keeps the window value its last audit wrote until the next settled audit overwrites it, and there is no migration shim for the stored `turn_count`; Continuity Marks now derive over the whole chat, including replies the host is hiding.
