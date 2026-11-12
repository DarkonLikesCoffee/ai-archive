# Full re-sync: replacing archived previews with originals (extension 0.5.29)

Exporter version 2 (extension 0.5.29) archives Claude's original image uploads
instead of WebP previews (`docs/archive-format-v1.md`, "Image originals and
previews"). Because every archived entry was written by exporter version 1,
the next "All conversations" sync re-exports each conversation once. This
document is the procedure for that one re-sync. Run it only with the owner's
approval.

## What the re-sync does, and does not do

- Re-exports every conversation of the selected archive account once. Images
  get their original wherever Claude's Files API (or, in older sandbox
  workspaces, the sandbox's `uploads/` copy) still serves it; the others are
  stored as labelled previews (`preview_only`).
- Never deletes an attachment. Every earlier file the new export no longer
  links (old previews under `.png`/`.jpg` names, files whose message left
  Claude's active branch) stays in the repository and is listed in
  `retained_assets`, annotated (`superseded_by`, `same_bytes_as`, and
  `variant: "preview"` when identical to a current preview). A kept file is
  never labelled as an original.
- A conversation whose download fails keeps its archived copy unchanged (and
  exporter version 1, so the next full sync retries it). An incomplete
  re-export that lacks a non-image file the archived copy has keeps the
  archived copy.
- Only Markdown files of renamed conversations are removed (their content is
  written to the new path).
- Covers one archive account (Claude login) per run. Each account is synced
  from its own Claude login.

## Before anything

1. **Every installed copy of the extension is 0.5.29 or later**, in every
   browser profile that syncs this archive. An older copy that syncs later
   would replace originals with previews in what it re-exports (detected and
   warned about through `archive/.ai-archive.json`, but not preventable).
2. In the popup: the right GitHub repository, the right archive account, and
   automatic sync off during the re-sync.

## 1. Plan only (writes nothing)

1. Open the popup, select the archive account, and click **Plan a full sync
   (writes nothing)**. It downloads every conversation a full sync would and
   computes every change, but writes nothing to GitHub: every write request
   is refused while it runs, and its attachments are never uploaded.
2. When it finishes, the popup shows a summary; **Copy last plan report**
   copies the full report as JSON (it contains conversation titles and file
   paths: keep it private). It reports: conversations to change (and how many
   are re-exports from the older exporter), originals found, previews kept
   next to an original, preview-only images, new files, files kept instead of
   deleted, deletions (renamed Markdown only), files already unreferenced,
   failed conversations with reasons, conversations that kept their archived
   copy, and images Claude lists only in `files_v2` (diagnostics; not
   exported).
3. Review it with the owner before going on. Stop if anything is unexpected:
   attachment deletions (there should be none), many failed conversations,
   any 403/429, or a downgrade warning.

## 2. The real re-sync (only after approval of the plan)

Select **All conversations** and click **Sync Claude**. It is one GitHub
commit for the whole account; nothing is published if anything fails before
that commit. A second full sync afterwards should change nothing except
conversations that failed or are incomplete (they are retried).

## Limits

- Whether Claude still serves an original is decided by Claude's undocumented
  Files API; many older originals answer 404 and stay previews.
- Images Claude lists only in `files_v2` are counted, not archived.
- The plan downloads everything from Claude, like a real full sync; it is not
  cheaper, only safe.
