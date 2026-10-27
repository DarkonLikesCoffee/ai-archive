import test from 'node:test';
import assert from 'node:assert/strict';
import { promptOutline } from './outline.js';

test('lists your prompts with their message positions', () => {
  const outline = promptOutline([
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'Answer' },
    { role: 'user', content: 'Second question' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(outline)), [{ index: 0, label: 'First question' }, { index: 2, label: 'Second question' }]);
});

test('labels are plain one-line text', () => {
  const [entry] = promptOutline([{ role: 'user', content: '## Fix **this** [bug](https://x.test)\n\n- with `code`\n\n```js\nconst a = 1;\n```\n![shot](assets/a.png)' }]);
  assert.equal(entry.label, 'Fix this bug with code [code]');
});

test('long prompts are shortened and attachment-only prompts are named', () => {
  const [long, image] = promptOutline([
    { role: 'user', content: 'word '.repeat(40) },
    { role: 'user', content: '![diagram](assets/diagram.png)' },
  ], { maxLength: 20 });
  assert.equal(long.label, 'word word word word…');
  assert.equal(long.label.length, 20);
  assert.equal(image.label, 'Attachment');
  assert.deepEqual(promptOutline(null), []);
});
