# Design proposal: index v3 — search text in shards

Status: **proposal for owner review. Not implemented.** This proposal changes the archive format (`docs/archive-format-v1.md`), so per CLAUDE.md it needs explicit approval before any implementation.

Related: `docs/TECHNICAL_AUDIT.md` finding 1; `docs/investigations/2026-11-github-502-large-sync.md`.

## Problem

`archive/index.json` (index v2) holds, for every conversation, its navigation metadata and its whole search cache (`search_text_gzip`: up to 250,000 characters, gzipped, base64). Consequences:

1. **Hard ceiling.** The index is written as one Git blob in one API request, and requests are limited to 40 MiB (`MAX_BLOB_REQUEST_BYTES`). Past that limit every sync fails. Since 0.5.20 that failure is early and named, but it still blocks the archive.
2. **Cost per sync grows with the archive, not with the change.** A sync that changes one conversation re-uploads every conversation's search text. Large single requests are also a likely source of GitHub 5xx and timeout errors.
3. **Viewer start-up.** The viewer downloads and inflates the whole search cache before showing the list.

## Proposal

Keep `archive/index.json` as the single navigation index (metadata only), and move search text into a fixed number of shard files:

```text
archive/search/<provider>/<account>/<bucket>.json    bucket = 00..ff (256 buckets)
```

- **Bucket choice:** `bucket = stableHash(id) % 256`, using the same FNV-1a `stableHash` already used for paths. Assignment is deterministic and never changes for a conversation.
- **Shard content:** `{ "version": 1, "entries": { "<id>": { "search_text_sha256": "…", "search_text_gzip": "…" } } }`, with keys sorted so output is byte-stable.
- **Index entry** for a sharded conversation:

  ```json
  {
    "search_text_encoding": "shard",
    "search_shard": "archive/search/claude/personal/3f.json",
    "search_text_sha256": "…"
  }
  ```

  It has no `search_text`/`search_text_gzip`. The `search_shard` path is listed so integrity checks can treat it like any other referenced file.
- **`index.version`** becomes `3`. `format_version` (conversation Markdown) does **not** change: no conversation file is rewritten.

### Size behaviour

- With 256 buckets, an archive of 812 conversations at about 20 KB of search cache each gives shards of about 64 KB. The index then shrinks to metadata, roughly 1 KB per conversation.
- A shard reaches the request limit only around 256 × 40 MiB of search cache in total, about 500,000 typical conversations.
- A sync that changes *k* conversations rewrites at most *k* shards plus the index.

## Writer (extension) rules

1. **Build shards from the base tree.** For every conversation that changed in this sync, read its shard file from the base tree (unless an earlier conversation in the same sync already modified it). Replace that conversation's entry, and write the shard with sorted keys.
2. **Migrate gradually but completely.** On the first v3 sync, every v2 entry that still holds an inline `search_text_gzip` or `search_text` is moved into its shard. The text comes from the existing index, so nothing is fetched from Claude again. This happens in the same single commit, so the archive is never half-migrated on the branch.
3. **Integrity.**
   - `search_shard` paths are added to the referenced paths used by the existing missing-file check and by `verifySyncTree`.
   - A conversation's shard entry must carry the index's `search_text_sha256`.
   - Shard files are never deleted automatically. A bucket that becomes empty is written as `{"version":1,"entries":{}}`.
4. **Ceiling guard.** The same early size check that 0.5.20 applies to the index also applies to each shard.
5. **Rebuild.** Shards stay derived data: each is rebuildable from the Markdown files, exactly like v2's inline cache (ROADMAP P0.2).

## Reader (viewer) rules

1. **Index first.** Read the index and show the list immediately using metadata only.
2. **Search loads shards on demand.** On the first search, load the shards for the account being viewed, at most 4 at a time, and inflate them as v2 does today.
3. **Inline beats shard.** If an entry still holds inline `search_text_gzip`/`search_text`, use it. This covers a mixed index written by an older extension (see below). A shard entry whose `search_text_sha256` does not match the index entry is ignored for that conversation and reported as a stale cache. It never replaces conversation content.
4. **Missing shard.** Search falls back to titles for the affected conversations and the viewer shows a notice. The archive itself is not affected.

## Compatibility

| Writer → / Reader ↓ | v2 index (≤ 0.5.20) | v3 index |
|---|---|---|
| Viewer ≤ 0.6.x | as today | List, reading and attachments work. Search covers titles only for sharded entries, because the current reader passes unknown encodings through and searches `search_text \|\| ''`. Nothing breaks. |
| Viewer v3 | reads inline v2 caches as today | full search |

- **Older extension (≤ 0.5.20) syncing into a v3 archive.** `loadArchiveIndex` accepts it, unknown entry fields are preserved, and shard files are not deleted, since deletions only target previous conversation or asset paths. It writes inline gzip caches for the conversations it changes; rule 3 makes those win until the next v3 sync moves them back into shards.
  - **Open point to verify before implementing:** the ≤0.5.20 compaction loop skips entries without `search_text`, so v3 entries pass through untouched. This needs a characterization test against 0.5.20 code before shipping.
- **Downgrade path.** A v3 archive stays fully readable as Markdown on GitHub. Index v2 can be regenerated from the shards without Claude access.

## Migration checklist (per `archive-format-v1.md` "Migration rule")

1. **What changed:** search caches move from index entries to `archive/search/**`, and `index.version` becomes 3.
2. **Detection:** `index.version === 3` and/or `search_text_encoding: "shard"` per entry.
3. **Old files readable:** yes. Conversation Markdown is untouched, and v2 entries remain valid in v3.
4. **How migration happens:** automatically, in one atomic sync commit, from data already in the index.
5. **Index rebuild:** from Markdown, as before. Shards are part of the rebuild.

## Tests required before shipping

- **Writer:**
  - an archive of 812 synthetic conversations migrates in one commit with byte-stable shards;
  - a sync of one conversation rewrites exactly one shard and the index;
  - a mixed v2/v3 index;
  - a missing shard in the base tree, which must fail without publishing, like a missing asset;
  - shard size guard.
- **Reader:**
  - lazy shard load;
  - inline-over-shard precedence;
  - SHA mismatch;
  - missing shard;
  - the current reader against a v3 fixture (title-only search, no crash).
- **E2E:** sync → viewer search across shards.

## Alternatives considered

- **Raise or split only the index blob:** not possible. A Git blob is one request.
- **Drop search text and use GitHub code search:** unreliable for private repositories, rate-limited, and not available offline. Rejected.
- **One search file per conversation:** thousands of tiny files, many requests for the viewer, and a larger tree. 256 fixed buckets balance request count against shard size.
- **Lower the 250,000-character cap:** reduces size but loses search coverage of long conversations, and only delays the ceiling. It could complement the proposal but does not replace it.

## Decision needed from the owner

Approve, adjust (for example the bucket count), or reject index v3. Until then, 0.5.20's early failure and 20 MiB warning are the safeguard.
