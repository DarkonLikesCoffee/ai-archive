import test from 'node:test';
import assert from 'node:assert/strict';
import type { UiSnapshot } from '../src/shared/messages.ts';
import { validateProject } from '../src/shared/settings.ts';
import { initialWorkflowState } from '../src/shared/workflow.ts';
import type { WorkflowState } from '../src/shared/types.ts';
import { buildDashboard } from '../src/ui/viewModel.ts';
import { validProject } from './helpers/fixtures.ts';

function snap(workflow: Partial<WorkflowState> = {}, overrides: Partial<UiSnapshot> = {}): UiSnapshot {
  const project = validProject();
  return {
    settings: { schemaVersion: 1, activeProjectId: 'p1', projects: [project] },
    settingsRecovered: false,
    workflow: { ...initialWorkflowState(), projectId: 'p1', ...workflow },
    validation: validateProject(project),
    prompt: { text: 'Read AUTOPILOT.md', errors: [], warnings: [], cycle: 1 },
    chatgptTabAvailable: true,
    ...overrides,
  };
}

test('no project: everything disabled and the next step says so', () => {
  const m = buildDashboard(snap({}, { settings: { schemaVersion: 1, activeProjectId: null, projects: [] }, validation: null, prompt: null }), 0);
  assert.equal(m.hasProject, false);
  assert.match(m.nextStep, /Create a project/);
  assert.ok(Object.values(m.actions).every((v) => v === false));
});

test('inactive valid project: only start (and copy) are available', () => {
  const m = buildDashboard(snap(), 0);
  assert.equal(m.actions.start, true);
  assert.equal(m.actions.copy, true);
  assert.equal(m.actions.insert, false);
  assert.equal(m.actions.pause, false);
  assert.equal(m.handoffStartsCycle, false);
});

test('active and ready: hand-off starts a cycle; insert needs a ChatGPT tab', () => {
  const m = buildDashboard(snap({ monitoring: 'active', phase: 'ready' }), 0);
  assert.equal(m.handoffStartsCycle, true);
  assert.equal(m.actions.insert, true);
  assert.equal(m.actions.review, false);
  assert.equal(buildDashboard(snap({ monitoring: 'active' }, { chatgptTabAvailable: false }), 0).actions.insert, false);
});

test('needs review: review enabled, insert disabled, next step asks for review', () => {
  const m = buildDashboard(snap({ monitoring: 'active', phase: 'needs_review', cycle: 1, responseStatus: 'complete' }), 0);
  assert.equal(m.actions.review, true);
  assert.equal(m.actions.insert, false);
  assert.match(m.nextStep, /mark the cycle reviewed/);
  assert.equal(m.observed.tone, 'success');
});

test('observed and reported information are labelled separately', () => {
  const m = buildDashboard(snap({ monitoring: 'stopped', stopReason: 'milestone_reported', lastReviewOutcome: 'milestone_reported', responseStatus: 'unknown' }), 0);
  assert.equal(m.observed.status, 'Unknown');
  assert.match(m.reported.outcome, /as reported by ChatGPT, not verified/);
  assert.match(m.workflow.stopReason, /You recorded/);
  assert.equal(m.actions.reset, true);
  assert.equal(m.actions.start, true);
});

test('usage-limit pause explains that nothing is resent', () => {
  const m = buildDashboard(snap({ monitoring: 'paused', pauseReason: 'usage_limit', responseStatus: 'usage_limit' }), 0);
  assert.match(m.workflow.monitoring, /usage-limit/);
  assert.match(m.nextStep, /Nothing is resent automatically/);
  assert.equal(m.actions.resume, true);
  assert.equal(m.observed.tone, 'danger');
});

test('invalid configuration lists the problems and blocks start', () => {
  const project = validProject({ milestone: '' });
  const m = buildDashboard(snap({}, { settings: { schemaVersion: 1, activeProjectId: 'p1', projects: [project] }, validation: validateProject(project) }), 0);
  assert.equal(m.configValid, false);
  assert.equal(m.actions.start, false);
  assert.match(m.configProblems.join(' '), /milestone/);
});

test('recovered storage is surfaced', () => {
  assert.ok(buildDashboard(snap({ recoveredFromCorruption: true }), 0).recoveredNotice);
  assert.equal(buildDashboard(snap(), 0).recoveredNotice, null);
});
