# AI Archive Dashboard v0.6.6

Web dashboard for browsing the AI conversation archive stored in a private GitHub repository.

## v0.6.6
- Theme cycle is **Black → Slate → Light**.
- The original palette is named **Slate** instead of "Current".
- Sidebar is fixed to the viewport height.
- Only the Accounts list scrolls when there are many accounts.
- Clicking an account from the sidebar returns to that account's conversation list, including from inside a conversation.
- Theme variables now consistently apply to conversation cards, reader surfaces, controls, code blocks, tool groups, and attachments.
- Image attachment detection is based on both MIME type and filename extension.
- Attachment paths are resolved relative to the conversation's GitHub directory and normalized before lookup.
- Image asset lookup also supports filename/basename fallbacks and URL fragments/query strings.
- Existing compact tool groups, right-aligned user messages, sticky reader header, hidden metadata, Markdown rendering, and attachment cards are retained.

## Run

```bash
npm install
npm run dev
```
