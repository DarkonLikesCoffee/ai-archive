// Real-browser check of the web viewer against a GitHub API mock whose archive
// is produced by the real exporter (extension/background.js).
//
// Requires Playwright with a Chromium browser (not part of CI). Run:
//   cd web && npm run build && npx vite preview --port 4317 --strictPort &
//   node e2e/viewer.e2e.cjs            # BASE_URL=http://localhost:4317/ by default
const { chromium } = require('playwright');
const fs = require('fs');
const vm = require('vm');
const { webcrypto } = require('crypto');

const path = require('path');
const repoRoot = path.resolve(__dirname, '..', '..');
const bg = fs.readFileSync(`${repoRoot}/extension/background.js`, 'utf8');
const ctx = { chrome: { storage: { local: { get: async () => ({}) } }, runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() } }, AbortController, fetch: () => new Promise(() => {}), TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, btoa, atob };
vm.runInNewContext(`${bg}\nglobalThis.h={normalizeAssetList,conversationMarkdown,conversationPath,indexEntry};`, ctx);

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';
const pngSha256 = require('crypto').createHash('sha256').update(Buffer.from(PNG, 'base64')).digest('hex');
const conversations = [
  { external_id: 'conv-react', title: 'Frontend help', source_updated_at: '2026-10-20T10:00:00Z', message_count: 2, messages: [
    { external_id: 'u1', role: 'user', content: 'How do React hooks work?', files: [{ file_uuid: 'img-1', file_name: 'diagram.png', file_kind: 'image' }], attachments: [] },
    { external_id: 'a1', role: 'assistant', content: 'Intro.\n\n---\n\n## Details\n\nhooks let components keep state.', files: [], attachments: [] }],
    assets: [{ file_uuid: 'img-1', name: 'diagram.png', mime: 'image/png', base64: PNG, sha256: pngSha256, size: Buffer.from(PNG, 'base64').length, message_external_ids: ['u1'] }] },
  { external_id: 'conv/rust?#1', title: 'Rust ownership', source_updated_at: '2026-10-25T10:00:00Z', message_count: 2, messages: [
    { external_id: 'u2', role: 'user', content: 'Explain the borrow checker', files: [], attachments: [] },
    { external_id: 'a2', role: 'assistant', content: 'The borrow checker enforces ownership.\n\n```rust\nlet s = String::from("hi");\nlet t = &s;\n```', files: [], attachments: [] },
    ...['Lifetimes?', 'What about **Rc** and RefCell?', 'Summarize'].flatMap((q, i) => [
      { external_id: `u2-${i}`, role: 'user', content: q, files: [], attachments: [] },
      { external_id: `a2-${i}`, role: 'assistant', content: Array.from({ length: 12 }, () => 'Ownership rules keep memory safe without a garbage collector.').join('\n\n'), files: [], attachments: [] },
    ])], assets: [] },
];
const files = {};
const index = { version: 2, conversations: [] };
const assetBytes = {};
for (const c of conversations) {
  const { assets, byKey } = ctx.h.normalizeAssetList(c, 'claude', 'personal');
  const path = ctx.h.conversationPath(c, 'claude', 'personal');
  files[path] = ctx.h.conversationMarkdown(c, 'claude', 'personal', byKey, assets);
  for (const asset of assets) assetBytes[asset.path] = Buffer.from(asset.base64, 'base64');
  index.conversations.push(ctx.h.indexEntry(c, path, 'claude', 'personal', assets));
}
files['archive/index.json'] = JSON.stringify(index);

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })).newPage();
  // Date groups are relative to "now".
  await page.clock.setFixedTime(new Date('2026-10-27T12:00:00'));
  const errors = [];
  const assetRequests = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('https://api.github.com/**', (route) => {
    const url = new URL(route.request().url());
    const m = url.pathname.match(/^\/repos\/me\/archive\/contents\/(.+)$/);
    const path = m && decodeURIComponent(m[1]);
    if (path && assetBytes[path]) {
      assetRequests.push(path);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'file', encoding: 'base64', content: assetBytes[path].toString('base64'), sha: 'x', size: assetBytes[path].length }) });
    }
    if (path && files[path] !== undefined) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(files[path]).toString('base64'), sha: 'x' }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' });
  });
  await page.addInitScript(() => localStorage.setItem('ai_archive_github_v3', JSON.stringify({ owner: 'me', repo: 'archive', token: 't' })));
  const base = process.env.BASE_URL || 'http://localhost:4317/';
  const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) process.exitCode = 1; };

  await page.goto(base);
  await page.waitForSelector('.conversation');
  check('list shows both conversations', (await page.locator('.conversation').count()) === 2);

  await page.fill('.search', 'hooks react');
  await page.waitForFunction(() => document.querySelectorAll('.conversation').length === 1);
  check('multi-word search matches non-adjacent words', (await page.locator('.conversation strong').first().textContent()) === 'Frontend help');
  check('search snippet highlights terms', (await page.locator('.search-snippet mark').count()) >= 2);
  check('search is in the URL (replaceState)', page.url().includes('q=hooks+react'), page.url());

  await page.locator('.conversation').first().click();
  await page.waitForSelector('.message');
  check('opening a conversation sets a deep link', page.url().includes('#/c/claude/personal/conv-react'), page.url());
  const roles = await page.locator('.message .role').allTextContents();
  check('answer with "---" + "## Details" stays one message (#47)', roles.length === 2, JSON.stringify(roles));

  await page.reload();
  await page.waitForSelector('.message');
  check('reload reopens the same conversation', (await page.locator('.message').count()) === 2);

  await page.goBack();
  await page.waitForSelector('.conversation');
  check('Back returns to the list with the search kept', (await page.inputValue('.search')) === 'hooks react', await page.inputValue('.search'));

  await page.goto(`${base}#/c/claude/personal/${encodeURIComponent('conv/rust?#1')}`);
  await page.waitForSelector('.message');
  check('deep link with an unusual ID opens it', (await page.locator('.message .content').first().textContent()).includes('borrow checker'));
  await page.locator('.code-block').first().hover();
  await page.locator('.copy-code').first().click();
  await page.waitForSelector('.copy-code.copied');
  const copiedCode = await page.evaluate(() => navigator.clipboard.readText());
  check('the copy button copies exactly the code', copiedCode === 'let s = String::from("hi");\nlet t = &s;' || copiedCode === 'let s = String::from("hi");\nlet t = &s;\n', JSON.stringify(copiedCode));
  await page.fill('.reader-search', 'copy');
  await page.waitForSelector('.reader-find-count');
  check('find ignores button labels', (await page.locator('.reader-find-count').textContent()) === 'No results', await page.locator('.reader-find-count').textContent());
  await page.fill('.reader-search', '');

  await page.goto(`${base}#/c/claude/personal/does-not-exist`);
  await page.waitForSelector('.error.banner');
  check('a dead link shows a clear error over the list', (await page.locator('.error.banner').textContent()).includes('not in the archive index'));

  await page.goto(base);
  await page.waitForSelector('.conversation');
  const titles = () => page.locator('.conversation strong').allTextContents();
  const labels = () => page.locator('.list-group-label').allTextContents();
  check('list is grouped by update date', JSON.stringify(await labels()) === JSON.stringify(['Previous 7 days', 'Previous 30 days']), JSON.stringify(await labels()));
  check('newest first by default', (await titles())[0] === 'Rust ownership', JSON.stringify(await titles()));
  await page.selectOption('.sort', 'oldest');
  check('oldest first reverses the order', (await titles())[0] === 'Frontend help', JSON.stringify(await titles()));
  check('the sort is in the URL', page.url().includes('sort=oldest'), page.url());
  await page.reload();
  await page.waitForSelector('.conversation');
  check('reload keeps the sort', (await page.inputValue('.sort')) === 'oldest' && (await titles())[0] === 'Frontend help');
  await page.selectOption('.sort', 'title');
  check('title sort has no date groups', (await labels()).length === 0 && (await titles())[0] === 'Frontend help');
  await page.selectOption('.sort', 'auto');
  await page.fill('.search', 'the');
  await page.waitForFunction(() => !document.querySelector('.list-group-label'));
  check('search results offer "Best match" and are not date-grouped', (await page.locator('.sort option').first().textContent()) === 'Best match');

  // Attachments are cached by content hash: revisiting needs no GitHub calls.
  const imageShown = () => page.waitForFunction(() => document.querySelector('.content img[src^="data:image/png"], .content [style*="data:image/png"]'));
  await page.goto(`${base}#/c/claude/personal/conv-react`);
  await imageShown();
  const firstVisit = assetRequests.length;
  check('the image attachment is shown', firstVisit === 1, `asset requests=${firstVisit}`);
  await page.reload();
  await imageShown();
  check('revisiting shows the image from the cache, without GitHub', assetRequests.length === firstVisit, `asset requests=${assetRequests.length}`);
  // Print / PDF: the button prints, and print media shows only the conversation.
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed += 1; }; });
  await page.click('.print-button');
  check('Print / PDF opens the print dialog', (await page.evaluate(() => window.__printed)) === 1);
  await page.emulateMedia({ media: 'print' });
  const printed = await page.evaluate(() => ({
    sidebar: getComputedStyle(document.querySelector('aside')).display,
    header: getComputedStyle(document.querySelector('.reader-sticky-header')).display,
    copy: document.querySelector('.copy-message').checkVisibility() ? 'visible' : 'none',
    background: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.querySelector('.message .content')).color,
    image: !!document.querySelector('.content img[src^="data:image/png"]'),
  }));
  check('print hides the app chrome and uses dark text on white', printed.sidebar === 'none' && printed.header === 'none' && printed.copy === 'none'
    && printed.background === 'rgb(255, 255, 255)' && printed.text === 'rgb(17, 17, 17)' && printed.image, JSON.stringify(printed));
  if (process.env.PRINT_PDF) await page.pdf({ path: process.env.PRINT_PDF });
  const pdf = await page.pdf();
  check('the conversation renders to PDF', pdf.length > 1000 && pdf.subarray(0, 4).toString() === '%PDF', `${pdf.length} bytes`);
  await page.emulateMedia({ media: 'screen' });
  await page.locator('button.nav', { hasText: 'Disconnect' }).click();
  await page.waitForFunction(async () => !(await caches.keys()).length);
  check('Disconnect clears the attachment cache', true);

  // Phones: the sidebar is a drawer behind a menu button.
  await page.addInitScript(() => localStorage.setItem('ai_archive_github_v3', JSON.stringify({ owner: 'me', repo: 'archive', token: 't' })));
  await page.goto(base);
  await page.waitForSelector('.conversation');
  check('desktop has no menu button', !(await page.locator('.menu-button').isVisible()) && await page.locator('.sidebar').isVisible());
  await page.setViewportSize({ width: 390, height: 800 });
  check('phone hides the sidebar behind a menu button', await page.locator('.menu-button').isVisible() && !(await page.locator('.sidebar').isVisible()));
  await page.click('.menu-button');
  check('the menu opens the sidebar', await page.locator('.sidebar').isVisible());
  await page.locator('.sidebar button.nav', { hasText: 'personal' }).click();
  await page.waitForFunction(() => location.hash.includes('account=personal'));
  check('choosing an account filters and closes the menu', !(await page.locator('.sidebar').isVisible()));
  await page.click('.menu-button');
  await page.keyboard.press('Escape');
  check('Escape closes the menu', !(await page.locator('.sidebar').isVisible()));
  await page.click('.menu-button');
  await page.mouse.click(370, 400);
  check('tapping outside closes the menu', !(await page.locator('.sidebar').isVisible()));
  await page.locator('.conversation', { hasText: 'Frontend help' }).click();
  await page.waitForSelector('.message');
  const phoneActions = page.locator('.reader-head-actions');
  check('phones show Print / PDF and Open on GitHub under the title',
    await phoneActions.locator('.print-button').isVisible() && await phoneActions.locator('a.github-link').isVisible()
    && !(await page.locator('.reader-header-actions').isVisible()));
  await page.goBack();
  await page.waitForSelector('.conversation');
  await page.setViewportSize({ width: 1280, height: 720 });

  // Keyboard: / focuses search, j/k move through the list, Enter opens,
  // Escape leaves the find bar and then goes back to the list.
  await page.addInitScript(() => localStorage.setItem('ai_archive_github_v3', JSON.stringify({ owner: 'me', repo: 'archive', token: 't' })));
  await page.goto(`${base}#/`);
  await page.reload(); // a hash-only navigation would not rerun the init script
  await page.waitForSelector('.conversation');
  const focused = () => page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
  await page.keyboard.press('/');
  check('/ focuses the search box', (await focused()) === 'search', await focused());
  await page.keyboard.press('Escape');
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  check('j/k move between conversations', (await page.evaluate(() => document.activeElement?.querySelector('strong')?.textContent)) === 'Rust ownership');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.message');
  check('Enter opens the focused conversation', page.url().includes('#/c/'), page.url());
  await page.keyboard.press('/');
  check('/ focuses the find bar in a conversation', (await focused()).includes('reader-search'), await focused());
  await page.keyboard.press('Escape');
  check('Escape leaves the empty find bar', !(await focused()).includes('reader-search'), await focused());
  await page.keyboard.press('Escape');
  await page.waitForSelector('.conversation');
  check('Escape goes back to the list', !page.url().includes('#/c/'), page.url());

  // Outline of your prompts in a long conversation (wide screens only).
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(`${base}#/c/claude/personal/${encodeURIComponent('conv/rust?#1')}`);
  await page.waitForSelector('.reader-outline button');
  const outlineLabels = await page.locator('.reader-outline button').allTextContents();
  check('the outline lists every prompt as plain text', JSON.stringify(outlineLabels) === JSON.stringify(['Explain the borrow checker', 'Lifetimes?', 'What about Rc and RefCell?', 'Summarize']), JSON.stringify(outlineLabels));
  await page.locator('.reader-outline button').nth(2).click();
  await page.waitForFunction(() => Math.abs(document.getElementById('message-4').getBoundingClientRect().top - 84) < 30);
  await page.waitForFunction(() => document.querySelector('.reader-outline button.active')?.textContent === 'What about Rc and RefCell?');
  check('clicking a prompt scrolls to it and marks it as current', true);
  await page.setViewportSize({ width: 1000, height: 800 });
  check('narrower screens hide the outline', !(await page.locator('.reader-outline').isVisible()));
  await page.setViewportSize({ width: 1280, height: 720 });

  // First run: a mistyped repository is explained, and a repository the
  // extension has not synced to yet shows an empty archive with next steps.
  const fresh = await (await browser.newContext()).newPage();
  fresh.on('pageerror', (e) => errors.push(String(e)));
  await fresh.route('https://api.github.com/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/repos/me/new-archive') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"full_name":"me/new-archive"}' });
    if (pathname.startsWith('/repos/me/new-archive/')) return route.fulfill({ status: 409, contentType: 'application/json', body: '{"message":"Git Repository is empty."}' });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' });
  });
  await fresh.goto(base);
  await fresh.fill('input[placeholder="your-username"]', 'me');
  await fresh.fill('input[placeholder="ai-conversation-archive"]', 'new-archiv');
  await fresh.fill('input[type="password"]', 't');
  await fresh.click('.auth button');
  await fresh.waitForSelector('.auth .error');
  check('a repository that does not exist is explained', /^Repository me\/new-archiv was not found/.test(await fresh.locator('.auth .error').textContent()), await fresh.locator('.auth .error').textContent());
  await fresh.fill('input[placeholder="ai-conversation-archive"]', 'new-archive');
  await fresh.click('.auth button');
  await fresh.waitForSelector('.empty-archive');
  check('an archive that was never synced shows next steps, not an error',
    (await fresh.locator('.empty-archive').textContent()).includes('This archive is empty') && !(await fresh.locator('.error').count()));

  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
