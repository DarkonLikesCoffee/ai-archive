# AI Archive — autonomous development log

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
