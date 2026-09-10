import * as THREE from "three/webgpu";
import { float, length, smoothstep, texture, uv, vec4 } from "three/tsl";

export const MATERIAL_LOUPE_DIAMETER_PX = 240;
export const MATERIAL_LOUPE_TARGET_PX = 320;
export const MATERIAL_LOUPE_ZOOM = 2;
/** Drawables and lights visible to the loupe in addition to the main camera. */
export const MATERIAL_LOUPE_LAYER = 1;

export interface MaterialLoupeRenderState {
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  diameter?: number;
}

/** Shared screen-space geometry for the WebGL disc and its DOM rim. */
export function resolveMaterialLoupeDiameter(
  width: number,
  height: number,
  requestedDiameter = MATERIAL_LOUPE_DIAMETER_PX,
): number {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const safeRequest =
    Number.isFinite(requestedDiameter) && requestedDiameter > 0
      ? requestedDiameter
      : MATERIAL_LOUPE_DIAMETER_PX;
  return Math.min(safeRequest, safeWidth, safeHeight);
}

export function resolveMaterialLoupeCenter(
  position: number,
  span: number,
  diameter: number,
): number {
  const safeSpan = Number.isFinite(span) ? Math.max(0, span) : 0;
  const half = Math.min(safeSpan, Math.max(0, diameter)) / 2;
  const safePosition = Number.isFinite(position) ? position : half;
  return THREE.MathUtils.clamp(safePosition, half, safeSpan - half);
}

/**
 * A renderer-native inspection pass. The live scene is rendered into one
 * bounded target, then composited through a circular mask into the same canvas.
 * It owns no RAF, DOM canvas, or readback path.
 */
export function createMaterialLoupeNodes() {
  const target = new THREE.RenderTarget(
    MATERIAL_LOUPE_TARGET_PX,
    MATERIAL_LOUPE_TARGET_PX,
    {
      depthBuffer: true,
      stencilBuffer: false,
    },
  );
  target.texture.generateMipmaps = false;
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.magFilter = THREE.LinearFilter;

  const loupeCamera = new THREE.PerspectiveCamera();
  const overlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
  overlayCamera.position.z = 1;

  const overlayMaterial = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const lensUv = uv();
  const sample = texture(target.texture, lensUv.flipY());
  const radius = length(lensUv.sub(0.5));
  const mask = float(1).sub(smoothstep(0.482, 0.5, radius));
  // The live magnification stays renderer-native, but its rim is a DOM/CSS
  // layer. Keeping the border out of this fragment pass makes it crisp at
  // every fragment-resolution preset and lets it extend past the canvas box.
  overlayMaterial.fragmentNode = vec4(sample.rgb, sample.a.mul(mask));

  const overlayGeometry = new THREE.PlaneGeometry(2, 2);
  const overlay = new THREE.Mesh(overlayGeometry, overlayMaterial);
  overlay.frustumCulled = false;
  overlay.renderOrder = 1000;
  const overlayScene = new THREE.Scene();
  overlayScene.add(overlay);
  const previousClearColor = new THREE.Color();

  const render = (
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    state: MaterialLoupeRenderState,
  ) => {
    if (!state.visible || state.width <= 0 || state.height <= 0) return;

    const diameter = resolveMaterialLoupeDiameter(
      state.width,
      state.height,
      state.diameter ?? MATERIAL_LOUPE_DIAMETER_PX,
    );
    const x = resolveMaterialLoupeCenter(state.x, state.width, diameter);
    const y = resolveMaterialLoupeCenter(state.y, state.height, diameter);
    const sampleSize = Math.max(1, diameter / MATERIAL_LOUPE_ZOOM);
    const offsetX = THREE.MathUtils.clamp(
      x - sampleSize / 2,
      0,
      Math.max(0, state.width - sampleSize),
    );
    const offsetY = THREE.MathUtils.clamp(
      y - sampleSize / 2,
      0,
      Math.max(0, state.height - sampleSize),
    );

    loupeCamera.copy(camera);
    // copy() also copies the main camera's layer mask. Restrict the cloned
    // camera after every copy so the target contains the active specimen only.
    loupeCamera.layers.set(MATERIAL_LOUPE_LAYER);
    loupeCamera.setViewOffset(
      state.width,
      state.height,
      offsetX,
      offsetY,
      sampleSize,
      sampleSize,
    );
    loupeCamera.updateProjectionMatrix();

    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    renderer.getClearColor(previousClearColor);
    const previousClearAlpha = renderer.getClearAlpha();
    try {
      renderer.setRenderTarget(target);
      renderer.autoClear = false;
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, loupeCamera);
      renderer.setRenderTarget(previousTarget);

      overlay.position.set(
        (x / state.width) * 2 - 1,
        1 - (y / state.height) * 2,
        0,
      );
      overlay.scale.set(diameter / state.width, diameter / state.height, 1);
      renderer.render(overlayScene, overlayCamera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
      renderer.setClearColor(previousClearColor, previousClearAlpha);
    }
  };

  return {
    render,
    dispose: () => {
      target.dispose();
      overlayGeometry.dispose();
      overlayMaterial.dispose();
      loupeCamera.clearViewOffset();
    },
  };
}
