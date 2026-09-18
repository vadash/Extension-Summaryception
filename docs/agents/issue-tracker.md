# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues; use the `gh` CLI. Infer the repo from `git remote -v`.

PRs are **not** a triage surface in this repo.

## Wayfinding

Used by `/wayfinder`:

- **Map**: one issue labelled `wayfinder:map`; child tickets are GitHub sub-issues of the map.
- **Blocking**: native GitHub issue dependencies; fall back to a `Blocked by: #<n>` line at the top of the child body.
- **Frontier**: open children with no open blocker and no assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`.
- **Resolve**: comment the answer, close the child, append the context pointer to the map's Decisions-so-far.

### gh api recipes

Verified shapes; GraphQL `repository(owner:…, name:…)` (never `repo:`); `Issue` has no `children` field.

- Map children (sub-issues), REST:

  ```
  gh api repos/{owner}/{repo}/issues/<n>/sub_issues --jq '.[] | {number, title, state, assignees: [.assignees[].login]}'
  ```

- Blockers of an issue, GraphQL `Issue.blockedBy` connection (returns real issues):

  ```
  gh api graphql -f query='query{issue(number:25){blockedBy(first:20){nodes{number state}}}}'
  ```

- `issueDependenciesSummary` is a **counts-only** summary: its `blockedBy`/`blocking` are `Int`s, not connections. Never select into them.
