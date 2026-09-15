// Compare the actual production SVG/CSS against its detached-image raster.
// No Next server, WebGL scene, or screenshot approximation of the room.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { webkit } from "playwright";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
}).outputText;
const frameModule = { exports: {} };
new Function("require", "exports", "module", transpile(await readFile("lib/ui/roomFrame.tsx", "utf8")))(
  name => name === "./roomSunlightImage" ? { RoomSunlightImage: () => null }
    : name === "./roomWindowLight" ? { RoomWindowLight: () => null, DEFAULT_ROOM_SUNLIGHT_BLOOM: 1 }
    : name === "./roomSurfaceCache" ? { RoomSurfaceCache: () => null }
    : require(name), frameModule.exports, frameModule,
);
const markup = renderToStaticMarkup(React.createElement(frameModule.exports.RoomFrame, { stage: null }));
const css = await readFile("app/styles/room.css", "utf8");
const helpers = transpile(await readFile("lib/ui/roomSurfaceSnapshot.ts", "utf8"));
const browser = await webkit.launch({ headless: true });
try {
  const results = [];
  for (const [width, height] of [[390, 844], [844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.route("http://room.test/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith("/2d-textures/")) {
        await route.fulfill({ body: await readFile(resolve("public", path.slice(1))), contentType: "image/png" });
      } else {
        await route.fulfill({ contentType: "text/html", body: `<style>${css}
          html,body{margin:0} .room-frame__architecture::before,.room-frame__architecture::after,
          .room-frame__architecture>:not(.room-frame__planes),.room-frame__guides{display:none!important}
          #surface-test{position:absolute;inset:0;z-index:10}
        </style>${markup}` });
      }
    });
    await page.goto("http://room.test/", { waitUntil: "networkidle" });
    await page.addScriptTag({ content: `globalThis.surfaceHelpers={};(function(exports){${helpers}})(globalThis.surfaceHelpers)` });
    await page.evaluate(async () => {
      const images = [...document.querySelectorAll(".room-frame__planes image")];
      await Promise.all(images.map(async el => {
        const image = new Image(); image.src = el.getAttribute("href"); await image.decode();
      }));
    });
    const source = page.locator(".room-frame__planes");
    const native = await source.screenshot();
    await page.evaluate(async () => {
      const source = document.querySelector(".room-frame__planes");
      const rect = source.getBoundingClientRect();
      const snapshot = globalThis.surfaceHelpers.roomSurfaceSnapshot(source, rect.width, rect.height);
      await globalThis.surfaceHelpers.embedRoomSurfaceTextures(snapshot);
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(snapshot)], { type: "image/svg+xml" }));
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement("canvas"); canvas.id = "surface-test";
      canvas.width = Math.ceil(rect.width); canvas.height = Math.ceil(rect.height);
      canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`;
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      document.querySelector(".room-frame").append(canvas);
      source.style.visibility = "hidden";
      URL.revokeObjectURL(url);
    });
    const cached = await page.locator("#surface-test").screenshot();
    const a = await sharp(native).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const b = await sharp(cached).resize(a.info.width, a.info.height).ensureAlpha().raw().toBuffer();
    let total = 0, maximum = 0, changed = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      let delta = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const difference = Math.abs(a.data[i + channel] - b[i + channel]);
        total += difference; maximum = Math.max(maximum, difference); delta = Math.max(delta, difference);
      }
      if (delta > 3) changed += 1;
    }
    const pixels = a.info.width * a.info.height;
    results.push({ width, height, meanAbsoluteChannelError: total / pixels / 3, maximumChannelError: maximum, percentPixelsOver3: changed / pixels * 100 });
    await sharp(native).toFile(`/tmp/room-surface-native-${width}.png`);
    await sharp(cached).toFile(`/tmp/room-surface-cache-${width}.png`);
    await page.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
