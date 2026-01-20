export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// Material types
export const MATERIAL_DIFFUSE = 0;
export const MATERIAL_SPECULAR = 1;
export const MATERIAL_EMISSIVE = 2;

export interface Material {
  albedo: Vec3;
  emissive: Vec3;
  roughness: number;
  materialType: number;  // 0 = diffuse, 1 = specular, 2 = emissive
}

export interface Vec2 {
  u: number;
  v: number;
}

export interface Triangle {
  v0: Vec3;
  v1: Vec3;
  v2: Vec3;
  normal: Vec3;
  materialIndex: number;
  // UV coordinates for texture mapping
  uv0: Vec2;
  uv1: Vec2;
  uv2: Vec2;
  // Texture index in atlas (-1 if no texture)
  textureIndex: number;
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function computeNormal(v0: Vec3, v1: Vec3, v2: Vec3): Vec3 {
  const edge1 = subtract(v1, v0);
  const edge2 = subtract(v2, v0);
  return normalize(cross(edge1, edge2));
}

function createTriangle(v0: Vec3, v1: Vec3, v2: Vec3, materialIndex: number): Triangle {
  return {
    v0,
    v1,
    v2,
    normal: computeNormal(v0, v1, v2),
    materialIndex,
    uv0: { u: 0, v: 0 },
    uv1: { u: 1, v: 0 },
    uv2: { u: 1, v: 1 },
    textureIndex: -1,  // No texture by default
  };
}

// Create a quad from 4 vertices (2 triangles)
function createQuad(v0: Vec3, v1: Vec3, v2: Vec3, v3: Vec3, materialIndex: number): Triangle[] {
  return [
    createTriangle(v0, v1, v2, materialIndex),
    createTriangle(v0, v2, v3, materialIndex),
  ];
}

export function createCube(center: Vec3, size: number, materialIndex: number): Triangle[] {
  const h = size / 2;
  const cx = center.x;
  const cy = center.y;
  const cz = center.z;

  const vertices: Vec3[] = [
    { x: cx - h, y: cy - h, z: cz - h },
    { x: cx + h, y: cy - h, z: cz - h },
    { x: cx + h, y: cy + h, z: cz - h },
    { x: cx - h, y: cy + h, z: cz - h },
    { x: cx - h, y: cy - h, z: cz + h },
    { x: cx + h, y: cy - h, z: cz + h },
    { x: cx + h, y: cy + h, z: cz + h },
    { x: cx - h, y: cy + h, z: cz + h },
  ];

  const triangles: Triangle[] = [];

  triangles.push(createTriangle(vertices[4], vertices[5], vertices[6], materialIndex));
  triangles.push(createTriangle(vertices[4], vertices[6], vertices[7], materialIndex));
  triangles.push(createTriangle(vertices[1], vertices[0], vertices[3], materialIndex));
  triangles.push(createTriangle(vertices[1], vertices[3], vertices[2], materialIndex));
  triangles.push(createTriangle(vertices[0], vertices[4], vertices[7], materialIndex));
  triangles.push(createTriangle(vertices[0], vertices[7], vertices[3], materialIndex));
  triangles.push(createTriangle(vertices[5], vertices[1], vertices[2], materialIndex));
  triangles.push(createTriangle(vertices[5], vertices[2], vertices[6], materialIndex));
  triangles.push(createTriangle(vertices[7], vertices[6], vertices[2], materialIndex));
  triangles.push(createTriangle(vertices[7], vertices[2], vertices[3], materialIndex));
  triangles.push(createTriangle(vertices[0], vertices[1], vertices[5], materialIndex));
  triangles.push(createTriangle(vertices[0], vertices[5], vertices[4], materialIndex));

  return triangles;
}

export function createCubeGrid(gridSize: number, spacing: number, cubeSize: number, materialIndex: number): Triangle[] {
  const triangles: Triangle[] = [];
  const offset = ((gridSize - 1) * spacing) / 2;

  for (let x = 0; x < gridSize; x++) {
    for (let y = 0; y < gridSize; y++) {
      for (let z = 0; z < gridSize; z++) {
        const center = {
          x: x * spacing - offset,
          y: y * spacing - offset,
          z: z * spacing - offset,
        };
        triangles.push(...createCube(center, cubeSize, materialIndex));
      }
    }
  }

  return triangles;
}

// Scene result with both triangles and materials
export interface SceneData {
  triangles: Triangle[];
  materials: Material[];
}

// Create Cornell box scene
export function createCornellBox(): SceneData {
  const triangles: Triangle[] = [];
  const materials: Material[] = [];
  const size = 5;
  const h = size / 2;

  // Define materials
  // 0: White diffuse
  materials.push({
    albedo: { x: 0.73, y: 0.73, z: 0.73 },
    emissive: { x: 0, y: 0, z: 0 },
    roughness: 1.0,
    materialType: MATERIAL_DIFFUSE,
  });

  // 1: Red diffuse
  materials.push({
    albedo: { x: 0.65, y: 0.05, z: 0.05 },
    emissive: { x: 0, y: 0, z: 0 },
    roughness: 1.0,
    materialType: MATERIAL_DIFFUSE,
  });

  // 2: Green diffuse
  materials.push({
    albedo: { x: 0.12, y: 0.45, z: 0.15 },
    emissive: { x: 0, y: 0, z: 0 },
    roughness: 1.0,
    materialType: MATERIAL_DIFFUSE,
  });

  // 3: Light emissive
  materials.push({
    albedo: { x: 1.0, y: 1.0, z: 1.0 },
    emissive: { x: 40, y: 40, z: 40 },
    roughness: 1.0,
    materialType: MATERIAL_EMISSIVE,
  });

  // 4: Mirror (specular)
  materials.push({
    albedo: { x: 0.95, y: 0.95, z: 0.95 },
    emissive: { x: 0, y: 0, z: 0 },
    roughness: 0.0,  // Perfect mirror
    materialType: MATERIAL_SPECULAR,
  });

  // 5: Glossy metal (slightly rough specular)
  materials.push({
    albedo: { x: 0.9, y: 0.7, z: 0.5 },  // Gold-ish color
    emissive: { x: 0, y: 0, z: 0 },
    roughness: 0.15,
    materialType: MATERIAL_SPECULAR,
  });

  // 6: Slightly reflective white (rough specular)
  materials.push({
    albedo: { x: 0.8, y: 0.8, z: 0.8 },
    emissive: { x: 0, y: 0, z: 0 },
    roughness: 0.4,
    materialType: MATERIAL_SPECULAR,
  });

  const MAT_WHITE = 0;
  const MAT_RED = 1;
  const MAT_GREEN = 2;
  const MAT_LIGHT = 3;
  const MAT_MIRROR = 4;
  const MAT_GLOSSY = 5;
  const MAT_GLOSSY_WHITE = 6;

  // Floor (white)
  triangles.push(...createQuad(
    { x: -h, y: -h, z: -h },
    { x: h, y: -h, z: -h },
    { x: h, y: -h, z: h },
    { x: -h, y: -h, z: h },
    MAT_WHITE
  ));

  // Ceiling (white)
  triangles.push(...createQuad(
    { x: -h, y: h, z: -h },
    { x: -h, y: h, z: h },
    { x: h, y: h, z: h },
    { x: h, y: h, z: -h },
    MAT_WHITE
  ));

  // Back wall (white)
  triangles.push(...createQuad(
    { x: -h, y: -h, z: h },
    { x: h, y: -h, z: h },
    { x: h, y: h, z: h },
    { x: -h, y: h, z: h },
    MAT_WHITE
  ));

  // Left wall (red)
  triangles.push(...createQuad(
    { x: -h, y: -h, z: -h },
    { x: -h, y: -h, z: h },
    { x: -h, y: h, z: h },
    { x: -h, y: h, z: -h },
    MAT_RED
  ));

  // Right wall (green)
  triangles.push(...createQuad(
    { x: h, y: -h, z: h },
    { x: h, y: -h, z: -h },
    { x: h, y: h, z: -h },
    { x: h, y: h, z: h },
    MAT_GREEN
  ));

  // Light on ceiling (emissive white quad, slightly smaller and lower than ceiling)
  const lightSize = 1.0;
  const lightY = h - 0.01;
  triangles.push(...createQuad(
    { x: -lightSize / 2, y: lightY, z: -lightSize / 2 },
    { x: -lightSize / 2, y: lightY, z: lightSize / 2 },
    { x: lightSize / 2, y: lightY, z: lightSize / 2 },
    { x: lightSize / 2, y: lightY, z: -lightSize / 2 },
    MAT_LIGHT
  ));

  // Tall box (mirror/specular, but front face is slightly glossy)
  const tallBoxCenter = { x: -1.0, y: -h + 1.5, z: 0.5 };
  const tallBoxSize = 1.5;
  const tallBoxHeight = 3.0;
  triangles.push(...createBox(tallBoxCenter, tallBoxSize, tallBoxSize, tallBoxHeight, MAT_MIRROR, 0.3, MAT_GLOSSY_WHITE));

  // Short box (glossy metal)
  const shortBoxCenter = { x: 1.0, y: -h + 0.75, z: -0.5 };
  const shortBoxSize = 1.5;
  const shortBoxHeight = 1.5;
  triangles.push(...createBox(shortBoxCenter, shortBoxSize, shortBoxSize, shortBoxHeight, MAT_GLOSSY, -0.25));

  return { triangles, materials };
}

// Create a box with rotation around Y axis
// Optional frontMaterialIndex allows a different material for the front face
function createBox(center: Vec3, width: number, depth: number, height: number, materialIndex: number, rotationY: number, frontMaterialIndex?: number): Triangle[] {
  const triangles: Triangle[] = [];
  const hw = width / 2;
  const hd = depth / 2;
  const hh = height / 2;

  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);

  function rotateY(x: number, z: number): { x: number; z: number } {
    return {
      x: x * cos - z * sin,
      z: x * sin + z * cos,
    };
  }

  function vertex(lx: number, ly: number, lz: number): Vec3 {
    const rotated = rotateY(lx, lz);
    return {
      x: center.x + rotated.x,
      y: center.y + ly,
      z: center.z + rotated.z,
    };
  }

  // 8 vertices of the box
  const v = [
    vertex(-hw, -hh, -hd), // 0
    vertex(hw, -hh, -hd),  // 1
    vertex(hw, -hh, hd),   // 2
    vertex(-hw, -hh, hd),  // 3
    vertex(-hw, hh, -hd),  // 4
    vertex(hw, hh, -hd),   // 5
    vertex(hw, hh, hd),    // 6
    vertex(-hw, hh, hd),   // 7
  ];

  const frontMat = frontMaterialIndex ?? materialIndex;

  // Front face (facing -Z before rotation, visible to camera)
  triangles.push(...createQuad(v[1], v[0], v[4], v[5], frontMat));
  // Back face
  triangles.push(...createQuad(v[3], v[2], v[6], v[7], materialIndex));
  // Left face
  triangles.push(...createQuad(v[0], v[3], v[7], v[4], materialIndex));
  // Right face
  triangles.push(...createQuad(v[2], v[1], v[5], v[6], materialIndex));
  // Top face
  triangles.push(...createQuad(v[7], v[6], v[5], v[4], materialIndex));
  // Bottom face (usually not visible)
  triangles.push(...createQuad(v[0], v[1], v[2], v[3], materialIndex));

  return triangles;
}

// Pack triangles into a Float32Array for GPU upload
// Layout per triangle:
//   v0(3) + pad(1) = 4 floats
//   v1(3) + pad(1) = 4 floats
//   v2(3) + pad(1) = 4 floats
//   normal(3) + materialIndex(1) = 4 floats
//   uv0(2) + uv1(2) = 4 floats
//   uv2(2) + textureIndex(1) + pad(1) = 4 floats
// Total: 24 floats
export function packTriangles(triangles: Triangle[]): Float32Array {
  const floatsPerTriangle = 24;
  const buffer = new ArrayBuffer(triangles.length * floatsPerTriangle * 4);
  const data = new Float32Array(buffer);
  const dataUint = new Uint32Array(buffer);
  const dataInt = new Int32Array(buffer);

  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    const offset = i * floatsPerTriangle;

    // Vertex positions
    data[offset + 0] = t.v0.x;
    data[offset + 1] = t.v0.y;
    data[offset + 2] = t.v0.z;
    data[offset + 3] = 0;

    data[offset + 4] = t.v1.x;
    data[offset + 5] = t.v1.y;
    data[offset + 6] = t.v1.z;
    data[offset + 7] = 0;

    data[offset + 8] = t.v2.x;
    data[offset + 9] = t.v2.y;
    data[offset + 10] = t.v2.z;
    data[offset + 11] = 0;

    // Normal and material
    data[offset + 12] = t.normal.x;
    data[offset + 13] = t.normal.y;
    data[offset + 14] = t.normal.z;
    dataUint[offset + 15] = t.materialIndex;

    // UV coordinates
    data[offset + 16] = t.uv0.u;
    data[offset + 17] = t.uv0.v;
    data[offset + 18] = t.uv1.u;
    data[offset + 19] = t.uv1.v;

    data[offset + 20] = t.uv2.u;
    data[offset + 21] = t.uv2.v;
    dataInt[offset + 22] = t.textureIndex;
    data[offset + 23] = 0; // padding
  }

  return data;
}

// Pack materials into a Float32Array for GPU upload
// Layout per material: albedo(3)+roughness + emissive(3)+materialType = 8 floats
export function packMaterials(materials: Material[]): Float32Array {
  const floatsPerMaterial = 8;
  const buffer = new ArrayBuffer(materials.length * floatsPerMaterial * 4);
  const data = new Float32Array(buffer);
  const dataUint = new Uint32Array(buffer);

  for (let i = 0; i < materials.length; i++) {
    const m = materials[i];
    const offset = i * floatsPerMaterial;

    data[offset + 0] = m.albedo.x;
    data[offset + 1] = m.albedo.y;
    data[offset + 2] = m.albedo.z;
    data[offset + 3] = m.roughness;

    data[offset + 4] = m.emissive.x;
    data[offset + 5] = m.emissive.y;
    data[offset + 6] = m.emissive.z;
    dataUint[offset + 7] = m.materialType;
  }

  return data;
}
