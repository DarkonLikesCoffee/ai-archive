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
3. Messages are separated by `---` and start with an H2 role heading.
4. `You` maps to the normalized `user` role.
5. The provider's own role name maps to normalized `assistant`.
6. Unknown role headings must be preserved rather than discarded.
7. Message content is Markdown and must be treated as opaque message data by the archive layer.

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
