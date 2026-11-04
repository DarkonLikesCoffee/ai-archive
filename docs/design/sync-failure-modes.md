# Sync failure modes (ROADMAP P0.3)

Review of extension 0.5.23 (`content.js` → transfer → `background.js` `sync()` → GitHub). For every failure: what the user sees, what happens to the archive, and the test that covers it. Tests named here are in `extension/background.test.js` (B), `extension/content.test.js` (C) or `e2e/extension-sync.e2e.cjs` (E).

**Invariant.** Nothing on the branch changes until the single non-force PATCH of the branch ref. Every Git object created before it (blobs, trees, the commit) is unreferenced. A failure before the PATCH therefore leaves the archive exactly as it was. A failure *of* the PATCH is resolved by reading the branch back.

## 1. Discovery and download (Claude tab)

| Failure | Outcome | Test |
|---|---|---|
| Claude's list or count is unreadable, inconsistent or incomplete | Sync fails before any transfer; nothing published | C: count/pagination tests |
| One conversation is malformed, or an attachment download fails (5xx, network, 403, 429) | That conversation is skipped; any archived copy kept; reported; retried next sync | C, B: "names conversations that could not be exported" |
| An attachment is gone at source (404/410, no URL) | Conversation archived with a visible "not archived" note, marked incomplete, retried every sync | B/E: "a file that could not be archived is shown where it was attached" |
| An attachment is over the upload limit | Same as above. The download is skipped on repeat syncs only when Claude confirms the recorded size | C: "known size" / "always download" |
| The archive state cannot be read (GitHub unavailable) | Full download, and the result says why | B/C: archive-state fallback tests |
| **Archive problem that blocks every sync** (missing or corrupt index, truncated tree) | **New in 0.5.23:** stops before any download, with the problem named | C: "an archive problem that blocks every sync…", B: "flags problems that block every sync" |
| Cancel during fetch | Cancelled; nothing published | C: cancel tests, B: "forwards a cancel…" |

## 2. Transfer (Claude tab → background)

| Failure | Outcome | Test |
|---|---|---|
| Missing, duplicated, reordered or resized chunk; wrong conversation | Transfer fails; nothing published | B: transfer chunk tests |
| Attachment altered in transit (size or SHA-256) | Transfer fails; nothing published | B: "an attachment corrupted in transfer…" |
| Background worker restarted, or a newer sync replaced this one | Reported as lost; nothing published | B: "a restarted worker reports the transfer as lost" |
| Duplicate handoff while a sync runs | Ignored, never a second commit | B: "ignores duplicate normalized sync messages" |

## 3. Preparing the commit (background)

| Failure | Outcome | Test |
|---|---|---|
| Corrupt or ill-structured index | Refused | B: "refuses to overwrite a corrupt archive index" |
| Index too large for the Contents API | Read through the blob API | B: "preserves unselected conversations when GitHub omits a large index…" |
| **Index missing on a branch that already holds conversations** | **Gap fixed in 0.5.23.** Previously a new index was started that listed only this sync's conversations and hid all others. Now refused before any upload, naming the problem and how to recover | B: "a missing index on a branch that already holds conversations is refused…" |
| Base tree truncated by GitHub | Refused before any upload | B: "a base tree GitHub truncated is refused…" |
| The index would reference a missing file | Refused | B: "refuses to publish an index while an unselected conversation still references a missing file" |
| An incomplete export would replace a more complete archived copy | Archived copy kept, reported | B: "an incomplete export never replaces an archived copy…" |
| Index over the request limit | Refused before any upload | B: index size test |

## 4. Git objects (background → GitHub)

| Failure | Outcome | Test |
|---|---|---|
| Transient 5xx, network error or secondary rate limit on a read or on blob/tree/commit creation | Retried (5 attempts, jittered); content-addressed, so a repeat is harmless | B: transient 502 tests |
| Persistent failure of any of these | Fails with the step named and "Nothing was published"; the next sync publishes everything exactly once | B/E: persistent 502 tests |
| Authentication, permission or rate-limit exhaustion | Not retried; explained | B: "explains authentication, permission, and rate-limit failures…" |
| GitHub builds a different tree than planned | Refused before the commit | B: "a tree GitHub built differently…" |
| Cancel during upload, tree or commit creation | Cancelled; nothing published; a retry succeeds | B: "cancelling during blob upload…", "cancelling while the tree or the commit is built…" |

## 5. Publication (the branch ref)

| Failure | Outcome | Test |
|---|---|---|
| The branch moved before the update (checked by a final read) | Refused; nothing published | B: "does not publish a sync built from a stale branch head" |
| **The branch moved between that read and the update** (GitHub 422 "not a fast forward") | **Clarified in 0.5.23.** Previously reported as "uncertain" with advice to inspect the branch history. GitHub's 422 is a definite refusal, so it is now "Nothing was published; sync again". Never forced, never retried | B: "a branch update GitHub refused because the branch moved…" |
| Update failed and the branch still points to the base commit | Nothing published; the original error is kept (including cancellation) | B: 502-on-PATCH test, "keeps cancellation semantics…" |
| Update failed but the branch points to this sync's commit (lost response) | Reported as published | B: "reports success when the final ref update was applied but its response was interrupted" |
| Update failed and the outcome cannot be read back | `PublicationUncertainError`: "check the branch before retrying". Never claims success or that nothing was published | B: "a failed branch update whose outcome cannot be read back…" |

## Remaining limitations (not defects)

- **A failed large sync restarts from zero.** Atomic publication means a failure costs a re-download, never a partial archive (audit finding 2; any change needs owner approval).
- **Latest-N syncs do not ask for the archive state**, so a blocking archive problem is found only after downloading those N conversations. It is still refused before anything is published.
- **Live Claude and GitHub behaviour** is modelled by fakes in these tests. Real-account checks remain manual.
