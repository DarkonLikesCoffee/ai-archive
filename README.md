# AI Conversation Archive — GitHub / Markdown Edition

A personal, portable archive for AI conversations. GitHub is the source of truth; conversations are stored as human-readable Markdown files. Claude is the first provider, but the data model is provider/account independent so ChatGPT, Gemini and other providers can be added later.

## What changed in this version

### v0.5.5 — inline images, contextual files, and reply excerpts

- Exports only the **currently active Claude branch** using `current_leaf_message_uuid` + `parent_message_uuid`, so edited messages and abandoned responses are not archived as if they were still visible.
- Renders image attachments as inline Markdown previews instead of plain links, with a filename-extension fallback when Claude reports `application/octet-stream`.
- Places user images/files/reply excerpts before the user's message, matching Claude's conversation flow.
- Places Claude-generated files beside the Claude response that created or referenced them; there is no trailing global `## Files` section.
- Treats real files as files: extracted document text is materialized as a downloadable text asset instead of being pasted into the conversation.
- Renders Claude's selected-text reply attachment (`excerpt_from_previous_claude_message.txt`) inline as the quoted excerpt before the user's reply.
- Downloads Claude sandbox files (uploads and generated outputs) through the conversation `wiggle` file endpoints.
- Stores binary/text assets inside the same GitHub archive and links/embeds them from the Markdown conversation.
- Tracks asset hashes in `archive/index.json` and removes assets that disappear from the active branch.
- Keeps the previous hidden metadata, readable filenames, and tool-call export behavior.


- **Markdown is the canonical conversation format.** Every conversation is readable without the app.
- `archive/index.json` is only a search/navigation cache, not the conversation store.
- **One Git commit per sync**, not one commit per conversation.
- Provider + account are part of the identity, so you can have multiple Claude/ChatGPT/etc. accounts.
- The web app searches the index and opens the Markdown conversation from GitHub.
- No Supabase, no custom server, and no GitHub Gists.

## Repository layout

```text
archive/
  index.json
  conversations/
    claude/
      personal/
        <conversation-id>.md
      work/
        <conversation-id>.md
    chatgpt/
      personal/
        <conversation-id>.md
```

A conversation file looks like:

```md
<!-- AI_ARCHIVE_METADATA
{
  "id": "abc123",
  "provider": "claude",
  "account": "personal",
  "title": "Example",
  "model": "...",
  "created_at": "...",
  "updated_at": "...",
  "message_count": 4
}
-->

# Example

## You

Hello

---

## Claude

Hi!
```

The metadata comment is intentionally hidden when GitHub renders the Markdown. It remains inside the file so the future dashboard can parse the stable conversation ID and other metadata.

Conversation filenames use a readable title plus a short stable-ID suffix, for example:

```text
ChatGPT-not-fixing-sync-and-repo-errors--9a6aed33.md
```

If a conversation title changes, the sync updates the filename and removes the old path in the same Git commit. The full conversation ID remains stable in the hidden metadata and `archive/index.json`.

## Claude tool calls

Claude tool-use blocks are preserved in Markdown rather than being replaced by the Claude UI's unsupported-device placeholder. Command-style tools are rendered as code blocks, and tool results are preserved separately.

## Sync behavior

- Latest 10/25/50/100/250 or all conversations can be selected.
- Auto-sync is opt-in and disabled by default.
- Sync progress is shown in the extension popup.
- A sync creates at most one GitHub commit.
- Existing v0.5.2/v0.5.3 conversations are migrated to the v0.5.4 format when their selected conversations are synced.

### Attachment rendering rules

- Images are rendered inline in Markdown when possible; common image extensions are used as a fallback when Claude reports a generic MIME type.
- User attachments and selected-text excerpts appear before the user's message.
- Claude-generated files are rendered directly beside the Claude response that created or referenced them.
- Real files are always links to archived files; extracted document text is never pasted into the conversation as a code block. If Claude exposes only extracted text and no downloadable binary, the extension preserves that text as a downloadable `.txt` asset rather than inline content.
- `excerpt_from_previous_claude_message.txt` is treated specially as reply context and remains inline as a quoted code block.
