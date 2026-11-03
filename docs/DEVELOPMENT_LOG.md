# AI Archive — autonomous development log

## Cloud development integration — 2026-11-03

- Added `.github/workflows/auto-merge-development.yml`.
- It listens for successful completion of the existing `Web CI` workflow on pull-request events.
- It resolves PRs associated with the exact tested commit and only merges same-repository PRs whose base is `development` and whose head SHA matches the successful CI run.
- Merge strategy is squash. It does not check out or execute PR code in the privileged workflow and does not use admin/bypass flags.
- Updated `CLAUDE.md` and `AUTOPILOT.md`: Claude Code cloud sessions should use `development` as the base, work on their session branch, and open PRs targeting `development`; automation handles integration after CI.
- `master` remains excluded.
- **Not yet verified:** this workflow has not yet been exercised by a real Claude Code cloud PR. Confirm the workflow-run trigger, permissions and GitHub merge policy on the first test PR. If repository rules require review, the workflow will not bypass them.
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
