// Real-browser check of the built extension (dist/) in Chromium with
// chatgpt.com replaced by a local fake page that mimics the parts of the
// ChatGPT interface the extension relies on (composer, send/stop controls,
// assistant messages, notices). It drives the side panel UI like a user.
//
// Requires Playwright with Chromium (not part of CI). Run: npm run e2e
// This does not prove compatibility with the live ChatGPT site; it proves the
// extension's own wiring: messaging, storage, insertion, detection, dedupe.

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const extensionDir = fileURLToPath(new URL('../dist', import.meta.url));
const profile = mkdtempSync(join(tmpdir(), 'autopilot-e2e-'));
const CONVO_URL = 'https://chatgpt.com/c/e2e-conversation';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// A minimal stand-in for chatgpt.com. "Sending" happens only when the test
// clicks the send button itself, the way a user would; window.__submissions
// counts every submission so we can prove the extension never sends.
const FAKE_CHATGPT = `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT</title></head><body>
<main id="thread"></main>
<div id="notices"></div>
<form id="composer-form" onsubmit="return false">
  <div id="prompt-textarea" contenteditable="true" role="textbox" style="min-height:40px;border:1px solid #ccc"></div>
  <span id="controls"><button type="button" data-testid="send-button" id="send">Send</button></span>
</form>
<script>
  window.__submissions = 0;
  let n = 0;
  const controls = document.getElementById('controls');
  function setGenerating(on) {
    controls.innerHTML = on
      ? '<button type="button" data-testid="stop-button" aria-label="Stop streaming">Stop</button>'
      : '<button type="button" data-testid="send-button" id="send">Send</button>';
  }
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-testid="send-button"]')) window.__send();
  });
  window.__send = () => {
    const box = document.getElementById('prompt-textarea');
    if (!box.innerText.trim()) return;
    window.__submissions += 1;
    const thread = document.getElementById('thread');
    const user = document.createElement('div');
    user.setAttribute('data-message-author-role', 'user');
    user.textContent = box.innerText;
    thread.append(user);
    box.innerHTML = '';
    n += 1;
    const answer = document.createElement('div');
    answer.setAttribute('data-message-author-role', 'assistant');
    answer.setAttribute('data-message-id', 'msg-' + n);
    thread.append(answer);
    setGenerating(true);
    let chunks = 0;
    const timer = setInterval(() => {
      answer.append(document.createTextNode(' chunk' + chunks + ' (mentions usage limit and something went wrong)'));
      if (++chunks === 12) { clearInterval(timer); setGenerating(false); }
    }, 150);
  };
  window.__rerender = () => {
    const thread = document.getElementById('thread');
    thread.replaceWith(thread.cloneNode(true));
  };
  window.__showLimit = () => {
    document.getElementById('notices').innerHTML = '<div role="alert">You\\u2019ve reached our limit of messages per hour. Please try again later.</div>';
  };
</script></body></html>`;

async function launch() {
  const context = await chromium.launchPersistentContext(profile, {
    // The full Chromium build: the headless shell cannot load extensions.
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  await context.route('https://chatgpt.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_CHATGPT }));
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  return { context, worker, extensionId };
}

const workflowState = (worker) => worker.evaluate(async () => (await chrome.storage.local.get('autopilot.workflow'))['autopilot.workflow']);
const notifications = (worker) => worker.evaluate(() => new Promise((resolve) => chrome.notifications.getAll((all) => resolve(Object.keys(all)))));

async function waitFor(label, fn, timeout = 10000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function confirmIfAsked(panel) {
  const dialog = panel.locator('#confirm-dialog[open]');
  if (await dialog.count()) await dialog.locator('button[value="ok"]').click();
}

try {
  let { context, worker, extensionId } = await launch();

  // ---- Configure a project through the side panel UI ----
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.click('#btn-new-project');
  await panel.fill('#field-projectName', 'E2E Project');
  await panel.fill('#field-repositoryUrl', 'https://github.com/octo/e2e');
  await panel.fill('#field-defaultBranch', 'main');
  await panel.fill('#field-milestone', 'Ship the E2E milestone');
  await panel.fill('#field-autopilotPath', 'docs/AUTOPILOT.md');
  await panel.fill('#field-maxCyclesPerSession', '2');
  await panel.click('#btn-save');
  await waitFor('save', async () => (await panel.textContent('#banner'))?.includes('Project saved'));
  check('project saved through the UI', true);

  await panel.click('#tab-prompt');
  await panel.fill('#field-projectRules', 'token ghp_' + 'x'.repeat(36));
  await panel.click('#panel-prompt button[type="submit"]');
  await waitFor('secret rejection', async () => (await panel.textContent('#banner'))?.includes('access token'));
  const stored = await worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  check('credential-like values are refused and not stored', !stored.includes('ghp_'));
  await panel.fill('#field-projectRules', 'Keep each change small.');
  await panel.click('#panel-prompt button[type="submit"]');
  await waitFor('rules saved', async () => (await panel.textContent('#banner'))?.includes('Project saved'));
  await panel.click('#tab-dashboard');

  // ---- Open the fake ChatGPT conversation ----
  const chat = await context.newPage();
  await chat.goto(CONVO_URL);
  await chat.waitForSelector('#prompt-textarea');
  await panel.bringToFront();

  await panel.click('#btn-start');
  await waitFor('session start', async () => (await panel.textContent('#wf-monitoring')) === 'Active');
  const preview = await panel.inputValue('#prompt-preview');
  check('prompt preview uses project variables', preview.includes('Read docs/AUTOPILOT.md in the connected GitHub repository octo/e2e (branch main)') && preview.includes('Keep each change small.'), preview.slice(0, 90));

  // ---- Insert (with confirmation) and verify nothing is submitted ----
  await waitFor('insert enabled', () => panel.isEnabled('#btn-insert'));
  await panel.click('#btn-insert');
  await panel.waitForSelector('#confirm-dialog[open]');
  await confirmIfAsked(panel);
  await waitFor('insert result', async () => (await panel.textContent('#banner'))?.includes('Press Send') || (await panel.textContent('#banner'))?.includes('press Send'));
  const composer = await chat.evaluate(() => document.getElementById('prompt-textarea').innerText);
  check('prompt inserted into the composer', composer.replace(/\s+/g, ' ').trim() === preview.replace(/\s+/g, ' ').trim());
  check('insertion did not submit anything', (await chat.evaluate(() => window.__submissions)) === 0);
  let state = await workflowState(worker);
  check('cycle 1 started on hand-off', state.cycle === 1 && state.phase === 'awaiting_response');

  // A second insert into a non-empty composer must ask before replacing.
  await panel.click('#btn-insert');
  await waitFor('replace confirmation', async () => (await panel.locator('#confirm-dialog[open]').count()) > 0 && (await panel.textContent('#confirm-message')).includes('already contains text'));
  await panel.locator('#confirm-dialog[open] button[value="cancel"]').click();
  check('non-empty composer requires confirmation to replace', (await workflowState(worker)).cycle === 1);

  // ---- The user presses Send; the extension detects generation and completion ----
  await chat.click('[data-testid="send-button"]');
  await waitFor('generating observed', async () => (await workflowState(worker)).responseStatus === 'generating');
  check('generation observed', true);
  await waitFor('needs review', async () => (await workflowState(worker)).phase === 'needs_review', 15000);
  state = await workflowState(worker);
  check('completion detected after streaming ended', state.responseStatus === 'complete' && state.lastResponseKey === '/c/e2e-conversation|id:msg-1');
  check('message text inside the reply did not trigger notices', state.monitoring === 'active');
  let shown = await notifications(worker);
  check('one completion notification', shown.filter((id) => id.startsWith('complete:')).length === 1, shown.join(', '));

  // Re-render the thread: no duplicate notification.
  await chat.evaluate(() => window.__rerender());
  await new Promise((r) => setTimeout(r, 2500));
  shown = await notifications(worker);
  check('page re-render causes no duplicate notification', shown.filter((id) => id.startsWith('complete:')).length === 1);

  // ---- Review the cycle ----
  await panel.click('#btn-review');
  await panel.locator('#review-dialog[open] button[value="ok"]').click();
  await waitFor('ready again', async () => (await workflowState(worker)).phase === 'ready');
  await waitFor('preview updated', async () => (await panel.inputValue('#prompt-preview')).includes('continuation 2 of at most 2'));
  check('next prompt prepared after review', true);

  // ---- Persistence across a browser restart ----
  await context.close();
  ({ context, worker, extensionId } = await launch());
  state = await workflowState(worker);
  check('state survives a browser restart', state.cycle === 1 && state.phase === 'ready' && state.monitoring === 'active', JSON.stringify({ cycle: state.cycle, phase: state.phase, monitoring: state.monitoring }));

  // ---- Copy hand-off, then a usage-limit notice ----
  const chat2 = await context.newPage();
  await chat2.goto(CONVO_URL);
  await chat2.waitForSelector('#prompt-textarea');
  const panel2 = await context.newPage();
  await panel2.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await waitFor('copy enabled', () => panel2.isEnabled('#btn-copy'));
  await panel2.click('#btn-copy');
  await confirmIfAsked(panel2);
  await waitFor('cycle 2', async () => (await workflowState(worker)).cycle === 2);
  check('copy hand-off starts cycle 2', true);

  await chat2.evaluate(() => window.__showLimit());
  await waitFor('usage-limit pause', async () => (await workflowState(worker)).pauseReason === 'usage_limit');
  state = await workflowState(worker);
  check('usage-limit notice pauses monitoring', state.monitoring === 'paused' && state.responseStatus === 'usage_limit');
  check('nothing was submitted or resent', (await chat2.evaluate(() => window.__submissions)) === 0);
  await waitFor('panel shows pause', async () => (await panel2.textContent('#wf-monitoring')).includes('usage-limit'));
  check('panel shows the usage-limit pause', true);

  // ---- Stop ----
  await panel2.click('#btn-stop');
  await panel2.locator('#confirm-dialog[open] button[value="ok"]').click();
  await waitFor('stopped', async () => (await workflowState(worker)).monitoring === 'stopped');
  check('stop ends the session', (await workflowState(worker)).stopReason === 'user_stopped');

  await context.close();
} catch (error) {
  failures += 1;
  console.error('FAIL', error);
} finally {
  rmSync(profile, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
