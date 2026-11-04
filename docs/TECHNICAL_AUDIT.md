# AI Archive — technical audit

Date: 2026-11-03. Base: `development` at 42065b9 (extension 0.5.19, web 0.6.15), plus the open PRs DarkonLikesCoffee/ai-archive#82 (GitHub 502 / large syncs) and DarkonLikesCoffee/ai-archive#83 (popup diagnostics, E2E repair).

Scope: read-only review of `extension/background.js` (sync, GitHub, transfer), `extension/content.js` (Claude fetch, incremental sync, diagnostics), `extension/popup.js`, the web viewer's GitHub and attachment code, CI and tests. No private data was used. **Confirmed** means verified in code or with a test; **Hypothesis** means plausible and not yet reproduced.

## Status (updated 2026-11-04)

| Finding | Status |
|---|---|
| 1a/1b index size measured, warned and named in the error | Done in #82 (merged) |
| 1c index v3 design | Proposed in #86; needs owner decision |
| 2 failed large sync restarts from zero | Open design question for the owner |
| 3 archive-state fallback reported | #85 |
| 4 popup hides summary when a report exists | Product question, unchanged |
| 5 diagnostics button | Done in #83 (merged) |
| 6 browser E2E in CI | #87 (non-blocking job) |
| 7 token storage guidance | #88 |
| 8 `fetchAsset` host restriction | Open; needs sanitized evidence of real URL shapes |

## Ranked findings

### 1. P1 — `archive/index.json` has a hard size ceiling that would block every sync — Confirmed (limit), Hypothesis (when it is reached)

- `sync()` uploads the whole index as one blob, `createBlob(JSON.stringify(nextIndex, null, 2))`. `createBlob` refuses any request over `MAX_BLOB_REQUEST_BYTES` (40 MiB) with `BlobTooLargeError`. That error is not caught for the index, so the sync fails.
- Every entry carries `search_text_gzip`, which is up to 250,000 characters of conversation text, gzipped and base64-encoded (`indexEntry`, `compressSearchText`). Real prose and code compress to roughly 30–50%, and base64 adds a third. One long conversation can therefore add on the order of 100 KB.
- Consequence: once an archive's index passes 40 MiB, **every** later sync fails. The message reads "the upload request would be over 40.0 MiB…" and never says that it is the index. The archive stays intact, since nothing is published, but it can no longer be updated. The viewer also downloads this whole file before it shows anything.
- This also bears on the 812-conversation 502 (`docs/investigations/2026-11-github-502-large-sync.md`). For an archive of that size the index blob is probably several MB, and it is uploaded in a single request. It is a second plausible size-dependent 502 source alongside the single tree request.
- Next steps:
  - (a) Measure: record the index size in each sync's outcome, then warn at a threshold. This is small and safe.
  - (b) Make the failure message name the index.
  - (c) Design an index v3 that moves search text into separate shards, with a backward-compatible reader and a migration note. That is a format change and needs review first (ROADMAP P0.2 / P1.3).

### 2. P1 — A failed large sync restarts from zero — Confirmed (behaviour), design question

- Publication is all-or-nothing per sync (CLAUDE.md invariant 8). A sync that fails after fetching 812 conversations publishes nothing. The next sync fetches all 812 from Claude again, because incremental skipping only covers conversations that are already archived (`archiveState` → `runSync`'s `unchangedIds`).
- This is correct for integrity, but the cost grows with archive size. It also means a first import that keeps hitting a deterministic GitHub limit can never finish.
- 0.5.20 (PR #82) removes the tree-size cause. The index-size cause remains (finding 1).
- A possible future design, which needs the user's decision before any implementation: an opt-in "checkpointed first import". It would publish N conversations per commit, where each commit is a complete, self-consistent archive: the index lists only conversations whose files are all present. It changes what "atomic" means from "per sync" to "per checkpoint", which is why it needs explicit approval.

### 3. P1 — Incremental-state read failures silently fall back to a full fetch — Confirmed

- `content.js` `getArchivedState()` turns any `getArchiveState` failure into `null`, which triggers a full download of every conversation. The same happens when GitHub answers 502 on the recursive tree read.
- This does not lose data: a full fetch is safe. But a temporary GitHub error turns a small incremental sync into a full re-download, with no sign of it in the popup.
- Suggested fix:
  - Report the fallback in the sync outcome, for example "archive state could not be read (GitHub 502 …); all conversations were downloaded".
  - Consider failing an *automatic* sync instead of starting a full fetch on its own. Automatic syncs already limit themselves to `AUTO_SYNC_LIMIT` when no archive state is available, so they never full-fetch.

### 4. P2 — Popup hides the sync summary whenever a per-conversation report exists — Confirmed (product question)

- Since the redesign, `describeLastSync` drops the message when `report` has entries. The popup then no longer shows how many conversations changed or were unchanged, or that a commit was made.
- The information is still stored in `last_sync.message`. Left as the user designed it; raised in PR #83.

### 5. P2 — Diagnostics were unreachable after the popup redesign — Confirmed, fixed in PR #83

- The content script stores sanitized `last_sync_diagnostics`, but the redesign removed the button that copies them. PR #83 restores it and repairs the E2E, which had been failing on `development`.

### 6. P2 — CI does not run the browser E2E — Confirmed

- `.github/workflows/web.yml` runs syntax checks, extension and web unit tests, and the build. `e2e/extension-sync.e2e.cjs` is not part of CI, which is how the popup regression above reached `development` unnoticed.
- Suggested fix: add an E2E job that uses Playwright's Chromium. That is a workflow change; keep it non-blocking until it is proven stable.

### 7. P2 — The viewer keeps the GitHub token in `localStorage` — Confirmed, accepted risk

- `web/src/main.jsx` keeps `{owner, repo, token}` in `localStorage`. Any script injection in the viewer origin could read it.
- Mitigations already in place:
  - Markdown is escaped before `dangerouslySetInnerHTML` (`markdownRenderer.js`).
  - Attachment URLs are host-allowlisted (`attachmentSecurity.js`).
  - The Authorization header is sent only to `api.github.com` and `raw.githubusercontent.com` (`safeRawGitHubDownloadUrl`).
- Recommendation: document in the README that a read-only fine-grained token is recommended for the viewer. Consider an opt-in session-only mode (`sessionStorage`). Part of ROADMAP P1.4.

### 8. P3 — Asset downloads send credentials to whatever URL Claude returns — Hypothesis (low risk)

- `content.js` `fetchAsset(url)` uses `credentials: 'include'` for any URL taken from Claude's response.
- In practice these URLs are claude.ai paths, and the content script runs under page CORS rules. Restricting `fetchAsset` to the claude.ai origin, plus any known CDN hosts, would make that assumption explicit.
- Needs sanitized evidence of the real URL shapes before changing anything, so that legitimate downloads are not broken.

### Verified as sound

These were checked and need no change:
- **Branch publication is atomic and race-checked.** The extension re-reads the branch head before the update, uses a non-force PATCH, and verifies the outcome when the PATCH fails.
- **Incomplete exports never replace complete archived copies.** `keptPrevious` handles this. Deletions are filtered against every path the index still references, and the index is refused if it references files that are missing.
- **Transfer integrity holds.** The transfer between the Claude tab and the extension is ordered and chunked, and every attachment is checked against its size and SHA-256.
- **Error messages do not leak tokens.** `redactSecrets` strips them.
- **Paths cannot collide.** Conversation and asset paths include a slug of the full ID plus a hash.

## Recommended order

1. **Index size:** measure it and name it in the error (finding 1 a/b). Small, safe, and it improves diagnosis of the 812-conversation failure. **← next task**
2. **Report the incremental-state fallback** (finding 3).
3. **Write the index v3 design** (finding 1c). Document only; no implementation before review.
4. **Add the E2E to CI** (finding 6), non-blocking at first.
5. **Document the viewer token guidance** (finding 7).
