# AI Conversation Archive — GitHub / Markdown Edition

A personal, portable archive for AI conversations. GitHub is the source of truth; conversations are stored as human-readable Markdown files. Claude is the first provider, but the data model is provider/account independent so ChatGPT, Gemini and other providers can be added later.

## What changed in this version

### Unreleased — export fidelity and reader fixes (#29–#45)

- **Inline media is archived in place.** Base64 images, audio, video, and documents (for example PDFs) inside a message are saved as assets and linked at their original position; images embed, other files link. Identical content is stored once, even when several messages contain it.
- **Tool output is no longer lost.** Every tool input field is kept (artifact content, file-editor paths and text, command descriptions), and media returned by tools (screenshots, charts, audio) is archived as an attachment of the message. Binary payloads never enter the Markdown; they appear as `[omitted inline payload: N characters]`.
- **Citations and references are kept.** Sources attached to Claude's text are listed after the text as safe links with their quoted passages; unknown content blocks are preserved as readable metadata instead of disappearing.
- **Correct image placement.** Inline images resolve to the right file at the right position, including shared files and nested content, and text that merely looks like an internal image marker is left untouched.
- **Safer web reader.** HTML in archived link labels can no longer execute, `javascript:` links are not clickable, and attachments whose names contain brackets (for example `Screenshot [2].png`) now display.

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

## Installation and setup

You need Chrome (or another Chromium browser that supports Manifest V3 extensions), a Claude.ai account, and a GitHub account. Node.js 22 is only needed to run the web viewer.

### 1. Create the archive repository

Create a **private** GitHub repository for the archive, for example `ai-conversation-archive`. It can be completely empty; the first sync initializes it.

### 2. Create GitHub tokens

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):

- **Repository access:** only the archive repository.
- **Permissions → Contents:** **Read and write** for the extension, which commits the archive.

For the web viewer, a second token with **Contents: Read-only** is enough and is the safer choice.

### 3. Install the extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this repository's `extension/` folder.
3. Optional: edit `extension/config.js` to prefill your GitHub owner and repository name in the popup.

### 4. Connect the extension to GitHub

1. Open [claude.ai](https://claude.ai) and sign in.
2. Click the AI Archive extension icon, enter the owner, repository, and the read-and-write token, and choose an account name (for example `personal` or `work`; it separates archives from different Claude accounts).
3. Click **Save GitHub settings**. The extension checks the repository first and tells you if the token is invalid, the repository cannot be found, or the token cannot write to it.

### 5. Sync

- With a claude.ai tab open, choose **All conversations** or **Latest N** and click **Sync Claude**. Progress is shown in the popup and the sync can be cancelled at any time; a sync publishes exactly one commit, or nothing if it fails or is cancelled.
- **All conversations syncs are incremental.** A conversation whose Claude update time has not changed since it was archived, and whose archived files are all present, is not downloaded again; the completion message says how many were skipped. A **Latest N** sync always re-downloads those N conversations, which is how to force a refresh. After an extension update that changes the export format, the next sync re-exports every conversation once.
- **Automatically sync when Claude opens**: when enabled, opening a claude.ai page (at most once every 10 minutes) syncs every conversation that changed since it was archived. Until the archive has its first sync, it only checks the 20 most recently updated conversations, so use a manual **All conversations** sync for the first import.
- The popup shows the outcome of the last sync, manual or automatic, with when it ran (for example "Last sync failed 12 min ago: …").
- Transient GitHub failures (network errors, 5xx, secondary rate limits) are retried automatically. If a sync still fails, nothing is published and it is safe to sync again; unchanged conversations are not re-uploaded. If one conversation cannot be exported (for example an attachment that will not download), it is skipped, its archived copy stays as it was, the other conversations are still synced, and the completion message names it.

### 6. Browse the archive

```bash
cd web
npm install
npm run dev        # open the printed local URL
# or: npm run build, then serve web/dist with any static file host
```

Enter the owner, repository, and the read-only token. The token is stored only in that browser's local storage. Attachments you have viewed are cached in the browser by content hash, so reopening a conversation does not download its images again; **Disconnect** removes the token and the cache. Search all conversations from the list: every word must appear (in any order), `"quoted phrases"` must appear as written, results are ranked with title matches first, and each result shows where it matched. The list is grouped by date (Today, Yesterday, Previous 7 days, Previous 30 days, then by month) and can be sorted by most recently updated, most recently created, oldest first, or title; while searching, results are ordered by best match unless you pick another order. Inside a conversation, use the find bar (Ctrl/Cmd+F); every code block has a **Copy** button. **Print / PDF** prints the open conversation, or saves it as a PDF through the browser's print dialog, without the sidebar or buttons and in a light layout whatever the theme. On a phone, the ☰ button opens the sidebar (providers, accounts, theme, refresh, disconnect). Keyboard: `/` focuses search (or the find bar inside a conversation), `j`/`k` move through the list and Enter opens a conversation, and Escape leaves the find bar and then returns to the list. Every conversation, search, and sort order has its own link (for example `#/c/claude/personal/<id>`), so reloading keeps your place, the browser's Back button returns to the list, and a conversation can be bookmarked.

### Known limitations

- Claude.ai is the only provider so far.
- The extension reads Claude.ai's internal web API, which can change without notice.
- **All conversations** relies on Claude.ai returning the full conversation list in one response, which is how it is read today. This has not been verified against very large accounts. If an **All conversations** sync does not receive a conversation that is already archived for that account (deleted in Claude, or a truncated list), the completion message reports how many; their archived copies are always kept.

## Testing

- `node --test extension/*.test.js` and `cd web && npm test` run the unit tests; CI also builds the viewer.
- `node e2e/extension-sync.e2e.cjs` runs the unpacked extension in headless Chromium against fake claude.ai and GitHub servers. It goes through popup setup (including a rejected token), a first sync into an empty repository, an unchanged incremental sync, a changed conversation, a GitHub outage that publishes nothing, and the retry, and inspects the commits and files the extension published. With `VIEWER_URL` set to a running viewer (see `web/README.md`), it also opens the synced archive in the viewer. It needs Playwright with a Chromium browser and is not part of CI. It does not replace a real sync: claude.ai's actual API responses and GitHub's real API are only modelled.

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
