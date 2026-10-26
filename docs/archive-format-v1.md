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

## Index contract

The current index has a top-level `version` and each conversation entry has `format_version`.

These are deliberately separate:

- `index.version` describes the index structure.
- `format_version` describes the conversation storage format.

Current repository values are:

- index version: **2**
- conversation format version: **4**

Do not bump either value for cosmetic dashboard changes.

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
