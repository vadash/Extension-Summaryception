# Summarizer requests carry a recall block as their last message

A summarizer call sends three messages: the system message holds the static declarative tags (`<role>`, `<inv>`, `<out>`, `<task>`, `<rules>`), the first user message holds the payload `<in>` with its provenance fragments, and the last user message holds a per-call-family recall block — numbered one-line tasks the model answers before writing, then the volatile limits, then the execution trigger as the final line. Recall is what keeps a long passage from pushing the constraints out of attention, so the invocation belongs at the very end, not mid-message.

## Considered Options

- **Inject the block into the main model at depth 0** — it would answer a different question and collide with Memory Injection's own slot.
- **Append it after the existing trigger line** — the invocation sentence ends up buried above the block.
- **No block, rules only** — the current passive list, which the payload can outweigh.

## Consequences

`insertBeforeTrigger` loses its purpose once the trigger moves to the recall block. A leading `<think>` region is stripped before envelope validation so a leaked reasoning step becomes a successful call instead of a retry. The block is an editable Prompt Profile pair like every other prompt, and the Auditor is disabled behind one comment until the rewrite lands.
