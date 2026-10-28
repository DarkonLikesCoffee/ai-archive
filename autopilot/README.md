# ChatGPT Project Autopilot (Chrome extension)

A Manifest V3 extension that runs a **prompt-and-review loop** around your normal ChatGPT website workflow. Your project's state lives in `AUTOPILOT.md` in your GitHub repository, and ChatGPT reads and updates that file through its GitHub integration. The extension:

- keeps a reusable, editable **continuation prompt** for each project,
- **copies** it, or **inserts** it into the ChatGPT message box (it never sends),
- **notices when ChatGPT's response appears complete** and notifies you,
- tracks **cycles** (prompt → response → your review) up to a per-session limit,
- **pauses** when ChatGPT shows a usage-limit message, and never retries or resends.

It is an assistant, not an autonomous agent. **You press Send for every message.** It uses no OpenAI API, no other AI provider, no backend and no paid service.

## Installation

Requirements: Chrome 116 or newer (or another Chromium browser with Manifest V3 and side panel support). You need Node.js 22.18 or newer only if you build from source.

```bash
cd autopilot
npm ci
npm run build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `autopilot/dist` folder.
3. Pin the extension. Click its icon for the popup, then **Open side panel** for the full interface.

If a ChatGPT tab was already open before you installed or reloaded the extension, reload that tab once yourself so the content script attaches.

## Permissions and why they are needed

| Permission | Why |
|---|---|
| `storage` | Saves your project settings and the workflow state in `chrome.storage.local` (stays on this device). |
| `notifications` | Shows "response appears complete", usage-limit and error notifications. You can turn these off per project. |
| `sidePanel` | Provides the side panel interface. |
| Host access to `chatgpt.com` and `chat.openai.com` | Runs the content script that watches the page state and inserts prompts, and lets the extension find the ChatGPT tab. |

The extension does **not** request access to GitHub, cookies, browsing history or any other site. It stores **no credentials**: no GitHub tokens, no ChatGPT cookies or session tokens. Settings that look like an access token (for example `ghp_…`, `github_pat_…`, `sk-…`, `Bearer …`) are rejected.

## Setting up a project

1. In the side panel, click **New** and fill in the **Project** tab:
   - **Project name**
   - **GitHub repository URL**, for example `https://github.com/owner/repo`
   - **Default branch**
   - **Path to AUTOPILOT.md**, relative to the repository root, for example `AUTOPILOT.md` or `docs/AUTOPILOT.md`
   - **Milestone description**: what "done" means for this round of work
   - **Maximum continuation cycles per session** (1–100)
   - **Show desktop notifications**
   - **Ask me to confirm before each prompt hand-off**. Submission is always manual; this option adds a confirmation step before a prompt is copied or inserted as a new cycle.
2. In **Prompt & rules**, edit the continuation template and add any standing rules. Then **Save**.
3. Put `AUTOPILOT.md` in the repository. In **Help**, use **Copy AUTOPILOT.md template**, then either commit it yourself or paste it into ChatGPT and ask it to fill the template in for your project and commit it. The same template is in [`templates/AUTOPILOT.md`](templates/AUTOPILOT.md).

### The AUTOPILOT.md template

The template has these sections:

1. Project overview and objectives
2. Current milestone
3. Definition of done
4. Mandatory project rules
5. Architecture and design constraints
6. Coding conventions
7. Functional requirements
8. Prioritized roadmap
9. Actionable task checklist
10. Build, test, lint and verification commands
11. Completed tasks and evidence
12. Known bugs, technical debt and regressions
13. Decisions and their rationale
14. Blockers and unresolved questions
15. Session history (bounded to the last 10 sessions)
16. Exact next recommended action

Every statement is labelled `[VERIFIED]`, `[ASSUMPTION]`, `[PROPOSAL]` or `[UNRESOLVED]`. A task may be checked off only with evidence: a command and its result, a commit, or a file reference. Decisions are superseded rather than deleted. The file asks ChatGPT to end each reply with `AUTOPILOT STATUS: CONTINUE | MILESTONE COMPLETE | BLOCKED`, so your review takes one glance.

### Prompt template variables

| Variable | Value |
|---|---|
| `{{projectName}}` | Project name |
| `{{repositoryUrl}}` | Repository URL |
| `{{repositoryName}}` | `owner/repo` parsed from the URL |
| `{{branch}}` | Default branch |
| `{{milestone}}` | Milestone description |
| `{{autopilotPath}}` | Path to AUTOPILOT.md |
| `{{projectRules}}` | Standing rules from the Prompt & rules tab |
| `{{cycle}}` | Number of the continuation being prepared |
| `{{maxCycles}}` | Maximum cycles per session |

`{{#name}} … {{/name}}` keeps the enclosed text only when the variable is non-empty. The default template uses this for the rules block. Unknown variables are reported as errors; they are never silently dropped.

## The workflow

1. Open the ChatGPT conversation that has your repository connected.
2. Click **Start session**. Continuation prompt 1 is prepared.
3. Click **Copy prompt** and paste it, or click **Insert into ChatGPT**. Read the prompt, then **press Send yourself**.
4. The extension watches the page. When the response appears complete, you get a notification and the badge shows **DONE**.
5. Read the reply, then click **Mark cycle reviewed…** and record what ChatGPT reported:
   - **Continue**: the next prompt is prepared.
   - **Milestone met** or **Blocked**: the session stops.
6. Repeat. The session also stops at the cycle limit or when you click **Stop**.

**Pause monitoring** keeps the session but stops notifications and cycle changes. On **Resume**, the extension checks the page again, so a response that finished while monitoring was paused is still recognized.

## What the extension really knows

The panel keeps these apart:

- **Observed by the extension.** What the ChatGPT page shows right now:
  - a stop-generation control or a streaming marker (generating),
  - a new assistant message with no generation signals (response appears complete),
  - visible error or usage-limit notices.

  If the page does not expose enough to decide, the status is **Unknown**, never a guess.
- **Recorded by the extension.** Cycles, hand-offs, timestamps, pause and stop.
- **Reported by ChatGPT, as you recorded it.** The outcome you choose when reviewing. The extension cannot verify it.

The extension **cannot** see GitHub and **does not read ChatGPT's replies**. It never claims that ChatGPT read or updated `AUTOPILOT.md`, or that the milestone is met. A finished, or stopped, response only means "time to review".

## How completion detection works

`src/content/` holds the content script:

- `selectors.ts` lists every assumption about ChatGPT's page in one place: the composer, the stop and send controls, streaming markers, assistant messages and notice regions.
- `page.ts` turns the page into a small **text-free observation**: which controls are visible, the number of assistant messages and the id attribute of the last one. It then classifies that observation. Without a recognizable composer, the status is `unknown`.
- `detector.ts` reacts to a `MutationObserver`, SPA navigation and visibility changes, and coalesces bursts of mutations.
  - **Generating** is reported immediately.
  - **The end of generation** is reported only after the page has stayed out of the generating state for a short confirmation window, and only after a fresh read agrees. This filters flicker between streamed chunks. It does not assume how long a response takes.
- The background worker accepts a completion only for the conversation it tracks, and only if generation was seen after your hand-off or the latest response changed since then. Each response key is notified at most once, so re-renders and repeated observations never produce duplicate notifications.

**Usage-limit and error notices** are matched in alert, status and error regions only. Text inside conversation messages is excluded, so a reply that mentions "rate limit" does not trigger anything. Notice text is matched and discarded immediately; it is never stored.

**Insertion** puts the prompt into the message box through the editor's normal input path. It then reads the box back to verify the text. It never presses Enter and never clicks Send. If the box already contains text, it asks before replacing it. If the box cannot be found, or the text cannot be verified, it tells you to use **Copy prompt**.

## Safety constraints

- Never submits messages, never presses Enter and never clicks Send.
- Never reloads a page, retries or resends, including after usage-limit or error messages. On a usage limit, monitoring pauses until you resume.
- Uses no ChatGPT internal APIs or endpoints. It only observes the rendered page.
- Does not bypass authentication, CAPTCHAs, limits or other protections.
- Does not scrape, persist or transmit conversation text. The event log contains only extension events.
- Never touches GitHub.
- Has no external backend and no network requests of its own.
- Pause and Stop are always visible. Consequential actions ask for confirmation: replacing composer text, stopping, deleting a project, switching projects mid-session, and each hand-off when the option is on.

## State and persistence

Settings and workflow state are stored in `chrome.storage.local` and survive browser restarts.

- **Workflow state:** active project, cycle, phase, observed status, reviewed flag, prepared-prompt flag, pause and stop state with reasons, tracked tab and conversation URL, timestamps, and a bounded event log.
- **Background worker:** loads state from storage for every event, because Chrome may stop the worker at any time. It applies changes one at a time through an explicit state machine (`src/shared/workflow.ts`).
- **After a browser restart:** tab ids change. The extension keeps the conversation URL and re-attaches when that conversation reports in again.
- **Unreadable stored data:** replaced with safe defaults (an inactive session), and the panel says so.

## Development

```bash
npm run typecheck   # strict TypeScript
npm test            # unit tests (node:test, Node's built-in TypeScript support)
npm run build       # bundles into dist/
npm run check       # all three
npm run e2e         # real Chromium end-to-end run against a fake ChatGPT page (needs Playwright)
```

| Path | Responsibility |
|---|---|
| `src/shared/` | Types, settings validation, template rendering, workflow state machine, storage, message contracts |
| `src/content/` | Page observation, completion detection and composer insertion on ChatGPT |
| `src/background/` | `controller.ts` holds the logic (testable with injected dependencies); `index.ts` wires up the `chrome.*` APIs, notifications and badge |
| `src/ui/` | Side panel and popup (`app.ts`), plus a pure view model (`viewModel.ts`) |
| `static/` | Manifest, HTML, CSS, icons |
| `templates/AUTOPILOT.md` | The project-state template |
| `test/` | Unit tests with mocked storage, tabs, timers and DOM |
| `e2e/` | Real-browser test |

Dev dependencies are `typescript`, `esbuild`, `@types/chrome` and `@types/node`. There are no runtime dependencies.

### Tests

The unit tests cover:

- template rendering
- settings validation, including credential rejection
- every workflow transition
- duplicate-notification prevention
- pause and resume
- unknown status
- usage-limit and error detection, including text inside messages
- persistence, restart and corruption recovery
- invalid or missing configuration
- serialized concurrent events

The e2e script loads `dist/` into Chromium. It replaces `chatgpt.com` with a local page that mimics the composer, send and stop controls, streaming assistant messages and notices. It then drives the side panel through:

- configuration and a credential rejection
- insertion, with a check that nothing was submitted
- detecting generation and completion
- a single notification, with no duplicates after a re-render
- review, then a browser restart
- a copy hand-off
- a usage-limit pause
- stop

## Known limitations

- **ChatGPT's interface changes.** Detection relies on the selectors in `src/content/selectors.ts`. When ChatGPT changes its markup, the status shows **Unknown**, or insertion reports that it cannot find the message box, until the selectors are updated. Nothing breaks unsafely, but detection quality depends on these selectors. The e2e test uses a fake page, so it does not prove compatibility with today's live site.
- **"Complete" is a page-state heuristic.** A response you stopped manually also looks complete. In either case it means "review it", not "it worked".
- **Usage-limit and error wording varies.** Unrecognized wording produces no notice. Notices outside the configured regions are not seen.
- **Inserting into the composer uses the browser's editing commands, with a paste fallback.** If ChatGPT's editor ignores both, insertion reports a failure and you use Copy.
- **Background tabs.** Chrome may throttle timers in background tabs, which can delay the completion notice by a few seconds.
- **Several ChatGPT tabs.** When more than one is open and none is clearly the target, the extension asks you to make the right one active instead of guessing.
- **The extension cannot verify repository changes.** It has no GitHub access, by design. `AUTOPILOT.md` stays the record that ChatGPT maintains.
