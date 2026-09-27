import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { readConversation, readIndex, readAsset, githubRequest } from './github';
import hljs from 'highlight.js/lib/common';
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
function highlightCode(source, language='') {
  const text = String(source);
  const lang = String(language).toLowerCase().replace(/^language-/, '').trim();
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(text).value;
  } catch {
    return escapeHtml(text);
  }
}

function renderMarkdown(text) {
  const source = String(text || '');
  const lines = source.split('\n');
  const out = [];
  let i = 0;

  function renderNormalLines(blockLines) {
    const html = [];
    let j = 0;
    while (j < blockLines.length) {
      const line = blockLines[j];

      // Claude represents a reply-to-selected-text as an attachment named
      // excerpt_from_previous_claude_message.txt followed by the quoted text.
      // Render that as a proper reply context card instead of exposing the
      // implementation detail as a file/code block.
      const replyMatch = line.match(/^\*\*Attachment: (excerpt_from_previous_claude_message\.txt)\*\*$/i);
      if (replyMatch && j + 1 < blockLines.length && /^```/.test(blockLines[j + 1])) {
        const fenceLine = blockLines[j + 1];
        const fence = fenceLine.match(/^(`{3,})/)?.[1] || '```';
        const quote = [];
        let k = j + 2;
        while (k < blockLines.length && !blockLines[k].startsWith(fence)) { quote.push(blockLines[k]); k++; }
        if (k < blockLines.length) k++;
        html.push(`<div class=\"reply-context\"><div class=\"reply-context-label\">↩ Replying to Claude</div><blockquote class=\"reply-context-quote\">${inlineMarkdown(quote.join('\n')).replace(/\n/g,'<br>')}</blockquote></div>`);
        j = k;
        while (j < blockLines.length && !blockLines[j].trim()) j++;
        continue;
      }

      if (/^```/.test(line) || /^`{3,}/.test(line)) {
        const fence = line.match(/^(`{3,})/)?.[1] || '```';
        const lang = line.slice(fence.length).trim(); const buf = []; j++;
        while (j < blockLines.length && !blockLines[j].startsWith(fence)) { buf.push(blockLines[j]); j++; }
        if (j < blockLines.length) j++;
        html.push(`<div class="code-block"><pre><code class="language-${escapeHtml(lang)}">${highlightCode(buf.join('\n'), lang)}</code></pre></div>`); continue;
      }
      if (/^#{1,3} /.test(line)) { const m=line.match(/^(#{1,3}) (.*)$/); html.push(`<h${m[1].length}>${inlineMarkdown(m[2])}</h${m[1].length}>`); j++; continue; }
      if (/^[-*] /.test(line)) { const items=[]; while(j<blockLines.length && /^[-*] /.test(blockLines[j])) { items.push(`<li>${inlineMarkdown(blockLines[j].slice(2))}</li>`); j++; } html.push(`<ul>${items.join('')}</ul>`); continue; }
      if (!line.trim()) { j++; continue; }
      const para=[line]; j++; while(j<blockLines.length && blockLines[j].trim() && !/^#{1,3} |^[-*] |^```/.test(blockLines[j])) { para.push(blockLines[j]); j++; }
      html.push(`<p>${inlineMarkdown(para.join('\n')).replace(/\n/g,'<br>')}</p>`);
    }
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

      // Tool sections produced by the archive exporter normally contain one
      // fenced block (the command/input or the tool result).  The important
      // distinction here is that a normal assistant response can follow the
      // tool result in the SAME message.  The old parser consumed that prose
      // as part of the final tool, which made the real Claude response appear
      // to be hidden inside the collapsed tool group.
      while (i < lines.length) {
        const line = lines[i];

        if (isToolHeading(line)) break;
        if (/^#{1,2} /.test(line)) break;

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
  x=x.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<span class="md-image-placeholder" data-md-image="$2">🖼️ $1</span>');
  x=x.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m,label,url) => {
    const safeUrl = String(url).replace(/\\/g, '/');
    if (/^(?:assets\/|archive\/.*\/assets\/)/.test(safeUrl)) {
      return `<span class="md-attachment-placeholder" data-md-attachment="${escapeHtml(safeUrl)}">${escapeHtml(label)}</span>`;
    }
    return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  x=x.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/__([^_]+)__/g,'<strong>$1</strong>');
  x=x.replace(/\*([^*]+)\*/g,'<em>$1</em>').replace(/_([^_]+)_/g,'<em>$1</em>');
  x=x.replace(/~~([^~]+)~~/g,'<del>$1</del>');
  x=x.replace(/`([^`]+)`/g,'<code>$1</code>');
  x=x.replace(/^&gt; (.*)$/gm,'<blockquote>$1</blockquote>');
  return x;
}

function isImageAsset(asset) {
  if (!asset) return false;
  if (/^image\//i.test(String(asset.mime || ''))) return true;
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?)$/i.test(String(asset.name || asset.path || ''));
}

function Message({ message, assets, assetBusy }) {
  const hasLocalAssets = /!?(?:\[[^\]]*\])\((?!https?:\/\/)[^)]+\)/i.test(String(message.content || ''));
  const [html, setHtml] = useState(renderMarkdown(message.content));
  useEffect(() => {
    let cancelled=false;
    const run=async()=>{
      const imageMatches=[...String(message.content).matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m=>m[1]);
      const attachmentMatches=[...String(message.content).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(m=>m[1]);
      const unique=[...new Set([...imageMatches, ...attachmentMatches])];
      if(!unique.length) return;
      let rendered=renderMarkdown(message.content).__html;
      for(const path of unique){
        const cleanPath=decodeURIComponent(String(path||'')).replace(/^\.\//,'').split('#')[0].split('?')[0];
        const asset=assets[path] || assets[cleanPath] || assets[cleanPath.split('/').pop()] || assets[cleanPath.split('/').pop().toLowerCase()];
        const escapedPath=path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
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
  if (assetBusy && hasLocalAssets) {
    return <article className={`message ${message.role}`}><div className="role">{message.role === 'user' ? 'You' : message.roleName || 'Assistant'}</div><div className="content asset-loading"><div className="asset-skeleton" aria-label="Loading attachments"></div></div></article>;
  }
  return <article className={`message ${message.role}`}><div className="role">{message.role === 'user' ? 'You' : message.roleName || 'Assistant'}</div><div className="content" dangerouslySetInnerHTML={html}/></article>;
}

function Reader({ settings, selected, conversation, onBack, search, onSearchChange, sidebar }) {
  const [assets,setAssets]=useState({});
  const [assetBusy,setAssetBusy]=useState(false);
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
    Promise.all(unique.map(async raw=>{
      for(const candidate of candidates(raw)){
        try{
          const asset=await readAsset(settings,candidate);
          return {raw, candidate, asset};
        }catch{}
      }
      return {raw, candidate:null, asset:null};
    }))
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
  const date=conversation.updated_at?new Date(conversation.updated_at).toLocaleString():'';
  return <div className="reader-shell">{sidebar}<main className="reader-main">
    <div className="reader-sticky-header"><button className="back" onClick={onBack}>← Back</button><input className="search reader-search" placeholder="Search every conversation…" value={search} onChange={e=>onSearchChange(e.target.value)}/><a className="github-link" href={`https://github.com/${settings.owner}/${settings.repo}/blob/main/${selected.path}`} target="_blank" rel="noreferrer">Open on GitHub ↗</a></div>
    <div className="reader"><div className="reader-head"><div className="pills"><div className="pill">{conversation.provider}</div><div className="pill">{conversation.account||'personal'}</div></div><h2>{conversation.title}</h2><div className="meta">{conversation.model||'model unknown'}{date?` · ${date}`:''}{assetBusy?' · loading attachments…':''}</div></div><div className="conversation-body">{conversation.messages.map((m,i)=><Message key={i} message={m} assets={assets} assetBusy={assetBusy}/>)}</div></div>
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
  if(selected&&conversation)return <Reader settings={settings} selected={selected} conversation={conversation} onBack={()=>{setSelected(null);setConversation(null)}} search={search} onSearchChange={setSearch} sidebar={sidebar}/>;
  return <div className="app">{sidebar}<main><header><div><h1>{provider==='all'?'All conversations':provider[0].toUpperCase()+provider.slice(1)}</h1><p>{items.length} conversation{items.length===1?'':'s'}</p></div><input className="search" placeholder="Search every conversation…" value={search} onChange={e=>setSearch(e.target.value)}/></header>{error&&<div className="error banner">{error}</div>}<div className="list">{loading?<div className="loading">Loading archive…</div>:items.map(c=><button className="conversation" key={`${c.provider}:${c.account}:${c.id}`} onClick={()=>open(c)}><div className="conv-main"><strong>{c.title}</strong><div className="meta">{c.provider} · {c.account||'personal'} · {c.message_count||0} messages</div>{c.preview&&<div className="preview">{c.preview.replace(/\s+/g,' ').slice(0,160)}</div>}</div><div className="conv-side"><time>{c.updated_at?new Date(c.updated_at).toLocaleDateString():''}</time>{c.assets?.length?<span className="asset-count">{c.assets.length} attachment{c.assets.length===1?'':'s'}</span>:null}</div></button>)}{!loading&&!items.length&&<div className="empty">No matching conversations.</div>}</div></main></div>;
}

createRoot(document.getElementById('root')).render(<App/>);
