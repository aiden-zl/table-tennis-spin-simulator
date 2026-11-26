import * as THREE from 'three';

/**
 * Draw `scene` once with every object visible, then restore visibility. Objects that are
 * hidden until a ball is played (markers, paths, ghost paddle, spin arrows, wind) otherwise
 * compile and link their shaders on first use, which stalls that frame by 0.1-0.5 s. A real
 * draw (not just renderer.compile) is needed: drivers link lazily at the first status check.
 */
export function prewarmRender(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
  const hidden: THREE.Object3D[] = [];
  const culled: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
    if (o.frustumCulled) {
      culled.push(o);
      o.frustumCulled = false;
    }
  });
  try {
    renderer.render(scene, camera);
  } catch (e) {
    console.warn('shader prewarm failed', e);
  } finally {
    for (const o of hidden) o.visible = false;
    for (const o of culled) o.frustumCulled = true;
  }
}
