# CN policy splits by direction: raw into the summarizer, clean out and clean at roleplay

The summarizer reads raw history but never emits it: the Passage keeps Han ideographs so no meaning is lost to scrubbing, while Output Hygiene strips them from the response and refuses the attempt past 5% Han with a repair line. The outgoing roleplay prompt strips Han from assistant-role content at the outgoing-only seam (ADR-0036), so a model that echoed CN never re-seeds itself; stored chat and Snippets stay byte-identical everywhere. Memory is clean by construction once output is gated, so it needs no scrub of its own.

**Summarizer input is never scrubbed.** Scrubbing the Passage trades meaning for cleanliness for no gain, since the output gate already bounds what enters memory.
**Output past 5% Han is a retryable refusal carrying repair text.** Below the gate the strip is silent; the repair line names the ratio so the retry has something to bite on.
**Roleplay assistant history is scrubbed outgoing-only.** The same toggle and the same Han-to-space rule apply, and `—`/`―` fold to a space in both scrubbed places, so inline ideographs never glue words together.

## Considered Options

- **Scrub the Passage too** — rejected: the summarizer loses the meaning carried by the stripped characters, and the output gate already keeps memory clean.
