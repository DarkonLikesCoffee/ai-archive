import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPT_TEMPLATE, inspectTemplate, parseRepositoryName, renderTemplate, templateValues } from '../src/shared/template.ts';
import { validProject } from './helpers/fixtures.ts';

test('default template renders every project variable', () => {
  const project = validProject({ autopilotPath: 'docs/AUTOPILOT.md' });
  const result = renderTemplate(DEFAULT_PROMPT_TEMPLATE, templateValues(project, 2));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.match(result.text, /^Read docs\/AUTOPILOT\.md in the connected GitHub repository octo\/demo \(branch main\)/);
  assert.match(result.text, /Current milestone: MVP: login and dashboard/);
  assert.match(result.text, /continuation 2 of at most 3/);
  assert.doesNotMatch(result.text, /\{\{/);
});

test('optional sections are dropped when the variable is empty and kept otherwise', () => {
  const template = 'A\n{{#projectRules}}\nRules: {{projectRules}}\n{{/projectRules}}\nB';
  const without = renderTemplate(template, templateValues(validProject({ projectRules: '  ' }), 1));
  assert.equal(without.text, 'A\nB');
  const withRules = renderTemplate(template, templateValues(validProject({ projectRules: 'No new dependencies.' }), 1));
  assert.equal(withRules.text, 'A\nRules: No new dependencies.\nB');
  const inline = renderTemplate('Rules{{#projectRules}}: {{projectRules}}{{/projectRules}}.', templateValues(validProject({ projectRules: 'none' }), 1));
  assert.equal(inline.text, 'Rules: none.');
});

test('the default template omits the rules block when no rules are set', () => {
  const plain = renderTemplate(DEFAULT_PROMPT_TEMPLATE, templateValues(validProject(), 1)).text;
  assert.doesNotMatch(plain, /Additional standing rules/);
  assert.doesNotMatch(plain, /\n{3,}/);
  const ruled = renderTemplate(DEFAULT_PROMPT_TEMPLATE, templateValues(validProject({ projectRules: '- Keep PRs small' }), 1)).text;
  assert.match(ruled, /Additional standing rules from me:\n- Keep PRs small\n/);
});

test('unknown variables and unbalanced sections are errors, not silent blanks', () => {
  const values = templateValues(validProject(), 1);
  const unknown = renderTemplate('Read {{autopilotPath}} for {{projetName}}', values);
  assert.equal(unknown.text, '');
  assert.match(unknown.errors.join(' '), /Unknown variable "\{\{projetName\}\}"/);

  assert.match(inspectTemplate('{{#projectRules}} x').errors.join(' '), /not closed/);
  assert.match(inspectTemplate('x {{/projectRules}}').errors.join(' '), /without a matching opening/);
  assert.match(inspectTemplate('{{#nope}}x{{/nope}} AUTOPILOT').errors.join(' '), /Unknown section "nope"/);
  assert.match(inspectTemplate('   ').errors.join(' '), /empty/);
});

test('whitespace inside tags is accepted', () => {
  const result = renderTemplate('Path: {{ autopilotPath }}', templateValues(validProject(), 1));
  assert.equal(result.text, 'Path: AUTOPILOT.md');
});

test('a template that never mentions AUTOPILOT.md produces a warning', () => {
  const result = renderTemplate('Continue working on {{projectName}}.', templateValues(validProject(), 1));
  assert.equal(result.text, 'Continue working on Demo.');
  assert.match(result.warnings.join(' '), /does not mention/);
});

test('empty variable values are reported as warnings', () => {
  const result = renderTemplate('Read {{autopilotPath}}. Milestone: {{milestone}}', templateValues(validProject({ milestone: '' }), 1));
  assert.match(result.warnings.join(' '), /"\{\{milestone\}\}" has no value/);
});

test('repository names are parsed from GitHub URLs', () => {
  assert.equal(parseRepositoryName('https://github.com/octo/demo'), 'octo/demo');
  assert.equal(parseRepositoryName('https://github.com/octo/demo.git'), 'octo/demo');
  assert.equal(parseRepositoryName('https://github.com/octo/demo/'), 'octo/demo');
  assert.equal(parseRepositoryName('https://gitlab.com/octo/demo'), '');
});
