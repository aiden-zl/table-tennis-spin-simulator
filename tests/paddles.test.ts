import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyPose, paddleGripPoint, poseQuaternion } from '../src/render/paddles';

const v = (x: number, y: number, z: number) => ({ x, y, z });

describe('paddle pose math', () => {
  it('maps local +Z to normal and +Y to up (right-handed)', () => {
    const n = new THREE.Vector3(0.3, 0.4, -0.8).normalize();
    const up0 = new THREE.Vector3(0.1, 1, 0.2);
    const pose = { pos: v(0.2, 1.0, 1.5), normal: { x: n.x, y: n.y, z: n.z }, up: { x: up0.x, y: up0.y, z: up0.z } };
    const q = poseQuaternion(pose);
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    expect(z.distanceTo(n)).toBeLessThan(1e-6);
    expect(Math.abs(y.dot(n))).toBeLessThan(1e-6);
    const upOrtho = up0.clone().addScaledVector(n, -up0.dot(n)).normalize();
    expect(y.distanceTo(upOrtho)).toBeLessThan(1e-6);
    expect(x.distanceTo(upOrtho.clone().cross(n))).toBeLessThan(1e-6);

    const obj = new THREE.Object3D();
    applyPose(obj, pose);
    expect(obj.position.toArray()).toEqual([0.2, 1.0, 1.5]);
    expect(obj.quaternion.angleTo(q)).toBeLessThan(1e-6);
  });

  it('identity pose gives identity rotation', () => {
    const q = poseQuaternion({ pos: v(0, 0, 0), normal: v(0, 0, 1), up: v(0, 1, 0) });
    expect(q.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
  });

  it('survives degenerate up parallel to normal', () => {
    const q = poseQuaternion({ pos: v(0, 0, 0), normal: v(0, 1, 0), up: v(0, 2, 0) });
    expect(Number.isFinite(q.x + q.y + q.z + q.w)).toBe(true);
    expect(new THREE.Vector3(0, 0, 1).applyQuaternion(q).distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-6);
  });

  it('grip point is below the blade along -up', () => {
    const g = paddleGripPoint({ pos: v(0, 1, 0), normal: v(0, 0, -1), up: v(0, 1, 0) });
    expect(g.distanceTo(new THREE.Vector3(0, 0.88, 0))).toBeLessThan(1e-9);
  });
});
