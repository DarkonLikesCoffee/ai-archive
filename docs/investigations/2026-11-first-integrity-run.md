# First real-archive integrity run: diagnosis

Run by the owner on 2026-11-06 against `DarkonLikesCoffee/ai-conversation-archive@main` with web 0.6.16 (`--markdown --hashes`).
- **Checked:** 824 conversations, 1,420 attachments hashed, 931 Markdown files.
- **Transfer:** 381.8 MB in 2,298 requests, with 0 retries and 0 download failures.
- **Findings:** 6 errors and 60 warnings.

This investigation was done **without reading the private archive**. The evidence comes from the verifier's output as reported, from the exporter's code and its full Git history in this repository, and from new synthetic tests. **Confirmed** means it follows from code or history; **likely** means it is consistent with every fact available and is confirmed or refuted by the `--history` run described below.

## 0. Verifier issues found (confirmed, fixed in web 0.6.17)

1. **Duplicate reporting.** Every *occurrence* of a broken link was a separate error. The 6 errors are therefore 2 missing targets, each linked several times. Now there is one finding per Markdown file and target, with an `occurrences` count.
2. **Possible false positives.** Every `](assets/…)` in a file was treated as an exporter-written attachment link, including links inside code blocks and links to *another* conversation's attachment folder.
   - Every exporter version since the first commit (`d90190a`) builds a conversation's attachment folder from that conversation's own ID: the legacy layout `assets/<first 8 characters>/` until 2026-10-26, and since then `assets/<id slug>-<hash>/`.
   - So a link to another conversation's folder, or a link inside code, cannot be an attachment reference written by the exporter.
   - Such links are now the warning `link-unresolved-quoted`. They are not hidden.
   - A missing link into the conversation's **own** folder, outside code, is still the error `link-broken`.
3. **Unexplained warnings.** `file-unreferenced` said only "orphaned, or written by another tool". Each one now carries a `kind` and an explanation, and the report groups them by kind and folder.
4. **Incomplete conversations without detail.** `conversation-incomplete` now lists each missing file with its category: not available from Claude, over the upload limit, or refused by GitHub.

No check was removed or weakened. Every finding that was reported before is still reported, as an error or a warning.

## 1. The six "broken asset link" errors

**Affected file:** `archive/conversations/claude/darkon/Code-block-and-image-rendering-fixes--138089cb-…-1f4d8315.md`

| Target | Facts | Diagnosis |
|---|---|---|
| `assets/bb7e12e2/9ac6b0da-extension.js` | `bb7e12e2` is a legacy-layout folder (8 hex characters) of a conversation whose ID starts with `bb7e12e2`, not this one (`138089cb`) | **Confirmed:** not a link the exporter wrote for this conversation. **Likely:** archive Markdown quoted in the conversation text; the conversation is about how attachments and code blocks render |
| `assets/9da9cc54/f7ac55ff-IMG_20260922_111920.jpg` | Same: the legacy folder of a conversation starting with `9da9cc54` | Same |

**Why the targets don't exist (likely).** The conversations `bb7e12e2…` and `9da9cc54…` were archived under the legacy layout. When they were later re-exported, their attachments were written under the current layout and the legacy paths were removed by that sync's own cleanup.

The file names keep their `<SHA-256 prefix>-<name>` form across layouts, so the same files should exist under `assets/bb7e12e2-…/9ac6b0da-extension.js` and `assets/9da9cc54-…/f7ac55ff-IMG_20260922_111920.jpg`. The 0.6.17 report lists files with the same name and says whether their indexed SHA-256 starts with the same prefix.

**Is data missing?** Likely not. These are references in quoted text. The files they named were most likely moved, not lost.

**To confirm** (read-only):
```bash
GITHUB_TOKEN=<read-only token> node web/scripts/verify-archive.mjs DarkonLikesCoffee/ai-conversation-archive --branch main --markdown --history
```
Expect both links as `link-unresolved-quoted`, each with a same-name candidate. The history line should show the commit that removed the legacy path; its parent still has the file.

## 2. The 56 `file-unreferenced` warnings

**Status: not yet classified on the real archive.** These are files under `archive/conversations/` that `archive/index.json` does not reference. The index doesn't reference them; that does not mean the data is missing. Possible causes, which the 0.6.17 report now names per file (`kind`):

| kind | Meaning | Data at risk? | Justified action |
|---|---|---|---|
| `duplicate-conversation` | An older Markdown copy of a conversation the index lists elsewhere. A rename leaves one when the old path was still referenced at the time | No (the indexed copy is current) | Optional cleanup after review |
| `conversation-not-indexed` | A conversation file whose identity is not in the index | **Possibly hidden from the viewer** | Run `--rebuild-dry-run`; re-indexing needs the reviewed apply step (P0.2), never automatic |
| `markdown-not-indexed` | A Markdown file without a readable identity | Unknown | Inspect manually |
| `linked-not-indexed` | An attachment a conversation links to, but the index doesn't list | No | Re-sync that conversation (the exporter rewrites its index entry) |
| `duplicate-copy` | The same bytes as an indexed attachment | No | Optional cleanup after review |
| `legacy-layout` | A file in a legacy `assets/<8 hex>/` folder, usually left over from before the layout change | No (usually also archived under the new layout) | Optional cleanup after `--history` and `duplicate-copy` confirm it |
| `placeholder` | The path contains a one-character run such as `aaaaaaaaaa`, which is not an ID the exporter writes | No (most likely sample or test data) | Confirm with `--history` which commit wrote it |
| `orphaned` | Nothing references it | Investigate | Inspect manually |

**About `aaaaaaaaaa`, `bbbbbbbbbbb` and `ccccccccc`.** Claude conversation IDs are UUIDs, and account folders are names typed in the popup. Strings like these are not produced by the exporter from Claude data. Nothing in this code base or its tests writes them to a real repository: the tests and E2E only talk to fake services.

**Likely:** these are test accounts or sample conversations created by hand, for example names typed while testing the account picker, or files added outside AI Archive. `--history` shows the commit that wrote each one. A commit message like "Sync N AI conversations" means the extension wrote it; anything else means another tool did.

## 3. The 4 `conversation-incomplete` warnings

**Affected:**
- `Building-custom-Valorant-overlay-apps`
- `Code-block-and-image-rendering-fixes`
- `Extracting-carousel-code-for-reuse`
- `Sharing-ChatGPT-conversation-format`

**Confirmed from the owner's live sync reports (0.5.21–0.5.25):** exactly 4 conversations contain the 7 attachments over the ~30 MiB upload limit. They are archived with visible "Not archived" notes and are correctly marked incomplete. The 0.6.17 warning lists each missing file with its category.

**Is data missing?** The oversized files are deliberately not in the archive and are still available in Claude. Everything else in these conversations is archived. This is expected behaviour, not corruption.

**Recovery.** Not possible within the current upload limit; it is an owner decision (ROADMAP P1.3, "decide whether and how to raise the attachment upload limit").

## 4. What can safely be recovered, and which repairs are justified

- **Nothing needs an urgent repair.** No finding shows lost bytes of an indexed attachment: all 1,420 attachments hashed correctly, and there were 0 download failures.
- **Justified now:** nothing automatic. All actions stay read-only until the `--history` run classifies the 56 files.
- **Justified after review:**
  - re-sync conversations whose files are `linked-not-indexed`;
  - review `conversation-not-indexed` files with `--rebuild-dry-run`.
- **Needs further investigation:** `markdown-not-indexed` and `orphaned` files, and whatever the `placeholder` files turn out to be.
- **Never without the owner:** deleting `duplicate-*`, `legacy-layout` or `placeholder` files. That would be an archive rewrite, and the files remain in Git history anyway.

## 5. Next step (owner)

Run the command above with `--markdown --history` (and `--json > report.json` if convenient). Report the `kind` totals from the "Unreferenced files by kind and folder" summary and the two `link-unresolved-quoted` findings. No file contents are needed.
