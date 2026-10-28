import test from 'node:test';
import assert from 'node:assert/strict';
import { createSerialQueue, loadSettings, loadWorkflow, saveSettings, saveWorkflow } from '../src/shared/storage.ts';
import { defaultSettingsStore } from '../src/shared/settings.ts';
import { initialWorkflowState } from '../src/shared/workflow.ts';
import { MemoryStorage, validProject } from './helpers/fixtures.ts';

test('settings and workflow round-trip through storage', async () => {
  const storage = new MemoryStorage();
  const store = { ...defaultSettingsStore(), projects: [validProject()], activeProjectId: 'p1' };
  await saveSettings(storage, store);
  const workflow = { ...initialWorkflowState(), monitoring: 'paused' as const, pauseReason: 'user' as const, phase: 'awaiting_response' as const, cycle: 2 };
  await saveWorkflow(storage, workflow);
  assert.deepEqual((await loadSettings(storage)).store, store);
  assert.deepEqual(await loadWorkflow(storage), workflow);
});

test('empty storage loads defaults without a recovery flag', async () => {
  const storage = new MemoryStorage();
  const settings = await loadSettings(storage);
  assert.equal(settings.recovered, false);
  assert.deepEqual(await loadWorkflow(storage), initialWorkflowState());
});

test('the serial queue runs tasks in order and survives failures', async () => {
  const queue = createSerialQueue();
  const order: number[] = [];
  const slow = queue(async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); });
  const failing = queue(async () => { order.push(2); throw new Error('boom'); });
  const fast = queue(async () => { order.push(3); return 'done'; });
  await slow;
  await assert.rejects(failing, /boom/);
  assert.equal(await fast, 'done');
  assert.deepEqual(order, [1, 2, 3]);
});
