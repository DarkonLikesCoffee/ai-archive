import test from 'node:test';
import assert from 'node:assert/strict';
import { assetPlaceholderPaths } from './assetPlaceholders.js';
import { renderMarkdownWithMarked } from './markdownRenderer.js';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The same placeholder hooks main.jsx passes to the Markdown renderer.
const readerHooks = {
  renderImage: ({ href, text }) => `<span class="md-image-placeholder" data-md-image="${escapeHtml(href)}">🖼️ ${escapeHtml(text)}</span>`,
  renderLink: ({ href, text }) => (/^assets\//.test(href)
    ? `<span class="md-attachment-placeholder" data-md-attachment="${escapeHtml(href)}">${escapeHtml(text)}</span>`
    : undefined),
};

test('finds asset paths for labels containing escaped brackets', () => {
  // Labels exactly as the exporter's escapeMarkdownLabel writes them.
  const markdown = [
    '![Screenshot \\[2\\].png](assets/c-1/abcd1234-Screenshot-2-.png)',
    '[report \\[final\\].pdf](assets/c-1/abcd1234-report-final-.pdf)',
    '[notes \\(1\\).txt](assets/c-1/abcd1234-notes-1-.txt)',
    '[external](https://example.com/page)',
  ].join('\n\n');
  const html = renderMarkdownWithMarked(markdown, readerHooks);

  assert.deepEqual(assetPlaceholderPaths(html), [
    { path: 'assets/c-1/abcd1234-Screenshot-2-.png', attribute: 'assets/c-1/abcd1234-Screenshot-2-.png' },
    { path: 'assets/c-1/abcd1234-report-final-.pdf', attribute: 'assets/c-1/abcd1234-report-final-.pdf' },
    { path: 'assets/c-1/abcd1234-notes-1-.txt', attribute: 'assets/c-1/abcd1234-notes-1-.txt' },
  ]);
});

test('decodes HTML-escaped placeholder attributes and lists each path once', () => {
  const html = [
    '<span class="md-image-placeholder" data-md-image="assets/a&amp;b.png">x</span>',
    '<span class="md-attachment-placeholder" data-md-attachment="assets/a&amp;b.png">x</span>',
    '<span class="md-attachment-placeholder" data-md-attachment="assets/q&quot;&#39;.txt">y</span>',
  ].join('');

  assert.deepEqual(assetPlaceholderPaths(html), [
    { path: 'assets/a&b.png', attribute: 'assets/a&amp;b.png' },
    { path: 'assets/q"\'.txt', attribute: 'assets/q&quot;&#39;.txt' },
  ]);
});

test('returns no paths when the message has no asset placeholders', () => {
  assert.deepEqual(assetPlaceholderPaths('<p>No assets <a href="https://example.com">here</a></p>'), []);
});
