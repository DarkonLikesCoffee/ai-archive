# Oversized attachment downloads (ROADMAP P1.3)

Status: approach B is implemented in extension 0.5.22. It still needs verification against live Claude responses (see the end of this document).

## Problem

A conversation with an attachment over the upload limit (31,457,232 bytes) stays incomplete. Every sync therefore fetches it again (invariant 9), and in 0.5.21 that meant downloading the oversized file in full from Claude only to leave it out of the archive. On the owner's real archive, that is 7 files across 4 conversations, each over 30 MiB: **more than 210 MiB of downloads per sync, for nothing.**

## What a skip must preserve

- **Identity.** The asset's SHA-256 drives deduplication and message matching in `content.js` (fingerprints `name|sha256`, Files API and path caches). It also sets the asset's path prefix, which in turn affects the path collisions of other assets. And it is recorded in the index (`incomplete[].sha256`). A skipped file without the same SHA-256 could change other files' paths, merge or split assets, and change the index.
- **Honesty.** A file whose bytes were not obtained is never marked archived. It keeps its visible "Not archived" note.
- **Retry.** The conversation is still re-fetched on every sync; only the oversized bytes are avoided.
- **Stability.** The Markdown and index must come out byte-identical, so nothing in the archive is rewritten.

## Can HTTP headers identify an oversized file before its body is read?

**Size: yes, under strict conditions.** For a `200` response with no content coding (`Content-Encoding` absent or `identity`) and no `Content-Range`, `Content-Length` is the length of the body. The browser enforces this framing: a body that ends early is a network error, and extra bytes are not delivered. Such a header therefore states the file's size. It is **not** usable when:
- **it is missing:** `Transfer-Encoding: chunked`, or a cross-origin response that does not expose it;
- **the response is compressed:** `Content-Length` is then the compressed size;
- **it is ambiguous:** a partial or range response, a non-decimal value, or several values;
- **Claude's own metadata disagrees:** it declares another size for the file.

**Identity: no.** No header proves which bytes the body holds. `ETag` and `Last-Modified` are optional, opaque and not content hashes. So headers can only confirm that a file *the archive already identified* still has the same exact size.

## Approaches compared

| | A: skip by `Content-Length` alone | **B: skip only a recorded file whose exact size is confirmed (implemented)** | C: skip incomplete conversations whose only problem is oversized files | D: stream-hash without keeping the bytes |
|---|---|---|---|---|
| Bandwidth: first sync | saved | full download (needed for the SHA-256) | full download | full download |
| Bandwidth: repeat syncs (owner's case: >210 MiB) | saved | **saved: headers only** | saved, plus the conversation JSON | none saved |
| Attachment identity | **lost** (no SHA-256): path collisions and deduplication can change, and the index loses `sha256` | kept: the SHA-256 of the earlier full download of the same file UUID | kept | kept |
| Archive files rewritten | the index changes; Markdown may change | none (verified: byte-identical, no commit) | none | none |
| Retry of incomplete conversations | kept | kept | **changed** (invariant 9; needs approval) | kept |
| Misleading size | wrongly skips any file whose header lies | a skip needs the same file UUID **and** the exact recorded size **and** a strict header | n/a | n/a |
| Complexity / risk | medium, with identity risk | small and local to `fetchAsset` | changes skip semantics | needs a streaming SHA-256 (WebCrypto has none) |

**Decision: B.** It removes the repeat-sync waste that was actually observed, without touching identity, retry behaviour or archive contents. A and D are rejected. C stays an option the owner can decide on separately; it would save only the small conversation JSON on top of B.

## Approach B in detail

- **What the archive provides.** `getArchiveState` returns `oversized`: for each conversation of the account, the `incomplete[]` items with `too_large: true`, a Claude `file_uuid`, a size over the limit and a valid SHA-256. Files GitHub refused (`github_rejected`) are excluded; they are within the limit.
- **Condition for a skip** (`canSkipOversizedDownload` in `content.js`): an "all" sync with a readable archive state, a record for this conversation and this file UUID, and a strict 200 response whose `Content-Length` equals the recorded size exactly. Any size Claude declares (`size_bytes`, `file_size`, `size`) must agree. The body is then cancelled.
- **What a skip returns.** An asset with the recorded size and SHA-256 and no bytes, exactly what the earlier full download produced. The background therefore writes the same "Not archived" note and the same index item.
- **Fallback.** Every other case downloads as before. That includes Latest-N syncs, an unreadable archive state, a changed size, missing or compressed headers, a disagreeing declared size, and records that are malformed or belong to another file or conversation.
- **Visibility.** The sync summary says "N attachments over the upload limit were not downloaded again", and each file still appears in the diagnostic report as over the upload limit.

### Residual risk

- **Same UUID and exact size, different bytes.** If Claude served different bytes under the same file UUID with exactly the same size, the archive would keep the old SHA-256. That would be stale metadata about a file that is **not** archived either way; no archived bytes or links are affected. Claude file UUIDs are expected to be immutable. That expectation is unverified, so it is recorded here.
- **Raised limit.** If the upload limit is ever raised above a recorded size, `canSkipOversizedDownload` stops skipping (it requires size > limit), and the file is downloaded and archived.

## Tests

- **`extension/content.test.js`, known size:** the body is never read and is cancelled; the recorded size and SHA-256 are kept; the asset is still not archived and still reported.
- **`extension/content.test.js`, cases that must download:**
  - no `Content-Length`; a compressed response; a partial response; a range header on a 200; a non-decimal value;
  - a changed size; a recorded size now within the limit; a disagreeing declared size;
  - a record for another file, another conversation, or a malformed record;
  - a Latest-N sync; an unreadable archive state.
  In each case the identity comes from the bytes actually received.
- **`e2e/extension-sync.e2e.cjs`:** the repeat sync of a 31 MiB attachment skips the download and makes no commit (byte-identical archive).

## Needs live verification (owner)

Whether Claude's real download endpoints send `Content-Length` without content coding is **unknown**; the E2E fake server does. If they don't, nothing changes: the files are downloaded as before. After syncing with 0.5.22, the summary line "… attachments over the upload limit were not downloaded again" shows whether the skip happened (7 expected on the owner's archive).
