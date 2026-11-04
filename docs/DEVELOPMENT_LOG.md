# AI Archive — autonomous development log

## Session handoff — 2026-11-03 (read this first)

Work from this session was submitted as separate PRs targeting `development`. All have GitHub squash auto-merge enabled. `Web CI` passed on each PR checked; GitHub showed DarkonLikesCoffee/ai-archive#82 as blocked anyway, so a required review or another merge rule is probably holding the merges. Each PR was checked to merge cleanly with the others (`git merge-tree`), and a local merge of #82–#85 passed 198 extension unit tests and 45/45 E2E checks.

| PR | Content |
|---|---|
| #82 | GitHub 502 investigation and large-sync hardening (0.5.20): tree batches, tree verification, 5-attempt retry, step-named errors, index-size guard |
| #83 | Restores the popup "Copy diagnostic report" button; repairs the extension E2E after the popup redesign |
| #84 | `docs/TECHNICAL_AUDIT.md` |
| #85 | Reports when a sync downloaded every conversation because the archive state could not be read |
| #86 | Index v3 design proposal (sharded search caches) — **needs owner decision**; not implemented |
| #87 | Extension E2E as a non-blocking CI job. Red until #83 merges (the failure is that known popup check) |
| #88 | README: where the tokens are stored |
| #89 | Read-only archive integrity verifier (ROADMAP P0.1) and the `web/scripts/verify-archive.mjs` command |

Notes for the next session:
- **Log order.** #83, #84 and #85 add log entries lower in this file, so parallel PRs would not conflict. Once all are merged, move them up so the newest comes first.
- **Branch state.** Start from the latest `development`. Do not stack new work on unmerged PR branches.
- **User verification pending.** Run `web/scripts/verify-archive.mjs` (from #89) against the real archive with a read-only token. Re-run the ~812-conversation sync on 0.5.20 and report the popup text if it fails; the message now names the step. The size of `archive/index.json` on GitHub tells how close the archive is to the 40 MiB index limit.
- **Earlier pending item.** The user still has to confirm the files of the six upgraded-workspace conversations.
- **Next tasks**, in order:
  1. After #83 merges, check that `extension-e2e` is green on `development`.
  2. ROADMAP P0.2: work out which index fields can be rebuilt from Markdown and asset files (design and dry-run only); the verifier from #89 can check any rebuilt index.
  3. Implement index v3 only if #86 is approved.
  4. Audit finding 8: restrict `fetchAsset` to known Claude hosts, after collecting sanitized evidence of real URL shapes.

## GitHub 502 on a large sync — 2026-11-03 (extension 0.5.20)

**Problem.** A real ~812-conversation sync failed with `GitHub 502: Server Error`. Full analysis: `docs/investigations/2026-11-github-502-large-sync.md`.

**Findings (confirmed from code).**
- The bare message can only come from the final `sync()` phase (after Claude fetch and transfer); other phases wrap or swallow GitHub errors differently.
- The exact failed request could not be established: 0.5.19 errors did not name the operation. Most likely candidate: the single POST `/git/trees` carrying every change (≥813 entries), which is size-dependent and would fail all 3 retries. Hypothesis, not proven.
- No partial publication or data loss was possible: all objects stay unreferenced until the branch PATCH, and a failed PATCH is verified by reading the branch back.

**Follow-up.** The index blob (all conversations' gzip search text in one request) is a second size-dependent 502 candidate and has a hard 40 MiB ceiling. Each sync now records `report.index_bytes`, warns from 20 MiB, and fails early with a message naming the index. Shrinking the index needs a format design (`docs/TECHNICAL_AUDIT.md` finding 1c).

**Changes.** Chained tree batches of ≤100 entries (`createTreeInBatches`); read-back verification of the new tree before committing (`verifySyncTree`); 5-attempt jittered retry budget for idempotent requests; errors name the step and attempt count and state when nothing was published. Ref PATCH is still never retried; no multi-commit publication.

**Tests.** `node --test extension/*.test.js` 195/195 pass (6 new tests, including index size: 812-conversation batching, transient and persistent 502 on each idempotent step with resume-without-duplicates, PATCH 502, tampered tree). `node e2e/extension-sync.e2e.cjs`: the updated outage checks pass (5 tree attempts, step named in the popup). The E2E later fails at "the sync is reported as finished with problems … #copyDiagnostics" — **this failure is pre-existing**: it fails identically on unmodified `development` (42065b9), apparently since the popup redesign. `cd web && npm test` 80/80 pass; `npm run build` succeeds.

**User verification needed.** Re-run the large sync on 0.5.20; if it fails, report the popup text (now names the step).

**Next task.** Fix the pre-existing E2E popup diagnostics failure (`#copyDiagnostics` never becomes visible after a partial sync), then the AUTOPILOT technical audit (`docs/TECHNICAL_AUDIT.md`).

## Cloud development integration — 2026-11-03

- Updated `CLAUDE.md` and `AUTOPILOT.md` so Claude Code cloud sessions use `development` as the PR base and never target `master`.
- Confirmed `development` is not protected and `master` is the repository default branch.
- An experimental `workflow_run` auto-merge workflow was briefly added, then removed: GitHub only loads `workflow_run` workflows from the default branch, so a workflow committed only to `development` would not run. Moving it to `master` would violate the user's explicit branch boundary.
- Recommended integration path: GitHub native PR auto-merge, enabled in repository settings and used on PRs targeting `development`. It respects configured required checks/reviews and does not require a privileged workflow on `master`.
- **Still requires setup/verification:** enable Allow auto-merge in repository settings and configure `Web CI` as a required check for `development` if the user wants merges to wait for CI. No repository settings or branch protection were changed by this work.
- Existing `Web CI` covers extension syntax checks, extension unit tests, web unit tests and web production build. Browser E2E tests are not part of this CI workflow.

## Popup diagnostics and E2E repair — 2026-11-03 (after the GitHub 502 work)

- **Problem.** `node e2e/extension-sync.e2e.cjs` failed on `development` (42065b9) since the popup redesign (939e2c2/45bacba): the "Copy diagnostic report" button and its lifecycle code were removed, while `content.js` still stores sanitized `last_sync_diagnostics`, so the report was unreachable. The E2E also still expected the old summary line + `<li>` report list.
- **Changes.** Restored the button (secondary style, hidden unless a report of the current extension version exists; hidden on disconnect and when a sync starts) with a popup unit test. E2E now reads the redesigned report panel (`.report-item`) for what the popup shows and the stored `last_sync.message` for the full summary the redesign hides when a report is present.
- **Tests.** `node --test extension/*.test.js` all pass; `node e2e/extension-sync.e2e.cjs` 45/45 PASS, exit 0.
- **Open product question (not changed).** With a per-conversation report present the popup no longer shows the summary ("N conversations changed in 1 GitHub commit", unchanged/listed counts). Intentional per the redesign; revisit only if the user wants it back.
- **Next task.** AUTOPILOT read-only technical audit → `docs/TECHNICAL_AUDIT.md`.

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
