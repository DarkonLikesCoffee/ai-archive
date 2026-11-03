# Investigation: `GitHub 502: Server Error` during an ~812-conversation sync

Date: 2026-11-03. Extension at the time of the failure: 0.5.19. Fixed in 0.5.20.

The user's private archive was **not** used for this investigation or any test. All regression tests use synthetic conversations.

## Reported symptom

A real sync of about 812 conversations ended with exactly `GitHub 502: Server Error`.

## Where the message can come from (0.5.19)

`gh()` in `extension/background.js` builds every GitHub error as `GitHub <status>: <GitHub's message>` (`gitHubError`). `Server Error` is the `message` field of GitHub's JSON error body, so the response came from the GitHub API (not a browser network error, and not an HTML proxy page, which would have produced a different message).

The *bare* message narrows down where it was raised:

| Phase | GitHub requests | Error text in 0.5.19 | Matches the report? |
|---|---|---|---|
| Incremental-state read (`getArchiveState` → `archiveState`) | GET ref, commit, `trees/<sha>?recursive=1`, `contents/archive/index.json` | Swallowed by `content.js` `getArchivedState()`; the sync falls back to a full fetch | No |
| Attachment staging during the transfer (`receiveAssetChunk` → `stageAssetUpload`) | POST `/git/blobs` | `Attachment "…" (…) could not be uploaded to GitHub: GitHub 502: …` + `Nothing was published; sync again.` | No |
| Upload-context load during the transfer (`transferUploadContext`) | snapshot GETs | `GitHub 502: … Nothing was published; sync again.` | Only if the user quoted the first sentence |
| Final sync (`sync()`), broadcast verbatim | snapshot GETs; one POST `/git/blobs` per changed Markdown file; POST `/git/blobs` for the index; **one** POST `/git/trees` with every change; POST `/git/commits`; GET ref; PATCH ref | `GitHub 502: Server Error` exactly | **Yes** |

So the failure happened in the final GitHub phase of `sync()`, after all conversations had been fetched from Claude and transferred. The 0.5.19 error did not record which request failed, so **the exact request cannot be determined from the reported text alone**. The popup's progress line at the moment of failure (uploading / creating tree / creating commit / finalizing) would distinguish them; it was not available to this investigation.

### Candidates and their likelihood

- **POST `/git/trees` (most likely).** 0.5.19 sent every change of the sync in one request. A sync that (re)writes ~812 conversations sends at least 813 entries (812 Markdown files + the index) plus every new attachment, spread over many nested directories. GitHub answers requests it cannot finish within its processing time limit with a `502`/`Server Error`-style response (from the GitHub REST troubleshooting documentation as remembered; docs.github.com was not reachable from this session, so this is unverified). Such a failure is deterministic for a given request size, so the three retries in 0.5.19 (1 s and 2 s apart) would all fail the same way. This fits a failure that appears only with a large sync.
- **POST `/git/blobs` for `archive/index.json` (also plausible, size-dependent).** The index is uploaded as one blob carrying the gzip+base64 search text (up to 250,000 characters of text) of *every* archived conversation. For an archive of ~812 conversations it is plausibly several MB to tens of MB, and it grows with every conversation. A request that large is a second deterministic 502 candidate. It also has a hard ceiling: past the 40 MiB request limit every sync fails (see `docs/TECHNICAL_AUDIT.md`, finding 1). 0.5.20 records the index size in each sync's report (`report.index_bytes`), warns from 20 MiB, and fails before uploading anything, naming the index, when the index cannot be uploaded. It does **not** shrink the index, because that is a format change that needs a design.
- **One of ~812 POST `/git/blobs` for Markdown.** Each body is small; a transient GitHub 502 is possible, and with ~813 requests and only a 3-second retry window, one unlucky burst is enough to fail the whole sync.
- **GET `trees/<sha>?recursive=1`** of the existing archive. Possible for very large repositories; the response is bounded by GitHub's truncation limit and is already refused when `truncated` is set.
- **POST `/git/commits`, GET ref**: small requests; only a transient 502.
- **PATCH ref**: never retried. On error 0.5.19 reads the ref back; if the branch was unchanged it rethrew the bare `GitHub 502: Server Error`. Possible, but small and not size-dependent.

## Was any data lost or partially published?

No, by construction, for every candidate above:

- Blobs, trees and commits are unreferenced objects until the final PATCH of the branch ref. A failure before the PATCH leaves the branch, the index and every archived file exactly as they were.
- A PATCH that fails is followed by a read of the branch head. Only three outcomes exist: published (reported as success), unchanged (error), or a different commit (`PublicationUncertainError` asking the user to inspect the branch). The reported text is the "unchanged" or pre-PATCH case, so nothing was published.
- Nothing in the extension deletes or rewrites data on Claude's side.

Consequence for the user: the archive is as it was before that sync; syncing again is safe and does not duplicate conversations, because Markdown paths are derived deterministically from the conversation ID and the index is keyed by `(provider, account, id)`.

## Changes in 0.5.20

1. **Tree built in chained batches** (`createTreeInBatches`, `TREE_BATCH_SIZE = 100`). Each request uses the previous request's tree as `base_tree`. Git trees are content-addressed, so the final tree is identical to the single-request result and a retried batch cannot change it. Still exactly one commit and one branch update: publication stays atomic.
2. **Verification of the new tree before committing** (`verifySyncTree`). The new tree is read back recursively; every written path must have the planned blob SHA, every deleted path must be absent, and every path the next index references must exist. Otherwise nothing is committed or published.
3. **Longer, jittered retry budget for idempotent requests**: 5 attempts, about 15 s (1 + 2 + 4 + 8 s ±25%). The branch-ref PATCH and the empty-repository Contents PUT are still never retried.
4. **Errors name the failed step and attempts**, e.g. `GitHub 502: Server Error [while building the archive tree; failed 5 attempts]`, without paths or titles. Every failure before the branch update ends with `Nothing was published; the archive on GitHub is unchanged. Sync again to retry.`; a failed PATCH whose branch was verified unchanged says so.

### Not changed, deliberately

- **No multi-commit publishing of large syncs.** Splitting one sync into several commits would publish partial archives; it violates the atomic-publication invariant (CLAUDE.md #8).
- **No automatic repeat of the ref PATCH.** It is not idempotent in the presence of concurrent writers; the next sync rebuilds and re-verifies against the current branch instead.
- **No cross-sync resume cache.** A failed sync re-fetches from Claude on the next run. Unchanged attachments are already reused from the archive and blob uploads are content-addressed, so a re-run costs time, not correctness. Persisting fetched conversation data between syncs would add a new store of private data in the browser and is out of scope without a design review.

## Regression coverage

`extension/background.test.js` (synthetic data only):
- an 812-conversation sync builds its tree in chained batches of ≤100 entries and publishes one commit and one ref update with every conversation exactly once;
- transient 502s on the archive file-list read, a blob upload, a mid-sync tree batch and the commit are retried and the sync completes once;
- persistent 502s on each of those steps publish nothing, name the step, and the next sync publishes all 812 conversations exactly once (no duplicates, no losses);
- a 502 on the ref update is sent once, read back, reported as unchanged, and the retry succeeds;
- a tree GitHub built differently from the planned changes is never committed.

`e2e/extension-sync.e2e.cjs`: a persistent tree-creation 502 publishes nothing, is retried 5 times and shown with its step in the popup; the next sync publishes.

## Still needs the user's real-world verification

- Re-run the large sync with 0.5.20. If it fails again, the popup message now names the failing step; please report that text (it contains no conversation content).
- Whether GitHub's real limit was the tree request or the index blob is a hypothesis until a real large sync succeeds with batching, or a new failure names another step (`uploading a file` right before the tree stage means the index).
- The size of the real archive's `archive/index.json` (visible on GitHub) would show how close it is to the limit. Only the size is needed, never the content.
