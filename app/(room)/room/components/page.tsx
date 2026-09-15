import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metadata } from "next";
import { ComponentWorkbench } from "@/lib/ui/workbench/workbench";
import "./workbench.css";

export const metadata: Metadata = { title: "components — digital loom", robots: { index: false, follow: false } };

export default async function ComponentsPage() {
  const css = await readFile(join(process.cwd(), "app/styles/room-tokens.css"), "utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("\n}"));
  const defaults = Object.fromEntries([...root.matchAll(/(--room-[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  return <ComponentWorkbench defaults={defaults} />;
}
