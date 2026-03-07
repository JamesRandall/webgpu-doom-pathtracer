import {
  Triangle,
  Material,
  SceneData,
  Vec3,
  MATERIAL_DIFFUSE,
  MATERIAL_EMISSIVE,
} from './geometry';

// 1 = wall, 0 = open space
const DUNGEON_MAP: number[][] = [
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,1,0,0,1,1,1,0,0,1,1,1,1],
  [1,1,0,1,1,0,0,1,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,1,0,0,1,1,1,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,1],
  [1,1,1,0,0,1,1,1,0,0,1,0,0,0,0,1],
  [1,0,0,0,0,0,0,1,0,0,1,0,0,1,1,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,1,1,1,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,1,0,0,0,0,1,1,1,1,0,0,0,1],
  [1,0,0,1,0,0,0,0,1,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
];

export const TILE_SIZE = 2.0;
export const WALL_HEIGHT = 2.5;
const EYE_HEIGHT = 1.2;

export const DUNGEON_START_X = 1;
export const DUNGEON_START_Z = 1;
export const DUNGEON_START_DIR = 1;

export function getDungeonMap(): number[][] {
  return DUNGEON_MAP;
}

export function getDungeonEyeHeight(): number {
  return EYE_HEIGHT;
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

function makeTriangle(v0: Vec3, v1: Vec3, v2: Vec3, materialIndex: number): Triangle {
  return {
    v0, v1, v2,
    normal: computeNormal(v0, v1, v2),
    materialIndex,
    uv0: { u: 0, v: 0 },
    uv1: { u: 1, v: 0 },
    uv2: { u: 1, v: 1 },
    textureIndex: -1,
  };
}

function makeQuad(v0: Vec3, v1: Vec3, v2: Vec3, v3: Vec3, mat: number): Triangle[] {
  return [
    makeTriangle(v0, v1, v2, mat),
    makeTriangle(v0, v2, v3, mat),
  ];
}

// Build a wall face, split into a non-emissive portion and an emissive torch area.
// The torch area is a large rectangle in the upper-middle of the wall face.
// facing: 0=+X, 1=-X, 2=+Z, 3=-Z
function makeWallWithTorch(
  wx: number, wz: number, facing: number,
  matWall: number, matTorch: number,
): Triangle[] {
  const tris: Triangle[] = [];
  const S = TILE_SIZE;
  const H = WALL_HEIGHT;

  // Torch region: horizontally centered, upper portion of wall
  const torchLeft = S * 0.15;
  const torchRight = S * 0.85;
  const torchBottom = H * 0.25;
  const torchTop = H * 0.75;

  // We need to build the wall face as 5 quads:
  // - bottom strip (0 to torchBottom, full width)
  // - left strip (torchBottom to torchTop, 0 to torchLeft)
  // - torch center (torchBottom to torchTop, torchLeft to torchRight) — emissive
  // - right strip (torchBottom to torchTop, torchRight to S)
  // - top strip (torchTop to H, full width)

  type Rect = { u0: number; v0: number; u1: number; v1: number; mat: number };
  const rects: Rect[] = [
    { u0: 0, v0: 0, u1: S, v1: torchBottom, mat: matWall },
    { u0: 0, v0: torchBottom, u1: torchLeft, v1: torchTop, mat: matWall },
    { u0: torchLeft, v0: torchBottom, u1: torchRight, v1: torchTop, mat: matTorch },
    { u0: torchRight, v0: torchBottom, u1: S, v1: torchTop, mat: matWall },
    { u0: 0, v0: torchTop, u1: S, v1: H, mat: matWall },
  ];

  for (const r of rects) {
    let q: Vec3[];
    switch (facing) {
      case 0: // +X face
        q = [
          { x: wx + S, y: r.v0, z: wz + r.u0 },
          { x: wx + S, y: r.v0, z: wz + r.u1 },
          { x: wx + S, y: r.v1, z: wz + r.u1 },
          { x: wx + S, y: r.v1, z: wz + r.u0 },
        ];
        break;
      case 1: // -X face
        q = [
          { x: wx, y: r.v0, z: wz + S - r.u0 },
          { x: wx, y: r.v0, z: wz + S - r.u1 },
          { x: wx, y: r.v1, z: wz + S - r.u1 },
          { x: wx, y: r.v1, z: wz + S - r.u0 },
        ];
        break;
      case 2: // +Z face
        q = [
          { x: wx + S - r.u0, y: r.v0, z: wz + S },
          { x: wx + S - r.u1, y: r.v0, z: wz + S },
          { x: wx + S - r.u1, y: r.v1, z: wz + S },
          { x: wx + S - r.u0, y: r.v1, z: wz + S },
        ];
        break;
      case 3: // -Z face
      default:
        q = [
          { x: wx + r.u0, y: r.v0, z: wz },
          { x: wx + r.u1, y: r.v0, z: wz },
          { x: wx + r.u1, y: r.v1, z: wz },
          { x: wx + r.u0, y: r.v1, z: wz },
        ];
        break;
    }
    tris.push(...makeQuad(q[0], q[1], q[2], q[3], r.mat));
  }

  return tris;
}

function makeWallFace(
  wx: number, wz: number, facing: number, mat: number,
): Triangle[] {
  const S = TILE_SIZE;
  const H = WALL_HEIGHT;

  switch (facing) {
    case 0: // +X
      return makeQuad(
        { x: wx + S, y: 0, z: wz },
        { x: wx + S, y: 0, z: wz + S },
        { x: wx + S, y: H, z: wz + S },
        { x: wx + S, y: H, z: wz },
        mat,
      );
    case 1: // -X
      return makeQuad(
        { x: wx, y: 0, z: wz + S },
        { x: wx, y: 0, z: wz },
        { x: wx, y: H, z: wz },
        { x: wx, y: H, z: wz + S },
        mat,
      );
    case 2: // +Z
      return makeQuad(
        { x: wx + S, y: 0, z: wz + S },
        { x: wx, y: 0, z: wz + S },
        { x: wx, y: H, z: wz + S },
        { x: wx + S, y: H, z: wz + S },
        mat,
      );
    case 3: // -Z
    default:
      return makeQuad(
        { x: wx, y: 0, z: wz },
        { x: wx + S, y: 0, z: wz },
        { x: wx + S, y: H, z: wz },
        { x: wx, y: H, z: wz },
        mat,
      );
  }
}

export function createDungeonScene(): SceneData {
  const triangles: Triangle[] = [];
  const materials: Material[] = [];

  // 0: Stone floor
  materials.push({
    albedo: { x: 0.35, y: 0.33, z: 0.30 },
    emissive: { x: 0, y: 0, z: 0 },
    roughness: 1.0,
    materialType: MATERIAL_DIFFUSE,
  });

  // 1: Stone wall
  materials.push({
    albedo: { x: 0.45, y: 0.42, z: 0.38 },
    emissive: { x: 0, y: 0, z: 0 },
    roughness: 1.0,
    materialType: MATERIAL_DIFFUSE,
  });

  // 2: Ceiling
  materials.push({
    albedo: { x: 0.3, y: 0.28, z: 0.25 },
    emissive: { x: 0, y: 0, z: 0 },
    roughness: 1.0,
    materialType: MATERIAL_DIFFUSE,
  });

  // 3: Wall torch glow — large emissive wall section
  materials.push({
    albedo: { x: 0.9, y: 0.75, z: 0.45 },
    emissive: { x: 12, y: 8, z: 3 },
    roughness: 1.0,
    materialType: MATERIAL_EMISSIVE,
  });

  const MAT_FLOOR = 0;
  const MAT_WALL = 1;
  const MAT_CEILING = 2;
  const MAT_TORCH = 3;

  const mapH = DUNGEON_MAP.length;
  const mapW = DUNGEON_MAP[0].length;

  // Decide which wall faces get torches
  const torchFaces = new Set<string>();
  for (let z = 1; z < mapH - 1; z++) {
    for (let x = 1; x < mapW - 1; x++) {
      if (DUNGEON_MAP[z][x] !== 1) continue;
      if ((x + z) % 3 !== 0) continue;

      // Pick first open neighbor
      if (DUNGEON_MAP[z][x + 1] === 0) {
        torchFaces.add(`${x},${z},0`);
      } else if (DUNGEON_MAP[z][x - 1] === 0) {
        torchFaces.add(`${x},${z},1`);
      } else if (DUNGEON_MAP[z + 1]?.[x] === 0) {
        torchFaces.add(`${x},${z},2`);
      } else if (DUNGEON_MAP[z - 1]?.[x] === 0) {
        torchFaces.add(`${x},${z},3`);
      }
    }
  }

  // Force a torch on wall (4,3) facing -X — visible when player turns right from the phantom
  torchFaces.add('4,3,1');

  let torchCount = 0;

  for (let z = 0; z < mapH; z++) {
    for (let x = 0; x < mapW; x++) {
      const wx = x * TILE_SIZE;
      const wz = z * TILE_SIZE;

      if (DUNGEON_MAP[z][x] === 1) {
        // Wall faces adjacent to open space
        const neighbors = [
          { dx: 1, dz: 0, facing: 0 },
          { dx: -1, dz: 0, facing: 1 },
          { dx: 0, dz: 1, facing: 2 },
          { dx: 0, dz: -1, facing: 3 },
        ];

        for (const n of neighbors) {
          const nx = x + n.dx;
          const nz = z + n.dz;
          if (nx < 0 || nx >= mapW || nz < 0 || nz >= mapH) continue;
          if (DUNGEON_MAP[nz][nx] !== 0) continue;

          const key = `${x},${z},${n.facing}`;
          if (torchFaces.has(key)) {
            triangles.push(...makeWallWithTorch(wx, wz, n.facing, MAT_WALL, MAT_TORCH));
            torchCount++;
          } else {
            triangles.push(...makeWallFace(wx, wz, n.facing, MAT_WALL));
          }
        }
      } else {
        // Floor
        triangles.push(...makeQuad(
          { x: wx, y: 0, z: wz },
          { x: wx + TILE_SIZE, y: 0, z: wz },
          { x: wx + TILE_SIZE, y: 0, z: wz + TILE_SIZE },
          { x: wx, y: 0, z: wz + TILE_SIZE },
          MAT_FLOOR,
        ));
        // Ceiling — slightly below wall height to avoid coplanar
        const ceilY = WALL_HEIGHT - 0.005;
        triangles.push(...makeQuad(
          { x: wx, y: ceilY, z: wz + TILE_SIZE },
          { x: wx + TILE_SIZE, y: ceilY, z: wz + TILE_SIZE },
          { x: wx + TILE_SIZE, y: ceilY, z: wz },
          { x: wx, y: ceilY, z: wz },
          MAT_CEILING,
        ));
      }
    }
  }

  // Collect walkable tile centers for precomputed BVH
  const walkablePositions: { x: number; z: number }[] = [];
  for (let z = 0; z < mapH; z++) {
    for (let x = 0; x < mapW; x++) {
      if (DUNGEON_MAP[z][x] === 0) {
        walkablePositions.push({
          x: x * TILE_SIZE + TILE_SIZE / 2,
          z: z * TILE_SIZE + TILE_SIZE / 2,
        });
      }
    }
  }

  console.log(`Dungeon scene: ${triangles.length} triangles, ${materials.length} materials, ${torchCount} wall torches, ${walkablePositions.length} walkable tiles`);
  return { triangles, materials, walkablePositions };
}
