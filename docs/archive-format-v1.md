# AI Archive — Archive Contract v1

This document defines the stable contract between exporters, the GitHub archive, and the dashboard.

The contract is provider-neutral. A provider may have provider-specific collection logic, but the stored archive must follow the same identity and storage rules.

## Source of truth

GitHub is the permanent source of truth.

- Conversation content lives in Markdown files.
- Binary attachments live as normal repository files.
- `archive/index.json` is an index/cache for navigation and search; it is not the canonical conversation store.
- A dashboard must remain usable if the index is rebuilt from the conversation files.

## Conversation identity

Every conversation has a stable provider-scoped identity:

```text
(provider, account, id)
```

The same conversation ID must not be reused across providers or accounts.

Required metadata:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Provider's stable external conversation ID |
| `provider` | string | Provider identifier, e.g. `claude`, `chatgpt`, `gemini` |
| `account` | string | User-defined account identity within that provider |
| `title` | string | Current conversation title |

Optional metadata:

| Field | Type | Meaning |
| --- | --- | --- |
| `model` | string/null | Model used by the provider |
| `created_at` | string/null | Provider creation timestamp |
| `updated_at` | string/null | Provider modification timestamp |
| `message_count` | number | Number of exported messages |

## Canonical Markdown

A conversation starts with a metadata block:

```md
<!-- AI_ARCHIVE_METADATA
{
  "id": "provider-conversation-id",
  "provider": "claude",
  "account": "personal",
  "title": "Example conversation"
}
-->

# Example conversation

## You

Hello

---

## Claude

Hello!
```

Rules:

1. The metadata block is machine-readable JSON.
2. The first H1 is the human-readable title fallback.
3. Messages are separated by `---` and start with an H2 role heading. Message
   bodies are not escaped, so readers only treat `---` followed by an H2 as a
   message boundary when the H2 names a role the exporter writes: `You`, the
   provider's display name (e.g. `Claude`), or a raw lowercase role identifier
   (e.g. `system`). A `---` followed by an ordinary heading such as
   `## Details` belongs to the message body. Files without provider metadata
   fall back to treating every H2 after `---` as a role heading.
4. `You` maps to the normalized `user` role.
5. The provider's own role name maps to normalized `assistant`.
6. Unknown role headings must be preserved rather than discarded.
7. Message content is Markdown and must be treated as opaque message data by the archive layer.

## Tool sections

Tool calls and results inside a message are H3 sections:
`### Claude tool: <name>` or `### Tool result: <name>`.

- A section normally holds exactly one fenced block (a bare command, code, or
  the tool input as JSON; or the fenced tool result). Readers end such a
  section at that block's closing fence.
- When a tool input has multi-line text fields (for example artifact
  `content`, `file_text`, `new_str`), the section holds the remaining metadata
  as a JSON block, then each such field as `**<field>**` followed by its own
  fenced block, and ends with a line containing only `<!-- /tool -->`.
  Readers keep every block up to that line inside the tool section; fenced
  content is skipped while looking for it. GitHub hides the line as an HTML
  comment.
- Binary payloads (`data`, `base64`, `bytes`) are never written into tool
  sections. They appear as `[omitted inline payload: N characters]`; tool-result
  media that could be decoded is additionally archived as an attachment of the
  message (`; archived as a message attachment`).

Compatibility: sections without the end line are read exactly as before, so
existing files stay readable and are not migrated. A conversation whose tool
inputs contain multi-line text is rewritten in the new form the next time it
is synced, which updates its `content_sha256` in the index.

## Attachments

Attachments are repository files, not embedded binary data in the conversation Markdown.

Conversation Markdown references them with relative links, for example:

```md
![screenshot.png](assets/1234abcd-screenshot.png)
```

The attachment path is stable and provider/account scoped:

```text
archive/conversations/<provider>/<account>/<conversation assets>
```

### Image originals and previews (extension 0.5.29)

Claude serves each uploaded image in two forms: the original upload, through
`/api/organizations/{org}/files/{file_uuid}/contents` (and, in sandbox
workspaces, the sandbox's `uploads/` folder), and a smaller lossy WebP preview
through the message file's `preview_asset.url`. Exporters before 0.5.29
archived only the preview, under Claude's file name (often `….png` or
`….jpg`), so those files are WebP bytes behind a misleading extension.

From 0.5.29 an image attachment is exported as follows:

1. The original is requested from the Files API first. It is accepted only
   when its bytes are a recognised image (PNG, JPEG, GIF, WebP, BMP, TIFF,
   AVIF, HEIC/HEIF or SVG). Its `mime` and its path's extension come from
   those bytes; the index `name` and the Markdown label keep Claude's file
   name. Originals are never converted.
2. Only when Claude answers the original with 404/410, or the file has no
   Claude file UUID, is the preview downloaded instead, stored under its real
   extension (normally `.webp`).
   - In a sandbox workspace, if the sandbox's `uploads/` folder holds exactly
     one file with the image's name and its bytes are a recognised image, that
     file is the original (type and extension from its bytes, linked to the
     same Claude file and message). Both files are kept: the original, and
     the preview as a separate preview variant.
   - Otherwise the image is **preview-only**: the Markdown shows
     `*Preview only: this is Claude's preview image, not the original upload.
     …*` under it. A 404/410 means only that Claude did not serve the original
     when the conversation was archived.
3. An original the archive viewer cannot display inline (HEIC, HEIF, TIFF,
   SVG) also gets Claude's preview as a **display copy** when the message has
   a preview URL and the preview is a displayable image. The original is kept
   unchanged; the Markdown shows the preview inline and links the original
   (`*Shown: Claude's preview. The original upload is archived unchanged as
   [name](…) …*`). Claude answering that preview with 404/410 leaves the
   original alone.
4. Any other failure (403, 429, 5xx, network error, an original whose bytes
   are not an image) fails the conversation for that sync; a later sync
   retries it. A preview is never substituted silently.
5. An original already archived is never demoted. When a conversation is
   re-exported and Claude answers 404/410 for an image whose original the
   archive holds (same conversation, same `file_uuid`, still in the
   repository), that archived original stays linked: the Claude tab refers
   to it from the archive state without downloading it again, and a sync
   without archive state (such as "Latest N") that received only the
   preview links the archived original again and keeps the new preview as
   its `preview_of` preview. A reference that does not match the archived
   file (path, SHA-256 and file UUID) is reported as not archived, so the
   archived copy is kept.
6. A sandbox `uploads/` file is paired with a preview only when its name is
   unique among the sandbox uploads and among the conversation's image
   attachments. Pasted images are often all named `image.png`; with several
   candidates nothing is guessed.

When both an original and its preview are archived, the Markdown links each
exactly once: the original as the image, followed by `*Also archived:
[Claude's preview of this image](…).*`, or for a non-displayable original the
preview as the image with the original linked as above.

Index fields (all optional and additive; readers ignore them when absent):

- `assets[].variant`: `"original"` or `"preview"`, on image assets written
  by 0.5.29 or later. Absent on every other asset and on all older entries,
  whose images may be either.
- `assets[].file_uuid`: Claude's file UUID, on image assets with a
  `variant` (when Claude gave one). It identifies the archived original of
  an image across re-exports.
- `assets[].preview_of`: on a preview whose original is also archived, the
  `path` of that original (one of the same entry's `assets`). A preview with
  `preview_of` is never preview-only.
- `preview_only[]`: one item per image whose original is **not** in the
  archive (also `reason: "files-api-served-preview"` when Claude's Files API
  returned a WebP identical to the preview: the bytes are kept as the
  preview, never as the original): `path` (of the preview, one of the entry's `assets`), `name`,
  `file_uuid` (when Claude gave one), `message_external_id`, `reason`
  (`original-unavailable`, `no-file-id`, or `original-not-archived` when the
  original was downloaded but too large to archive), and for
  `original-unavailable` the `original_status` (404/410) and
  `original_checked_at` (when Claude was asked). A conversation with
  preview-only images is **not** `incomplete`: incremental sync may still skip
  it, and a normal sync does not ask Claude for those originals again. An
  explicit "Latest N" sync asks again, as does any re-export of the
  conversation that has no archive state. These items are the identity a
  later, explicit recovery needs.
- `retained_assets[]`: files the Markdown no longer links, kept instead of
  deleted. **From 0.5.29 a sync never deletes an attachment**: an image
  replaced by its original, a preview stored again under its real extension,
  and a file of any type whose message left Claude's active branch all stay
  in the repository and are listed here with their `path`, `sha256`, `size`,
  `mime`, `name` and:
  - `reason`: `superseded` (the export holds an original or preview of the
    same Claude file name) or `not-in-export`;
  - `superseded_by`: the path of that original (or preview);
  - `same_bytes_as`: the path of a current asset with identical bytes;
  - `variant: "preview"` only when those identical bytes are a current
    preview (typically an old WebP preview stored under a `.png`/`.jpg`
    name). A kept file is never labelled `original`: its bytes were never
    verified as Claude's upload.

  Later syncs keep the list (and its annotations). Nothing is moved or
  rewritten. Only a renamed conversation's old Markdown file is removed, its
  content being written to the new path.

So an image file is exactly one of: a linked asset (`assets[]`, with
`variant`, and `preview_of` when it is the preview of an archived original), a
linked preview-only asset (also listed in `preview_only[]`), or an unlinked
historical file (`retained_assets[]`).

#### Version requirement and downgrade detection

- Top-level `requires_extension` in the index (index version stays 2): the
  oldest extension version allowed to write to the archive (currently
  `"0.5.29"`), written with every index by 0.5.29 or later.
- `archive/.ai-archive.json`, written with every index by 0.5.29 or later:

  ```json
  { "format": "ai-archive", "requires_extension": "0.5.29", "written_by_extension": "0.5.29" }
  ```

  plus, while one is unacknowledged, `"downgrade_warning": { "detected_at":
  …, "reason": … }`. Fields a version does not know are kept when it
  rewrites the file. The viewer and verifier ignore it as an attachment. An
  archive without it (every archive before 0.5.29) is valid; the first sync
  that commits adds it.
- From 0.5.29 on, an extension older than the requirement in the index **or**
  in the marker file refuses to sync, before downloading or writing anything.

What extensions before 0.5.29 do (verified by running the released 0.5.28
code in `extension/background.test.js`, fixture
`test-fixtures/extension-0.5.28/background.js`): they never read either
marker, so **nothing stops them from syncing**. When they write, they
rewrite the index as `{ version, updated_at, conversations }` (dropping
`requires_extension`), re-export changed conversations from Claude's preview,
delete the archived original and preview of those conversations from the
latest version of the archive (git history keeps them), and drop their
`variant`, `preview_of`, `file_uuid`, `preview_only` and `retained_assets`
records. They never write, rename or delete `archive/.ai-archive.json`.

So the marker file survives such a write while the index marker does not.
The next sync of 0.5.29 or later detects it (`index-rewritten-without-marker`)
even when the older extension re-exported every conversation that had image
records, reports it in the popup (a warning shown first, with an "I
understand" button) and in the sync report, and stores the warning in the
marker file. Every later sync reports it again until the user acknowledges
that exact warning; the next sync after that removes it from the marker
file. For an archive without a marker file, original-first records without
`requires_extension` are detected the same way
(`original-first-records-without-marker`). The verifier reports both as
`older-extension-wrote`. A marker file that cannot be read, or whose
`downgrade_warning` cannot be read, is never replaced silently: it is reported
the same way (`marker-unreadable`, `warning-unreadable`, "the archive's
version marker could not be read"), kept as an unacknowledged warning in the
rewritten marker, and cleared only once acknowledged, because it may have
held a warning nobody has seen.

Limitations, by design: detection happens only after an older extension has
written; it cannot undo what that sync did (the files are recovered from the
repository history, and the affected conversations regain originals only
where Claude still serves them or the history is restored); it relies on the
marker file still being there (deleting it by hand removes the evidence); and
nothing is detected until a 0.5.29+ sync (or the verifier) runs. Every
installed copy of the extension must be updated to 0.5.29 or later.

Migration: `exporter_version` is **2** from 0.5.29. Entries written with 1
(0.5.28 and earlier) are therefore not skipped: the next "All conversations"
sync re-exports each of them once, which replaces archived previews by
originals wherever Claude still serves them, labels the rest as previews, and
keeps every earlier file (`retained_assets`). A conversation whose re-export
fails keeps its archived copy and exporter version 1, so the next full sync
retries it; an incomplete re-export that lacks a file the archived copy has
(other than an image it represents by an original or preview of the same
name) keeps the archived copy. Old entries remain valid and readable. Run the
plan-only full sync first (popup: "Plan a full sync (writes nothing)"): it
does everything a full sync does, writes nothing to GitHub (every write
request is refused while it runs, and its attachments are never uploaded),
and reports the conversations to re-export, originals found, preview-only
images, new files, files kept instead of deleted, deletions (renamed
Markdown only), files already unreferenced, failed conversations, and the
count of images Claude lists only in `files_v2` (not exported; diagnostics).
See `docs/full-resync-original-images.md`. An index rebuild (dry run) cannot recover `preview_only[]`,
`retained_assets[]`, `variant`, `preview_of` or `file_uuid` from Markdown
alone; only the visible notes survive. The dry run therefore never reports
an entry holding them as unchanged: it lists them as "not preserved by a
rebuild" for that entry. It also never writes `requires_extension` or the
marker file.

## Index contract

The current index has a top-level `version` and each conversation entry has `format_version`.

These are deliberately separate:

- `index.version` describes the index structure.
- `format_version` describes the conversation storage format.

Current repository values are:

- index version: **2**
- conversation format version: **4**

Do not bump either value for cosmetic dashboard changes.

Each conversation entry also records `exporter_version`, the version of the extension's exporter that wrote it.
Incremental sync skips a conversation only when its entry has the current `exporter_version`, its `updated_at`
matches Claude's, and every referenced file exists; raising the exporter version therefore re-exports every
conversation once. Entries without the field (older archives) are simply re-exported on their next sync.

## Compatibility principle

Readers should be more tolerant than writers:

- Missing optional metadata must not make a conversation unreadable.
- Unknown metadata fields must be ignored and preserved when possible.
- Unknown message roles must remain visible.
- A missing index should be treated as rebuildable state, not lost conversation data.

## Migration rule

Future format changes must document:

1. what changed,
2. how old files are detected,
3. whether old files remain readable,
4. how migration is performed,
5. how the index is rebuilt.

No migration should rewrite existing conversations merely because the dashboard was upgraded.
