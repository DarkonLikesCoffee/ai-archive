# AI Archive — autonomous development protocol

This file defines how Claude Code should continue developing the project without requiring a new task prompt for every change. It supplements (and does not replace) `CLAUDE.md`.

## Mission

Continuously improve AI Archive toward a trustworthy, portable, maintainable personal AI-conversation archive. Prefer reliability and data integrity over feature count. Do not optimize for number of commits or lines changed.

## Start-of-session checklist

1. Read `CLAUDE.md`, this file, `ROADMAP.md`, `ARCHITECTURE.md`, `docs/archive-format-v1.md`, and the latest `docs/DEVELOPMENT_LOG.md`.
2. Inspect the worktree, branch, recent commits and current CI. Preserve any uncommitted user work.
3. For Claude Code cloud sessions, select `development` as the base branch and work on the session-managed branch. Open/update a PR targeting `development` when a coherent slice is ready. Do not try to push directly to the protected/base branch. For non-cloud sessions, work on `development`. Never work on `master`.
4. Identify the highest-priority unfinished roadmap item that can be completed safely with available tools and evidence.
5. If a real-account/manual test is needed but unavailable, record it as blocked and select another useful task.

## Continuous work loop

Repeat the following cycle for as long as the Claude Code session remains active and useful work is available:

1. **Choose one task.** Select one small, independently verifiable task from the top of ROADMAP.md. Do not start multiple overlapping refactors.
2. **Understand first.** Trace the relevant code path, inspect existing tests and history, and reproduce the issue where possible.
3. **Define acceptance criteria.** Write down the expected behavior and regression coverage before editing.
4. **Implement.** Make a focused change. Prefer tests first for bug fixes.
5. **Verify.** Run targeted tests, then the full relevant suite/build. For synchronization or data-format changes, run archive round-trip and E2E tests where possible.
6. **Review.** Inspect the full diff and ask: could this lose data, alter old archives, expose secrets, break an older format, or mask an error?
7. **Document.** Update relevant docs and append an entry to `docs/DEVELOPMENT_LOG.md`.
8. **Checkpoint.** Commit the completed slice. In cloud sessions, push through the session branch and open/update a PR targeting `development`; in non-cloud sessions, push verified work to `development` only if the remote branch has not advanced unexpectedly and no sensitive data is included. If GitHub native auto-merge is enabled for the repository, enable it on the PR after the exact PR head commit passes `Web CI`; GitHub will merge only when all configured requirements pass. Do not bypass checks or reviews.
9. **Continue.** Re-read the roadmap and choose the next highest-priority independent task. Do not ask the user what to do next unless a decision genuinely requires their preference or authority.

Do not make a cosmetic change merely to keep the loop busy. If no safe, worthwhile task remains, perform a review of the next roadmap item, document findings, and stop with a clear handoff.

## Priority order

1. Data integrity, correctness, recoverability and security.
2. Real-world Claude export fidelity and robust failure handling.
3. Test quality, diagnostics and observability.
4. Maintainability and provider boundaries.
5. Viewer usability and accessibility.
6. New providers and optional features, only after reliability gates are met.

## Rules for unattended operation

- Do not use `--dangerously-skip-permissions` as a shortcut. Use Claude Code's normal permission controls and a scoped project environment. If a permission prompt blocks progress, leave the operation unperformed and choose another task.
- Do not run destructive shell commands or commands whose effects you cannot explain.
- Do not alter secrets, tokens, browser profiles, personal archives or user data.
- Do not use the user's live Claude session or private archive as an unbounded test fixture.
- Do not create or modify external resources, publish releases, open public issues, or change repository settings.
- In cloud sessions, open PRs targeting `development` after verification; do not merge them yourself. GitHub native auto-merge handles eligible merges when enabled in repository settings and all required checks/reviews pass. Never target or push to `master`.
- Never claim live Claude compatibility based solely on mocks or unit tests.
- If tests fail, investigate and fix the cause. Do not continue stacking unrelated features on a failing baseline.
- If a failure cannot be resolved safely, document the exact command, failure, likely cause and next step; then work on a different independent task.

## Context-window handoff

Before context compaction or when nearing a stopping point:
1. Finish or safely checkpoint the current task; do not leave half-applied migrations.
2. Update `docs/DEVELOPMENT_LOG.md` with current commit, task state, test results, decisions, blockers and the exact next action.
3. Update roadmap status accurately.
4. Ensure no uncommitted changes are silently abandoned.
5. Continue from the written state after compaction/new context. Do not assume prior chat history is available.

## Definition of done

A task is done only when:
- the behavior is implemented or the finding is documented;
- relevant regression tests exist and pass;
- the relevant build passes;
- no existing tests were weakened or removed;
- documentation and progress state are updated;
- the diff has been reviewed;
- the commit is focused and the branch state is known.

## First autonomous assignment

Begin with a **read-only technical audit**, not a large refactor:
- inspect current code, tests, workflow, recent commits and existing documentation;
- compare implementation against the archive contract;
- identify the highest-risk data-loss, integrity, recovery and security gaps;
- write a ranked, evidence-backed audit to `docs/TECHNICAL_AUDIT.md`, citing exact files/functions/tests and distinguishing confirmed defects from hypotheses;
- do not expose private data or secrets;
- then select the first small, testable P0/P1 improvement from the audit and implement it if safe.
After this first audit, continue the normal work loop using ROADMAP.md.

## Standing findings from real-archive checks (keep current)

- **First integrity run (2026-11-06, web 0.6.16), on the owner's archive:** 824 conversations, 1,420 attachments hashed, 0 download failures, 6 errors and 60 warnings. Diagnosis: `docs/investigations/2026-11-first-integrity-run.md`.
  - The 6 errors are 2 links in one conversation, counted once per occurrence. They point into **other** conversations' legacy attachment folders, which the exporter never writes; most likely quoted text.
  - The 4 incomplete conversations are the 7 oversized attachments.
  - The 56 unreferenced files are not yet classified.
- **Rules for these findings:**
  - Do not delete, move or rewrite any of these files, and do not rebuild or publish the index on your own.
  - Repairs wait for the owner's `--markdown --history` run and an explicit decision per category.
- **Image previews (2026-11-10, extension 0.5.29, not yet live-verified):** 729 archived images are Claude's WebP previews stored under `.png`/`.jpg` names (726 unique, 722 not yet recovered, in 241 conversations; 114 of them under a second archive profile). Root cause: the exporter downloaded `preview_asset.url` for every image and never asked the Files API for the original. 0.5.29 archives originals first. Already-archived conversations are untouched until re-exported. Do not start a bulk re-export or recovery without the owner's approval; the live check must use a separate test repository.
- **Next action:** ask for, then analyse, the `kind` summary of the 0.6.17 report. Only then propose category-specific, reviewed repairs, for example re-syncing `linked-not-indexed` conversations or reviewing `conversation-not-indexed` files with `--rebuild-dry-run`.

