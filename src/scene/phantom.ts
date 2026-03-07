import {
  Triangle,
  Material,
  Vec3,
  MATERIAL_DIFFUSE,
  MATERIAL_EMISSIVE,
} from './geometry';
import { TILE_SIZE } from './dungeon';

// Phantom model — inspired by the Dragon 32 "Phantom Slayer" sprite
// A tall dark crimson robed figure with a crown-like head and glowing eye

// Material indices (appended to scene materials)
export interface PhantomMaterials {
  body: number;    // dark crimson robe
  head: number;    // darker crown
  eye: number;     // glowing eye (emissive)
}

export function createPhantomMaterials(baseIndex: number): { materials: Material[]; indices: PhantomMaterials } {
  const materials: Material[] = [
    // Body — dark crimson
    {
      albedo: { x: 0.55, y: 0.08, z: 0.05 },
      emissive: { x: 0, y: 0, z: 0 },
      roughness: 1.0,
      materialType: MATERIAL_DIFFUSE,
    },
    // Head/crown — darker red-brown
    {
      albedo: { x: 0.4, y: 0.05, z: 0.03 },
      emissive: { x: 0, y: 0, z: 0 },
      roughness: 1.0,
      materialType: MATERIAL_DIFFUSE,
    },
    // Eye — eerie glow
    {
      albedo: { x: 0.1, y: 0.05, z: 0.4 },
      emissive: { x: 0.8, y: 0.2, z: 0.2 },
      roughness: 1.0,
      materialType: MATERIAL_EMISSIVE,
    },
  ];

  return {
    materials,
    indices: {
      body: baseIndex,
      head: baseIndex + 1,
      eye: baseIndex + 2,
    },
  };
}

function computeNormal(v0: Vec3, v1: Vec3, v2: Vec3): Vec3 {
  const e1 = { x: v1.x - v0.x, y: v1.y - v0.y, z: v1.z - v0.z };
  const e2 = { x: v2.x - v0.x, y: v2.y - v0.y, z: v2.z - v0.z };
  const n = {
    x: e1.y * e2.z - e1.z * e2.y,
    y: e1.z * e2.x - e1.x * e2.z,
    z: e1.x * e2.y - e1.y * e2.x,
  };
  const len = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
  if (len === 0) return { x: 0, y: 1, z: 0 };
  return { x: n.x / len, y: n.y / len, z: n.z / len };
}

function tri(v0: Vec3, v1: Vec3, v2: Vec3, mat: number): Triangle {
  return {
    v0, v1, v2,
    normal: computeNormal(v0, v1, v2),
    materialIndex: mat,
    uv0: { u: 0, v: 0 }, uv1: { u: 1, v: 0 }, uv2: { u: 1, v: 1 },
    textureIndex: -1,
  };
}

function quad(v0: Vec3, v1: Vec3, v2: Vec3, v3: Vec3, mat: number): Triangle[] {
  return [tri(v0, v1, v2, mat), tri(v0, v2, v3, mat)];
}

// Build a box from min/max, all 6 faces
function box(
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
  mat: number
): Triangle[] {
  const tris: Triangle[] = [];
  // Front (+Z)
  tris.push(...quad(
    { x: minX, y: minY, z: maxZ }, { x: maxX, y: minY, z: maxZ },
    { x: maxX, y: maxY, z: maxZ }, { x: minX, y: maxY, z: maxZ }, mat));
  // Back (-Z)
  tris.push(...quad(
    { x: maxX, y: minY, z: minZ }, { x: minX, y: minY, z: minZ },
    { x: minX, y: maxY, z: minZ }, { x: maxX, y: maxY, z: minZ }, mat));
  // Right (+X)
  tris.push(...quad(
    { x: maxX, y: minY, z: maxZ }, { x: maxX, y: minY, z: minZ },
    { x: maxX, y: maxY, z: minZ }, { x: maxX, y: maxY, z: maxZ }, mat));
  // Left (-X)
  tris.push(...quad(
    { x: minX, y: minY, z: minZ }, { x: minX, y: minY, z: maxZ },
    { x: minX, y: maxY, z: maxZ }, { x: minX, y: maxY, z: minZ }, mat));
  // Top (+Y)
  tris.push(...quad(
    { x: minX, y: maxY, z: maxZ }, { x: maxX, y: maxY, z: maxZ },
    { x: maxX, y: maxY, z: minZ }, { x: minX, y: maxY, z: minZ }, mat));
  // Bottom (-Y)
  tris.push(...quad(
    { x: minX, y: minY, z: minZ }, { x: maxX, y: minY, z: minZ },
    { x: maxX, y: minY, z: maxZ }, { x: minX, y: minY, z: maxZ }, mat));
  return tris;
}

// Generate phantom triangles at a given tile position (tileX, tileZ in tile coords)
// The phantom faces towards -Z by default (south)
export function createPhantomTriangles(
  tileX: number,
  tileZ: number,
  m: PhantomMaterials
): Triangle[] {
  const cx = tileX * TILE_SIZE + TILE_SIZE / 2;
  const cz = tileZ * TILE_SIZE + TILE_SIZE / 2;
  const tris: Triangle[] = [];

  // Scale: roughly 1.7 units tall, ~0.5 wide body
  // Y=0 is floor

  // === Robe / Body ===
  // Main body column — tapers slightly at top
  tris.push(...box(cx - 0.22, 0.0, cz - 0.15, cx + 0.22, 0.45, cz + 0.15, m.body));  // base/feet
  tris.push(...box(cx - 0.25, 0.45, cz - 0.16, cx + 0.25, 1.15, cz + 0.16, m.body)); // torso
  tris.push(...box(cx - 0.20, 1.15, cz - 0.14, cx + 0.20, 1.30, cz + 0.14, m.body)); // shoulders/neck

  // === Head ===
  tris.push(...box(cx - 0.16, 1.30, cz - 0.12, cx + 0.16, 1.55, cz + 0.12, m.head));

  // === Crown spikes ===
  // Center spike
  tris.push(...box(cx - 0.04, 1.55, cz - 0.04, cx + 0.04, 1.72, cz + 0.04, m.head));
  // Left spike
  tris.push(...box(cx - 0.14, 1.55, cz - 0.03, cx - 0.08, 1.65, cz + 0.03, m.head));
  // Right spike
  tris.push(...box(cx + 0.08, 1.55, cz - 0.03, cx + 0.14, 1.65, cz + 0.03, m.head));
  // Far left spike
  tris.push(...box(cx - 0.18, 1.50, cz - 0.02, cx - 0.13, 1.58, cz + 0.02, m.head));
  // Far right spike
  tris.push(...box(cx + 0.13, 1.50, cz - 0.02, cx + 0.18, 1.58, cz + 0.02, m.head));

  // === Face / Eye ===
  // Dark glowing eye region on front face (-Z side)
  tris.push(...quad(
    { x: cx - 0.08, y: 1.36, z: cz - 0.125 },
    { x: cx + 0.08, y: 1.36, z: cz - 0.125 },
    { x: cx + 0.06, y: 1.48, z: cz - 0.125 },
    { x: cx - 0.06, y: 1.48, z: cz - 0.125 },
    m.eye,
  ));
  // Eye on back face (+Z side)
  tris.push(...quad(
    { x: cx + 0.08, y: 1.36, z: cz + 0.125 },
    { x: cx - 0.08, y: 1.36, z: cz + 0.125 },
    { x: cx - 0.06, y: 1.48, z: cz + 0.125 },
    { x: cx + 0.06, y: 1.48, z: cz + 0.125 },
    m.eye,
  ));

  // === Arms / Robe wings ===
  // Left arm (draping down)
  tris.push(...box(cx - 0.35, 0.50, cz - 0.06, cx - 0.25, 1.15, cz + 0.06, m.body));
  tris.push(...box(cx - 0.40, 0.35, cz - 0.05, cx - 0.30, 0.80, cz + 0.05, m.body));
  // Right arm
  tris.push(...box(cx + 0.25, 0.50, cz - 0.06, cx + 0.35, 1.15, cz + 0.06, m.body));
  tris.push(...box(cx + 0.30, 0.35, cz - 0.05, cx + 0.40, 0.80, cz + 0.05, m.body));

  return tris;
}
