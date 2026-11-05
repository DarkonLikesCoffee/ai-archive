# Attachment verification audit (ROADMAP P0.4, slice 1)

Extension 0.5.26. This traces each attachment path from Claude's response to the archive: download, byte validation, MIME and size, SHA-256, transfer, GitHub blob, and the Markdown/index reference. **Confirmed** means verified in code or with a test. Real-account behaviour is pending unless stated.

## Common stages (all downloaded paths)

| Stage | Behaviour | Where | Status |
|---|---|---|---|
| Download | `fetchAsset`: not 2xx → error. 404/410 → recorded as unavailable ("not archived", incomplete, retried); any other failure skips the conversation, keeping its archived copy | `content.js` | confirmed, tested |
| Empty body | Error, never an empty file | `fetchAsset` | confirmed |
| Size | Byte length of the received body; never metadata | `fetchAsset` | confirmed |
| SHA-256 | Of the received bytes | `fetchAsset` → `sha256Bytes` | confirmed |
| MIME | Claude's declared type, else the response `Content-Type`, else `application/octet-stream`. Not checked against the bytes | `fetchAsset` | gap (low risk), noted below |
| Over the upload limit | Never transferred or uploaded; "Not archived" note with size and SHA-256; incomplete. Repeat downloads skipped only for a recorded identity with an exact size (P1.3) | `content.js`, `normalizeAssetList` | confirmed; live-verified in 0.5.25 |
| Transfer | Chunked, in order; the background checks the byte length and SHA-256 of every attachment before use | `receiveAssetChunk` | confirmed, tested |
| GitHub blob | **Before 0.5.26 the blob ID GitHub returned was trusted.** Now it must equal the Git blob ID computed from the bytes sent | `createBlob` / `gitBlobSha` | **gap fixed** |
| Reuse of archived bytes | **Before 0.5.26 an archived blob was reused when the index's SHA-256 and the tree's size matched**, even if the file had since been changed outside AI Archive. Now reused only when its blob ID equals that of the bytes in hand; otherwise uploaded | `stageAssetUpload` | **gap fixed** |
| Archived file that differs from the verified bytes | **Before: left as is, so the index's SHA-256 was false.** Now the conversation is rewritten with the verified bytes, the sync report says so, and the previous version stays in Git history | `sync()` | **gap fixed** |
| Reference | The Markdown links to `assets/…` at the message; the index records path, SHA-256, size, MIME and name; the tree is verified against every written path before the commit | `conversationMarkdown`, `indexEntry`, `verifySyncTree` | confirmed |

## Per path

1. **Message-level files** (`message.files[]` with a preview or document URL).
   - Downloaded per unique file ID (or name) and URL, then linked to every message that references them.
   - Deduplication is by `name|sha256`, never by name alone.
   - Status: confirmed, tested.
2. **Files API blobs** (`file_kind: blob`, `download_source: files_api`).
   - `/files/<uuid>/contents`, cached per UUID.
   - 404/410 count as unavailable.
   - Status: confirmed, tested. The endpoint itself still needs live validation.
3. **Generated sandbox files** (`wiggle/list-files`).
   - Only files referenced by the active lineage are downloaded: by their full path, or by a basename that is unique.
   - Identity comes from the one `message.files[]` entry naming the exact path (0.5.25).
   - Status: confirmed, tested.
4. **Legacy sandbox paths** (a message file with a `path` and no URL, not in the list).
   - Both path forms are tried. A 4xx moves on to the next form; a 5xx skips the conversation. If nothing succeeds, the file is recorded as not archived.
   - Status: confirmed, tested.
5. **Inline media** (content blocks with a `base64` source).
   - Decoded strictly: invalid or empty base64 makes the conversation fail; it is never written as an empty file.
   - SHA-256 of the decoded bytes. MIME comes from `media_type`; images fall back to PNG for path compatibility.
   - The marker position is kept per message.
   - Status: confirmed, tested.
6. **Tool-result media.**
   - Archived as message attachments when the base64 decodes. Payloads that don't decode stay redacted in the fenced result (`[omitted … payload]`) and are not recorded as incomplete: there are no valid bytes to archive.
   - Status: confirmed. The visible note is the only record (see below).

## Remaining gaps (not fixed in this slice)

- **MIME type not verified against the bytes.** A wrong declared type changes how the viewer shows a file, never the bytes or their hash. Content sniffing would be a heuristic; low priority.
- **Undecodable tool-result media** leaves only the inline redaction note, not an `incomplete[]` entry. Low risk, since the source data itself is invalid. Could be added as an incomplete item with kind `tool-result-media`, but that would change Markdown and index output for affected conversations.
- **Unchanged conversations are never re-verified.** A file changed outside AI Archive is repaired only when its conversation is synced again. `web/scripts/verify-archive.mjs --hashes` detects such files read-only across the whole archive.
- **Live verification pending** for real-account bytes of the five paths: compare representative archived files with the originals in Claude (P0.4 checklist item).

## Tests (0.5.26)

`extension/background.test.js`:
- **"a blob ID GitHub returns for other bytes is never referenced…":** covers attachments and Markdown; nothing is published.
- **"an archived file changed outside AI Archive (same size) is not reused…":** the file is not reused, is uploaded and rewritten, and the report says so. Intact bytes are reused with no commit.

Both fail on 0.5.25.

The test fakes now return real Git blob IDs. This also exposed a race in the unit harness, where a delayed response read the body of a later request.
