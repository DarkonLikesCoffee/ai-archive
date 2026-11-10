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
   The image Claude names `<stem>.png` is matched by that name.

## Procedure

1. In the extension's settings (test profile), point it at the test
   repository, with a test account name such as `image-test`.
2. **New data.** Start a new Claude conversation, paste one screenshot and
   upload one JPEG, then sync "Latest 10". Expected: both images archived as
   originals (`variant: "original"`, extensions matching their bytes), no
   "Preview only" note, `requires_extension: "0.5.29"` in
   `archive/index.json`, and `archive/.ai-archive.json` present.
3. **Recovered originals.** Sync "Latest N" with N just large enough to
   include the conversations the recovered files come from. This copies N of
   the owner's conversations into the private test repository; check their
   positions in Claude's list first.
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
