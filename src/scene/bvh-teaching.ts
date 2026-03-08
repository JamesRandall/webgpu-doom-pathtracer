import { SceneData, Triangle, Material, Vec3, MATERIAL_DIFFUSE, MATERIAL_EMISSIVE } from './geometry';

const noUV = { u: 0, v: 0 };

function tri(v0: Vec3, v1: Vec3, v2: Vec3, normal: Vec3, mat: number): Triangle {
  return { v0, v1, v2, normal, materialIndex: mat, uv0: noUV, uv1: noUV, uv2: noUV, textureIndex: -1 };
}

function quad(v0: Vec3, v1: Vec3, v2: Vec3, v3: Vec3, normal: Vec3, mat: number): Triangle[] {
  return [tri(v0, v1, v2, normal, mat), tri(v0, v2, v3, normal, mat)];
}

function cube(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, mat: number): Triangle[] {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const v = [
    { x: cx - hx, y: cy - hy, z: cz - hz },
    { x: cx + hx, y: cy - hy, z: cz - hz },
    { x: cx + hx, y: cy + hy, z: cz - hz },
    { x: cx - hx, y: cy + hy, z: cz - hz },
    { x: cx - hx, y: cy - hy, z: cz + hz },
    { x: cx + hx, y: cy - hy, z: cz + hz },
    { x: cx + hx, y: cy + hy, z: cz + hz },
    { x: cx - hx, y: cy + hy, z: cz + hz },
  ];
  const n = { x: 0, y: 0, z: 0 }; // auto-computed below
  const tris: Triangle[] = [];
  const faces: [number, number, number, number, Vec3][] = [
    [0, 1, 2, 3, { x: 0, y: 0, z: -1 }], // front (-Z)
    [5, 4, 7, 6, { x: 0, y: 0, z: 1 }],  // back (+Z)
    [4, 0, 3, 7, { x: -1, y: 0, z: 0 }], // left
    [1, 5, 6, 2, { x: 1, y: 0, z: 0 }],  // right
    [3, 2, 6, 7, { x: 0, y: 1, z: 0 }],  // top
    [4, 5, 1, 0, { x: 0, y: -1, z: 0 }], // bottom
  ];
  for (const [a, b, c, d, fn] of faces) {
    tris.push(...quad(v[a], v[b], v[c], v[d], fn, mat));
  }
  return tris;
}

// Open-front box (no -Z face so camera can see inside)
function openBox(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, mat: number): Triangle[] {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const v = [
    { x: cx - hx, y: cy - hy, z: cz - hz },
    { x: cx + hx, y: cy - hy, z: cz - hz },
    { x: cx + hx, y: cy + hy, z: cz - hz },
    { x: cx - hx, y: cy + hy, z: cz - hz },
    { x: cx - hx, y: cy - hy, z: cz + hz },
    { x: cx + hx, y: cy - hy, z: cz + hz },
    { x: cx + hx, y: cy + hy, z: cz + hz },
    { x: cx - hx, y: cy + hy, z: cz + hz },
  ];
  const tris: Triangle[] = [];
  // Skip front face (-Z): [0,1,2,3]
  tris.push(...quad(v[5], v[4], v[7], v[6], { x: 0, y: 0, z: 1 }, mat));  // back
  tris.push(...quad(v[4], v[0], v[3], v[7], { x: -1, y: 0, z: 0 }, mat)); // left
  tris.push(...quad(v[1], v[5], v[6], v[2], { x: 1, y: 0, z: 0 }, mat));  // right
  tris.push(...quad(v[3], v[2], v[6], v[7], { x: 0, y: 1, z: 0 }, mat));  // top
  tris.push(...quad(v[4], v[5], v[1], v[0], { x: 0, y: -1, z: 0 }, mat)); // bottom
  return tris;
}

export function createBVHTeachingScene(): SceneData {
  const materials: Material[] = [
    { albedo: { x: 0.8, y: 0.8, z: 0.8 }, roughness: 1, emissive: { x: 0, y: 0, z: 0 }, materialType: MATERIAL_DIFFUSE },   // 0: white
    { albedo: { x: 0.8, y: 0.15, z: 0.1 }, roughness: 1, emissive: { x: 0, y: 0, z: 0 }, materialType: MATERIAL_DIFFUSE },  // 1: red
    { albedo: { x: 0.1, y: 0.15, z: 0.8 }, roughness: 1, emissive: { x: 0, y: 0, z: 0 }, materialType: MATERIAL_DIFFUSE },  // 2: blue
    { albedo: { x: 0.1, y: 0.7, z: 0.15 }, roughness: 1, emissive: { x: 0, y: 0, z: 0 }, materialType: MATERIAL_DIFFUSE },  // 3: green
    { albedo: { x: 0.8, y: 0.75, z: 0.1 }, roughness: 1, emissive: { x: 0, y: 0, z: 0 }, materialType: MATERIAL_DIFFUSE },  // 4: yellow
    { albedo: { x: 0.9, y: 0.5, z: 0.1 }, roughness: 1, emissive: { x: 0, y: 0, z: 0 }, materialType: MATERIAL_DIFFUSE },   // 5: orange
    { albedo: { x: 0.1, y: 0.7, z: 0.7 }, roughness: 1, emissive: { x: 0, y: 0, z: 0 }, materialType: MATERIAL_DIFFUSE },   // 6: cyan
    { albedo: { x: 0, y: 0, z: 0 }, roughness: 1, emissive: { x: 8, y: 7.5, z: 6.5 }, materialType: MATERIAL_EMISSIVE },     // 7: light
    { albedo: { x: 0.3, y: 0.3, z: 0.3 }, roughness: 1, emissive: { x: 0, y: 0, z: 0 }, materialType: MATERIAL_DIFFUSE },   // 8: dark grey
  ];

  const triangles: Triangle[] = [];

  // --- 1. Room shell (material 0) ---
  // Floor
  triangles.push(...quad(
    { x: -10, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 8 }, { x: -10, y: 0, z: 8 },
    { x: 0, y: 1, z: 0 }, 0));
  // Ceiling
  triangles.push(...quad(
    { x: -10, y: 10, z: 0 }, { x: -10, y: 10, z: 8 }, { x: 10, y: 10, z: 8 }, { x: 10, y: 10, z: 0 },
    { x: 0, y: -1, z: 0 }, 0));
  // Back wall
  triangles.push(...quad(
    { x: -10, y: 0, z: 8 }, { x: 10, y: 0, z: 8 }, { x: 10, y: 10, z: 8 }, { x: -10, y: 10, z: 8 },
    { x: 0, y: 0, z: -1 }, 0));
  // Left wall
  triangles.push(...quad(
    { x: -10, y: 0, z: 0 }, { x: -10, y: 0, z: 8 }, { x: -10, y: 10, z: 8 }, { x: -10, y: 10, z: 0 },
    { x: 1, y: 0, z: 0 }, 0));
  // Right wall
  triangles.push(...quad(
    { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 10, y: 10, z: 8 }, { x: 10, y: 0, z: 8 },
    { x: -1, y: 0, z: 0 }, 0));
  // Front wall (behind camera)
  triangles.push(...quad(
    { x: -10, y: 0, z: 0 }, { x: -10, y: 10, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 10, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 }, 0));

  // --- 2. Ceiling light (material 7) ---
  triangles.push(...quad(
    { x: -2, y: 9.99, z: 3 }, { x: 2, y: 9.99, z: 3 }, { x: 2, y: 9.99, z: 5 }, { x: -2, y: 9.99, z: 5 },
    { x: 0, y: -1, z: 0 }, 7));

  // --- 3. Well-separated objects (left side) ---
  triangles.push(...cube(-7, 1, 5, 2, 2, 2, 1));       // Red cube
  triangles.push(...cube(-5, 4, 3, 1.5, 1.5, 1.5, 3)); // Green cube
  triangles.push(...cube(-7, 1.5, 7, 1.5, 3, 1.5, 2)); // Blue tall cube

  // --- 4. Dense cluster (right side) — 8 small cubes ---
  const cs = 0.8;
  triangles.push(...cube(5.5, 1.5, 4.5, cs, cs, cs, 1)); // red
  triangles.push(...cube(6.5, 1.5, 4.5, cs, cs, cs, 2)); // blue
  triangles.push(...cube(5.5, 2.5, 4.5, cs, cs, cs, 3)); // green
  triangles.push(...cube(6.5, 2.5, 4.5, cs, cs, cs, 4)); // yellow
  triangles.push(...cube(5.5, 1.5, 5.5, cs, cs, cs, 5)); // orange
  triangles.push(...cube(6.5, 1.5, 5.5, cs, cs, cs, 6)); // cyan
  triangles.push(...cube(5.5, 2.5, 5.5, cs, cs, cs, 1)); // red
  triangles.push(...cube(6.5, 2.5, 5.5, cs, cs, cs, 2)); // blue

  // --- 5. Russian dolls (centre) — nested open-front boxes ---
  triangles.push(...openBox(0, 3, 5, 4, 4, 4, 4));       // Outer: yellow
  triangles.push(...openBox(0, 3, 5, 2.5, 2.5, 2.5, 5)); // Middle: orange
  triangles.push(...cube(0, 3, 5, 1, 1, 1, 1));           // Inner: red (fully closed)

  // --- 6. Diagonal slab (material 8) ---
  {
    const A: Vec3 = { x: -9, y: 0.5, z: 1 };
    const B: Vec3 = { x: 9, y: 9, z: 7 };
    const dir = { x: B.x - A.x, y: B.y - A.y, z: B.z - A.z };
    // cross(dir, up)
    const up = { x: 0, y: 1, z: 0 };
    const cx = dir.y * up.z - dir.z * up.y;
    const cy = dir.z * up.x - dir.x * up.z;
    const cz = dir.x * up.y - dir.y * up.x;
    const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const w = 0.25;
    const perp = { x: (cx / cl) * w, y: (cy / cl) * w, z: (cz / cl) * w };

    const v0 = { x: A.x - perp.x, y: A.y - perp.y, z: A.z - perp.z };
    const v1 = { x: A.x + perp.x, y: A.y + perp.y, z: A.z + perp.z };
    const v2 = { x: B.x + perp.x, y: B.y + perp.y, z: B.z + perp.z };
    const v3 = { x: B.x - perp.x, y: B.y - perp.y, z: B.z - perp.z };

    // Compute normal from cross product
    const e1 = { x: v1.x - v0.x, y: v1.y - v0.y, z: v1.z - v0.z };
    const e2 = { x: v2.x - v0.x, y: v2.y - v0.y, z: v2.z - v0.z };
    const nx = e1.y * e2.z - e1.z * e2.y;
    const ny = e1.z * e2.x - e1.x * e2.z;
    const nz = e1.x * e2.y - e1.y * e2.x;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const normal = { x: nx / nl, y: ny / nl, z: nz / nl };

    triangles.push(tri(v0, v1, v2, normal, 8));
    triangles.push(tri(v0, v2, v3, normal, 8));
  }

  // --- 7. Floor grid — 4x4 tiles with slight elevation ---
  {
    const gridX0 = 2, gridZ0 = 0.5;
    const tileW = 1.75, tileD = 0.625;
    const elevations = [
      [0.0, 0.05, 0.0, 0.05],
      [0.05, 0.0, 0.05, 0.0],
      [0.0, 0.05, 0.0, 0.05],
      [0.05, 0.0, 0.05, 0.0],
    ];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const x0 = gridX0 + col * tileW;
        const z0 = gridZ0 + row * tileD;
        const y = elevations[row][col];
        const mat = (row + col) % 2 === 0 ? 0 : 8;
        triangles.push(...quad(
          { x: x0, y, z: z0 }, { x: x0 + tileW, y, z: z0 },
          { x: x0 + tileW, y, z: z0 + tileD }, { x: x0, y, z: z0 + tileD },
          { x: 0, y: 1, z: 0 }, mat));
      }
    }
  }

  console.log(`BVH Teaching scene: ${triangles.length} triangles, ${materials.length} materials`);
  return { triangles, materials };
}
