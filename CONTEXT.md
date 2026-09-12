# Summaryception

Browser-only SillyTavern extension for recursive layered summarization. Summarized messages stay visible in chat but are hidden from model context.

## Language

**Layer**:
A container of summary snippets at one summarization depth. Layer 0 holds narratives and the state snapshot; deeper layers hold merged older snippets.
_Avoid_: Tier, level

**Snippet**:
One summary text unit inside a layer, owned by the store and carrying stable message-identifier provenance.

**Promotion**:
Moving merged older snippets from a layer into the next deeper layer.

**Ghosting**:
Hiding summarized turns from model context through the host command while keeping them visible in chat.

**Verbatim Window**:
The recent chat range kept in model context without summarization.

**State Snapshot**:
A bounded rolling snapshot of roleplay state. Only the newest snapshot reaches the prompt.

**Mutation Epoch**:
A counter bumped on every summary layer or snippet mutation. Consumers use it to detect stale derived data.

**Effective Settings**:
Runtime settings with the extension-Off mode resolved to `enabled: false`. Runtime behavior reads these, never raw settings.

**Memory Mode**:
How raw chat converts into summaries. Either Balanced or Prefix Cache.
_Avoid_: Append Only

**Route Plan**:
The set of request routes (new summary, deeper merge, fallback) built for one run.

**Engine Gate**:
The single gate that owns all automatic summarization work and its guards.

**Pause Latch**:
The persisted `autoPaused` flag set by Stop. Automatic cycles respect it; manual runs do not.
