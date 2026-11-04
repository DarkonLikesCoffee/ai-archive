# Index rebuild and archive recovery (ROADMAP P0.2)

Status: the field analysis and a **read-only dry run** are implemented (`web/src/indexRebuild.js`, `web/scripts/verify-archive.mjs --rebuild-dry-run`). There is **no apply step**. The apply design below needs owner review before any implementation.

## Can every index field be rebuilt from the canonical files?

The fields come from `indexEntry()` and `sync()` in `extension/background.js` (index v2, format v4). "Exact" means the dry-run test reproduces the exporter's own value from the exporter's own output (`web/src/indexRebuild.test.js`).

| Field | Source when rebuilding | Fidelity |
|---|---|---|
| `id`, `provider`, `account`, `title`, `model`, `created_at`, `updated_at`, `message_count` | `AI_ARCHIVE_METADATA` block at the top of the Markdown | exact |
| `path` | file path | exact |
| `content_sha256` | SHA-256 of the Markdown file | exact |
| `assets[].path` | `assets/…` links in the Markdown, resolved next to the file | exact |
| `assets[].size` | tree entry size, or the bytes | exact |
| `assets[].sha256` | SHA-256 of the file bytes (requires downloading them) | exact |
| `assets[].name` | link label, unescaped | exact for tested names; a newline in an original name was folded to a space, so that is lost |
| `assets[].mime` | guessed from the file extension | approximate: the original MIME type is not stored in Markdown |
| `preview`, `search_text` (and their gzip/SHA fields) | rebuilt from the rendered message text | approximate: derived from Markdown, not Claude's raw text. Search still works; the text differs slightly |
| `exporter_version` | not in Markdown | **not recoverable** |
| `format_version` | not in Markdown | **not recoverable** |
| `incomplete[]` | only the visible "not archived" / "Incomplete archive" notes survive | **not recoverable** in detail: name, size, SHA-256, `too_large` and `github_rejected` are lost. The dry run reports `flaggedIncomplete` |

**What the unrecoverable fields affect:**
- `exporter_version` and `format_version` only control re-export. If they are missing, the next sync re-exports that conversation once, which is safe.
- `incomplete[]` makes every sync retry a conversation, and remembers that GitHub refused certain bytes. If it is missing:
  - retries depend on the rebuilt entry being marked incomplete whenever its file carries a visible note;
  - bytes GitHub refused would be offered to GitHub once more, which costs time but loses no data.

Files that cannot be rebuilt at all:
- Markdown without a metadata block (exports older than the metadata format) carries no identity. The dry run lists it as `UNREADABLE`. An apply must keep the existing index entry for such a file, never drop it.

## Dry run (implemented)

```bash
GITHUB_TOKEN=<read-only token> node web/scripts/verify-archive.mjs <owner>/<repo> --rebuild-dry-run [--hashes]
```

It reports, without writing anything:
- **match:** conversations whose exact fields equal the index;
- **`DIFFERS`:** the exact fields that differ, for example a title edited by hand or an asset reference missing from the index;
- **`NOT IN INDEX`:** files the index does not list, which a rebuild would recover;
- **`NOT REBUILT`:** index entries with no readable file;
- **`UNREADABLE`:** files whose identity cannot be read;
- **lost on apply:** entries that would lose `exporter_version`, `format_version` or `incomplete` details.

## Apply (proposed, not implemented)

Rules an apply must follow:

1. **Explicit only.** A separate command and flag, never automatic, never triggered by a sync or the viewer.
2. **Merge, don't replace.**
   - For each identity, take the rebuilt exact fields.
   - Keep the existing entry's unrecoverable fields when its `content_sha256` equals the rebuilt one. The file is then provably unchanged, so the recorded versions and `incomplete[]` are still true.
   - Otherwise drop them, so that the next sync re-exports the conversation.
3. **Keep what cannot be rebuilt.** Existing entries for `UNREADABLE` files and for `NOT REBUILT` identities stay exactly as they are. An apply never removes an entry.
4. **Mark uncertainty.** Set `incomplete` to a generic item for every `flaggedIncomplete` file that has no preserved `incomplete[]`, so syncs keep retrying it.
5. **One verified commit.** Write only `archive/index.json`, in one commit, with the same chained-tree and verify-before-publish path the extension uses. Run `auditArchive` on the result first and refuse on any error. Never touch Markdown or attachments.
6. **Backup.** Git history already keeps the previous index. The apply prints the previous blob SHA so the change can be reverted with an ordinary commit, never a force push.

## Tests before an apply ships

- Merge rule 2, both when the content SHA matches and when it differs.
- Rule 3: no entry is ever removed.
- An index rebuilt from an archive produced by the 0.5.20 exporter passes `auditArchive` and makes the next sync re-export only the conversations whose versions were dropped.
- Old-format fixtures: Markdown without a metadata block, and format v3 paths.
