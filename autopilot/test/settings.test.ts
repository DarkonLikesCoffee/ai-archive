import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeProject, defaultProject, looksLikeSecret, normalizeProject, normalizeSettingsStore,
  validateAutopilotPath, validateBranchName, validateProject,
} from '../src/shared/settings.ts';
import { validProject } from './helpers/fixtures.ts';

const fields = (result: ReturnType<typeof validateProject>) => result.errors.map((e) => e.field);

test('a complete project is valid', () => {
  const result = validateProject(validProject());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('a new default project is invalid until the required fields are filled in', () => {
  const result = validateProject(defaultProject('x'));
  assert.equal(result.valid, false);
  assert.deepEqual(fields(result).sort(), ['milestone', 'projectName', 'repositoryUrl']);
});

test('repository URLs must be GitHub repository URLs without credentials', () => {
  for (const url of ['https://github.com/octo', 'http://github.com/octo/demo', 'https://example.com/octo/demo', 'github.com/octo/demo']) {
    assert.ok(fields(validateProject(validProject({ repositoryUrl: url }))).includes('repositoryUrl'), url);
  }
  const withCreds = validateProject(validProject({ repositoryUrl: 'https://user:pw@github.com/octo/demo' }));
  assert.match(withCreds.errors[0]!.message, /credentials/);
  assert.equal(validateProject(validProject({ repositoryUrl: 'https://github.com/octo/demo.git' })).valid, true);
});

test('branch names follow Git rules', () => {
  assert.equal(validateBranchName('main'), null);
  assert.equal(validateBranchName('feature/autopilot-1'), null);
  for (const bad of ['', 'has space', 'a..b', '-x', 'x/', 'x.lock', 'a:b', 'a~1', 'x@{1}']) {
    assert.notEqual(validateBranchName(bad), null, bad);
  }
});

test('the AUTOPILOT.md path is a relative Markdown path', () => {
  assert.equal(validateAutopilotPath('AUTOPILOT.md'), null);
  assert.equal(validateAutopilotPath('docs/AUTOPILOT.md'), null);
  for (const bad of ['', '/AUTOPILOT.md', '../AUTOPILOT.md', 'docs//A.md', 'AUTOPILOT.txt', 'C:/x.md']) {
    assert.notEqual(validateAutopilotPath(bad), null, bad);
  }
});

test('maximum cycles must be a whole number in range', () => {
  for (const value of [0, -1, 101, 2.5, Number.NaN]) {
    assert.ok(fields(validateProject(validProject({ maxCyclesPerSession: value }))).includes('maxCyclesPerSession'), String(value));
  }
  assert.equal(validateProject(validProject({ maxCyclesPerSession: 100 })).valid, true);
});

test('template problems surface as settings errors and warnings', () => {
  const broken = validateProject(validProject({ promptTemplate: 'Read {{nope}}' }));
  assert.ok(fields(broken).includes('promptTemplate'));
  const vague = validateProject(validProject({ promptTemplate: 'Keep going on {{projectName}}.' }));
  assert.equal(vague.valid, true);
  assert.equal(vague.warnings[0]?.field, 'promptTemplate');
});

test('values that look like credentials are rejected', () => {
  assert.equal(looksLikeSecret('ghp_' + 'a'.repeat(36)), true);
  assert.equal(looksLikeSecret('github_pat_' + 'A1_'.repeat(10)), true);
  assert.equal(looksLikeSecret('Authorization: Bearer ' + 'x'.repeat(30)), true);
  assert.equal(looksLikeSecret('Keep the API stable'), false);
  const result = validateProject(validProject({ projectRules: 'token ghp_' + 'b'.repeat(36) }));
  assert.ok(fields(result).includes('projectRules'));
});

test('stored projects with missing or wrong-typed fields are repaired', () => {
  const project = normalizeProject({ id: 'p9', projectName: 'X', maxCyclesPerSession: '7', showNotifications: 'yes' });
  assert.ok(project);
  assert.equal(project.projectName, 'X');
  assert.equal(project.maxCyclesPerSession, 10);
  assert.equal(project.showNotifications, true);
  assert.equal(project.autopilotPath, 'AUTOPILOT.md');
  assert.equal(normalizeProject({ projectName: 'no id' }), null);
  assert.equal(normalizeProject('garbage'), null);
});

test('settings store recovery: missing data is clean, corrupt data is flagged', () => {
  assert.deepEqual(normalizeSettingsStore(undefined), { store: { schemaVersion: 1, activeProjectId: null, projects: [] }, recovered: false });
  assert.equal(normalizeSettingsStore('nonsense').recovered, true);
  assert.equal(normalizeSettingsStore([1, 2]).recovered, true);

  const p = validProject();
  const ok = normalizeSettingsStore({ schemaVersion: 1, activeProjectId: 'p1', projects: [p] });
  assert.equal(ok.recovered, false);
  assert.equal(activeProject(ok.store)?.projectName, 'Demo');

  const dup = normalizeSettingsStore({ schemaVersion: 1, activeProjectId: 'gone', projects: [p, p, { bad: true }] });
  assert.equal(dup.recovered, true);
  assert.equal(dup.store.projects.length, 1);
  assert.equal(dup.store.activeProjectId, 'p1');
});
