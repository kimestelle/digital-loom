"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { NavBar, type StageMode } from "../navBar";
import { RoomLightModal } from "../roomLightModal";
import { DEFAULT_ROOM_LIGHT_SETTINGS, resolveRoomLight, type RoomLightSettings } from "../roomLight";
import { MaterialCabinet, type MaterialCabinetFace } from "../materialCabinet";
import { MaterialEditShelf } from "../materialEditShelf";
import { DEFAULT_FABRIC_KNOBS, type FabricKnobs } from "../knobs";
import { createMaterialDraft, materialDraftReducer, isMaterialDraftDirty, canUndoMaterialDraft, canRedoMaterialDraft, selectedMaterialDraft } from "../materialDraftHistory";
import { Slider, IntSlider, SectionLabel, InfoDot, PanelHeader } from "../panelPrimitives";
import { InstrumentPad } from "../instrumentPad";
import { PixelPlay } from "../pixelPlay";
import { WeaveDiagram } from "../weaveDiagram";
import type { WeaveType } from "@/lib/cloth/fabricCore";
import { SampleGrid, LibraryGrid, useSwatchDrag, type SwatchItem } from "../materialSwatches";
import { MapsStrip } from "../mapsStrip";
import { InsertPanel } from "../insertPanel";
import { SaveStatus, type SaveStatusKind } from "../saveStatus";
import { safeTokenValue, type ComponentId } from "./catalog";
import { RoomSunlightStudy } from "./roomSunlightStudy";

const MAPS = (["albedo", "normal", "roughness", "height"] as const).map(name => ({ name, url: `/pregen/silk-sample/${name}.png` }));
const SAMPLES: SwatchItem[] = [
  { id: "silk", label: "red silk", thumb: MAPS[0].url },
  { id: "blank", label: "empty specimen" },
];

function Swatches() {
  const drag = useSwatchDrag();
  const [items, setItems] = useState<SwatchItem[]>([]);
  const [selected, setSelected] = useState<string | null>("silk");
  const clone = (id: string) => {
    const item = [...SAMPLES, ...items].find(i => i.id === id);
    if (item) setItems(list => [...list, { ...item, id: crypto.randomUUID(), label: `${item.label} copy`, deletable: true }]);
  };
  return <div className="cabinet-pane cabinet-pane--archive">
    <header className="cabinet-pane__header"><div><p className="cabinet-pane__kicker">swatch archive</p><p className="cabinet-pane__lede">Disposable samples and library.</p></div></header>
    <SampleGrid items={SAMPLES} activeId={selected} drag={drag} onSelect={setSelected} onClone={clone} />
    <LibraryGrid items={items} activeId={selected} drag={drag} onSelect={setSelected} onClone={clone}
      onDelete={id => setItems(list => list.filter(item => item.id !== id))}
      onRename={(id, label) => setItems(list => list.map(item => item.id === id ? { ...item, label } : item))}
      onReorder={(id, before) => setItems(list => {
        const item = list.find(i => i.id === id); if (!item || id === before) return list;
        const rest = list.filter(i => i.id !== id); const index = rest.findIndex(i => i.id === before);
        rest.splice(index < 0 ? rest.length : index, 0, item); return rest;
      })} />
  </div>;
}

function Fields() {
  const [behavior, setBehavior] = useState({ x: 0.3, y: 0.6 });
  const [surface, setSurface] = useState({ x: 0.7, y: 0.4 });
  return <><div className="instrument-pad-grid">
    <InstrumentPad label="behavior" {...behavior} xLow="fluid" xHigh="crisp" yLow="airy" yHigh="grounded" onChange={(x, y) => setBehavior({ x, y })} />
    <InstrumentPad label="surface" {...surface} xLow="matte" xHigh="lustrous" yLow="smooth" yHigh="deep" onChange={(x, y) => setSurface({ x, y })} />
  </div><output className="workbench-readout">committed behavior {behavior.x.toFixed(2)} / {behavior.y.toFixed(2)} · surface {surface.x.toFixed(2)} / {surface.y.toFixed(2)}</output></>;
}

function Sliders() {
  const [value, setValue] = useState(0.45);
  const [count, setCount] = useState(6);
  const [commit, setCommit] = useState(0.45);
  return <><SectionLabel hint="Native range inputs, not simulated sliders.">measurements</SectionLabel>
    <Slider label="roughness" value={value} onChange={setValue} onChangeEnd={setCommit} hint="Drag or use arrow keys. The committed readout updates at the end of the gesture." />
    <IntSlider label="iterations" value={count} onChange={setCount} min={1} max={12} />
    <output className="workbench-readout">last committed roughness {commit.toFixed(2)}</output></>;
}

function MaterialChanges() {
  const [viewingSavedSwatch, setViewingSavedSwatch] = useState(false);
  const [history, dispatch] = useReducer(materialDraftReducer, DEFAULT_FABRIC_KNOBS, createMaterialDraft);
  const [face, setFace] = useState<MaterialCabinetFace>("material");
  const [previewSheen, setPreviewSheen] = useState<number | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [selected, setSelected] = useState("silk");
  const [copies, setCopies] = useState<(SwatchItem & { knobs: FabricKnobs })[]>([]);
  const materialRef = useRef<HTMLElement | null>(null);
  const drag = useSwatchDrag();
  const displayed = selectedMaterialDraft(history);
  const materialName = copies.find(copy => copy.id === selected)?.label ?? "red silk";
  const focusMaterial = () => materialRef.current?.querySelector<HTMLInputElement>("input[type=range]")?.focus();
  const save = () => {
    const name = `red silk · ${copies.length + 1}`;
    const id = crypto.randomUUID();
    setCopies(items => [...items, { id, label: name, thumb: MAPS[0].url, knobs: { ...history.current } }]);
    setSelected(id);
    setSavedName(name);
    dispatch({ type: "keep" });
    focusMaterial();
  };

  return <main className="workbench-preview-document"><div className="workbench-cabinet-slot">
    <MaterialCabinet
      face={face}
      onFlip={next => { setViewingSavedSwatch(false); setFace(next); }}
      onFaceSettled={next => {
        if (next === "archive" && viewingSavedSwatch) {
          setViewingSavedSwatch(false);
          setSavedName(null);
        }
      }}
      materialFaceRef={materialRef}
      materialFace={<div className="cabinet-pane cabinet-pane--material">
        <header className="cabinet-pane__header cabinet-material-header"><div><p className="cabinet-pane__kicker">material dossier</p><h2>{materialName}</h2><p className="cabinet-pane__lede">Adjust sheen, then use the shelf below. No cloth renderer or device archive is loaded.</p></div></header>
        <SectionLabel>surface</SectionLabel>
        <Slider label="sheen" value={previewSheen ?? displayed.sheen} onChange={setPreviewSheen} onChangeEnd={sheen => {
          dispatch({ type: "commit", knobs: { ...history.current, sheen } });
          setPreviewSheen(null);
          setSavedName(null);
        }} hint="One completed gesture is one undo step. Compare changes only the displayed value." />
        <output className="workbench-readout">showing {history.comparison === "baseline" ? "original" : "edited"} sheen {displayed.sheen.toFixed(2)} · original {history.baseline.sheen.toFixed(2)}</output>
      </div>}
      archiveFace={<div className="cabinet-pane cabinet-pane--archive">
        <header className="cabinet-pane__header"><div><p className="cabinet-pane__kicker">swatch archive</p><p className="cabinet-pane__lede">Saved copies exist only in this preview. Reset state clears them.</p></div></header>
        <SampleGrid items={[SAMPLES[0], ...copies]} activeId={selected} drag={drag} onSelect={id => {
          dispatch({ type: "keep", knobs: copies.find(copy => copy.id === id)?.knobs ?? DEFAULT_FABRIC_KNOBS });
          setSelected(id);
          setSavedName(null);
          setPreviewSheen(null);
          setFace("material");
        }} onClone={id => {
          const original = copies.find(copy => copy.id === id);
          setCopies(items => [...items, {
            id: crypto.randomUUID(),
            label: `${original?.label ?? "red silk"} copy`,
            thumb: MAPS[0].url,
            knobs: { ...(original?.knobs ?? DEFAULT_FABRIC_KNOBS) },
          }]);
        }} />
      </div>}
      actionShelf={<MaterialEditShelf
        dirty={isMaterialDraftDirty(history)}
        canUndo={canUndoMaterialDraft(history)}
        canRedo={canRedoMaterialDraft(history)}
        comparingOriginal={history.comparison === "baseline"}
        saving={false}
        savedName={savedName}
        dismissing={viewingSavedSwatch}
        onCompare={original => dispatch({ type: "compare", selection: original ? "baseline" : "current" })}
        onUndo={() => dispatch({ type: "undo" })}
        onRedo={() => dispatch({ type: "redo" })}
        onReset={() => { focusMaterial(); dispatch({ type: "discard" }); setSavedName(null); }}
        onSave={save}
        onViewArchive={() => {
          materialRef.current?.closest(".material-cabinet")?.querySelector<HTMLButtonElement>(".material-cabinet__flip")?.focus();
          if (face === "archive") setSavedName(null);
          else { setViewingSavedSwatch(true); setFace("archive"); }
        }}
      />}
    />
  </div></main>;
}

function Weaves() {
  const [weave, setWeave] = useState<WeaveType>("plain");
  const [mode, setMode] = useState("fabric");
  return <><SectionLabel>construction</SectionLabel><div className="construction-options"><PixelPlay tone="ink" layer="over" />
    {(["plain", "twill", "satin", "knit"] as WeaveType[]).map(type => <button type="button" className="construction-option" key={type} data-active={type === weave} aria-pressed={type === weave} onClick={() => setWeave(type)}><WeaveDiagram type={type} /><span>{type}</span></button>)}
  </div><SectionLabel>pixel selector</SectionLabel><div className="tx-mode-picker"><PixelPlay tone="ink" layer="over" />{["fabric", "scene"].map(value => <button key={value} type="button" className="tx-mode-tab" data-active={value === mode} aria-pressed={value === mode} onClick={() => setMode(value)}>{value}</button>)}</div></>;
}

function Maps() {
  const [entries, setEntries] = useState(MAPS);
  const [message, setMessage] = useState("Export is disabled here; this is a disposable editor specimen.");
  const urls = useRef<string[]>([]);
  useEffect(() => () => { urls.current.forEach(url => URL.revokeObjectURL(url)); }, []);
  return <><MapsStrip entries={entries} source={{ itemId: "workbench-silk", pkgHash: "workbench-silk" }} canExport={false} exportState="idle" onExport={() => {}}
    onCreateVariation={async (_source, name, file) => {
      const url = URL.createObjectURL(file); urls.current.push(url);
      setEntries(list => list.map(entry => entry.name === name ? { ...entry, url } : entry));
      setMessage(`${name} variation applied to this preview only.`);
    }} /><p className="workbench-readout" role="status">{message}</p></>;
}

function Insert() {
  const [stagedName, setName] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <><div className="workbench-fixture-tools"><label><input type="checkbox" checked={busy} onChange={e => setBusy(e.target.checked)} /> busy state</label><label><input type="checkbox" checked={Boolean(error)} onChange={e => setError(e.target.checked ? "Example: extraction unavailable. Try another image." : null)} /> error state</label></div>
    <InsertPanel stagedName={stagedName} onFiles={files => setName(files?.[0]?.name ?? null)} prompt={prompt} onPrompt={setPrompt} onSubmit={() => setError("Preview only — no extraction was sent.")} busy={busy} error={error} credentialStorage="session" />
  </>;
}

function Status() {
  const [state, setState] = useState<SaveStatusKind>("saved");
  return <><label className="workbench-fixture-tools">save state <select value={state} onChange={e => setState(e.target.value as SaveStatusKind)}>{["dirty", "saving", "saved", "error"].map(s => <option key={s}>{s}</option>)}</select></label>
    <SaveStatus status={state} onRetry={() => setState("saved")} /></>;
}

function Primitives() {
  const [pressed, setPressed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  return <><SectionLabel hint="Tab to the information marker to open the real tooltip.">buttons + hints</SectionLabel>
    <div className="workbench-fixture-tools"><button className="btn btn-ghost" type="button" data-pressed={pressed} aria-pressed={pressed} onClick={() => setPressed(!pressed)}><PixelPlay tone="ink" />{pressed ? "selected" : "select"}</button><button className="btn btn-ghost" disabled>disabled</button><InfoDot hint="This tooltip escapes the preview panel through the real portal." /></div>
    <details className="fine-tune"><summary>fine tune</summary><p>Disclosure content remains keyboard accessible.</p></details>
    <PanelHeader title="panel header" side="left" collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />{!collapsed && <p>Expanded header content.</p>}
  </>;
}

export function ComponentPreview({ id }: { id: ComponentId }) {
  const [open, setOpen] = useState(id === "environment");
  const [face, setFace] = useState<MaterialCabinetFace>("archive");
  const [mode, setMode] = useState<StageMode>("cloth");
  const [light, setLight] = useState<RoomLightSettings>({ ...DEFAULT_ROOM_LIGHT_SETTINGS });
  useEffect(() => {
    let applied: string[] = [];
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.type !== "loom-workbench:tokens") return;
      if (!event.data.patch || typeof event.data.patch !== "object") return;
      applied.forEach(name => document.documentElement.style.removeProperty(name)); applied = [];
      for (const [name, value] of Object.entries(event.data.patch)) {
        if (!/^--room-[\w-]+$/.test(name) || !safeTokenValue(value)) continue;
        document.documentElement.style.setProperty(name, value); applied.push(name);
      }
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "loom-workbench:ready" }, window.location.origin);
    return () => { window.removeEventListener("message", receive); applied.forEach(name => document.documentElement.style.removeProperty(name)); };
  }, []);

  if (id === "logo" || id === "environment") return <main className="workbench-preview-document">
    <NavBar onOpenLight={() => setOpen(!open)} lightDialogOpen={open} status={{ kind: "idle" }} saveStatus="saved" onRetrySave={() => {}} />
    <RoomLightModal open={open} settings={light} resolved={resolveRoomLight(light)} onChange={setLight} onReset={() => setLight({ ...DEFAULT_ROOM_LIGHT_SETTINGS })} onClose={() => setOpen(false)} mode={mode} onMode={setMode} />
  </main>;
  if (id === "cabinet") return <main className="workbench-preview-document"><div className="workbench-cabinet-slot"><MaterialCabinet face={face} onFlip={setFace} archiveFace={<Swatches />} materialFace={<div className="cabinet-pane cabinet-pane--material"><header className="cabinet-pane__header cabinet-material-header"><div><p className="cabinet-pane__kicker">material dossier</p><h2>red silk</h2></div></header><Maps /><Sliders /><Fields /></div>} /></div></main>;
  if (id === "changes") return <MaterialChanges />;
  if (id === "sunlight") return <RoomSunlightStudy />;
  return <main className="workbench-preview-document"><div className={`workbench-specimen material-cabinet__face material-cabinet__face--${id === "swatches" ? "archive" : "material"}`}><div className="cabinet-pane cabinet-pane--material">
    {id === "sliders" && <Sliders />}{id === "pads" && <Fields />}{id === "weaves" && <Weaves />}{id === "swatches" && <Swatches />}{id === "maps" && <Maps />}{id === "insert" && <Insert />}{id === "status" && <Status />}{id === "primitives" && <Primitives />}
    {id === "lens" && <div className="workbench-lens cloth-scene" data-material-loupe="visible"><div className="cloth-scene__loupe-ring" style={{ "--material-loupe-x": "50%", "--material-loupe-y": "50%" } as React.CSSProperties} /><p>CSS border specimen</p></div>}
  </div></div></main>;
}
