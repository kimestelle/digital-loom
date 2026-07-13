"use client";

// Demo / smoke-test for the embeddable <FabricViewer>. Loads the bundled
// pregen material and drops it into flexible boxes of different sizes and
// aspect ratios — each one fills its box and reflows on resize. This page is
// also the copy-paste reference for anyone embedding the viewer.

import { useEffect, useState } from "react";
import FabricViewer from "@/lib/ui/fabricViewer";
import { MAP_ORDER, type MapName, type MaterialPackage } from "@/lib/core/materialPackage";

const PREGEN_MANIFEST = "/pregen/silk-sample/manifest.json";
const PREGEN_BASE = "/pregen/silk-sample";

export default function ViewerDemo() {
  const [pkg, setPkg] = useState<MaterialPackage | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(PREGEN_MANIFEST);
        if (!r.ok) return;
        const m = (await r.json()) as {
          maps: { name: string; file: string }[];
          hash?: string;
        };
        const p: MaterialPackage = {
          id: m.hash ?? "pregen",
          maps: {},
          params: {},
          meta: { fabricName: "silk-sample", createdAt: new Date().toISOString() },
        };
        for (const mp of m.maps) {
          if (!(MAP_ORDER as string[]).includes(mp.name)) continue;
          p.maps[mp.name as MapName] = {
            name: mp.name as MapName,
            url: `${PREGEN_BASE}/${mp.file}`,
            provenance: "patina",
          };
        }
        setPkg(p);
      } catch {
        /* pregen absent */
      }
    })();
  }, []);

  return (
    <main style={{ padding: 24, fontFamily: "system-ui", color: "#e8e2d4", background: "#14110b", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 18, letterSpacing: "0.02em" }}>&lt;FabricViewer /&gt;</h1>
      <p style={{ opacity: 0.6, fontSize: 13, maxWidth: 640 }}>
        The same component in three different boxes. Each fills its container and
        reflows on window resize — no size math on the caller.
      </p>

      {/* A responsive flex row: wide hero + a narrow column. */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 20 }}>
        <div style={{ flex: "2 1 420px", height: 460, borderRadius: 12, overflow: "hidden", background: "#1c1810" }}>
          <FabricViewer pkg={pkg} fabricId="myeongju" />
        </div>
        <div style={{ flex: "1 1 240px", height: 460, borderRadius: 12, overflow: "hidden", background: "#1c1810" }}>
          <FabricViewer pkg={pkg} fabricId="mosi" knobs={{ openness: 0.8, sheen: 0.4 }} />
        </div>
      </div>

      {/* A short, wide strip in object mode. */}
      <div style={{ marginTop: 16, height: 260, borderRadius: 12, overflow: "hidden", background: "#1c1810" }}>
        <FabricViewer pkg={pkg} mode="object" />
      </div>

      <pre
        style={{
          marginTop: 24,
          padding: 14,
          borderRadius: 10,
          background: "#000",
          color: "#b9d0c0",
          fontSize: 12,
          overflowX: "auto",
        }}
      >{`import FabricViewer from "@/lib/ui/fabricViewer";

<div style={{ display: "flex", height: 400 }}>
  <FabricViewer pkg={pkg} fabricId="myeongju" knobs={{ openness: 0.7 }} />
</div>`}</pre>
    </main>
  );
}
