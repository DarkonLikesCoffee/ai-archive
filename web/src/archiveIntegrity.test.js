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

// ---- Diagnostics for the first real-archive run (synthetic shapes) ----
const DARK = 'archive/conversations/claude/darkon';
const OWN_ID = '138089cb-0000-4000-8000-000000000001';
const OTHER_ID = 'bb7e12e2-0000-4000-8000-000000000002';
const OWN_MD = `${DARK}/Code-block-fixes--${OWN_ID}-1f4d8315.md`;
const metaBlock = (id) => `<!-- AI_ARCHIVE_METADATA\n${JSON.stringify({ id, provider: 'claude', account: 'darkon', title: 'T' })}\n-->\n\n# T\n\n`;

function diagnosticArchive() {
  const js = bytes('console.log(1)');
  const jsSha = sha(js);
  const otherAsset = `${DARK}/assets/${OTHER_ID}-aaaa1111/${jsSha.slice(0, 8)}-extension.js`;
  const files = new Map([
    // Quoted text from another archive file, three times, links into another
    // conversation's legacy folder; one own attachment is really missing.
    [OWN_MD, bytes(`${metaBlock(OWN_ID)}## You\n\nThe viewer shows [extension.js](assets/bb7e12e2/${jsSha.slice(0, 8)}-extension.js) as text.\n> [extension.js](assets/bb7e12e2/${jsSha.slice(0, 8)}-extension.js)\n\`\`\`md\n![x](assets/bb7e12e2/${jsSha.slice(0, 8)}-extension.js)\n![y](assets/138089cb/ffff0000-in-code.png)\n\`\`\`\n![gone](assets/${OWN_ID}-1f4d8315/0000aaaa-gone.png)\n![gone](assets/${OWN_ID}-1f4d8315/0000aaaa-gone.png)\n`)],
    [`${DARK}/Other--${OTHER_ID}.md`, bytes(`${metaBlock(OTHER_ID)}## You\n\n[extension.js](assets/${OTHER_ID}-aaaa1111/${jsSha.slice(0, 8)}-extension.js)\n`)],
    [otherAsset, js],
    ['archive/index.json', bytes('{}')],
    // Unreferenced files of each kind.
    [`${DARK}/Old-title--${OTHER_ID}.md`, bytes(`${metaBlock(OTHER_ID)}## You\n\nold copy\n`)],
    [`${DARK}/Lost--cccc0000-0000-4000-8000-000000000003.md`, bytes(`${metaBlock('cccc0000-0000-4000-8000-000000000003')}## You\n\nnot indexed\n`)],
    [`${DARK}/assets/bb7e12e2/${jsSha.slice(0, 8)}-extension.js`.replace('bb7e12e2', '9da9cc54'), bytes('legacy leftover')],
    [`${DARK}/assets/${OTHER_ID}-aaaa1111/copy-extension.js`, js],
    ['archive/conversations/claude/aaaaaaaaaa/Test--x.md', bytes('# test')],
    [`${DARK}/assets/oldstuff/notes.txt`, bytes('orphan')],
  ]);
  const index = { version: 2, conversations: [
    { id: OWN_ID, provider: 'claude', account: 'darkon', path: OWN_MD, assets: [],
      incomplete: [{ kind: 'attachment', name: 'project.zip', too_large: true, size: 4e7, sha256: 'e'.repeat(64) }, { kind: 'attachment', name: 'gone.pdf', reason: 'no link' }] },
    { id: OTHER_ID, provider: 'claude', account: 'darkon', path: `${DARK}/Other--${OTHER_ID}.md`, assets: [{ path: otherAsset, sha256: jsSha, size: js.byteLength, name: 'extension.js' }] },
  ] };
  return { files, index, otherAsset, jsSha };
}

test('a broken link is reported once per file and target, and links into another conversation\'s folder or code are not called exporter errors', async () => {
  const { files, index, otherAsset, jsSha } = diagnosticArchive();
  const result = await auditArchive(inputs({ index, files }));
  const links = result.findings.filter((f) => f.path === OWN_MD && f.code.startsWith('link-'));
  assert.deepEqual(links.map((f) => [f.severity, f.code, f.target, f.occurrences]), [
    ['warning', 'link-unresolved-quoted', `assets/bb7e12e2/${jsSha.slice(0, 8)}-extension.js`, 3],
    ['warning', 'link-unresolved-quoted', 'assets/138089cb/ffff0000-in-code.png', 1],
    ['error', 'link-broken', `assets/${OWN_ID}-1f4d8315/0000aaaa-gone.png`, 2],
  ]);
  const [quoted, inCode, broken] = links;
  assert.match(quoted.message, /another conversation's attachment folder \(assets\/bb7e12e2\/\)/);
  assert.deepEqual(quoted.candidates, [otherAsset, `${DARK}/assets/9da9cc54/${jsSha.slice(0, 8)}-extension.js`], 'files with the same name are found, in tree order');
  assert.match(quoted.message, new RegExp(`SHA-256 starting with ${jsSha.slice(0, 8)}.*very likely the same file`));
  assert.match(inCode.message, /inside a code block or inline code/);
  assert.equal(inCode.own_folder, true, 'its own legacy folder, but quoted in code');
  assert.match(broken.message, /\(2 times\).*No file with that name exists anywhere/);
});

test('unreferenced files are classified by likely cause and summarized per folder', async () => {
  const { files, index } = diagnosticArchive();
  const result = await auditArchive(inputs({ index, files }));
  const kinds = Object.fromEntries(result.findings.filter((f) => f.code === 'file-unreferenced').map((f) => [f.path, f.kind]));
  const legacy = Object.keys(kinds).find((k) => k.startsWith(`${DARK}/assets/9da9cc54/`));
  assert.deepEqual(kinds, {
    [`${DARK}/Old-title--${OTHER_ID}.md`]: 'duplicate-conversation',
    [`${DARK}/Lost--cccc0000-0000-4000-8000-000000000003.md`]: 'conversation-not-indexed',
    [legacy]: 'legacy-layout',
    [`${DARK}/assets/${OTHER_ID}-aaaa1111/copy-extension.js`]: 'duplicate-copy',
    'archive/conversations/claude/aaaaaaaaaa/Test--x.md': 'markdown-not-indexed',
    [`${DARK}/assets/oldstuff/notes.txt`]: 'orphaned',
  });
  const placeholder = result.findings.find((f) => f.path === 'archive/conversations/claude/aaaaaaaaaa/Test--x.md');
  assert.equal(placeholder.placeholder, 'aaaaaaaaaa');
  assert.match(placeholder.message, /"aaaaaaaaaa", which is not an ID the exporter writes: most likely sample or test data/);
  const duplicate = result.findings.find((f) => f.kind === 'duplicate-conversation');
  assert.match(duplicate.message, /older copy of a conversation the index lists at .*Other--/);
  const report = formatAuditReport(result);
  assert.match(report, /Unreferenced files by kind and folder:\n/);
  assert.match(report, /\n {2}1 older copies of indexed conversations:\n {4}1 in archive\/conversations\/claude\/darkon\//);
  assert.match(report, /1 files in legacy attachment folders:\n {4}1 in archive\/conversations\/claude\/darkon\/assets\/9da9cc54\//);
  // Nothing is downgraded or hidden: every unreferenced file is still a warning.
  assert.equal(result.findings.filter((f) => f.code === 'file-unreferenced').every((f) => f.severity === 'warning'), true);
});

test('an incomplete conversation lists its missing files with their category', async () => {
  const { files, index } = diagnosticArchive();
  const result = await auditArchive(inputs({ index, files }));
  const incomplete = result.findings.find((f) => f.code === 'conversation-incomplete');
  assert.match(incomplete.message, /2 file\(s\) missing; every sync retries it: project\.zip \(over the upload limit\); gone\.pdf \(not available from Claude\)\./);
  assert.deepEqual(incomplete.missing, [{ name: 'project.zip', category: 'over the upload limit' }, { name: 'gone.pdf', category: 'not available from Claude' }]);
});

test('scanAssetLinks: one entry per target with counts, fences and inline code', async () => {
  const { scanAssetLinks } = await import('./archiveIntegrity.js');
  const links = scanAssetLinks('a [x](assets/d/1.png) `[y](assets/d/2.png)`\n~~~\n[z](assets/d/1.png)\n~~~\n[x](assets/d/1.png)\n````\n```\n[w](assets/d/3.png)\n````\n');
  assert.deepEqual(links.map((l) => [l.ref, l.count, l.inCode]), [['assets/d/1.png', 3, false], ['assets/d/2.png', 1, true], ['assets/d/3.png', 1, true]]);
});

test('images kept from an earlier export are referenced, not orphans; a missing kept file is a warning', async () => {
  const archive = cleanArchive();
  const kept = `${ROOT}/assets/conv-a/2-map.png`;
  archive.files.set(kept, bytes('synthetic preview bytes'));
  archive.index.conversations[0].assets[0].variant = 'original';
  archive.index.conversations[0].retained_assets = [{ path: kept, name: 'map.png', mime: 'image/webp' }];
  archive.index.conversations[0].preview_only = [];
  archive.index.requires_extension = '0.5.29';
  const clean = await auditArchive(inputs(archive));
  assert.deepEqual(codes(clean), [], 'a kept file and the new fields raise nothing');

  archive.files.delete(kept);
  const missing = await auditArchive(inputs(archive));
  assert.deepEqual(codes(missing), [`warning:retained-asset-missing:${kept}`]);
});

test('without retained_assets, the same file is still reported as unreferenced', async () => {
  const archive = cleanArchive();
  const stray = `${ROOT}/assets/conv-a/2-map.png`;
  archive.files.set(stray, bytes('synthetic preview bytes'));
  const result = await auditArchive(inputs(archive));
  assert.deepEqual(codes(result), [`warning:file-unreferenced:${stray}`]);
});

test('an original with its preview is consistent; a dangling preview_of or a contradicting preview_only is a warning', async () => {
  const archive = cleanArchive();
  const preview = `${ROOT}/assets/conv-a/2-map.webp`;
  archive.files.set(preview, bytes('synthetic preview'));
  archive.files.set(`${ROOT}/A--conv-a.md`, bytes(`# A\n\n![map.png](assets/conv-a/1-map.png)\n\n*Also archived: [Claude's preview of this image](assets/conv-a/2-map.webp).*\n`));
  const entry = archive.index.conversations[0];
  archive.index.requires_extension = '0.5.29';
  entry.assets[0].variant = 'original';
  entry.assets.push({ path: preview, size: 17, sha256: sha(bytes('synthetic preview')), name: 'map.png', variant: 'preview', preview_of: entry.assets[0].path });
  assert.deepEqual(codes(await auditArchive(inputs(archive))), []);

  entry.preview_only = [{ path: preview, name: 'map.png', reason: 'original-unavailable' }];
  assert.deepEqual(codes(await auditArchive(inputs(archive))), [`warning:preview-only-has-original:${preview}`]);
  delete entry.preview_only;

  entry.assets[1].preview_of = `${ROOT}/assets/conv-a/gone.png`;
  assert.deepEqual(codes(await auditArchive(inputs(archive))), [`warning:preview-of-missing:${preview}`]);
  entry.assets[1].preview_of = entry.assets[0].path;

  entry.preview_only = [{ path: `${ROOT}/assets/conv-a/not-indexed.webp`, name: 'x.png', reason: 'original-unavailable' }];
  assert.deepEqual(codes(await auditArchive(inputs(archive))), [`warning:preview-only-unlisted:${ROOT}/assets/conv-a/not-indexed.webp`]);
});

test('original-first records without the requires_extension marker report an older extension; older archives do not', async () => {
  const archive = cleanArchive();
  archive.index.conversations[0].assets[0].variant = 'original';
  assert.deepEqual(codes(await auditArchive(inputs(archive))), ['warning:older-extension-wrote:archive/index.json']);
  archive.index.requires_extension = '0.5.29';
  assert.deepEqual(codes(await auditArchive(inputs(archive))), []);
  assert.deepEqual(codes(await auditArchive(inputs(cleanArchive()))), [], 'an archive from before 0.5.29 raises nothing');
});

test('the marker file reveals an older extension even after it removed every image record from the index', async () => {
  const archive = cleanArchive();
  archive.files.set('archive/.ai-archive.json', bytes('{"format":"ai-archive","requires_extension":"0.5.29"}'));
  assert.deepEqual(codes(await auditArchive(inputs(archive))), ['warning:older-extension-wrote:archive/index.json'], 'no image records left, still detected');
  archive.index.requires_extension = '0.5.29';
  assert.deepEqual(codes(await auditArchive(inputs(archive))), [], 'and nothing once the index has its marker');
});
