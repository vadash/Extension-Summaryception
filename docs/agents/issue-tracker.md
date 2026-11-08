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

- Blockers of an issue, GraphQL `Issue.blockedBy` connection (returns real issues). pwsh-safe shape: query in a variable, values ride `-F`, never inline quotes:

  ```powershell
  $q = 'query($owner: String!, $name: String!, $num: Int!) { repository(owner: $owner, name: $name) { issue(number: $num) { blockedBy(first: 20) { nodes { number state } } } } }'
  gh api graphql -F owner=vadash -F name=Extension-Summaryception -F num=47 -f query=$q --jq '.data.repository.issue.blockedBy.nodes'
  ```

  Loop over numbers from a `.ps1` script file (written with the file tool) to dodge the quoting layer entirely. Never `--input` a raw-GraphQL file (400s); never combine `--input` with `--paginate`.

- `gh --jq` multiline output arrives in pwsh as an array: wrap in `(... | Out-String)` before `-match`/`-replace`/`.Contains`/`.Replace`, which otherwise act element-wise.

- `issueDependenciesSummary` is a **counts-only** summary: its `blockedBy`/`blocking` are `Int`s, not connections. Never select into them.
