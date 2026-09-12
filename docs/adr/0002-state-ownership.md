# Per-chat summary state lives with chat metadata

Per-chat summaries live with chat metadata and survive extension reloads; global configuration lives in extension settings. Extension-owned state was rejected: summary provenance and ghosting ownership must stay bound to the chat they summarize, or a reload or chat switch would orphan or leak summary data.
