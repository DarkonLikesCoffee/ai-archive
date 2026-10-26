import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_SECTION_END, terminatedToolSectionEnd } from './toolSections.js';

const lines = (text) => text.split('\n');

test('finds the end marker of a terminated tool section', () => {
  const source = lines([
    '### Claude tool: artifacts',
    '',
    '```json',
    '{ "title": "Hello" }',
    '```',
    '',
    '**content**',
    '',
    '```python',
    '# a comment, not a heading',
    'print(1)',
    '```',
    '',
    TOOL_SECTION_END,
    '',
    'The answer.',
  ].join('\n'));

  assert.equal(terminatedToolSectionEnd(source, 0), 13);
});

test('ignores end markers and headings inside fenced code', () => {
  const source = lines([
    '### Claude tool: artifacts',
    '',
    '````markdown',
    '## Not a heading',
    TOOL_SECTION_END,
    '```',
    '````',
    '',
    TOOL_SECTION_END,
  ].join('\n'));

  assert.equal(terminatedToolSectionEnd(source, 0), 8);
});

test('returns -1 for legacy sections without an end marker', () => {
  const legacy = lines('### Claude tool: bash\n\n```bash\nls\n```\n\nProse after the tool.');
  assert.equal(terminatedToolSectionEnd(legacy, 0), -1);

  const nextTool = lines(`### Claude tool: bash\n\n\`\`\`bash\nls\n\`\`\`\n\n### Tool result: bash\n\n${TOOL_SECTION_END}`);
  assert.equal(terminatedToolSectionEnd(nextTool, 0), -1, 'a marker after the next tool belongs to that tool');

  const nextMessage = lines(`### Claude tool: bash\n\n\`\`\`bash\nls\n\`\`\`\n\n## You\n\n${TOOL_SECTION_END}`);
  assert.equal(terminatedToolSectionEnd(nextMessage, 0), -1);
});
