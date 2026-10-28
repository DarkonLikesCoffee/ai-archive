import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, nextPromptCycle, type TabAccess } from '../src/background/controller.ts';
import { createLogger } from '../src/shared/logger.ts';
import type { UiRequest, UiResponse } from '../src/shared/messages.ts';
import { SETTINGS_KEY, WORKFLOW_KEY } from '../src/shared/storage.ts';
import type { PageObservation, ProjectSettings } from '../src/shared/types.ts';
import type { NotifyEffect } from '../src/shared/workflow.ts';
import { initialWorkflowState } from '../src/shared/workflow.ts';
import { MemoryStorage, obs, validProject } from './helpers/fixtures.ts';

const quiet = createLogger('test', { info() {}, warn() {}, error() {} });

interface Harness {
  storage: MemoryStorage;
  notifications: NotifyEffect[];
  inserts: { tabId: number; text: string; overwrite: boolean }[];
  page: { tabId: number | null; observation: PageObservation | null; insertResult: Awaited<ReturnType<TabAccess['insert']>> };
  ui: (request: UiRequest) => Promise<UiResponse>;
  controller: ReturnType<typeof createController>;
  clock: { now: number };
}

function harness(storage = new MemoryStorage()): Harness {
  const notifications: NotifyEffect[] = [];
  const inserts: Harness['inserts'] = [];
  const page: Harness['page'] = { tabId: 5, observation: obs('complete', '/c/abc|id:old'), insertResult: { ok: true, verified: true } };
  const clock = { now: 1000 };
  const tabs: TabAccess = {
    findTargetTab: async () => page.tabId,
    anyChatgptTab: async () => page.tabId !== null,
    getObservation: async () => page.observation,
    insert: async (tabId, text, overwrite) => {
      inserts.push({ tabId, text, overwrite });
      return page.insertResult;
    },
  };
  const controller = createController({ storage, tabs, notify: async (e) => void notifications.push(e), now: () => (clock.now += 10), log: quiet });
  return { storage, notifications, inserts, page, controller, clock, ui: (r) => controller.handleUi(r) };
}

async function withProject(h: Harness, overrides: Partial<ProjectSettings> = {}): Promise<UiResponse> {
  const created = await h.ui({ type: 'CREATE_PROJECT' });
  assert.ok(created.ok);
  const id = created.snapshot.settings.activeProjectId!;
  return h.ui({ type: 'SAVE_PROJECT', project: validProject({ id, ...overrides }) });
}

function ok(response: UiResponse): Extract<UiResponse, { ok: true }> {
  assert.ok(response.ok, response.ok ? '' : response.error);
  return response;
}

test('missing configuration: no project means no session and no prompt', async () => {
  const h = harness();
  const snap = ok(await h.ui({ type: 'GET_SNAPSHOT' })).snapshot;
  assert.equal(snap.prompt, null);
  assert.equal(snap.validation, null);
  const start = await h.ui({ type: 'START_SESSION' });
  assert.equal(start.ok, false);
  assert.equal(!start.ok && start.code, 'no_project');
});

test('invalid configuration is saved as a draft but blocks the session', async () => {
  const h = harness();
  const created = ok(await h.ui({ type: 'CREATE_PROJECT' }));
  const id = created.snapshot.settings.activeProjectId!;
  const saved = ok(await h.ui({ type: 'SAVE_PROJECT', project: validProject({ id, repositoryUrl: 'not a url' }) }));
  assert.match(saved.note ?? '', /draft/);
  assert.equal(saved.snapshot.validation?.valid, false);
  const start = await h.ui({ type: 'START_SESSION' });
  assert.equal(!start.ok && start.code, 'invalid_project');
  const insert = await h.ui({ type: 'INSERT_PROMPT' });
  assert.equal(insert.ok, false);
  assert.equal(h.inserts.length, 0);
});

test('credentials are never stored', async () => {
  const h = harness();
  const created = ok(await h.ui({ type: 'CREATE_PROJECT' }));
  const id = created.snapshot.settings.activeProjectId!;
  const response = await h.ui({ type: 'SAVE_PROJECT', project: validProject({ id, projectRules: 'use ghp_' + 'z'.repeat(36) }) });
  assert.equal(!response.ok && response.code, 'secret_detected');
  assert.doesNotMatch(JSON.stringify(h.storage.data), /ghp_/);
});

test('full cycle through the controller: insert, observe, one notification, review', async () => {
  const h = harness();
  await withProject(h);
  ok(await h.ui({ type: 'START_SESSION' }));

  const inserted = ok(await h.ui({ type: 'INSERT_PROMPT' }));
  assert.equal(h.inserts.length, 1);
  assert.equal(h.inserts[0]!.overwrite, false);
  assert.match(h.inserts[0]!.text, /^Read AUTOPILOT\.md in the connected GitHub repository octo\/demo/);
  assert.match(inserted.note ?? '', /press Send yourself/);
  assert.equal(inserted.snapshot.workflow.cycle, 1);
  assert.equal(inserted.snapshot.workflow.trackedTabId, 5);
  assert.equal(inserted.snapshot.workflow.responseKeyAtHandoff, '/c/abc|id:old');

  await h.controller.handleContent(5, { type: 'PAGE_OBSERVATION', observation: obs('generating', '/c/abc|id:new') });
  await h.controller.handleContent(5, { type: 'PAGE_OBSERVATION', observation: obs('complete', '/c/abc|id:new') });
  await h.controller.handleContent(5, { type: 'PAGE_OBSERVATION', observation: obs('complete', '/c/abc|id:new') });
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0]!.kind, 'response_complete');

  const reviewed = ok(await h.ui({ type: 'MARK_REVIEWED', outcome: 'continue' }));
  assert.equal(reviewed.snapshot.workflow.phase, 'ready');
  assert.equal(reviewed.snapshot.prompt?.cycle, 2);
  assert.match(reviewed.snapshot.prompt?.text ?? '', /continuation 2 of at most 3/);
});

test('insert is refused while ChatGPT is generating, shows a usage limit, or has no content script', async () => {
  const h = harness();
  await withProject(h);
  ok(await h.ui({ type: 'START_SESSION' }));
  h.page.observation = obs('generating', 'k|1');
  assert.equal((await h.ui({ type: 'INSERT_PROMPT' }) as { code?: string }).code, 'generating');
  h.page.observation = obs('usage_limit', null);
  assert.equal((await h.ui({ type: 'INSERT_PROMPT' }) as { code?: string }).code, 'usage_limit');
  h.page.observation = null;
  assert.equal((await h.ui({ type: 'INSERT_PROMPT' }) as { code?: string }).code, 'no_content_script');
  h.page.tabId = null;
  assert.equal((await h.ui({ type: 'INSERT_PROMPT' }) as { code?: string }).code, 'no_tab');
  assert.equal(h.inserts.length, 0);
  const state = ok(await h.ui({ type: 'GET_SNAPSHOT' })).snapshot.workflow;
  assert.equal(state.cycle, 0, 'failed inserts do not start a cycle');
});

test('a non-empty composer needs explicit overwrite; a failed insert starts no cycle', async () => {
  const h = harness();
  await withProject(h);
  ok(await h.ui({ type: 'START_SESSION' }));
  h.page.insertResult = { ok: false, error: 'The ChatGPT message box already contains text.', code: 'composer_not_empty' };
  const first = await h.ui({ type: 'INSERT_PROMPT' });
  assert.equal(!first.ok && first.code, 'composer_not_empty');
  assert.equal(first.snapshot?.workflow.cycle, 0);
  h.page.insertResult = { ok: true, verified: true };
  ok(await h.ui({ type: 'INSERT_PROMPT', overwrite: true }));
  assert.equal(h.inserts.at(-1)!.overwrite, true);
});

test('insert is refused before touching the page when the hand-off would be rejected', async () => {
  const h = harness();
  await withProject(h);
  const response = await h.ui({ type: 'INSERT_PROMPT' });
  assert.match(!response.ok ? response.error : '', /Start a session/);
  assert.equal(h.inserts.length, 0);
});

test('copy hand-off records a cycle using the active tab when there is one', async () => {
  const h = harness();
  await withProject(h);
  ok(await h.ui({ type: 'START_SESSION' }));
  const r = ok(await h.ui({ type: 'RECORD_HANDOFF', method: 'copy' }));
  assert.equal(r.snapshot.workflow.cycle, 1);
  assert.equal(r.snapshot.workflow.phase, 'awaiting_response');
  assert.equal(r.snapshot.workflow.trackedTabId, 5);
  const again = ok(await h.ui({ type: 'RECORD_HANDOFF', method: 'copy' }));
  assert.equal(again.snapshot.workflow.cycle, 1);
  assert.match(again.note ?? '', /already waiting/);
});

test('notifications respect the project setting', async () => {
  const h = harness();
  await withProject(h, { showNotifications: false });
  ok(await h.ui({ type: 'START_SESSION' }));
  ok(await h.ui({ type: 'INSERT_PROMPT' }));
  await h.controller.handleContent(5, { type: 'PAGE_OBSERVATION', observation: obs('generating', '/c/abc|id:new') });
  await h.controller.handleContent(5, { type: 'PAGE_OBSERVATION', observation: obs('complete', '/c/abc|id:new') });
  assert.equal(h.notifications.length, 0);
  assert.equal(ok(await h.ui({ type: 'GET_SNAPSHOT' })).snapshot.workflow.phase, 'needs_review');
});

test('usage limit pauses; resume re-reads the page; nothing is inserted or resent', async () => {
  const h = harness();
  await withProject(h);
  ok(await h.ui({ type: 'START_SESSION' }));
  ok(await h.ui({ type: 'INSERT_PROMPT' }));
  await h.controller.handleContent(5, { type: 'PAGE_OBSERVATION', observation: obs('usage_limit', null) });
  let snap = ok(await h.ui({ type: 'GET_SNAPSHOT' })).snapshot;
  assert.equal(snap.workflow.monitoring, 'paused');
  assert.equal(snap.workflow.pauseReason, 'usage_limit');
  assert.equal(h.inserts.length, 1);
  assert.equal(h.notifications.filter((n) => n.kind === 'usage_limit').length, 1);

  h.page.observation = obs('idle', null);
  snap = ok(await h.ui({ type: 'RESUME' })).snapshot;
  assert.equal(snap.workflow.monitoring, 'active');
  assert.equal(snap.workflow.responseStatus, 'idle');
  assert.equal(h.inserts.length, 1, 'resume never inserts or resends');
});

test('state survives a restart (new controller over the same storage)', async () => {
  const storage = new MemoryStorage();
  const h1 = harness(storage);
  await withProject(h1);
  ok(await h1.ui({ type: 'START_SESSION' }));
  ok(await h1.ui({ type: 'INSERT_PROMPT' }));
  await h1.controller.handleContent(5, { type: 'PAGE_OBSERVATION', observation: obs('generating', '/c/abc|id:new') });

  const h2 = harness(storage);
  await h2.controller.handleStartup();
  let snap = ok(await h2.ui({ type: 'GET_SNAPSHOT' })).snapshot;
  assert.equal(snap.workflow.cycle, 1);
  assert.equal(snap.workflow.monitoring, 'active');
  assert.equal(snap.workflow.trackedTabId, null);
  assert.equal(snap.workflow.responseStatus, 'unknown');
  assert.equal(snap.settings.projects[0]?.projectName, 'Demo');

  // The reopened tab (new id) reports the same conversation and completes the cycle.
  await h2.controller.handleContent(77, { type: 'PAGE_OBSERVATION', observation: obs('complete', '/c/abc|id:new') });
  snap = ok(await h2.ui({ type: 'GET_SNAPSHOT' })).snapshot;
  assert.equal(snap.workflow.phase, 'needs_review');
  assert.equal(snap.workflow.trackedTabId, 77);
  assert.equal(h2.notifications.length, 1);
});

test('corrupt stored data recovers to safe defaults and is reported', async () => {
  const storage = new MemoryStorage();
  storage.data[SETTINGS_KEY] = 'garbage';
  storage.data[WORKFLOW_KEY] = { schemaVersion: 1, monitoring: 'warp', phase: 'ready' };
  const h = harness(storage);
  const snap = ok(await h.ui({ type: 'GET_SNAPSHOT' })).snapshot;
  assert.equal(snap.settingsRecovered, true);
  assert.equal(snap.workflow.recoveredFromCorruption, true);
  assert.equal(snap.workflow.monitoring, 'inactive');
  assert.equal(h.inserts.length, 0);
});

test('concurrent events are applied one at a time without losing updates', async () => {
  const h = harness();
  await withProject(h);
  ok(await h.ui({ type: 'START_SESSION' }));
  ok(await h.ui({ type: 'INSERT_PROMPT' }));
  await Promise.all([
    h.controller.handleContent(5, { type: 'PAGE_OBSERVATION', observation: obs('generating', '/c/abc|id:new') }),
    h.controller.handleContent(5, { type: 'PAGE_OBSERVATION', observation: obs('complete', '/c/abc|id:new') }),
    h.ui({ type: 'PAUSE' }),
  ]);
  const snap = ok(await h.ui({ type: 'GET_SNAPSHOT' })).snapshot;
  assert.equal(snap.workflow.phase, 'needs_review');
  assert.equal(snap.workflow.monitoring, 'paused');
  assert.equal(h.notifications.length, 1);
});

test('deleting or switching the active project stops its session', async () => {
  const h = harness();
  await withProject(h);
  ok(await h.ui({ type: 'START_SESSION' }));
  const second = ok(await h.ui({ type: 'CREATE_PROJECT' }));
  assert.equal(second.snapshot.workflow.monitoring, 'inactive');
  assert.equal(second.snapshot.settings.projects.length, 2);
  const firstId = second.snapshot.settings.projects[0]!.id;
  ok(await h.ui({ type: 'SELECT_PROJECT', projectId: firstId }));
  const deleted = ok(await h.ui({ type: 'DELETE_PROJECT', projectId: firstId }));
  assert.equal(deleted.snapshot.settings.projects.length, 1);
  assert.notEqual(deleted.snapshot.settings.activeProjectId, firstId);
  assert.equal((await h.ui({ type: 'SELECT_PROJECT', projectId: 'missing' })).ok, false);
});

test('the prompt preview cycle number follows the workflow', () => {
  const s = initialWorkflowState();
  assert.equal(nextPromptCycle(s), 1);
  assert.equal(nextPromptCycle({ ...s, monitoring: 'active', phase: 'ready', cycle: 2 }), 3);
  assert.equal(nextPromptCycle({ ...s, monitoring: 'active', phase: 'awaiting_response', cycle: 2 }), 2);
  assert.equal(nextPromptCycle({ ...s, monitoring: 'paused', phase: 'needs_review', cycle: 2 }), 3);
});
