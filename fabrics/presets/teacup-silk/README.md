# IMG_9721 copy

AI-extracted fabric material (명주 · silk), captured from a single
photo via Patina and dialed in with **loom**. Tileable PBR maps + a ready-to-drop
`.glb`, plus the cloth's motion character for physics-aware pipelines.

## Files

| file | use |
|---|---|
| `img-9721-copy_BaseColor.png` | base color / albedo (sRGB) |
| `img-9721-copy_Normal.png` | normal (OpenGL, Y+) |
| `img-9721-copy_Roughness.png` | roughness (linear) |
| `img-9721-copy_Metallic.png` | metalness (linear) |
| `img-9721-copy_Height.png` | height / displacement |
| `img-9721-copy_ORM.png` | packed **O**cclusion·**R**oughness·**M**etallic (glTF/Unreal) |
| `img-9721-copy.glb` | self-contained specimen (PBR + sheen + transmission) |
| `material.json` | maps + PBR scalars + cloth physics + provenance |

## Import

- **Blender** — enable *Node Wrangler*, add a Principled BSDF, `Ctrl+Shift+T`, select all the map PNGs. Suffixes auto-wire.
- **Unreal / glTF** — use `img-9721-copy_ORM.png` as the packed metallic-roughness (+occlusion) texture.
- **Unity (HDRP/URP)** — BaseColor + Normal + `img-9721-copy_ORM.png` (Mask/MetallicSmoothness); note Unity wants **DirectX (Y−)** normals — flip the green channel if it looks inverted.
- **three.js / R3F** — the `.glb` drops straight in, or use the snippet below.

## three.js

```js
import * as THREE from "three";

const tl = new THREE.TextureLoader();
const srgb = (t) => ((t.colorSpace = THREE.SRGBColorSpace), t);

const material = new THREE.MeshPhysicalMaterial({
  map:          srgb(tl.load("img-9721-copy_BaseColor.png")),
  normalMap:    tl.load("img-9721-copy_Normal.png"),
  roughnessMap: tl.load("img-9721-copy_ORM.png"), // G = roughness
  metalnessMap: tl.load("img-9721-copy_ORM.png"), // B = metalness
  aoMap:        tl.load("img-9721-copy_ORM.png"), // R = occlusion
  metalness:     0,
  roughness:     1,
  sheen:         0.9,
  sheenColor:    new THREE.Color(0xf3dcb1),
  sheenRoughness: 0.8,
  transmission:  0.07, // fabric openness → see-through
  thickness:     0.35,
  ior:           1.4,
  side:          THREE.DoubleSide,
});
// aoMap needs a second UV set: geometry.setAttribute("uv2", geometry.getAttribute("uv"));
```

## Cloth physics (loom-native)

Not a PBR standard — these describe how the fabric *moves* (0..1 stiffness →
XPBD compliance). See `material.json → physics`.

| axis | value |
|---|---|
| weave | plain |
| warp / weft | 0.95 / 0.92 |
| shear | 0.55 |
| bend | 0.06 |
| weight | 1 |

*Extracted via Patina · packaged by loom.*
