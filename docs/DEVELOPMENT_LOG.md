# AI Archive — autonomous development log

## GitHub 502 on a large sync — 2026-11-03 (extension 0.5.20)

**Problem.** A real ~812-conversation sync failed with `GitHub 502: Server Error`. Full analysis: `docs/investigations/2026-11-github-502-large-sync.md`.

**Findings (confirmed from code).**
- The bare message can only come from the final `sync()` phase (after Claude fetch and transfer); other phases wrap or swallow GitHub errors differently.
- The exact failed request could not be established: 0.5.19 errors did not name the operation. Most likely candidate: the single POST `/git/trees` carrying every change (≥813 entries), which is size-dependent and would fail all 3 retries. Hypothesis, not proven.
- No partial publication or data loss was possible: all objects stay unreferenced until the branch PATCH, and a failed PATCH is verified by reading the branch back.

**Changes.** Chained tree batches of ≤100 entries (`createTreeInBatches`); read-back verification of the new tree before committing (`verifySyncTree`); 5-attempt jittered retry budget for idempotent requests; errors name the step and attempt count and state when nothing was published. Ref PATCH is still never retried; no multi-commit publication.

**Tests.** `node --test extension/*.test.js` 194/194 pass (5 new tests: 812-conversation batching, transient and persistent 502 on each idempotent step with resume-without-duplicates, PATCH 502, tampered tree). `node e2e/extension-sync.e2e.cjs`: the updated outage checks pass (5 tree attempts, step named in the popup). The E2E later fails at "the sync is reported as finished with problems … #copyDiagnostics" — **this failure is pre-existing**: it fails identically on unmodified `development` (42065b9), apparently since the popup redesign. `cd web && npm test` 80/80 pass; `npm run build` succeeds.

**User verification needed.** Re-run the large sync on 0.5.20; if it fails, report the popup text (now names the step).

**Next task.** Fix the pre-existing E2E popup diagnostics failure (`#copyDiagnostics` never becomes visible after a partial sync), then the AUTOPILOT technical audit (`docs/TECHNICAL_AUDIT.md`).

## Cloud development integration — 2026-11-03

- Updated `CLAUDE.md` and `AUTOPILOT.md` so Claude Code cloud sessions use `development` as the PR base and never target `master`.
- Confirmed `development` is not protected and `master` is the repository default branch.
- An experimental `workflow_run` auto-merge workflow was briefly added, then removed: GitHub only loads `workflow_run` workflows from the default branch, so a workflow committed only to `development` would not run. Moving it to `master` would violate the user's explicit branch boundary.
- Recommended integration path: GitHub native PR auto-merge, enabled in repository settings and used on PRs targeting `development`. It respects configured required checks/reviews and does not require a privileged workflow on `master`.
- **Still requires setup/verification:** enable Allow auto-merge in repository settings and configure `Web CI` as a required check for `development` if the user wants merges to wait for CI. No repository settings or branch protection were changed by this work.
- Existing `Web CI` covers extension syntax checks, extension unit tests, web unit tests and web production build. Browser E2E tests are not part of this CI workflow.

This file is the durable handoff between Claude Code sessions. Keep entries factual and concise. Newest entries go first.

## Baseline handoff — 2026-11-03

### Repository state observed
- Repository: `DarkonLikesCoffee/ai-archive`.
- Working branch: `development`.
- Baseline commit: `37a26a97005c7510b89c11fbbf8c3e85b9aabb46`.
- Extension version: `0.5.19`.
- Web app version: `0.6.15`.
- Latest known GitHub Actions run for this baseline: `41703560130`, conclusion `success`.
- Existing automated tests include extension unit tests, web unit tests, extension browser E2E and viewer browser E2E.
- No `CLAUDE.md` existed at the baseline.

### Recent user testing and outstanding verification
- A real Claude account sync reprocessed six previously incomplete upgraded-workspace conversations.
- The misleading legacy Wiggle sandbox 404 warnings disappeared after the upgraded-workspace handling fix.
- The sync reported six changed conversations and six unchanged conversations skipped.
- **Still unverified:** the user has not yet confirmed that the expected generated files are present and accessible in those six archived conversations. Do not mark this issue fully closed until checked.

### Product decisions already established
- GitHub remains the canonical archive store.
- Markdown is canonical conversation content; attachments are ordinary repository files; index is derived.
- No custom backend/Supabase.
- Claude is first; ChatGPT/Gemini are future providers.
- Work on `development`; do not merge to `master` without explicit user approval and real-world testing.
- Prioritize fidelity, integrity, recoverability and security over feature expansion.

### Next action
Perform the read-only technical audit described in `AUTOPILOT.md`. Write findings to `docs/TECHNICAL_AUDIT.md`, then implement one small, high-priority issue with regression coverage. Do not begin a broad refactor or a new provider.
