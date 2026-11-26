# Approved Preserved Messages move from raw chat into global memory

A Preserved Message is selected before summarization and keeps an approved, regex-rendered body. It stays only in raw chat until the first later Layer 0 commit, then Ghosting hides the raw copy and Memory Injection renders one anchored `<preserved>` block; it never becomes a Snippet. The Chat Store owns the record (ADR-0002), and Clear removes it through that owner (ADR-0027).

**Approved snapshot, not live projection.** The body approved in the confirmation preview is immutable. Later edits, swipe changes, and regex-preset changes do not rewrite it; deleting the source message or running Clear removes it. Live rendering was rejected because a preset change could silently alter established memory.

**Full prompt regex set by default.** Preservation approval defaults to every eligible prompt regex script without source-depth filters. A Preserved Message becomes global memory, so its former chat depth must not keep depth-gated cleanup from applying; depth-scoped formatting scripts apply too. Preserving the source-depth filter was rejected because it left such cleanup in global memory.

**Per-approval cleanup.** The confirmation modal can restore source-depth regex, disable the shared CN cleaner, or strip markup to visible text. These choices rebuild only the proposed preview and snapshot, are not saved, and never affect other extension paths; the approved result freezes the body the user confirms.

**Global chronology without Promotion barriers.** Main Memory Injection orders snippets and Preserved Messages by current source position across Layer 0 and Layer 1+. Promotion remains snippet-only and may cross a preserved position; the preserved block follows the snippet whose source range contains it. Promotion barriers were rejected because they make memory unnecessarily rigid.

**Exact text outside image compression.** Preserved blocks stay literal text, appear only once when a template repeats its memory placeholder, and are excluded from Microfiche pages and Promotion pressure. Their tokens still count toward actual injection cost and context-overage reporting; imaging or treating them as compressed memory would lose the exact approved body.
