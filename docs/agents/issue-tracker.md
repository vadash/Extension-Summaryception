# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues; use the `gh` CLI. Infer the repo from `git remote -v`.

PRs are **not** a triage surface in this repo.

## Wayfinding

Used by `/wayfinder`:

- **Map**: one issue labelled `wayfinder:map`; child tickets are GitHub sub-issues of the map.
- **Blocking**: native GitHub issue dependencies; fall back to a `Blocked by: #<n>` line at the top of the child body.
- **Frontier**: open children with no open blocker and no assignee. Map order is sub-issue creation order, so the first row is the next ticket.
- **Claim**: `gh issue edit <n> --add-assignee @me`.
- **Resolve**: comment the answer, close the child, append the context pointer to the map's Decisions-so-far.

### gh api recipes

Verified shapes; GraphQL `repository(owner:…, name:…)` (never `repo:`); `Issue` has no `children` field.

- **Frontier in one call** (number, title, assignee count, open-blocker count):

  ```
  q='query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){issue(number:$num){subIssues(first:50){nodes{number title state assignees(first:5){nodes{login}} blockedBy(first:20){nodes{number state}}}}}}}'
  gh api graphql -F owner=<owner> -F name=<repo> -F num=<map> -f query="$q" --jq '.data.repository.issue.subIssues.nodes[] | select(.state=="OPEN") | "\(.number) \(.title) | assignees=\(.assignees.nodes|length) blockers=\([.blockedBy.nodes[]|select(.state=="OPEN")]|length)"'
  ```

- **Map children** (sub-issues), REST: `gh api repos/<owner>/<repo>/issues/<n>/sub_issues --jq '.[] | {number, title, state, assignees: [.assignees[].login]}'`

- **Blockers of one issue**: the same GraphQL shape with `blockedBy(first:20){nodes{number state}}`.

- **Multi-line GraphQL**: hold the query in a single-quoted variable, pass it with `-f query="$q"`. Never `--input` a raw-GraphQL file (400s); never combine `--input` with `--paginate`.

- **Map body edit**: `gh issue view <n> --json body --jq .body > map.md`, edit the file with the file tool, then `gh issue edit <n> --body-file map.md`.

- **Counts trap**: `issueDependenciesSummary` is counts-only — its `blockedBy`/`blocking` are `Int`s, not connections. Never select into them.

- **In PowerShell**: `gh --jq` multiline output arrives as an array; wrap in `(… | Out-String)` before `-match`/`-replace`/`.Contains`/`.Replace`.
