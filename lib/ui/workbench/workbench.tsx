"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { COMPONENTS, DRAFT_KEY, exportTokens, safeTokenValue, sanitizeDrafts, type ComponentId, type Drafts, type TokenDefaults } from "./catalog";

const DRAFT_EVENT = "loom-workbench:drafts";
let memoryDrafts: string | null = null;
let useMemoryDrafts = false;
const readDraftSnapshot = () => {
  if (useMemoryDrafts) return memoryDrafts;
  try { return localStorage.getItem(DRAFT_KEY); } catch { return memoryDrafts; }
};
const subscribeToDrafts = (notify: () => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener(DRAFT_EVENT, notify);
  return () => { window.removeEventListener("storage", notify); window.removeEventListener(DRAFT_EVENT, notify); };
};

export function ComponentWorkbench({ defaults }: { defaults: TokenDefaults }) {
  const [selected, setSelected] = useState<ComponentId>("logo");
  const stored = useSyncExternalStore(subscribeToDrafts, readDraftSnapshot, () => null);
  const drafts = useMemo(() => {
    try { return sanitizeDrafts(JSON.parse(stored ?? "{}"), defaults); } catch { return {}; }
  }, [stored, defaults]);
  const [viewport, setViewport] = useState("960");
  const [availableWidth, setAvailableWidth] = useState(960);
  const tray = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const spec = COMPONENTS.find(c => c.id === selected)!;
  const patch = drafts[selected] ?? {};
  const latest = useRef(patch);
  useEffect(() => {
    if (!tray.current) return;
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width));
    observer.observe(tray.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { latest.current = drafts[selected] ?? {}; }, [drafts, selected]);
  const setDrafts = (update: (current: Drafts) => Drafts) => {
    const next = JSON.stringify(update(drafts));
    memoryDrafts = next;
    try { localStorage.setItem(DRAFT_KEY, next); useMemoryDrafts = false; }
    catch { useMemoryDrafts = true; setStatus("Draft storage unavailable; export your changes before leaving."); }
    window.dispatchEvent(new Event(DRAFT_EVENT));
  };

  const sync = () => frame.current?.contentWindow?.postMessage({ type: "loom-workbench:tokens", patch: latest.current }, window.location.origin);
  useEffect(() => {
    const ready = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.source === frame.current?.contentWindow && event.data?.type === "loom-workbench:ready") sync();
    };
    window.addEventListener("message", ready);
    return () => window.removeEventListener("message", ready);
  }, []);
  useEffect(() => { sync(); }, [drafts, selected]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([exportTokens(selected, patch)], { type: "text/css" }));
    const link = document.createElement("a");
    link.href = url; link.download = `digital-loom-${selected}.css`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("CSS exported. Apply reviewed values to room-tokens.css to change the app.");
  };
  const relevant = Object.entries(defaults).filter(([key]) => {
    const group = key.replace("--room-", "").split("-")[0];
    return (spec.groups as readonly string[]).includes(group) && key.includes(search);
  }).sort(([a], [b]) => (spec.groups as readonly string[]).indexOf(a.replace("--room-", "").split("-")[0]) - (spec.groups as readonly string[]).indexOf(b.replace("--room-", "").split("-")[0]));
  const frameWidth = viewport === "fit" ? availableWidth : Number(viewport);
  const scale = Math.min(1, availableWidth / frameWidth);

  return <main className="component-workbench">
    <header className="workbench-header">
      <div><p className="workbench-eyebrow">digital loom / component workbench</p><h1>One piece at a time.</h1></div>
      <Link href="/" prefetch={false}>back to room ↗</Link>
    </header>
    <div className="workbench-layout">
      <nav className="workbench-index" aria-label="Components">
        {COMPONENTS.map(c => <button key={c.id} type="button" aria-current={selected === c.id ? "page" : undefined} onClick={() => { setSelected(c.id); setSearch(""); setStatus(""); }}>
          {c.label}<span>{Object.keys(drafts[c.id] ?? {}).length || ""}</span>
        </button>)}
        <p>Real UI components. No cloth renderer, paid extraction, or material-library writes.</p>
      </nav>
      <section className="workbench-preview" aria-label="Component preview">
        <div className="workbench-preview-heading"><div><h2>{spec.label}</h2><code>{spec.source}</code></div>
          <select aria-label="Preview width" value={viewport} onChange={e => setViewport(e.target.value)}><option value="960">desktop · 960px</option><option value="390">mobile · 390px</option><option value="fit">available width</option></select>
        </div>
        <p>{spec.note}</p>
        <div ref={tray} className="workbench-frame-tray">
          <div style={{ width: frameWidth * scale, height: 720 * scale, margin: "auto" }}>
            <iframe ref={frame} key={`${selected}-${revision}`} title={`${spec.label} live preview`} src={`/room/components/preview?component=${selected}`} onLoad={sync} style={{ width: frameWidth, height: 720, transform: `scale(${scale})`, transformOrigin: "top left" }} />
          </div>
        </div>
        <p className="workbench-preview-scale">{Math.round(frameWidth)}px viewport · {Math.round(scale * 100)}% display scale. Component breakpoints use the viewport width.</p>
        <button type="button" onClick={() => setRevision(r => r + 1)}>reset interaction state</button>
      </section>
      <aside className="workbench-inspector" aria-label="Token inspector">
        <h2>Specimen tokens</h2><p>Changes affect this specimen only. Drafts stay on this device; the room and source files are unchanged.</p>
        <label>find a token<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="glass, type, size…" /></label>
        <div className="workbench-token-list">{relevant.map(([name, fallback]) => <label key={`${selected}-${name}`}>
          <span>{name.replace("--room-", "")}{Object.hasOwn(patch, name) ? " •" : ""}</span>
          <input aria-label={name} value={patch[name] ?? fallback} spellCheck={false} onChange={e => {
            const value = e.target.value;
            setDrafts(current => {
              const next = { ...current[selected] };
              if (value === fallback || !value) delete next[name]; else if (safeTokenValue(value)) next[name] = value;
              return { ...current, [selected]: next };
            });
          }} />
        </label>)}</div>
        <div className="workbench-actions"><button type="button" onClick={() => setDrafts(current => ({ ...current, [selected]: {} }))}>reset tokens</button><button type="button" disabled={!Object.keys(patch).length} onClick={download}>export CSS ↓</button></div>
        <p role="status">{status}</p>
      </aside>
    </div>
  </main>;
}
