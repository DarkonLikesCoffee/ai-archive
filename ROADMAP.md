# AI Archive — product and engineering roadmap

This is a prioritized, living roadmap. It is deliberately reliability-first. Update status only when acceptance criteria are met and tested.

## Product north star

A user should be able to export years of conversations from supported AI providers into a portable archive, trust that messages and files were preserved faithfully, browse/search the archive independently, and recover from sync failures without silent loss.

## Current scope

- Implemented provider: Claude.ai.
- Export surface: Chromium Manifest V3 extension.
- Storage: GitHub repository; Markdown conversations, repository attachment files, rebuildable `archive/index.json`.
- Viewer: React + Vite static web app.
- No custom backend or database.
- Future providers: ChatGPT and Gemini, after Claude reliability gates.

## P0 — Trust and data integrity

### P0.1 Archive integrity verifier
- [ ] Add a read-only integrity audit that walks the index and verifies every referenced conversation and asset exists.
- [ ] Verify SHA-256 and recorded byte sizes where metadata exists.
- [ ] Detect orphaned assets, duplicate identities/paths, broken Markdown asset references, missing index entries and malformed metadata.
- [ ] Produce a human-readable report with severity and exact paths; never repair or delete automatically.
- [ ] Add unit tests using synthetic fixtures and a documented invocation.

Acceptance: a deliberately corrupted fixture produces precise findings; a clean fixture produces zero errors; the tool never mutates the archive.

### P0.2 Index rebuild and archive recovery design
- [ ] Determine whether all required index fields can be reconstructed from canonical Markdown and asset files.
- [ ] Document fields that cannot be reconstructed and why.
- [ ] Design a dry-run-first index rebuild with backup, validation and explicit apply step.
- [ ] Do not implement destructive repair until the design is reviewed and tested.

Acceptance: recovery behavior is documented, tested against historical format fixtures and cannot silently overwrite canonical content.

### P0.3 Sync correctness and atomicity review
- [ ] Audit every failure path from Claude discovery through download, transfer, Git object creation and branch publication.
- [ ] Verify incomplete exports cannot overwrite complete archived versions.
- [ ] Verify cancellation, lost responses, concurrent branch changes and retry behavior.
- [ ] Add regression tests for each confirmed gap.

Acceptance: each failure mode has a test and documented user-visible outcome; no false-success state remains.

### P0.4 Attachment verification
- [ ] Verify message-level file references, generated workspace files, legacy sandbox files, inline media and tool-result media.
- [ ] Verify each saved file's bytes, MIME, size and SHA-256 against its source when possible.
- [ ] Distinguish unavailable-at-source from download-failed and GitHub-upload-refused.
- [ ] Keep real-account validation pending until the user checks representative exported files.

Acceptance: synthetic tests cover all known payload shapes; manual real-account test checklist is documented; no claim of live correctness without actual verification.

## P1 — Reliability and operational quality

### P1.1 Real-world regression harness
- [ ] Build sanitized, synthetic fixtures based on observed Claude response shapes.
- [ ] Cover edited branches, tool inputs/results, artifacts, generated files, upgraded workspaces, pagination, large messages and malformed responses.
- [ ] Ensure fixtures contain no personal text, credentials, cookies, private URLs or real account IDs.
- [ ] Add a manual checklist for live Claude tests that mocks cannot replace.

### P1.2 Diagnostics
- [ ] Audit diagnostic reports for usefulness and privacy.
- [ ] Ensure reports identify endpoint/shape/status without including message content, secrets, file contents or sensitive identifiers.
- [ ] Add clear categories for source-unavailable, fetch-failed, transfer-failed, validation-failed and upload-refused.
- [ ] Ensure stale reports cannot be mistaken for the latest sync.

### P1.3 Repository growth and GitHub limits
- [ ] Measure repository size, tree entry count, blob count and index size.
- [ ] Document practical GitHub API and Git repository limits relevant to this design.
- [ ] Estimate growth under realistic conversation/attachment workloads.
- [ ] Propose thresholds and warnings before considering storage changes.
- [ ] Never rewrite Git history or delete historical data as an automatic optimization.

### P1.4 Security and privacy review
- [ ] Review extension token storage, viewer token storage and disconnect behavior.
- [ ] Review Markdown rendering, HTML sanitization, link protocols, attachment URL allowlists and authorization headers.
- [ ] Review message/asset path traversal and filename normalization.
- [ ] Document threat model and privacy boundaries.
- [ ] Consider per-conversation exclusion only after designing how exclusions interact with full sync and deletions.

## P2 — Maintainability

### P2.1 Provider boundary
- [ ] Map Claude-specific parsing/normalization currently mixed with shared sync/storage logic.
- [ ] Define a minimal provider adapter interface based on actual requirements.
- [ ] Keep the archive contract provider-neutral.
- [ ] Extract code incrementally with characterization tests; avoid a broad rewrite.

### P2.2 Code health
- [ ] Identify oversized modules and high-coupling functions.
- [ ] Extract only boundaries with clear responsibilities and regression coverage.
- [ ] Improve comments where they explain non-obvious invariants rather than restating code.
- [ ] Keep dependency count low and review dependency updates deliberately.

### P2.3 Documentation and release discipline
- [ ] Keep README version notes accurate.
- [ ] Document setup, sync behavior, known limitations and troubleshooting.
- [ ] Document version bump rules for extension exporter changes and web-only changes.
- [ ] Maintain migration notes for archive/index format changes.
- [ ] Add a release checklist.

## P3 — Viewer improvements

- [ ] Add archive health status without mutating data.
- [ ] Improve large archive performance based on profiling, not assumptions.
- [ ] Review accessibility, keyboard navigation, mobile layout and error states.
- [ ] Make search behavior and indexing limitations explicit.
- [ ] Add export/print/download affordances only where they preserve portability and security.

## P4 — Additional providers and advanced features

Do not start these until P0 is complete and P1 reliability gates are met.

- [ ] ChatGPT provider adapter and sanitized fixtures.
- [ ] Gemini provider adapter and sanitized fixtures.
- [ ] Provider capability matrix (branches, files, tools, timestamps, pagination).
- [ ] Provider-specific failure and compatibility documentation.
- [ ] Optional import/export interoperability.

## Explicit non-goals unless the user changes direction

- No hosted backend, Supabase, Firebase or paid infrastructure.
- No AI summarization or transformation of archived conversation content by default.
- No automatic deletion or rewriting of canonical archive data.
- No uploading private conversation samples to the public source-code repository.
- No feature expansion at the expense of export fidelity.
- No merging into `master` without explicit user approval and real-world testing.

## Prioritization rules

When choosing the next task, rank by:
1. Potential data loss or corruption.
2. Security/privacy impact.
3. Incorrect success reporting or unrecoverable failure.
4. Reliability gaps affecting real users.
5. Maintainability that blocks safe progress.
6. UX friction.
7. New features.

A task should be small enough to implement, test and review as one coherent change. Split broad roadmap items into independently verifiable slices.
