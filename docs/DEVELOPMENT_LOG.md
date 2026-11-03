# AI Archive — autonomous development log

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

## Archive-state fallback is reported — 2026-11-03 (audit finding 3)

(Appended at the end to avoid merge conflicts with parallel PRs; reorder newest-first once they are merged.)
- **Problem.** When `getArchiveState` failed (for example a GitHub 502 while reading the archive file list), `content.js` silently downloaded every conversation again; the outcome gave no hint why nothing was skipped as unchanged.
- **Change.** `getArchivedState()` now returns the failure reason (sanitized, bounded); it travels in the transfer metadata as `archiveStateError`, is stored in `report.archiveStateError`, and the completion message says "The archive state could not be read (…), so every conversation was downloaded again…" (or, for an automatic sync, that only the latest conversations were checked). The sync is not marked partial: nothing was lost.
- **Tests.** Extension unit tests 191/191 (new: content handoff carries the reason / no reason when the state is readable; background message variants). E2E: unchanged except the pre-existing popup failure fixed by PR #83.
- **Next task.** Index v3 design document (audit finding 1c): move search text out of the single index blob, backward-compatible reader, migration notes. Design only, for owner review.
