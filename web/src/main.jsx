import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { readConversation, readIndex, readAsset, githubRequest, mapWithConcurrency } from './github';
import { renderMarkdownWithMarked } from './markdownRenderer.js';
import { assetPlaceholderPaths } from './assetPlaceholders.js';
import { terminatedToolSectionEnd } from './toolSections.js';
import './styles.css';

const KEY = 'ai_archive_github_v3';
function getSaved() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }

function Settings({ initial, onSave }) {
  const [owner, setOwner] = useState(initial?.owner || '');
  const [repo, setRepo] = useState(initial?.repo || '');
  const [token, setToken] = useState(initial?.token || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const s = { owner: owner.trim(), repo: repo.trim(), token: token.trim() };
      if (!s.owner || !s.repo || !s.token) throw Error('All three fields are required.');
      await githubRequest(s, ''); onSave(s);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <div className="auth"><div className="card auth-card"><div className="logo">AI</div><h1>AI Archive</h1><p className="muted">Your AI conversations, stored as Markdown in your private GitHub repository.</p><form onSubmit={submit}><label>GitHub username / owner</label><input value={owner} onChange={e => setOwner(e.target.value)} placeholder="your-username"/><label>Private repository</label><input value={repo} onChange={e => setRepo(e.target.value)} placeholder="ai-conversation-archive"/><label>Fine-grained token</label><input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="github_pat_…"/><button disabled={busy}>{busy ? 'Checking GitHub…' : 'Connect GitHub'}</button></form>{error && <div className="error">{error}</div>}<p className="hint">The token stays in this browser's local storage. Restrict it to this repository with Contents read access.</p></div></div>;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function renderMarkdown(text) {
  const source = String(text || '');
  const lines = source.split('\n');
  const out = [];
  let i = 0;

  function renderNormalLines(blockLines) {
    const html = [];
    let normalLines = [];

    // Preserve the reader's attachment placeholders while delegating standard
    // Markdown parsing (lists, headings, nested quotes, tables, emphasis, etc.)
    // to Marked. The Message component later resolves these placeholders.
    const markdownOptions = {
      renderImage: ({ href, text: alt }) => {
        const path = String(href ?? '');
        return `<span class="md-image-placeholder" data-md-image="${escapeHtml(path)}">🖼️ ${escapeHtml(alt)}</span>`;
      },
      renderLink: ({ href, text: label }) => {
        const path = String(href ?? '').replace(/\\/g, '/');
        if (/^(?:assets\/|archive\/.*\/assets\/)/.test(path)) {
          // The label is raw Markdown source; escape it so it cannot inject HTML.
          return `<span class="md-attachment-placeholder" data-md-attachment="${escapeHtml(path)}">${escapeHtml(label)}</span>`;
        }
        return undefined;
      },
    };

    function flushMarkdown() {
      if (!normalLines.length) return;
      html.push(renderMarkdownWithMarked(normalLines.join('\n'), markdownOptions));
      normalLines = [];
    }

    let j = 0;
    while (j < blockLines.length) {
      const line = blockLines[j];
      const replyMatch = line.match(/^\*\*Attachment: (excerpt_from_previous_claude_message\.txt)\*\*$/i);
      if (replyMatch) {
        flushMarkdown();

        // Claude exports selected-text context as a synthetic attachment
        // followed by a fenced quote. Keep the familiar reply-context card.
        let fenceIndex = j + 1;
        while (fenceIndex < blockLines.length && !blockLines[fenceIndex].trim()) fenceIndex++;
        if (fenceIndex < blockLines.length && /^\s*(`{3,}|~{3,})/.test(blockLines[fenceIndex])) {
          const fenceLine = blockLines[fenceIndex];
          const fence = fenceLine.match(/^\s*(`{3,}|~{3,})/)?.[1] || '```';
          const quote = [];
          let k = fenceIndex + 1;
          const marker = fence[0];
          const isClosingFence = (candidate) => {
            const match = candidate.match(/^\s*(`{3,}|~{3,})\s*$/);
            return Boolean(match && match[1][0] === marker && match[1].length >= fence.length);
          };
          while (k < blockLines.length && !isClosingFence(blockLines[k])) quote.push(blockLines[k++]);
          if (k < blockLines.length) k++;
          const quotedHtml = inlineMarkdown(quote.join('\n')).replace(/\n/g, '<br>');
          html.push(`<div class="reply-context"><div class="reply-context-icon">↩</div><div class="reply-context-main"><div class="reply-context-label"><strong>Claude</strong><span>replying to a message</span></div><div class="reply-context-quote">${quotedHtml}</div></div></div>`);
          j = k;
          while (j < blockLines.length && !blockLines[j].trim()) j++;
          continue;
        }
      }

      normalLines.push(line);
      j++;
    }

    flushMarkdown();
    return html.join('\n');
  }

  function isToolHeading(line) {
    return /^### (Claude tool|Tool result): /.test(line);
  }

  function toolLabel(heading) {
    const m = heading.match(/^### (Claude tool|Tool result): (.+)$/);
    if (!m) return 'Tool';
    const kind = m[1] === 'Claude tool' ? 'Executed command' : 'Tool result';
    return `${kind} — ${m[2]}`;
  }

  while (i < lines.length) {
    if (!isToolHeading(lines[i])) {
      const normal = [];
      while (i < lines.length && !isToolHeading(lines[i])) { normal.push(lines[i++]); }
      out.push(renderNormalLines(normal));
      continue;
    }

    const tools = [];
    while (i < lines.length && isToolHeading(lines[i])) {
      const heading = lines[i++];
      const body = [];
      let fence = null;
      let sawClosedFence = false;

      // A section closed by an explicit end marker (metadata plus readable
      // bodies, e.g. artifact content) keeps every fence up to the marker.
      const end = terminatedToolSectionEnd(lines, i - 1);
      if (end >= 0) {
        body.push(...lines.slice(i, end));
        i = end + 1;
        sawClosedFence = true;
      }

      // Tool sections produced by the archive exporter normally contain one
      // fenced block (the command/input or the tool result).  The important
      // distinction here is that a normal assistant response can follow the
      // tool result in the SAME message.  The old parser consumed that prose
      // as part of the final tool, which made the real Claude response appear
      // to be hidden inside the collapsed tool group.
      while (end < 0 && i < lines.length) {
        const line = lines[i];

        // Only treat a line as a section boundary when we are NOT in the
        // middle of an open fence. A shell/code comment like "# foo" inside
        // a fenced tool body must never be mistaken for a Markdown heading —
        // doing so truncated the fence early and corrupted every tool
        // section that contained a "#"-style comment.
        if (!fence) {
          if (isToolHeading(line)) break;
          if (/^#{1,2} /.test(line)) break;
        }

        if (!fence) {
          const m = line.match(/^(`{3,})/);
          if (m) {
            fence = m[1];
            body.push(line);
            i++;
            continue;
          }
        } else if (line.startsWith(fence)) {
          body.push(line);
          i++;
          sawClosedFence = true;
          // Consume only the separator whitespace belonging to this tool.
          // If the next non-empty line is another tool heading, the outer
          // loop will continue the group. If it is ordinary prose, leave it
          // for the normal Markdown renderer.
          while (i < lines.length && !lines[i].trim()) i++;
          break;
        }

        body.push(line);
        i++;
      }

      // Fallback for a tool section without a fenced body: consume until the
      // next tool/heading boundary, as the old parser did.
      if (!sawClosedFence) {
        while (i < lines.length && !isToolHeading(lines[i]) && !/^#{1,2} /.test(lines[i])) {
          if (!lines[i].trim() && i + 1 < lines.length && !lines[i + 1].trim()) break;
          body.push(lines[i++]);
        }
      }

      tools.push({ heading, body });
      while (i < lines.length && !lines[i].trim()) {
        if (i + 1 < lines.length && isToolHeading(lines[i + 1])) { i++; continue; }
        i++;
        break;
      }
      if (i >= lines.length || !isToolHeading(lines[i])) break;
    }

    const inner = tools.map((tool, index) => {
      const summary = escapeHtml(toolLabel(tool.heading));
      const bodyHtml = renderNormalLines(tool.body);
      return `<details class="tool-detail"><summary>${summary}</summary><div class="tool-detail-body">${bodyHtml}</div></details>`;
    }).join('');
    const countLabel = `${tools.length} tool${tools.length === 1 ? '' : 's'}`;
    out.push(`<details class="tool-group"><summary>Claude used ${countLabel}</summary><div class="tool-group-body">${inner}</div></details>`);
  }

  return { __html: out.filter(Boolean).join('\n') };
}

function inlineMarkdown(s) {
  let x=escapeHtml(s);

  // Image/link placeholders are generated HTML containing the raw asset
  // path/URL. That path very often contains underscores (phone photos are
  // named IMG_YYYYMMDD_HHMMSS.jpg) or asterisks. If the emphasis regexes
  // below are allowed to scan that generated HTML too, they mangle the
  // data-md-image/data-md-attachment attribute value (injecting a literal
  // <em>/<strong> tag inside the attribute), which then never matches the
  // unmangled path the asset-resolution code looks for — so the image never
  // renders. Stash each generated placeholder behind an opaque token so the
  // formatting passes below can't see inside it, then restore at the end.
  const stash = [];
  const protect = (html) => { const token = `\u0000${stash.length}\u0000`; stash.push(html); return token; };

  x=x.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => protect(`<span class="md-image-placeholder" data-md-image="${url}">🖼️ ${alt}</span>`));
  x=x.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m,label,url) => {
    const safeUrl = String(url).replace(/\\/g, '/');
    if (/^(?:assets\/|archive\/.*\/assets\/)/.test(safeUrl)) {
      return protect(`<span class="md-attachment-placeholder" data-md-attachment="${safeUrl}">${label}</span>`);
    }
    // Only well-known, non-executable schemes become links; a javascript: or
    // data: URL here would run when the reader clicks the quoted link.
    if (!/^(?:https?:|mailto:|#|\/|\.\.?\/)/i.test(safeUrl)) return protect(label);
    return protect(`<a href="${safeUrl}" target="_blank" rel="noreferrer">${label}</a>`);
  });
  x=x.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/__([^_]+)__/g,'<strong>$1</strong>');
  x=x.replace(/\*([^*]+)\*/g,'<em>$1</em>').replace(/_([^_]+)_/g,'<em>$1</em>');
  x=x.replace(/~~([^~]+)~~/g,'<del>$1</del>');
  x=x.replace(/`([^`]+)`/g,'<code>$1</code>');

  // Markdown blockquotes are a single block when consecutive lines are
  // quoted. The old one-line replacement created a separate <blockquote>
  // for every quoted line, which made Claude's quoted messages look like a
  // stack of unrelated cards. Keep the whole contiguous quote together and
  // only add line breaks inside it.
  x=x.replace(/(^|\n)((?:&gt; ?[^\n]*(?:\n|$))+)/g, (m, prefix, run) => {
    const lines = run.split('\n').filter((line, index, all) => !(index === all.length - 1 && line === ''));
    const quoteHtml = lines.map(line => inlineMarkdown(line.replace(/^&gt; ?/, ''))).join('<br>');
    return `${prefix}<blockquote>${quoteHtml}</blockquote>`;
  });

  x=x.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[Number(i)]);
  return x;
}

function isImageAsset(asset) {
  if (!asset) return false;
  if (/^image\//i.test(String(asset.mime || ''))) return true;
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?)$/i.test(String(asset.name || asset.path || ''));
}

function extractCopyMarkdown(source) {
  const lines = String(source || '').split('\n');
  const kept = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Claude tool sections are implementation details, not part of the
    // assistant's actual answer. Skip each tool heading and its fenced body.
    if (/^### (Claude tool|Tool result): /.test(line)) {
      const end = terminatedToolSectionEnd(lines, i);
      if (end >= 0) {
        i = end + 1;
        while (i < lines.length && !lines[i].trim()) i++;
        continue;
      }
      i++;
      let fence = null;
      let closed = false;
      while (i < lines.length) {
        const current = lines[i];
        if (!fence) {
          const m = current.match(/^\s*(`{3,}|~{3,})/);
          if (m) {
            fence = m[1];
            i++;
            continue;
          }
          if (/^### (Claude tool|Tool result): /.test(current) || /^#{1,2} /.test(current)) break;
          i++;
          continue;
        }
        const marker = fence[0];
        const close = new RegExp(`^\\s*${marker}{${fence.length},}\\s*$`);
        if (close.test(current)) {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      while (i < lines.length && !lines[i].trim()) i++;
      continue;
    }

    // Claude replies store the selected text as a synthetic attachment.
    // Keep the actual answer that follows, but never copy the quoted context.
    if (/^\*\*Attachment: excerpt_from_previous_claude_message\.txt\*\*$/i.test(line)) {
      i++;
      while (i < lines.length && !lines[i].trim()) i++;
      if (i < lines.length && /^\s*(`{3,}|~{3,})/.test(lines[i])) {
        const fence = lines[i].match(/^\s*(`{3,}|~{3,})/)[1];
        const marker = fence[0];
        i++;
        while (i < lines.length) {
          const close = new RegExp(`^\\s*${marker}{${fence.length},}\\s*$`);
          if (close.test(lines[i])) { i++; break; }
          i++;
        }
      }
      continue;
    }

    // Attached files/images are UI attachments, not part of the message
    // text. Strip local Markdown links while leaving normal URLs untouched.
    let cleaned = line
      .replace(/!\[[^\]]*\]\((?!https?:\/\/)[^)]+\)/gi, '')
      .replace(/\[[^\]]+\]\((?:assets\/|archive\/.*\/assets\/)[^)]+\)/gi, '')
      .replace(/\[([^\]]+)\]\((?!https?:\/\/)[^)]+\)/gi, (match, label) => label || '');

    if (cleaned.trim() || (kept.length && kept[kept.length - 1].trim())) kept.push(cleaned);
    i++;
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function Message({ message, assets, assetBusy }) {
  const hasLocalAssets = /!?(?:\[[^\]]*\])\((?!https?:\/\/)[^)]+\)/i.test(String(message.content || ''));
  const [html, setHtml] = useState(renderMarkdown(message.content));
  const [copied, setCopied] = useState(false);

  async function copyMessage() {
    const markdown = extractCopyMarkdown(message.content);
    const renderedHtml = renderMarkdown(markdown).__html;
    try {
      if (navigator.clipboard?.write && window.ClipboardItem) {
        const item = new ClipboardItem({
          'text/plain': new Blob([markdown], { type: 'text/plain' }),
          'text/html': new Blob([renderedHtml], { type: 'text/html' }),
        });
        await navigator.clipboard.write([item]);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(markdown);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = markdown;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }
  useEffect(() => {
    let cancelled=false;
    const run=async()=>{
      let rendered=renderMarkdown(message.content).__html;
      // Take paths from the placeholders the renderer produced, so every link
      // Marked parsed (including labels with escaped brackets) is resolved.
      const placeholders=assetPlaceholderPaths(rendered);
      if(!placeholders.length) return;
      for(const {path, attribute} of placeholders){
        const cleanPath=decodeURIComponent(String(path||'')).replace(/^\.\//,'').split('#')[0].split('?')[0];
        const asset=assets[path] || assets[cleanPath] || assets[cleanPath.split('/').pop()] || assets[cleanPath.split('/').pop().toLowerCase()];
        const escapedPath=attribute.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        if(asset?.dataUrl && isImageAsset(asset)){
          rendered=rendered.replace(new RegExp(`<span class=\"md-image-placeholder\" data-md-image=\"${escapedPath}\">[^<]*</span>`, 'g'), `<img class=\"md-image\" src=\"${asset.dataUrl}\" alt=\"${escapeHtml(asset.name)}\" />`);
        }
        if(asset){
          const href=asset.htmlUrl || asset.downloadUrl || '#';
          const name=escapeHtml(asset.name);
          if(isImageAsset(asset)) {
            const imageHtml=`<a class="md-image-link" href="${href}" target="_blank" rel="noreferrer"><img class="md-image" src="${asset.dataUrl}" alt="${name}" loading="lazy" /></a>`;
            rendered=rendered.replace(new RegExp(`<span class="md-attachment-placeholder" data-md-attachment="${escapedPath}">[^<]*</span>`, 'g'), imageHtml);
          } else {
            const type=escapeHtml((asset.mime || 'file').replace(/^application\//,'').replace(/^text\//,''));
            const card=`<a class="md-attachment-card" href="${href}" target="_blank" rel="noreferrer"><span class="attachment-icon">↗</span><span class="attachment-info"><strong>${name}</strong><small>${type}</small></span></a>`;
            rendered=rendered.replace(new RegExp(`<span class="md-attachment-placeholder" data-md-attachment="${escapedPath}">[^<]*</span>`, 'g'), card);
          }
        }
      }
      if(!cancelled) setHtml({__html:rendered});
    }; run(); return()=>{cancelled=true};
  },[message.content,assets]);
  const roleLabel = message.role === 'user' ? 'You' : message.roleName || 'Assistant';
  const messageClass = `message ${message.role}`;
  const role = <div className="role">{roleLabel}</div>;
  const copyButton = <div className="message-actions"><button className="copy-message" type="button" onClick={copyMessage} title="Copy message" aria-label="Copy message">{copied ? '✓ Copied' : 'Copy'}</button></div>;
  if (assetBusy && hasLocalAssets) {
    return <article className={messageClass}>{role}<div className="content asset-loading"><div className="asset-skeleton" aria-label="Loading attachments"></div></div>{copyButton}</article>;
  }
  return <article className={messageClass}>{role}<div className="content" dangerouslySetInnerHTML={html}/>{copyButton}</article>;
}

function Reader({ settings, selected, conversation, onBack, sidebar }) {
  const [assets,setAssets]=useState({});
  const [assetBusy,setAssetBusy]=useState(false);
  const [findQuery,setFindQuery]=useState('');
  const [findIndex,setFindIndex]=useState(0);
  const [findTotal,setFindTotal]=useState(0);
  const bodyRef=useRef(null);
  const findInputRef=useRef(null);
  const marksRef=useRef([]);

  function clearFindMarks() {
    const root = bodyRef.current;
    if (!root) return;
    root.querySelectorAll('mark.conversation-find-match').forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
      parent.normalize();
    });
    marksRef.current=[];
    setFindTotal(0);
  }

  useEffect(() => {
    clearFindMarks();
    const query=findQuery.trim();
    const root=bodyRef.current;
    if (!root || !query) { setFindIndex(0); setFindTotal(0); return; }
    const lower=query.toLocaleLowerCase();
    const walker=document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent=node.parentElement;
        if (!parent || parent.closest('script,style,mark')) return NodeFilter.FILTER_REJECT;
        return node.nodeValue && node.nodeValue.toLocaleLowerCase().includes(lower)
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const nodes=[];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const marks=[];
    for (const node of nodes) {
      const text=node.nodeValue || '';
      const frag=document.createDocumentFragment();
      let pos=0;
      const haystack=text.toLocaleLowerCase();
      while (pos<text.length) {
        const hit=haystack.indexOf(lower,pos);
        if (hit===-1) { frag.appendChild(document.createTextNode(text.slice(pos))); break; }
        if (hit>pos) frag.appendChild(document.createTextNode(text.slice(pos,hit)));
        const mark=document.createElement('mark');
        mark.className='conversation-find-match';
        mark.textContent=text.slice(hit,hit+query.length);
        frag.appendChild(mark); marks.push(mark);
        pos=hit+query.length;
      }
      node.parentNode?.replaceChild(frag,node);
    }
    marksRef.current=marks;
    setFindTotal(marks.length);
    setFindIndex(prev => marks.length ? Math.min(prev,marks.length-1) : 0);
  },[findQuery,conversation,assets]);

  useEffect(()=>{
    let dead=false;
    const rawPaths=[];
    for(const m of conversation.messages||[]) {
      const text=String(m.content||'');
      for(const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)|\[[^\]]+\]\(([^)]+)\)/g)) {
        const path=match[1]||match[2];
        if(path && !/^https?:\/\//i.test(path)) rawPaths.push(path);
      }
    }
    for(const a of (selected.assets||[])) if(a?.path) rawPaths.push(a.path);
    const unique=[...new Set(rawPaths)];
    if(!unique.length){setAssets({});setAssetBusy(false);return;}
    setAssetBusy(true);
    const baseDir=selected.path.includes('/')?selected.path.slice(0,selected.path.lastIndexOf('/')):'';
    const normalizePath=value=>{
      let clean=decodeURIComponent(String(value||'')).trim().replace(/\\/g,'/').split('#')[0].split('?')[0];
      clean=clean.replace(/^\.\//,'').replace(/^\//,'');
      const parts=[];
      for(const part of clean.split('/')){ if(!part||part==='.') continue; if(part==='..') parts.pop(); else parts.push(part); }
      return parts.join('/');
    };
    const candidates=raw=>{
      const clean=normalizePath(raw);
      const out=[clean];
      if(baseDir){ const base=normalizePath(baseDir); if(!clean.startsWith(base+'/')) out.push(`${base}/${clean}`); }
      return [...new Set(out)];
    };
    // At most four assets in flight: each image costs two GitHub API calls.
    mapWithConcurrency(unique, 4, async raw=>{
      for(const candidate of candidates(raw)){
        try{
          const metadata=(selected.assets||[]).find(item=>item?.path===candidate) || null;
          const asset=await readAsset(settings,candidate,metadata);
          return {raw, candidate, asset};
        }catch{}
      }
      return {raw, candidate:null, asset:null};
    })
      .then(xs=>{
        if(dead)return;
        const map={};
        for(const x of xs){
          if(!x.asset)continue;
          map[x.raw]=x.asset;
          if(x.candidate)map[x.candidate]=x.asset;
          const rawClean=String(x.raw).replace(/^\.\//,'');
          map[`./${rawClean}`]=x.asset;
          const basename=rawClean.split('/').pop();
          map[basename]=x.asset;
          map[basename.toLowerCase()]=x.asset;
          map[String(x.asset.name)]=x.asset;
          map[String(x.asset.name).toLowerCase()]=x.asset;
          if(x.candidate) map[String(x.candidate).replace(/^\.\//,'')]=x.asset;
        }
        for(const a of (selected.assets||[])){
          if(a?.path && map[a.path]) map[a.path]=map[a.path];
        }
        setAssets(map);
      })
      .finally(()=>{if(!dead)setAssetBusy(false);});
    return()=>{dead=true};
  },[settings,selected,conversation]);
  useEffect(() => {
    const marks=marksRef.current;
    marks.forEach((mark,i)=>mark.classList.toggle('current',i===findIndex));
    if (marks[findIndex]) marks[findIndex].scrollIntoView({block:'center',behavior:'smooth'});
  },[findIndex]);

  useEffect(()=>{
    const onKeyDown=(e)=>{
      if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='f'){
        e.preventDefault();
        findInputRef.current?.focus();
        findInputRef.current?.select();
      }
    };
    window.addEventListener('keydown',onKeyDown);
    return()=>window.removeEventListener('keydown',onKeyDown);
  },[]);

  function cycleFind(direction=1) {
    const total=marksRef.current.length;
    if (!total) return;
    setFindIndex(current => (current + direction + total) % total);
  }

  function handleFindKeyDown(e) {
    if (e.key==='Enter') { e.preventDefault(); cycleFind(e.shiftKey ? -1 : 1); }
    if (e.key==='Escape') { e.preventDefault(); setFindQuery(''); }
  }

  const findCount=findTotal;
  const date=conversation.updated_at?new Date(conversation.updated_at).toLocaleString():'';
  return <div className="reader-shell">{sidebar}<main className="reader-main">
    <div className="reader-sticky-header"><button className="back" onClick={onBack}>← Back</button><div className="reader-find"><input ref={findInputRef} className="search reader-search" placeholder="Search in conversation…" aria-label="Search in conversation" value={findQuery} onChange={e=>{setFindQuery(e.target.value);setFindIndex(0)}} onKeyDown={handleFindKeyDown}/>{findQuery.trim()&&<div className="reader-find-controls"><span className="reader-find-count">{findCount ? `${Math.min(findIndex+1,findCount)} / ${findCount}` : 'No results'}</span><button className="reader-find-button" type="button" onClick={()=>cycleFind(-1)} disabled={!findCount} aria-label="Previous result" title="Previous result">↑</button><button className="reader-find-button" type="button" onClick={()=>cycleFind(1)} disabled={!findCount} aria-label="Next result" title="Next result">↓</button></div>}</div><div className="reader-header-actions"><a className="github-link" href={`https://github.com/${settings.owner}/${settings.repo}/blob/main/${selected.path}`} target="_blank" rel="noreferrer">Open on GitHub ↗</a></div></div>
    <div className="reader"><div className="reader-head"><div className="pills"><div className="pill">{conversation.provider}</div><div className="pill">{conversation.account||'personal'}</div></div><h2>{conversation.title}</h2><div className="meta">{conversation.model||'model unknown'}{date?` · ${date}`:''}{assetBusy?' · loading attachments…':''}</div></div><div className="conversation-body" ref={bodyRef}>{conversation.messages.map((m,i)=><Message key={i} message={m} assets={assets} assetBusy={assetBusy}/>)}</div></div>
  </main></div>;
}

function App() {
  const [theme,setTheme]=useState(()=>({current:'slate', black:'black', light:'light'}[localStorage.getItem('ai_archive_theme')] || localStorage.getItem('ai_archive_theme') || 'slate')); const [settings,setSettings]=useState(getSaved()); const [index,setIndex]=useState(null); const [selected,setSelected]=useState(null); const [conversation,setConversation]=useState(null); const [search,setSearch]=useState(''); const [provider,setProvider]=useState('all'); const [account,setAccount]=useState('all'); const [loading,setLoading]=useState(false); const [error,setError]=useState('');
  useEffect(()=>{document.documentElement.dataset.theme=theme;localStorage.setItem('ai_archive_theme',theme)},[theme]);
  async function load(){if(!settings)return;setLoading(true);setError('');try{setIndex(await readIndex(settings));}catch(e){setError(e.message)}finally{setLoading(false)}}
  useEffect(()=>{load()},[settings]);
  const providers=useMemo(()=>[...new Set((index?.conversations||[]).map(x=>x.provider))].sort(),[index]);
  const accounts=useMemo(()=>[...new Set((index?.conversations||[]).filter(x=>provider==='all'||x.provider===provider).map(x=>x.account||'personal'))].sort(),[index,provider]);
  const items=useMemo(()=>{let xs=index?.conversations||[];if(provider!=='all')xs=xs.filter(x=>x.provider===provider);if(account!=='all')xs=xs.filter(x=>(x.account||'personal')===account);const q=search.trim().toLowerCase();if(q)xs=xs.filter(x=>`${x.title}\n${x.search_text||''}`.toLowerCase().includes(q));return xs},[index,provider,account,search]);
  async function open(c){setError('');try{setSelected(c);setConversation(await readConversation(settings,c.path));}catch(e){setSelected(null);setError(e.message)}}
  function disconnect(){localStorage.removeItem(KEY);setSettings(null);setSelected(null);setConversation(null)}
  const goList=(nextProvider=provider,nextAccount=account)=>{setProvider(nextProvider);setAccount(nextAccount);setSelected(null);setConversation(null);};
  const sidebar=<aside className="sidebar"><div className="sidebar-top"><div className="brand"><span className="brand-mark">AI</span><div><strong>AI Archive</strong><small>{settings?.owner}/{settings?.repo}</small></div></div><button className={provider==='all'?'nav active':'nav'} onClick={()=>goList('all','all')}>All conversations <span>{index?.conversations?.length||0}</span></button>{providers.map(p=><button key={p} className={provider===p?'nav active':'nav'} onClick={()=>goList(p,'all')}>{p[0].toUpperCase()+p.slice(1)}</button>)}<div className="section-label">Accounts</div><div className="account-list"><button className={account==='all'?'nav active':'nav'} onClick={()=>goList(provider,'all')}>All accounts</button>{accounts.map(a=><button key={a} className={account===a?'nav active':'nav'} onClick={()=>goList(provider,a)}>{a}</button>)}</div></div><div className="sidebar-bottom"><button className="nav theme-nav" onClick={()=>setTheme(theme==='black'?'slate':theme==='slate'?'light':'black')}>◐ Theme <span>{theme==='black'?'Black':theme==='slate'?'Slate':'Light'}</span></button><button className="nav" onClick={load}>↻ Refresh</button><button className="nav" onClick={disconnect}>Disconnect</button></div></aside>;
  if(!settings)return <Settings onSave={s=>{localStorage.setItem(KEY,JSON.stringify(s));setSettings(s)}}/>;
  if(selected&&conversation)return <Reader settings={settings} selected={selected} conversation={conversation} onBack={()=>{setSelected(null);setConversation(null)}} sidebar={sidebar}/>;
  return <div className="app">{sidebar}<main><header><div><h1>{provider==='all'?'All conversations':provider[0].toUpperCase()+provider.slice(1)}</h1><p>{items.length} conversation{items.length===1?'':'s'}</p></div><input className="search" placeholder="Search every conversation…" value={search} onChange={e=>setSearch(e.target.value)}/></header>{error&&<div className="error banner">{error}</div>}<div className="list">{loading?<div className="loading">Loading archive…</div>:items.map(c=><button className="conversation" key={`${c.provider}:${c.account}:${c.id}`} onClick={()=>open(c)}><div className="conv-main"><strong>{c.title}</strong><div className="meta">{c.provider} · {c.account||'personal'} · {c.message_count||0} messages</div>{c.preview&&<div className="preview">{c.preview.replace(/\s+/g,' ').slice(0,160)}</div>}</div><div className="conv-side"><time>{c.updated_at?new Date(c.updated_at).toLocaleDateString():''}</time>{c.assets?.length?<span className="asset-count">{c.assets.length} attachment{c.assets.length===1?'':'s'}</span>:null}</div></button>)}{!loading&&!items.length&&<div className="empty">No matching conversations.</div>}</div></main></div>;
}

createRoot(document.getElementById('root')).render(<App/>);
