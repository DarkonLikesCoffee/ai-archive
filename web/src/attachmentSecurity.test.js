import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMimeType,
  isSafeImagePreviewMime,
  isSafeImageDataUrl,
  safeGitHubAttachmentUrl,
  safeRawGitHubDownloadUrl,
  renderInlineImageHtml,
  renderImageLinkHtml,
  renderAttachmentCardHtml,
} from './attachmentSecurity.js';

test('normalizes valid MIME types and rejects HTML or attribute injection', () => {
  assert.equal(normalizeMimeType(' IMAGE/PNG ; charset=binary '), 'image/png');
  assert.equal(normalizeMimeType('image/png" onerror="alert(1)'), 'application/octet-stream');
  assert.equal(normalizeMimeType('<img src=x onerror=alert(1)>'), 'application/octet-stream');
  assert.equal(normalizeMimeType('text/html onload=alert(1)'), 'application/octet-stream');
});

test('only known raster formats are eligible for inline image previews', () => {
  assert.equal(isSafeImagePreviewMime('image/png'), true);
  assert.equal(isSafeImagePreviewMime('image/webp'), true);
  assert.equal(isSafeImagePreviewMime('image/svg+xml'), false);
  assert.equal(isSafeImagePreviewMime('image/png" onerror="alert(1)'), false);
  assert.equal(isSafeImagePreviewMime('text/html'), false);
});

test('accepts only safe base64 raster image data URLs', () => {
  assert.equal(isSafeImageDataUrl('data:image/png;base64,aGVsbG8='), true);
  assert.equal(isSafeImageDataUrl('data:image/svg+xml;base64,PHN2Zy8+'), false);
  assert.equal(isSafeImageDataUrl('data:image/png;base64,a" onerror="alert(1)'), false);
  assert.equal(isSafeImageDataUrl('javascript:alert(1)'), false);
});

test('restricts attachment links to official HTTPS GitHub hosts', () => {
  assert.equal(safeGitHubAttachmentUrl('https://github.com/me/archive/blob/HEAD/file.pdf'), 'https://github.com/me/archive/blob/HEAD/file.pdf');
  assert.equal(safeGitHubAttachmentUrl('https://raw.githubusercontent.com/me/archive/main/file.pdf'), 'https://raw.githubusercontent.com/me/archive/main/file.pdf');
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'http://github.com/me/archive',
    'https://github.com.evil.example/me/archive',
    'https://user:pass@github.com/me/archive',
    'https://github.com:444/me/archive',
  ]) assert.equal(safeGitHubAttachmentUrl(url), null, url);
});

test('restricts authenticated raw downloads to raw.githubusercontent.com', () => {
  assert.equal(safeRawGitHubDownloadUrl('https://raw.githubusercontent.com/me/archive/main/file.png'), 'https://raw.githubusercontent.com/me/archive/main/file.png');
  assert.equal(safeRawGitHubDownloadUrl('https://evil.example/steal'), null);
  assert.equal(safeRawGitHubDownloadUrl('https://github.com/me/archive'), null);
});

test('escapes every dynamic value in attachment cards and image HTML', () => {
  const payload = '"><img src=x onerror=alert(1)>';
  const card = renderAttachmentCardHtml({
    href: 'javascript:alert(1)',
    name: payload,
    mime: 'image/png" onmouseover="alert(1)',
  });
  assert.doesNotMatch(card, /href="javascript:/i);
  assert.doesNotMatch(card, /<img src=x/i);
  assert.match(card, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(card, /image\/png&quot; onmouseover=&quot;alert\(1\)/);

  const image = renderInlineImageHtml('data:image/png;base64,aGVsbG8=', payload);
  assert.match(image, /src="data:image\/png;base64,aGVsbG8="/);
  assert.match(image, /alt="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);

  const imageLink = renderImageLinkHtml({
    href: 'https://evil.example/file',
    dataUrl: 'data:image/png;base64,aGVsbG8=',
    name: payload,
  });
  assert.doesNotMatch(imageLink, /href="https:\/\/evil\.example/);
  assert.match(imageLink, /href="#"/);
  assert.match(imageLink, /rel="noopener noreferrer"/);
});
