# Remote CI Observation - riv-gate2-runtime (2026-03-12)

## Goal
Capture remote GitHub Actions evidence for strict `riv-gate2-runtime` gating after Phase 4 updates.

## Repository Observed
- Repo: `Hansuqwer/OpencodeRiveIMG-Plugin`
- URL: `https://github.com/Hansuqwer/OpencodeRiveIMG-Plugin`
- Default branch: `main`
- Visibility: public

## Commands Run (Remote)
- `gh auth status`
- `gh repo view Hansuqwer/OpencodeRiveIMG-Plugin --json name,defaultBranchRef,isPrivate,url`
- `gh workflow list --repo Hansuqwer/OpencodeRiveIMG-Plugin`
- `gh workflow view ci.yml --repo Hansuqwer/OpencodeRiveIMG-Plugin --yaml`
- `gh run list --repo Hansuqwer/OpencodeRiveIMG-Plugin --limit 30 --json databaseId,workflowName,displayTitle,headBranch,headSha,status,conclusion,event,createdAt,updatedAt,url`
- `gh api repos/Hansuqwer/OpencodeRiveIMG-Plugin/actions/workflows`
- `gh api repos/Hansuqwer/OpencodeRiveIMG-Plugin/branches/main --jq '{protected: .protected, required_status_checks: .protection.required_status_checks}'`
- `gh api repos/Hansuqwer/OpencodeRiveIMG-Plugin/commits/fefac5b66f9a1edb6311086ef4929dd65c8258ef/check-runs --jq '{total_count: .total_count, check_runs: [.check_runs[] | {name: .name, status: .status, conclusion: .conclusion, app: .app.slug}]}'`
- Enumerated remote branches and checked each for `.github/workflows/ci.yml`

## Remote Findings
1. GitHub CLI auth is valid for account `Hansuqwer`.
2. `gh api repos/.../actions/workflows` returned `{ "total_count": 0, "workflows": [] }`.
3. `gh workflow view ci.yml` returned HTTP 404 (`workflow ci.yml not found on the default branch`).
4. `gh run list` returned `[]` (no workflow runs found).
5. Branch protection reports no required checks:
   - `protected: false`
   - `required_status_checks.enforcement_level: off`
   - `required_status_checks.contexts: []`
6. Latest main commit check-runs are empty:
   - `total_count: 0`
   - `check_runs: []`
7. Branch sweep confirms no CI workflow file on remote heads:
   - `main: no .github/workflows/ci.yml`
   - `master: no .github/workflows/ci.yml`

## Local Strict-Gate Context (for comparison)
Local workflow declares strict Gate 2 matrix job in `.github/workflows/ci.yml`:
- Job id: `riv-gate2-runtime`
- Matrix: `ubuntu-latest`, `macos-latest`, `windows-latest`
- Node: `22`
- Test env flags:
  - `RUN_RIVE_GATE2=1`
  - `RUN_RIVE_GATE2_EXPECT_PASS=1`

Additional local policy references:
- `HANDOVER.md` states strict CI job and required status posture for Gate 3.

## Execution Update (Published + Triggered)
Follow-up execution completed after initial observation:

1. Published branch: `phase4/remote-ci-evidence`
   - Commit: `e21cd1401d208160103952178cda00fe760e7eb3`
2. Opened PR: `https://github.com/Hansuqwer/OpencodeRiveIMG-Plugin/pull/1`
   - Base: `master`
   - Head: `phase4/remote-ci-evidence`
3. Triggered CI run via `pull_request` event:
   - Run ID: `23007034102`
   - Run URL: `https://github.com/Hansuqwer/OpencodeRiveIMG-Plugin/actions/runs/23007034102`
   - Workflow: `CI`

## Run Evidence (riv-gate2-runtime)
`riv-gate2-runtime` matrix jobs were created and executed as strict checks:

- `gate2-runtime / ubuntu-latest / node-22` (job `66806693172`) -> `failure`
- `gate2-runtime / windows-latest / node-22` (job `66806693196`) -> `failure`
- `gate2-runtime / macos-latest / node-22` (job `66806693227`) -> `failure`

Each `riv-gate2-runtime` check-run annotation message is identical:

> "The job was not started because your account is locked due to a billing issue."

This was confirmed through each check-run annotation endpoint.

## Conclusion
Remote CI evidence is now captured end-to-end: workflow publication, PR-triggered run creation, and strict `riv-gate2-runtime` job records. The current blocker is not pipeline logic but GitHub billing lock on the account, which prevents job execution from starting.

## Next Required Step
Resolve GitHub billing lock, then re-run PR CI (or re-run failed jobs) to collect pass/fail evidence for runtime execution itself.
