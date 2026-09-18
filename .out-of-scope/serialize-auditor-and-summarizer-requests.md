# Serialized Auditor and Summarizer Requests

The Auditor and the macro summarizer may dispatch concurrently over the shared Layer 0 connection. No mutual exclusion or lease between the two request paths will be added.

## Why this is out of scope

On a turn where a summarization batch is ready, the message hook schedules the summarizer while the auditor run may start in the same window; both end in a non-streaming generation call on the same connection. That collision is real in code, but the harm is not: whether local or proxy backends actually break under two concurrent raw calls (dropped connections, requests that queue forever) is unconfirmed platform behavior, and no collision has ever been observed in the wild or the test suite.

A guard would have to live inside the existing request router — the Continuity Engine decision pins the auditor to the shared connection, so a standalone mutex beside the router is the wrong shape. That means touching the busiest serialization path in the extension to defend against a failure nobody has seen.

Revisit this if dropped or hung requests get observed and attributed to auditor/summarizer overlap. The direction is already sketched: gate the auditor dispatch on live-request state, or lease the summarizer queue — never a second mutex.

## Prior requests

- #33: "Serialize Auditor and macro summarizer request paths"
