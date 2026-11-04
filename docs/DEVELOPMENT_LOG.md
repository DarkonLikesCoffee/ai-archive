# AI Archive — autonomous development log

This file is the durable handoff between Claude Code sessions. Keep entries factual and concise. Newest entries go first.

## Skip repeated downloads of recorded oversized files — 2026-11-04 (extension 0.5.22, ROADMAP P1.3)

- **Problem.** Confirmed on the real archive: 7 attachments over the limit, in 4 incomplete conversations, are downloaded in full (more than 210 MiB) on every sync, then left out.
- **Analysis** (`docs/design/oversized-downloads.md`):
  - HTTP headers can establish a file's *size* before its body is read, but only for a strict 200 with an exact decimal `Content-Length`, no content coding and no range.
  - They cannot establish its *identity*. The SHA-256 drives deduplication, message matching and asset path collisions, and it is recorded in the index.
  - Four approaches compared: A, skip by `Content-Length` alone (loses identity); B, skip only a file the archive already recorded, when its exact size is confirmed; C, skip such conversations (changes invariant 9); D, stream-hash (saves no bandwidth).
- **Implemented B.**
  - The background's `getArchiveState` also returns the recorded oversized files: file UUID, size and SHA-256, excluding GitHub-refused files.
  - `canSkipOversizedDownload` / `fetchAsset` in `content.js` cancel the body only when every condition holds. The skipped asset carries the recorded identity and no bytes, so it is still not archived, and the Markdown and index are byte-identical.
  - Any missing, compressed, ambiguous, changed or conflicting size downloads as before. Retry behaviour is unchanged: the conversation is still re-fetched every sync.
- **Tests.**
  - `node --test extension/*.test.js`: 204/204, including a test of which recorded files the archive state lists. New: the known-size case, and 13 must-download cases (unknown size, changed file, misleading or ambiguous sizes, mismatched records, no archive state).
  - Harness change: mocked downloads now answer per header name and record body reads and cancels.
  - `node e2e/extension-sync.e2e.cjs`: 48/48. The repeat sync of a 31 MiB file skips the download and makes no commit.
- **Live verification pending.** Do Claude's real download endpoints send `Content-Length` without compression? If not, behaviour is as before. After a 0.5.22 sync, the summary should say "7 attachments over the upload limit were not downloaded again".
- **Residual risk (documented).** If Claude ever served different bytes of exactly the same size under the same file UUID, the recorded SHA-256 of that not-archived file would be stale. No archived bytes are affected.
- **Next task.** ROADMAP P0.3, the sync correctness and atomicity review.

## Oversized attachments after the real 0.5.20 sync — 2026-11-04 (extension 0.5.21)

**User report.** The real sync on 0.5.20 succeeded with no 502.
- Claude listed 802 conversations: 798 were skipped as unchanged and 4 incomplete ones were retried.
- 7 attachments in those 4 conversations exceeded the ~30 MiB limit.
- The attachment report was visible, but **Copy diagnostic report** was missing.

**1. Diagnostic button: confirmed bug, fixed.**
- Diagnostics are written by `content.js` (`storeDiagnostics`, carrying the running manifest version) and loaded by the popup (`loadDiagnostics` / `isCurrentDiagnosticReport`). Storage, version matching and loading work correctly.
- The problem: an item was only created when the content script's own `conversation.incomplete` was non-empty. Oversized files are only marked as left out by the background (`normalizeAssetList`), so a sync whose only problems were oversized files stored `items: []`, and the popup correctly hid the button.
- Fix: `runSync` adds one problem per asset over `MAX_ARCHIVED_FILE_BYTES`, recording kind, reason, message id, extension, size and limit, never the file name.
- Tests:
  - content unit test (fails without the fix);
  - E2E check that the button appears and the copied report names the problem without the file name;
  - the existing privacy assertions still hold.

**2. Index and Markdown representation: verified with exporter output, no bug found.**
- An oversized file is not listed in `assets[]`.
- `incomplete[]` keeps `{kind, name, message_external_id, reason, too_large, sha256, size}`.
- The Markdown has `**Not archived: <name>** (<size>; larger than the 30.0 MiB AI Archive can upload through GitHub's API)` where the file was attached.
- New regression test for exactly this, plus an integrity-verifier check (`incomplete-note-missing`, with `--markdown`) so the real archive can be checked read-only.
- The real archive was **not** read; the owner can run the verifier.

**3. Repeat syncs.**
- Confirmed correct: an oversized file is never uploaded (size check before any request), and a repeat sync with identical data makes no commit. Covered by a new unit test and a new E2E check.
- Confirmed inefficiency, not fixed: the conversation stays incomplete, so every sync re-fetches it and downloads the oversized bytes in full from Claude before leaving them out. Recorded in ROADMAP P1.3 with two options. One of them, skipping such conversations, changes invariant 9 and needs owner approval.

**4. Limit and wording.**
- The limit is `MAX_ARCHIVED_FILE_BYTES` = 31,457,232 bytes, i.e. 30 MiB − 48 B (the base64 of a 40 MiB JSON blob request). It is the same in `content.js` and `background.js`, and it was **not changed**.
- Inconsistencies found and fixed outside the archive files:
  - The README's current-behaviour text said "over 100 MB". Fixed.
  - The sync report called these files "too large to upload to GitHub", although they were never sent. It now says "over AI Archive's 30.0 MiB upload limit", with exact bytes near the limit, where both values used to round to "30.0 MiB". Files GitHub actually refused (HTTP 422) now say "refused by GitHub as too large to process".
- Left as is, deliberately: the Markdown/index reason text ("30.0 MiB; larger than the 30.0 MiB …" for a file just over the limit). Changing it would rewrite the 4 archived conversations on the next sync.

**Tests.**
- `node --test extension/*.test.js`: 201/201.
- `cd web && npm test`: 89/89; `npm run build` passes.
- `node e2e/extension-sync.e2e.cjs`: 47/47, exit 0.
- Expected-output updates: only the report label text in 3 unit tests and 3 E2E checks, which now assert the new exact wording.

**Notes for the owner.**
- 802 listed versus the ~812 conversations mentioned before: if the archive still holds about 812 entries, the full-sync message should have said that some archived conversations were not returned by Claude. Their archived copies are kept.
- Next task: ROADMAP P1.3 option (a), design only, or whichever option the owner picks.

## Index rebuild analysis and dry run — 2026-11-04 (ROADMAP P0.2)

- **Question.** Can `archive/index.json` be rebuilt from the canonical Markdown and attachment files, and what would a rebuild lose?
- **Answer** (in `docs/design/index-rebuild.md`):
  - Exact: identity, title, model, timestamps, message count, path, `content_sha256`, attachment paths, sizes and SHA-256 (the last needs the bytes).
  - Approximate: attachment names and MIME types, preview and search text.
  - Not recoverable: `exporter_version`, `format_version`, and `incomplete[]` details.
  - Markdown without a metadata block has no recoverable identity.
- **Implemented.**
  - `web/src/indexRebuild.js`: a dry-run plan that never writes and has no apply step.
  - `verify-archive.mjs --rebuild-dry-run`.
- **Tests.** 4 new tests in `web/src/indexRebuild.test.js` use the real exporter (loaded from `extension/background.js`) to produce fixtures:
  - every exact field round-trips;
  - a matching index yields zero differences;
  - a damaged index is diagnosed (drift, missing entry, dangling entry, unreadable legacy file);
  - missing files and "not archived" notes are reported, never invented.
  Results: `cd web && npm test` 88/88 pass; `npm run build` passes. The command was smoke-tested against a fake GitHub API.
- **Not done (needs owner review).** The apply step. Its proposed rules: merge, never replace; keep unrecoverable fields only while `content_sha256` matches; never remove entries; write one verified commit.
- **Next task.** Audit finding 8 needs real URL evidence, and index v3 needs approval of #86. Without those, the next independent item is ROADMAP P1.2: audit diagnostic reports for privacy and usefulness, and add the categories source-unavailable, fetch-failed, transfer-failed, validation-failed and upload-refused.

## PR integration of #82–#89 — 2026-11-04

- **Problem.** All eight PRs had squash auto-merge enabled, passing `test-and-build` and `mergeable_state: clean`, but none merged. None was behind `development` at the time.
- **Findings.**
  - The `development` ruleset (id 26481969) requires: a PR (0 approvals, squash only), the `test-and-build` check on an up-to-date branch (strict), no force pushes, and code quality results. Code scanning is `not-configured`, yet GitHub reports the PRs as `clean`, so the code-quality rule did not block.
  - Auto-merge only acts on an event. The checks had finished before the PRs became mergeable under the ruleset, so nothing triggered it.
  - GitHub refuses to arm auto-merge on a PR that is already `clean` ("Pull request is in clean status").
- **What was done.**
  - #82: re-ran its `test-and-build` run, which made the check pending, and re-armed auto-merge; GitHub merged it when the check passed.
  - The strict up-to-date rule then made every other PR behind. Each was updated in turn by merging `development` into its branch (no history rewrite), tested locally, pushed, and merged by auto-merge.
  - Twice GitHub did not process a branch push: the PR head stayed stale and no CI run started. Each time a real content commit was pushed instead of an empty one: the audit status table (#84) and this log entry (#88).
  - No settings, rules or `master` were changed. Nothing was merged by hand.
- **Verification.** Before integrating, all seven remaining branches were merged locally on top of #82: extension unit tests 198/198, web tests 84/84, build OK, extension E2E 45/45 (exit 0). Each updated branch passed `test-and-build` in CI before merging.
- **Order.** Merged as #82, #83, #84, #85, #86, #87, #89, #88.
- **Next tasks**, in order:
  1. ROADMAP P0.2: work out which index fields can be rebuilt from Markdown and asset files. Design and dry run only; use the verifier from #89 to check any rebuilt index.
  2. Implement index v3 only if the #86 design is approved by the owner.
  3. Audit finding 8 (`fetchAsset` host restriction): needs sanitized evidence of real URL shapes first.
- **User verification still pending.**
  - Re-run the ~812-conversation sync on 0.5.20.
  - Run `web/scripts/verify-archive.mjs` on the real archive with a read-only token.
  - Confirm the files of the six upgraded-workspace conversations.

## Session handoff — 2026-11-03 (superseded: every PR listed below merged on 2026-11-04)

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

## Archive-state fallback is reported — 2026-11-03 (audit finding 3)

- **Problem.** When `getArchiveState` failed (for example a GitHub 502 while reading the archive file list), `content.js` silently downloaded every conversation again; the outcome gave no hint why nothing was skipped as unchanged.
- **Change.** `getArchivedState()` now returns the failure reason (sanitized, bounded); it travels in the transfer metadata as `archiveStateError`, is stored in `report.archiveStateError`, and the completion message says "The archive state could not be read (…), so every conversation was downloaded again…" (or, for an automatic sync, that only the latest conversations were checked). The sync is not marked partial: nothing was lost.
- **Tests.** Extension unit tests 191/191 (new: content handoff carries the reason / no reason when the state is readable; background message variants). E2E: unchanged except the pre-existing popup failure fixed by PR #83.
- **Next task.** Index v3 design document (audit finding 1c): move search text out of the single index blob, backward-compatible reader, migration notes. Design only, for owner review.

## Technical audit — 2026-11-03

- Wrote `docs/TECHNICAL_AUDIT.md` (read-only; ranked, evidence-backed). Top finding: `archive/index.json` is uploaded as one blob with gzip search text for every conversation; past the 40 MiB request limit every sync fails with a message that does not name the index. It is also a second plausible size-dependent source of the 812-conversation 502.
- Next task: record the index size in each sync outcome, warn near the limit, and name the index in the error (audit finding 1 a/b), with regression tests.

## Popup diagnostics and E2E repair — 2026-11-03 (after the GitHub 502 work)

- **Problem.** `node e2e/extension-sync.e2e.cjs` failed on `development` (42065b9) since the popup redesign (939e2c2/45bacba): the "Copy diagnostic report" button and its lifecycle code were removed, while `content.js` still stores sanitized `last_sync_diagnostics`, so the report was unreachable. The E2E also still expected the old summary line + `<li>` report list.
- **Changes.** Restored the button (secondary style, hidden unless a report of the current extension version exists; hidden on disconnect and when a sync starts) with a popup unit test. E2E now reads the redesigned report panel (`.report-item`) for what the popup shows and the stored `last_sync.message` for the full summary the redesign hides when a report is present.
- **Tests.** `node --test extension/*.test.js` all pass; `node e2e/extension-sync.e2e.cjs` 45/45 PASS, exit 0.
- **Open product question (not changed).** With a per-conversation report present the popup no longer shows the summary ("N conversations changed in 1 GitHub commit", unchanged/listed counts). Intentional per the redesign; revisit only if the user wants it back.
- **Next task.** AUTOPILOT read-only technical audit → `docs/TECHNICAL_AUDIT.md`.

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
