import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { auditArchive, formatAuditReport } from './archiveIntegrity.js';

// Synthetic archive only: no real conversation text or identifiers.
const ROOT = 'archive/conversations/claude/personal';
const bytes = (text) => new TextEncoder().encode(text);
const sha = (data) => createHash('sha256').update(data).digest('hex');

function cleanArchive() {
  const image = bytes('synthetic image bytes');
  const files = new Map([
    [`${ROOT}/A--conv-a.md`, bytes('# A\n\n![map.png](assets/conv-a/1-map.png)\n')],
    [`${ROOT}/assets/conv-a/1-map.png`, image],
    [`${ROOT}/B--conv-b.md`, bytes('# B\n\nno files\n')],
    ['archive/index.json', bytes('{}')],
  ]);
  const index = {
    version: 2,
    conversations: [
      { id: 'conv-a', provider: 'claude', account: 'personal', path: `${ROOT}/A--conv-a.md`,
        assets: [{ path: `${ROOT}/assets/conv-a/1-map.png`, sha256: sha(image), size: image.byteLength, name: 'map.png' }] },
      { id: 'conv-b', provider: 'claude', account: 'personal', path: `${ROOT}/B--conv-b.md`, assets: [] },
    ],
  };
  return { index, files };
}

function inputs({ index, files }) {
  const tree = [...files].map(([path, data]) => ({ path, type: 'blob', sha: sha(data).slice(0, 40), size: data.byteLength }));
  tree.push({ path: ROOT, type: 'tree', sha: 'dir' });
  const markdown = new Map([...files].filter(([path]) => path.endsWith('.md')).map(([path, data]) => [path, new TextDecoder().decode(data)]));
  const readBytes = async (path) => files.get(path);
  return { index, tree, markdown, readBytes };
}

const codes = (result) => result.findings.map((item) => `${item.severity}:${item.code}:${item.path}`).sort();

test('a clean archive has no findings and every check ran', async () => {
  const archive = cleanArchive();
  const result = await auditArchive(inputs(archive));
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.checked, { conversations: 2, assets: 1, markdownFiles: 2, hashedFiles: 1 });
  assert.match(formatAuditReport(result), /^Archive integrity: 0 error\(s\), 0 warning\(s\)/);
});

test('a deliberately corrupted archive produces precise findings', async () => {
  const archive = cleanArchive();
  const image = `${ROOT}/assets/conv-a/1-map.png`;
  archive.files.set(image, bytes('different bytes of another length'));           // hash and size
  archive.files.delete(`${ROOT}/B--conv-b.md`);                                     // missing conversation
  archive.files.set(`${ROOT}/assets/old/9-left-over.txt`, bytes('orphan'));         // unreferenced file
  archive.files.set(`${ROOT}/A--conv-a.md`, bytes('![x](assets/conv-a/1-map.png) [y](assets/conv-a/2-gone.pdf) [z](https://example.com/a)'));
  archive.index.conversations.push({ ...archive.index.conversations[1] });          // duplicate identity and path
  archive.index.conversations.push({ id: 'conv-c', provider: 'claude', account: 'personal', path: `${ROOT}/C.md`,
    assets: [{ path: `${ROOT}/assets/conv-c/1-a.bin`, sha256: '0'.repeat(64), size: 3 }],
    incomplete: [{ name: 'too-big.zip' }] });
  const before = JSON.stringify(archive.index);

  const result = await auditArchive(inputs(archive));
  assert.deepEqual(codes(result), [
    `error:asset-hash-mismatch:${image}`,
    `error:asset-missing:${ROOT}/assets/conv-c/1-a.bin`,
    `error:asset-size-mismatch:${image}`,
    `error:asset-size-mismatch:${image}`,
    `error:conversation-missing:${ROOT}/B--conv-b.md`,
    `error:conversation-missing:${ROOT}/B--conv-b.md`,
    `error:conversation-missing:${ROOT}/C.md`,
    `error:identity-duplicate:${ROOT}/B--conv-b.md`,
    `error:link-broken:${ROOT}/A--conv-a.md`,
    `warning:conversation-incomplete:${ROOT}/C.md`,
    `warning:file-unreferenced:${ROOT}/assets/old/9-left-over.txt`,
  ].sort());
  assert.equal(JSON.stringify(archive.index), before, 'the audit never changes its input');
  const report = formatAuditReport(result);
  assert.match(report, /^Archive integrity: 9 error\(s\), 2 warning\(s\)/);
  assert.ok(report.indexOf('ERROR') < report.indexOf('WARNING'), 'errors are listed first');
});

test('shared Markdown paths are errors; shared asset paths from older archives are warnings', async () => {
  const archive = cleanArchive();
  const [a, b] = archive.index.conversations;
  b.path = a.path;
  b.assets = [...a.assets];
  archive.files.delete(`${ROOT}/B--conv-b.md`);
  const result = await auditArchive(inputs(archive));
  assert.deepEqual(codes(result), [
    `error:path-shared:${a.path}`,
    `warning:asset-shared:${a.assets[0].path}`,
  ]);
});

test('malformed indexes and entries are reported instead of throwing', async () => {
  assert.deepEqual(codes(await auditArchive({ index: { conversations: null }, tree: [] })), ['error:index-malformed:archive/index.json']);
  const result = await auditArchive({ index: { conversations: [null, { id: 'x', provider: 'claude', account: 'personal', path: 'archive/conversations/x.md', assets: {} }] }, tree: [] });
  assert.deepEqual(codes(result), [
    'error:conversation-missing:archive/conversations/x.md',
    'error:entry-malformed:archive/conversations/x.md',
    'error:entry-malformed:null',
  ]);
});

test('files the index records as not archived must be noted in the exporter\'s Markdown', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const source = await readFile(new URL('../../extension/background.js', import.meta.url), 'utf8');
  const chrome = { storage: { local: { get: async () => ({}) } }, runtime: { onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); } } };
  const context = { chrome, AbortController, TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob };
  vm.runInNewContext(`${source}\nglobalThis.__hooks = { normalizeAssetList, conversationMarkdown, conversationPath, indexEntry, MAX_ARCHIVED_FILE_BYTES };`, context);
  const exporter = context.__hooks;

  // An oversized file (as the content script hands it over: metadata only)
  // with a name that needs escaping, and a file Claude gave no link for.
  const c = {
    external_id: 'conv-big', title: 'Big files', model: null,
    source_created_at: '2026-11-01T00:00:00.000Z', source_updated_at: '2026-11-01T00:00:00.000Z', message_count: 1,
    messages: [{ external_id: 'm1', role: 'user', content: 'see files', files: [{ file_name: 'lecture_[part 1]*.mp4' }, { file_name: 'gone.pdf' }], attachments: [] }],
    assets: [{ name: 'lecture_[part 1]*.mp4', mime: 'video/mp4', base64: '', size: exporter.MAX_ARCHIVED_FILE_BYTES + 1, sha256: 'c'.repeat(64), source: 'message', message_external_id: 'm1' }],
    incomplete: [{ kind: 'attachment', name: 'gone.pdf', reason: 'Claude did not provide a download link for this file', message_external_id: 'm1' }],
  };
  const normalized = exporter.normalizeAssetList(c, 'claude', 'personal');
  c.incomplete = [...c.incomplete, ...normalized.omissions];
  const markdown = exporter.conversationMarkdown(c, 'claude', 'personal', normalized.byKey, normalized.assets);
  const path = exporter.conversationPath(c, 'claude', 'personal');
  const entry = JSON.parse(JSON.stringify(exporter.indexEntry(c, path, 'claude', 'personal', normalized.assets)));
  assert.equal(entry.incomplete.length, 2);
  const index = { conversations: [entry] };
  const tree = [{ path, type: 'blob', size: markdown.length }, { path: 'archive/index.json', type: 'blob', size: 2 }];

  const clean = await auditArchive({ index, tree, markdown: new Map([[path, markdown]]) });
  assert.deepEqual(codes(clean), [`warning:conversation-incomplete:${path}`], 'both missing files are noted where they were attached');

  const withoutNote = markdown.replace(/\*\*Not archived: [^\n]*/, '');
  const broken = await auditArchive({ index, tree, markdown: new Map([[path, withoutNote]]) });
  assert.deepEqual(codes(broken), [`error:incomplete-note-missing:${path}`, `warning:conversation-incomplete:${path}`]);
  assert.match(broken.findings.find((item) => item.code === 'incomplete-note-missing').message, /"lecture_\[part 1\]\*\.mp4"/);
});
