# Overnight progress — AI Conversation Archive

Branch for this file: `claude/fervent-fermi-pljls6` (progress notes only; not meant to be merged).
Last updated: 2026-10-27 16:50 UTC — real-account sync failures diagnosed and fixed in code (PR #79, merged as `00c4850`); real-account confirmation pending.

## Product feature inventory (owner priority: finish the product)

Status key: ✅ complete + test-verified · 🟡 implemented, needs real-world verification · ❌ missing

| Area | Feature | Status | PRs |
|---|---|---|---|
| Export | Active branch only, ordering, text/markdown, citations, unknown blocks | ✅ | #28–#36, #47 |
| Export | Inline images/audio/video/documents in place, dedupe, tool-result media | ✅ | #31–#45 |
| Export | Tool calls with every input field; readable artifact/editor bodies | ✅ | #41, #42, #46 |
| Export | One bad conversation no longer blocks the rest (skipped + reported) | ✅ | #53 |
| GitHub | Settings validation (bad token / missing repo / no write access) | ✅ | #50 |
| GitHub | One atomic commit per sync, stale-branch guard, interrupted-publish check | ✅ | earlier |
| GitHub | Retry transient failures; explain 401/403/rate limits | ✅ | #50 |
| GitHub | Automatic sync on Claude open (latest 20, ≤ every 10 min) | ✅ | #48 |
| GitHub | "Sync all" completeness | 🟡 one-request list (unverified for huge accounts); any archived conversation Claude did not list is now **reported**, never dropped | #55 |
| Popup | Progress + Cancel survive reopening the popup mid-fetch | ✅ | #54 |
| Viewer | Load index/conversations/assets, large files, bounded asset loading, retries | ✅ | #43, #52 |
| Viewer | Markdown, code, images, citations, tool groups, artifacts, safe rendering | ✅ | #36, #43, #46, #47 |
| Viewer | Global search, in-conversation find bar, provider/account filters | ✅ (existing) | — |
| Export | Incremental "All conversations" sync (unchanged conversations not re-downloaded) | ✅ (🟡 relies on Claude's `updated_at`) | #57 |
| Viewer | Multi-word / phrase search, ranked, with highlighted snippets | ✅ | #58 |
| Popup | Last sync outcome (manual or automatic) shown with time | ✅ | #59 |
| Viewer | Deep links for conversations/search/sort; Back/reload work | ✅ real Chromium | #60 |
| Test | Real-browser e2e of the extension (popup + content script + service worker) vs fake claude.ai/GitHub | ✅ 23/23 | #61 |
| Viewer | "Open on GitHub" follows the default branch (main or master) | ✅ | #62 |
| Viewer | Date groups + sort (updated / created / oldest / title) | ✅ real Chromium | #63 |
| Viewer | Attachment cache by sha256 (no GitHub calls on revisit; cleared on Disconnect) | ✅ real Chromium | #64 |
| Viewer | Copy buttons on code blocks; find bar ignores button labels | ✅ real Chromium | #65 |
| Viewer | Print / Save as PDF (print stylesheet) | ✅ real Chromium PDF | #66 |
| Viewer | Phone layout: sidebar drawer (was unreachable below 700px) | ✅ real Chromium | #67 |
| Viewer | Keyboard shortcuts (/, j/k, Enter, Escape) | ✅ real Chromium | #68 |
| Popup | Bug: finished sync reported as "fetching" for 5 min (Sync disabled) | ✅ fixed | #69 |
| Popup | Sync from any tab: finds or opens a Claude tab | ✅ real Chromium e2e | #70 |
| Viewer | Outline of your prompts in long conversations | ✅ real Chromium | #71 |
| Viewer | Print / Open on GitHub reachable on phones | ✅ real Chromium | #72 |
| Viewer | First run: clear "repository not found"; empty archive shows next steps | ✅ real Chromium | #73 |
| Export | **Bug:** syncs over ~48 MB of attachments failed (Chrome 64 MiB message limit) → chunked handoff | ✅ reproduced + fixed in real Chromium | #74 |
| Export | Attachment over GitHub's 100 MB limit no longer fails every sync (left out with a visible note) | ✅ unit + real Chromium (cap lowered in a test copy) | #75 |
| Test | Rich content (tools, citations, inline image) end to end, extension → Markdown → viewer | ✅ 31/31, no bug found | #77 |
| Viewer | Archive overview (totals, per month, models, accounts) | ✅ real Chromium | #78 |
| Docs | Install, token setup, sync, viewer, known limitations | ✅ | #51 |
| All | Real claude.ai export + real Chrome + real GitHub end-to-end | 🟡 not possible here; the extension now runs end to end in headless Chromium against faithful fakes (#61), but real claude.ai responses and real GitHub remain unverified | — |

## Real-account sync investigation (2026-10-27, owner report) — PR #79, squash-merged as `00c4850` (branch head `8d25566`, CI green)

Owner's first real sync: Claude listed 11 conversations (sidebar shows 11); 1 committed, 7 "could not be
exported", the rest unchanged; viewer showed 4.

### Per-conversation status (from code + owner's popup text; IDs not available to me)
| Conversation | Returned by Claude's list | Fetched | Export | Committed | In viewer | Cause |
|---|---|---|---|---|---|---|
| Busqueda y Uso de la informacion, Carrera de estudios, Information science, Rutina del gym | yes | 1 of them re-fetched (changed), 3 unchanged | ok | yes (earlier syncs + 1 now) | yes | — |
| Repaso de Information Science | yes (it was attempted) | yes | failed | no | no | sandbox `list-files` HTTP 404 (error text seen) |
| Canva con guion de diapositivas | yes | yes | failed | no | no | sandbox `list-files` HTTP 404 (error text seen) |
| Base de datos | yes | yes | failed | no | no | PDF listed without a download URL, no sandbox/extracted match (error text seen) |
| Proyecto web open-source, Edición digital 1, Édition digital asignatura, Medios de comunicacion y sociedad digital | yes (11 = 1 + 3 + 7) | yes | failed | no | no | not shown (popup listed only 3 errors) — most likely sandbox 404 too; **unconfirmed** |

Why "returned by Claude" is a deduction: every listed conversation ends up unchanged, exported, or in
`skipped`; 1 + 3 + 7 = 11 = the sidebar count. Why "not hidden by the viewer": skipped conversations never
reach the background; index entries are never removed; the viewer lists every index entry unless the URL
carries an account/provider filter — so the 7 were never archived.

### Confirmed causes and fixes (code, tests, and a real-browser reproduction against a fake claude.ai)
1. `list-files` 404 threw → whole conversation skipped. Fix: 404 = no sandbox; conversation archived; if file
   tools were used, a visible "Incomplete archive" note + `incomplete` in the index. Other statuses still skip
   and retry.
2. File without URL (or download 404/410) threw → whole conversation skipped. Fix: try the sandbox; else
   archive with "Attachment not archived: <name> (<reason>)" in place, `incomplete` in the index.
3. Incomplete entries are never "unchanged" → every sync retries them.
4. Integrity guard: an incomplete export never replaces an archived copy that has files the new export lacks.
5. Reporting: listed / committed / unchanged / failed (new vs archived copy kept) / incomplete / kept-previous;
   "Sync finished with problems"; popup list with titles + IDs; viewer "files missing" badge; outdated
   "Sync stopped before anything was sent to GitHub" texts removed.
6. "Copy diagnostic report" (sanitized response structure; no text, titles, file names, contents, credentials).

Reproduction: the extension e2e's fake claude.ai answers `list-files` with 404 + Claude-style error body and
lists the PDF without a URL; on master it fails with the exact real error text, on the branch it passes.

Tests: extension 135/135, web 73/73, build OK, viewer e2e 47/47, extension e2e 37/37.

### Still needs the real account
- That `list-files` 404 means "no sandbox" (inferred: same endpoint works for other conversations).
- Where Claude exposes the PDF's file (needs the diagnostic report) — the PDF is now visibly marked, not lost,
  but not yet downloaded.
- That the 4 conversations without visible error text failed for the same reason, and that all 7 now archive.

## Ground rules followed
- No force-push, no history rewrite, no deploys/releases.
- `master` is **not** a protected branch (`protected: false`, no required checks).
- Merging: the owner granted autonomy to merge verified changes (tests + build pass, diff reviewed, CI green on
  the exact head). Squash-merge with expectedHeadSha.
- Every merge: base retargeted to `master`, `master` merged into the head (no rebase), changed lines
  verified identical to the reviewed PR, local tests run, CI green on that exact head, then squash-merge
  with `expectedHeadSha`.

## Checklist
- [x] Merge #37 (scoped inline positions) → `1aa1c9d`
- [x] Merge #43 (reader asset paths from placeholders) → `97be843`
- [x] Merge #38 (single traversal) → `5b64546`
- [x] Merge #39 (nonce markers) → `93998f7`
- [x] Merge #40 (audio/video/documents via shared pipeline) → `2eff073`
- [x] Merge #44 (cross-message inline dedupe) → `9e9b113`
- [x] Merge #45 (tool-result media archived as attachments) → `e9dc6ae`
- [x] Merge #41 (keep every tool input field) → `e654726`
- [x] Merge #42 (redact tool input payloads) → `53ac164`
- [x] Final master `53ac164` verified: syntax OK, extension 84/84, web 30/30, build OK, e2e probe as expected
- [x] Readable artifact/tool bodies (approved): PR #46 (`feat/readable-tool-bodies`), extension 85/85, web 33/33, build OK — **open for review, not merged**
- [x] Readable tool bodies: format documented in `docs/archive-format-v1.md` (in PR #46)
- [x] Fidelity audit: reader split Claude answers at `---` + `## Section` into fake messages → PR #47
      (role-heading boundaries; raw lowercase roles kept; contract rule 3 documented) — **open, not merged**
- [x] Dry-run: #46 + #47 merged together onto master → extension 85/85, web 35/35, build OK
- [x] Audited, no bug found: popup (textContent only), reader asset loading (index paths + unique basenames),
      github.js blob fallback, sync change detection

## Test results (latest)
- master `53ac164`: syntax OK, extension 84/84, web 30/30, build OK.
- PR #46 (`feat/readable-tool-bodies`): extension 85/85, web 33/33, build OK, CI green.
- PR #47 (`fix/reader-message-split-on-headings`): extension 84/84, web 32/32, build OK, CI green.

## Milestone status (2026-10-26 21:20 UTC)
Main development phase: **complete in code and automated tests**. Every roadmap feature is implemented end to end
and covered by tests; master passes all extension/web tests and the production build. What is NOT done, and cannot be
done in this environment: an end-to-end run with a real claude.ai account in real Chrome against a real GitHub repo.
That is the single most important remaining step (owner).

Secondary items left (none blocks the product):
- Explicit message separator in the export format (removes the last `---` + `## You` ambiguity, but rewrites every
  archived conversation once) — deferred.
- `decompressSearchText` strips a literal `\n` instead of newlines — harmless (btoa output has none).

## Merged in the product-completion cycle
- #46 readable tool bodies · #47 role-heading message split · #48 automatic sync · #49 README changes
- #50 GitHub retries + clear auth/permission/rate-limit errors + settings validation
- #51 installation and setup docs · #52 viewer retries + bounded asset loading
- #53 skip unexportable conversations instead of failing the whole sync
- #54 popup progress/Cancel during the fetching phase
- #55 report archived conversations a full sync did not receive
- #56 escape filenames in unarchived-attachment placeholders
- Final master `d95d9ee`: syntax OK, extension 102/102, web 39/39, build OK

## Post-roadmap cycle (owner: keep building useful capabilities)
- #57 incremental sync · #58 search syntax/ranking/snippets · #59 last-sync status in popup
- #60 viewer deep links + Playwright viewer e2e (`web/e2e/viewer.e2e.cjs`)
- #61 extension e2e (`e2e/extension-sync.e2e.cjs`): loads the unpacked extension with `channel: 'chromium'`
  (old headless never starts the service worker); service-worker fetches are routable with
  `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1`. Optional `VIEWER_URL` stage opens the synced archive.
- #62 "Open on GitHub" link used blob/main (404 on master archives) → blob/HEAD
- #63 date groups + sort · #64 attachment cache · #65 copy-code buttons · #66 print/PDF
- #67 phone sidebar drawer · #68 keyboard shortcuts
- #69 bug found by the extension e2e once it clicked the real Sync button: a reopened popup showed a finished
  sync as still fetching (and disabled Sync) for 5 minutes after every sync — fixed
- #70 Sync from any tab (find most recent Claude tab, or open one in the background)
- #71 prompt outline · #72 phone reader actions · #73 first-run states
- #74 **serious bug**: the content→background handoff was one message; Chrome caps messages at 64 MiB, so any
  sync carrying > ~48 MB of base64 attachments failed and published nothing (a big first sync could never
  succeed). Reproduced with the real extension (3 × 25 MB) → chunked handoff; e2e checks bytes end to end.
- #75 attachments over GitHub's 100 MiB limit are left out with a note (they could never be archived; they
  used to fail every sync). Playwright's DevTools pipe cannot carry a single >100 MB response, so the e2e runs
  a copy of the extension with the cap lowered to 30 MiB; the real constant is unit-tested.
- #76 ignore web/dist · #77 rich-content end-to-end fidelity check (no bug found)
- Not verified: GitHub API behaviour for single files between 50 and 100 MB.
- #78 archive overview.

## Status after #78 (2026-10-27 07:40 UTC)
No further capability is both meaningful and verifiable in this environment. What remains needs the owner:
1. **Real-world run** (most important): a real claude.ai account in real Chrome against a real GitHub repo —
   especially "All conversations" on a large account (list completeness/paging, `updated_at` semantics for
   incremental sync, sign-in redirect when Sync opens a background tab).
2. **Decision:** explicit message separator in the export format (fixes the `---` + `## You` ambiguity, but
   rewrites every archived conversation once).
3. **Decision:** delete the superseded `fix/materialize-inline-audio-video` branch.
Check-ins switched to the long fallback (≈50 min, then ≈4 h, stop after 3 empty) per the policy.
- Test totals on master + #71: extension 118/118, web 67/67, viewer e2e 41/41, extension e2e 24/24.
- Next candidates: reader controls on phones (Print/Open on GitHub are hidden < 700px), archive overview.

## Process note
- A merge-conflict resolution on #54 briefly pushed an unparsable test file because a `grep`-based check did not
  stop the command chain. Fixed in the next commit; commits are now gated on the parsed `# fail 0` count.

## Findings needing an owner decision
- Unverified risk: `/chat_conversations` is fetched once without pagination. If claude.ai paginates, "sync all"
  could silently miss older conversations. Needs a real-account check. No evidence either way in the repo or the
  uploaded design conversation; speculative paging was NOT added (if the API ignored paging params, the existing
  duplicate-UUID guard would fail every sync).
- Message separator ambiguity remains for bodies containing `---` + `## You`/`## Claude`; a real fix needs an
  explicit separator in the export format, which would rewrite every archived conversation once (owner decision).

## Scheduler behavior and check-in policy

Verified 2026-10-26 with a probe (trig_01X1rgvyHPMXZtWqx7se3MnL):
- `send_later` only supports a fixed delay or an absolute time (1-minute granularity). There is no
  "start after the current run ends" option. The probe set at 20:47:19 for 20:49:00 fired at 20:49:32 (~30 s late).
- A check-in firing **during an active run does not start a parallel run**: it is queued for this session and was
  read via `ReadNotifications` inside the running turn (20:50:49). Queued items that are not read during a turn
  wake the session after the turn ends (observed for GitHub events queued 19:32–19:42 while a turn was running).
- Not verified: behavior if a run is cut off mid-way (container restart). The next run recovers from Git state and
  this file.

Policy:
1. Finish the current task, push, and update this file before scheduling anything.
2. Keep **exactly one** pending check-in, always bound to this session (`send_later`). Before scheduling, list
   triggers and delete any other pending check-in. Never use `create_new_session_on_fire` or another session for
   repo work, since those could run in parallel on the same repository.
3. Useful verifiable work remains → schedule the next check-in with a 1-minute delay as the run's last action, so
   the next run starts within ~1–1.5 min of this one ending (or right after it, if the run outlasts the delay).
4. No useful work (only waiting on owner review or decisions) → long fallback: ~50 min, then ~4 h; stop after 3
   check-ins in a row that find nothing new. GitHub events on watched PRs wake the session anyway.
5. Every run starts with `ReadNotifications`; a check-in already read during a turn counts as consumed, so the
   same work is not repeated.

Soak test (20:47–20:50 UTC): extension + web suites run 23 times each on master and the heads of #46, #47, #48 —
no failures (no flaky tests found).

## Blockers / notes
- `fix/materialize-inline-audio-video` (no PR) is superseded by #40 and contains a `'\\n\\n'`
  join regression. Left untouched; safe to delete once the owner agrees.
- Nothing has been verified against a real claude.ai export in a browser.
