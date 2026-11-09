# Call Profile: per-call policy resolved once at dispatch

Every summarizer call resolves one Call Profile from settings and the call category at dispatch time (`resolveCallProfile`, src/core/call-profile.js), and the resolved value is the only thing the request path consumes. Distributing the policy across per-module kind branches was rejected: thirteen branches across six modules re-derived slices of the same decision.
