# Ghosting hides a reply from the prompt without removing it from the Turn Count

A ghosted reply is still an assistant turn: Ghosting hides through the host command, which marks a hidden message `is_system`, and the engine's shared `is_system` test read every summarized reply as a host system line. The Turn Count therefore sawtoothed against summarization instead of counting the chat, putting the Spark conversion and the Grudge decay on the wrong cadence and leaving the Gate ladder behind the fiction. An assistant turn is any present message that is not the User turn; a reply's prompt visibility is never part of its identity.

## Consequences

A chat whose latest Continuity Checkpoint predates this decision keeps the window value its last audit wrote until the next settled audit overwrites it, and there is no migration shim for the stored `turn_count`. Continuity Marks now derive over the whole chat, including replies the host is hiding.
