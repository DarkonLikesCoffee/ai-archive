# Controlled live test: original-first images (extension 0.5.29)

The original-first image export (`docs/archive-format-v1.md`, "Image
originals and previews") is tested only against simulated Claude and GitHub
services. This procedure checks it once against the real Claude.ai, **without
touching the real archive**. Run it only with the owner's explicit approval.

## What it proves, and what it does not

- Proves: for a few chosen conversations, the extension downloads Claude's
  original uploads, stores them byte for byte with extensions and types taken
  from their bytes, labels previews correctly, and writes the version markers.
- Does not prove: behaviour for every conversation, Claude's availability of
  originals over time, or anything about the real archive. Downgrade
  detection is covered by automated tests that run the released 0.5.28 code;
  it is not part of this test.

## Prerequisites

1. A **new, empty, private** GitHub repository used only for this test. Do not
   reuse a repository written by an earlier build of this work (it would hold
   records without the version markers).
2. A fine-grained GitHub token with Contents read/write on **that repository
   only**.
3. A **separate Chrome profile**, logged into claude.ai, with only the build
   under test loaded unpacked from `extension/` (the popup shows 0.5.29). No
   other copy of the extension may write to the test repository.
4. The originals recovered by hand, in one local folder, named
   `original-<first 8 characters of the conversation ID>-<stem>.<png|jpg>`.
   The archived image whose name, without its extension, is `<stem>` is
   matched (a pasted image is `<stem>.png`; an uploaded file keeps its own
   extension). For the new test conversation of step 2, copy the two files
   you uploaded into such a folder under these names.

## Procedure

1. In the extension's settings (test profile), **first make sure automatic
   sync is off** (it is off unless it was turned on): an automatic sync would
   copy up to the 20 latest conversations before you choose what to sync. Then point
   the extension at the test repository, with a test account name such as
   `image-test`.
2. **New data.** Start a new Claude conversation, paste one PNG screenshot and
   upload one JPEG, and do not touch any other conversation. Then sync only
   the most recently updated conversation, which is the new one. The popup's
   smallest choice, "Latest 10", would also copy the 9 conversations before
   it; to sync exactly one, open the extension popup, right-click it, choose
   **Inspect**, and in that DevTools console run:

   ```js
   sendToClaude({ type: 'startSync', limit: '1' }, { openIfMissing: true })
   ```

   This is the popup's own sync call with a limit of 1. Check that the sync
   report says 1 conversation before continuing. Expected: both images archived as
   originals (`variant: "original"`, extensions matching their bytes), no
   "Preview only" note, `requires_extension: "0.5.29"` in
   `archive/index.json`, and `archive/.ai-archive.json` present.
3. **Recovered originals: stop and decide first.** The extension can only
   sync the N most recently updated conversations ("Latest N") or all of
   them; it cannot select conversations by ID. Find each recovered
   conversation's position in Claude's conversation list (most recent
   first): N must be at least the largest position, and the sync copies all
   N of those conversations into the private test repository. Agree on N
   with the owner before running it.
4. Clone the test repository locally and run, from the root of this source
   repository:

   ```bash
   node web/scripts/verify-recovered-originals.mjs <clone-of-the-test-repository> <folder-with-recovered-files>
   ```

   It reads local files only (no network, nothing written) and prints PASS/FAIL
   for each check, never image bytes or hashes. Exit status: 0 all checks
   passed, 1 a check failed, 2 it could not run. Expected: exit 0. Other images
   in those conversations may appear as `.webp` with "Preview only" notes and
   `preview_only` records (Claude answered 404 for their originals).

## Stop at the first problem

Stop and report (sync report, popup text, the script's output) on: any FAIL,
any sync error, any 403/429 from Claude, or any downgrade warning. Do not
retry against the real archive.

## Afterwards

Delete the test repository and the token if no longer needed. Nothing in
this procedure reads from or writes to the real archive.
