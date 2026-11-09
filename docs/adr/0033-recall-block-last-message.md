# Summarizer requests carry a recall block as their last message

A summarizer call sends three messages: the system message holds the static declarative tags, the first user message holds the payload `<in>`, and the last user message holds a per-call-family recall block — numbered one-line tasks answered before writing, then the volatile limits, then the execution trigger as the final line. Recall keeps a long passage from pushing the constraints out of attention, so the invocation belongs at the very end.

## Consequences

A leading ` thinking` region is stripped before envelope validation, so leaked reasoning becomes a successful call, not a retry. The block is an editable Prompt Profile pair, and the Auditor is disabled behind one comment.
