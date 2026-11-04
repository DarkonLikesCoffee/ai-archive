import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { webcrypto, createHash } from 'node:crypto';
import vm from 'node:vm';
import { rebuildIndexEntry, planIndexRebuild, formatRebuildPlan, EXACT_FIELDS } from './indexRebuild.js';

// The real exporter writes the fixtures, so the rebuild is checked against
// what the extension actually produces. Synthetic content only.
const backgroundSource = await readFile(fileURLToPath(new URL('../../extension/background.js', import.meta.url)), 'utf8');
function loadExporter() {
  const chrome = { storage: { local: { get: async () => ({}) } }, runtime: { onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); } } };
  const context = { chrome, AbortController, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, btoa: globalThis.btoa, atob: globalThis.atob };
  vm.runInNewContext(`${backgroundSource}\nglobalThis.__hooks = { normalizeAssetList, conversationMarkdown, conversationPath, indexEntry, sha256, EXPORTER_VERSION };`, context);
  return context.__hooks;
}
const exporter = loadExporter();
const sha = (data) => createHash('sha256').update(data).digest('hex');

function conversation(id, title, files = []) {
  return {
    external_id: id, title, model: 'test-model',
    source_created_at: '2026-10-26T08:00:00.000Z', source_updated_at: '2026-10-26T09:00:00.000Z', message_count: 2,
    messages: [
      { external_id: `${id}-u`, role: 'user', content: `question about ${title}`, files: files.map((f) => ({ file_name: f.name })), attachments: [] },
      { external_id: `${id}-a`, role: 'assistant', content: 'an answer\n\n---\n\n## A heading inside the answer', files: [], attachments: [] },
    ],
    assets: files.map((f) => ({ name: f.name, mime: f.mime, base64: Buffer.from(f.bytes).toString('base64'), size: f.bytes.length, sha256: sha(f.bytes), source: 'message', message_external_id: `${id}-u` })),
  };
}

async function exportArchive(conversations) {
  const files = new Map();
  const entries = [];
  for (const c of conversations) {
    const normalized = exporter.normalizeAssetList(c, 'claude', 'personal');
    const markdown = exporter.conversationMarkdown(c, 'claude', 'personal', normalized.byKey, normalized.assets);
    const path = exporter.conversationPath(c, 'claude', 'personal');
    const entry = exporter.indexEntry(c, path, 'claude', 'personal', normalized.assets);
    entry.content_sha256 = await exporter.sha256(markdown); // as sync() does
    files.set(path, Buffer.from(markdown));
    for (const asset of normalized.assets) files.set(asset.path, Buffer.from(c.assets.find((a) => a.sha256 === asset.sha256).base64, 'base64'));
    entries.push(JSON.parse(JSON.stringify(entry)));
  }
  const tree = [...files].map(([path, bytes]) => ({ path, type: 'blob', size: bytes.length }));
  const markdown = new Map([...files].filter(([path]) => path.endsWith('.md')).map(([path, bytes]) => [path, bytes.toString('utf8')]));
  return { index: { version: 2, conversations: entries }, tree, markdown, readBytes: async (path) => new Uint8Array(files.get(path)) };
}

const FILES = [
  { name: 'diagram [v2].png', mime: 'image/png', bytes: 'png bytes' },
  { name: 'notes_*draft*.txt', mime: 'text/plain', bytes: 'notes body' },
];

test('every exact index field is rebuilt from the exporter\'s Markdown and files', async () => {
  const archive = await exportArchive([conversation('conv-1', 'First "quoted" title', FILES)]);
  const [original] = archive.index.conversations;
  const [path, markdown] = [...archive.markdown][0];
  const { entry, problems, flaggedIncomplete } = await rebuildIndexEntry({ path, markdown, tree: archive.tree, readBytes: archive.readBytes });
  assert.deepEqual(problems, []);
  assert.equal(flaggedIncomplete, false);
  for (const field of EXACT_FIELDS) assert.deepEqual(entry[field], original[field], field);
  const shape = (assets) => assets.map(({ path: p, size, sha256, name }) => ({ path: p, size, sha256, name })).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(shape(entry.assets), shape(original.assets), 'paths, sizes, hashes and escaped names survive');
  assert.deepEqual(entry.assets.map((a) => a.mime).sort(), ['image/png', 'text/plain']);
});

test('a dry run against a matching index changes nothing and names what an apply would lose', async () => {
  const archive = await exportArchive([conversation('conv-1', 'One', FILES), conversation('conv-2', 'Two')]);
  const before = JSON.stringify(archive.index);
  const plan = await planIndexRebuild(archive);
  assert.equal(JSON.stringify(archive.index), before, 'the index is never modified');
  assert.equal(plan.rebuilt, 2);
  assert.equal(plan.unchanged.length, 2);
  assert.deepEqual(plan.differs, []);
  assert.deepEqual(plan.lostIfApplied.map((item) => item.fields), [['exporter_version', 'format_version'], ['exporter_version', 'format_version']]);
  assert.match(formatRebuildPlan(plan), /^Index rebuild dry run \(nothing was written\): 2 conversation file\(s\) rebuilt; 2 match the index/);
});

test('a damaged index is diagnosed precisely: drift, missing entries, dangling entries and unreadable files', async () => {
  const archive = await exportArchive([conversation('conv-1', 'One', FILES), conversation('conv-2', 'Two'), conversation('conv-3', 'Three')]);
  const [one, two, three] = archive.index.conversations;
  one.title = 'Edited by hand';                       // drift
  one.assets = one.assets.slice(1);                   // lost asset reference
  archive.index.conversations = [one, three, { id: 'gone', provider: 'claude', account: 'personal', path: 'archive/conversations/claude/personal/gone.md' }];
  archive.markdown.set('archive/conversations/claude/personal/legacy.md', '# Old export without a metadata block\n\n## You\n\nhi\n');
  const plan = await planIndexRebuild(archive);
  assert.deepEqual(plan.differs.map((item) => [item.key, item.fields]), [['claude:personal:conv-1', ['title', 'assets']]]);
  assert.deepEqual(plan.onlyInFiles.map((item) => item.key), [`claude:personal:${two.id}`]);
  assert.deepEqual(plan.onlyInIndex.map((item) => item.key), ['claude:personal:gone']);
  assert.deepEqual(plan.unreadable.map((item) => item.path), ['archive/conversations/claude/personal/legacy.md']);
  const report = formatRebuildPlan(plan);
  assert.match(report, /DIFFERS .*: title; assets/);
  assert.match(report, /UNREADABLE .*legacy\.md: no id\/provider\/account in the metadata block/);
});

test('a missing attachment file and a "not archived" note are reported, not invented', async () => {
  const c = conversation('conv-1', 'One', FILES);
  c.incomplete = [{ kind: 'attachment', name: 'lost.pdf', reason: 'Claude did not provide a download link for this file', message_external_id: 'conv-1-u' }];
  c.messages[0].files.push({ file_name: 'lost.pdf' });
  const archive = await exportArchive([c]);
  const imagePath = archive.tree.find((item) => item.path.endsWith('.png')).path;
  archive.tree = archive.tree.filter((item) => item.path !== imagePath);
  const [path, markdown] = [...archive.markdown][0];
  const { entry, problems, flaggedIncomplete } = await rebuildIndexEntry({ path, markdown, tree: archive.tree });
  assert.equal(flaggedIncomplete, true, 'the visible note marks the rebuilt entry as needing a retry');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /links to assets\/.*\.png, which is not in the repository/);
  assert.equal(entry.assets.some((asset) => asset.path === imagePath), false);
  assert.equal(entry.assets.every((asset) => asset.sha256 === null), true, 'no hash is claimed without reading the bytes');
});
