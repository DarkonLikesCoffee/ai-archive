import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownWithMarked } from './markdownRenderer.js';

test('renders headings and paragraphs', () => {
  const html = renderMarkdownWithMarked('# Hello\n\nThis is a paragraph.');
  assert.match(html, /<h1[^>]*>Hello<\/h1>/);
  assert.match(html, /<p>This is a paragraph\.<\/p>/);
});

test('renders unordered lists', () => {
  const html = renderMarkdownWithMarked('- One\n- Two\n- Three');
  assert.match(html, /<ul>/);
  assert.match(html, /<li>One<\/li>/);
  assert.match(html, /<li>Two<\/li>/);
  assert.match(html, /<li>Three<\/li>/);
});

test('renders blockquotes', () => {
  const html = renderMarkdownWithMarked('> A quoted sentence.');
  assert.match(html, /<blockquote>/);
  assert.match(html, /A quoted sentence\./);
});

test('renders safe links with external-link protections', () => {
  const html = renderMarkdownWithMarked('[GitHub](https://github.com/example "Project")');
  assert.match(html, /href="https:\/\/github\.com\/example"/);
  assert.match(html, /title="Project"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('does not render executable link protocols', () => {
  const html = renderMarkdownWithMarked('[click](javascript:alert%281%29)');
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /target="_blank"/);
});

test('renders inline code', () => {
  const html = renderMarkdownWithMarked('Use `const answer = 42` here.');
  assert.match(html, /<code>const answer = 42<\/code>/);
});

test('renders fenced code blocks with syntax highlighting', () => {
  const html = renderMarkdownWithMarked('```js\nconst answer = 42;\n```');
  assert.match(html, /<div class="code-block">/);
  assert.match(html, /<code class="hljs language-js">/);
  assert.match(html, /answer/);
});

test('does not parse Markdown syntax inside fenced code blocks', () => {
  const html = renderMarkdownWithMarked('```text\n# Not a heading\n- Not a list\n```');
  assert.match(html, /Not a heading/);
  assert.match(html, /Not a list/);
  assert.doesNotMatch(html, /<h1>/);
  assert.doesNotMatch(html, /<li>/);
});

test('escapes raw HTML in archived Markdown', () => {
  const html = renderMarkdownWithMarked('<script>alert("xss")</script>');
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;/i);
});

test('preserves line breaks in paragraphs', () => {
  const html = renderMarkdownWithMarked('First line\nSecond line');
  assert.match(html, /First line<br>\s*Second line/);
});


test('allows the reader to replace image and attachment rendering', () => {
  const html = renderMarkdownWithMarked(
    '![photo](assets/photo_01.jpg)\n\n[notes](assets/notes.txt)',
    {
      renderImage: ({ href, text }) => `<span data-md-image="${href}">${text}</span>`,
      renderLink: ({ href, text }) => href.startsWith('assets/')
        ? `<span data-md-attachment="${href}">${text}</span>`
        : undefined,
    },
  );
  assert.match(html, /data-md-image="assets\/photo_01\.jpg"/);
  assert.match(html, /data-md-attachment="assets\/notes\.txt"/);
});

test('escapes raw HTML inside link labels', () => {
  const html = renderMarkdownWithMarked('[<img src=x onerror=alert(1)>](https://example.com)');
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /<a href="https:\/\/example\.com"[^>]*>&lt;img src=x onerror=alert\(1\)&gt;<\/a>/);
});

test('escapes raw HTML inside labels of unsafe links', () => {
  const html = renderMarkdownWithMarked('[<b onmouseover=alert(1)>x</b>](javascript:void(0))');
  assert.doesNotMatch(html, /<b/i);
  assert.doesNotMatch(html, /href=/i);
  assert.match(html, /&lt;b onmouseover=alert\(1\)&gt;x&lt;\/b&gt;/);
});

test('renders inline Markdown and backslash escapes inside link labels', () => {
  const html = renderMarkdownWithMarked('[**Bold** \\*literal\\* \\[x\\]](https://example.com)');
  assert.match(html, />\s*<strong>Bold<\/strong> \*literal\* \[x\]<\/a>/);
});

test('passes raw link labels to custom link hooks unchanged', () => {
  let seen;
  renderMarkdownWithMarked('[a \\_b](assets/x.png)', {
    renderLink: ({ text }) => { seen = text; return '<span></span>'; },
  });
  assert.equal(seen, 'a \\_b');
});
