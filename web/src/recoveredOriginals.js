// Read-only check for the controlled live test of original-first images
// (extension 0.5.29): does an archive written by the extension hold exactly
// the original images the owner recovered by hand, labelled correctly?
// See docs/live-test-original-images.md. The command-line wrapper is
// web/scripts/verify-recovered-originals.mjs.
//
// Recovered files are named original-<first 8 characters of the
// conversation ID>-<stem>.<png|jpg|jpeg>, as the DevTools download step
// saves them; Claude's name for the image is <stem>.png.
//
// Schema checked (docs/archive-format-v1.md, "Image originals and previews"):
//   assets[].variant, assets[].file_uuid, assets[].preview_of,
//   preview_only[], retained_assets[], index.requires_extension and
//   archive/.ai-archive.json.
//
// It never writes anything. Reports name files, sizes, formats, dimensions
// and PASS/FAIL; never image bytes or hashes.

export const RECOVERED_NAME = /^original-([0-9a-f]{8})-(.+)\.(png|jpe?g)$/i;
const REQUIRED_EXTENSION = '0.5.29';
const MIME = { png: 'image/png', jpeg: 'image/jpeg' };
const EXTENSIONS = { png: ['png'], jpeg: ['jpg', 'jpeg'] };

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function imageFormat(b) {
  const at = (offset, ...values) => b.length >= offset + values.length && values.every((v, i) => b[offset + i] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  return 'other';
}

export function imageDimensions(b, format) {
  const u16 = (i) => (b[i] << 8) | b[i + 1];
  const u32 = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  if (format === 'png' && b.length >= 24) return `${u32(16)}x${u32(20)}`;
  if (format === 'jpeg') {
    let i = 2;
    while (i + 8 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return `${u16(i + 7)}x${u16(i + 5)}`;
      i += 2 + u16(i + 2);
    }
  }
  return null;
}

const rel = (path) => `assets/${String(path).split('/assets/').pop()}`;
const occurrences = (text, needle) => String(text).split(needle).length - 1;

// index: parsed archive/index.json; marker: parsed archive/.ai-archive.json
// or null; recovered: [{ fileName, bytes }]; readFile(path) -> bytes of a
// repository file; readText(path) -> text of a repository file.
// Returns { sections: [{ title, checks: [{ ok, label, detail }] }], failures }.
export async function checkRecoveredOriginals({ index, marker, recovered, readFile, readText }) {
  const sections = [];
  let failures = 0;
  const section = (title) => {
    const checks = [];
    sections.push({ title, checks });
    return (ok, label, detail = '') => { checks.push({ ok: Boolean(ok), label, detail }); if (!ok) failures += 1; };
  };

  const archive = section('Archive');
  archive(index?.requires_extension === REQUIRED_EXTENSION, `index records requires_extension ${REQUIRED_EXTENSION}`, String(index?.requires_extension));
  archive(marker?.requires_extension === REQUIRED_EXTENSION, `archive/.ai-archive.json requires ${REQUIRED_EXTENSION}`);
  archive(!marker?.downgrade_warning, 'no downgrade warning recorded');

  for (const { fileName, bytes } of recovered) {
    const [, conv8, stem] = String(fileName).match(RECOVERED_NAME) || [];
    if (!conv8) continue;
    const claudeName = `${stem}.png`;
    const format = imageFormat(bytes);
    const want = { size: bytes.length, sha: await sha256Hex(bytes), format, dims: imageDimensions(bytes, format) };
    const check = section(`${conv8} ${claudeName} -> ${fileName} (${format}, ${want.dims ?? '?'}, ${want.size} bytes)`);

    const entries = (index?.conversations || []).filter((e) => String(e?.id).toLowerCase().startsWith(conv8.toLowerCase()));
    check(entries.length === 1, 'conversation is in the test archive', `${entries.length} entries`);
    const entry = entries[0];
    const named = (entry?.assets || []).filter((a) => a?.name === claudeName);
    const originals = named.filter((a) => a.variant === 'original');
    check(originals.length === 1, "exactly one archived original with Claude's name", `${originals.length} found`);
    if (originals.length !== 1) continue;
    const a = originals[0];
    const archived = await readFile(a.path);
    const af = imageFormat(archived);
    check((await sha256Hex(archived)) === want.sha, 'SHA-256 equals the recovered original');
    check(archived.length === want.size, 'size equals the recovered original', `${archived.length} vs ${want.size} bytes`);
    check(a.size === want.size, 'index size equals the recovered original', String(a.size));
    check(a.sha256 === want.sha, 'index SHA-256 equals the recovered original');
    check(af === want.format, 'format equals the recovered original', `${af} vs ${want.format}`);
    check(imageDimensions(archived, af) === want.dims, 'dimensions equal the recovered original', `${imageDimensions(archived, af)} vs ${want.dims}`);
    check((EXTENSIONS[af] || []).includes(a.path.split('.').pop().toLowerCase()), 'path extension matches the bytes', a.path.split('/').pop());
    check(a.mime === MIME[af], 'index mime matches the bytes', a.mime);
    check(typeof a.file_uuid === 'string' && a.file_uuid.length > 0, 'index records the Claude file UUID');
    check(a.preview_of === undefined, 'the original is not marked as a preview');
    check(!(entry.preview_only || []).some((p) => p.path === a.path), 'the original is not listed as preview-only');
    check(!(entry.retained_assets || []).some((p) => p.path === a.path), 'the original is not listed as a kept historical file');
    const previews = named.filter((p) => p.variant === 'preview');
    for (const p of previews) {
      check(p.preview_of === a.path, 'its preview names this original (preview_of)', p.path.split('/').pop());
      check(!(entry.preview_only || []).some((item) => item.path === p.path), 'that preview is not listed as preview-only');
      if (p.file_uuid && a.file_uuid) check(p.file_uuid === a.file_uuid, 'that preview has the same Claude file UUID');
    }
    check(!(entry.preview_only || []).some((item) => item.name === claudeName && (!a.file_uuid || item.file_uuid === a.file_uuid)), 'no preview-only record for this image');
    const markdown = await readText(entry.path);
    check(occurrences(markdown, `](${rel(a.path)})`) === 1, 'the Markdown links the original exactly once');
    check(!String(markdown).includes(`](${rel(a.path)})\n\n*Preview only`), 'no "Preview only" note on it');
    for (const p of previews) check(occurrences(markdown, `](${rel(p.path)})`) === 1, 'the Markdown links its preview exactly once');
  }
  return { sections, failures };
}

export function formatRecoveredOriginalsReport({ sections, failures }) {
  const lines = [];
  for (const { title, checks } of sections) {
    lines.push(title);
    for (const { ok, label, detail } of checks) lines.push(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
    lines.push('');
  }
  lines.push(failures ? `${failures} check(s) FAILED.` : 'All checks passed.');
  return lines.join('\n');
}
