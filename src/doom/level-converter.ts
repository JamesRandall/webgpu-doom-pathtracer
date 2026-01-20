// Convert Doom level data to triangle meshes
import { LevelData, Vertex, Linedef, Sidedef, Sector } from './wad-parser';
import { Triangle, Material, Vec3, Vec2, SceneData, MATERIAL_DIFFUSE, MATERIAL_EMISSIVE } from '../scene/geometry';
import { TextureAtlas, AtlasEntry } from './textures';

// Doom units to world units scale (Doom 1 unit ≈ 1 inch, we'll use ~1/64 for reasonable world scale)
const SCALE = 1 / 64;

// Global emissive multiplier for tuning light intensity
const EMISSIVE_MULTIPLIER = 3.0;

// Linedef flags
const ML_TWOSIDED = 0x0004;

// Emissive texture patterns
const EMISSIVE_TEXTURES = [
  'LITE',     // LITE3, LITE5, LITEBLU1, etc.
  'TLITE',    // TLITE6_1, etc.
  'BFALL',    // Blood fall (glowing)
  'SFALL',    // Slime fall (glowing)
  'FIREBLU',  // Animated fire
  'FIRELAV',  // Fire/lava
  'FIREMAG',  // Fire/magma
  'FIREWALA', // Fire wall
  'FIREWALB',
  'FIREWALL',
  'NUKAGE',   // Nukage (glowing green)
  'FWATER',   // Glowing water
  'LAVA',     // Lava
  'BLOOD',    // Blood (slightly glowing)
  'COMP',     // Computer screens (COMPSTA*, etc.)
  'COMPSTA',
  'SW1COMP',  // Computer switches
  'SW2COMP',
];

interface SectorPolygon {
  sectorIndex: number;
  vertices: Vec3[];
}

// Check if a texture name is emissive
function isEmissiveTexture(textureName: string): boolean {
  const upper = textureName.toUpperCase().replace(/\0/g, '');
  for (const pattern of EMISSIVE_TEXTURES) {
    if (upper.startsWith(pattern)) {
      return true;
    }
  }
  return false;
}

// Get emissive color based on texture name
function getEmissiveColor(textureName: string): Vec3 {
  const upper = textureName.toUpperCase();

  if (upper.includes('BLU') || upper.includes('COMP')) {
    // Blue lights / computer screens
    return { x: 0.3 * EMISSIVE_MULTIPLIER, y: 0.5 * EMISSIVE_MULTIPLIER, z: 1.0 * EMISSIVE_MULTIPLIER };
  } else if (upper.includes('FIRE') || upper.includes('LAV') || upper.includes('RED')) {
    // Fire / lava - orange/red
    return { x: 1.0 * EMISSIVE_MULTIPLIER, y: 0.4 * EMISSIVE_MULTIPLIER, z: 0.1 * EMISSIVE_MULTIPLIER };
  } else if (upper.includes('NUK') || upper.includes('SLIME') || upper.includes('SFALL')) {
    // Nukage / slime - green
    return { x: 0.2 * EMISSIVE_MULTIPLIER, y: 1.0 * EMISSIVE_MULTIPLIER, z: 0.2 * EMISSIVE_MULTIPLIER };
  } else if (upper.includes('BLOOD') || upper.includes('BFALL')) {
    // Blood - dark red
    return { x: 0.8 * EMISSIVE_MULTIPLIER, y: 0.1 * EMISSIVE_MULTIPLIER, z: 0.1 * EMISSIVE_MULTIPLIER };
  } else {
    // Default white/yellow light
    return { x: 1.0 * EMISSIVE_MULTIPLIER, y: 0.95 * EMISSIVE_MULTIPLIER, z: 0.8 * EMISSIVE_MULTIPLIER };
  }
}

// Convert sector light level (0-255) to brightness multiplier
function lightLevelToBrightness(lightLevel: number): number {
  // Doom light levels: 0 = dark, 255 = bright
  // Use linear mapping with a floor to prevent total darkness
  // Boost overall brightness for path tracing (needs more light than rasterization)
  const normalized = lightLevel / 255;
  return 0.3 + 0.7 * normalized;
}

// Atlas entry lookup helper
let textureAtlas: TextureAtlas | null = null;
let atlasEntryList: AtlasEntry[] = [];

// Set the texture atlas for UV generation
export function setTextureAtlas(atlas: TextureAtlas | null): void {
  textureAtlas = atlas;
  if (atlas) {
    atlasEntryList = Array.from(atlas.entries.values());
  } else {
    atlasEntryList = [];
  }
}

// Get texture index from name
function getTextureIndex(textureName: string): number {
  if (!textureAtlas) return -1;
  const upperName = textureName.toUpperCase().replace(/\0/g, '').replace(/-/g, '');
  if (!upperName || upperName === '-') return -1;

  const entry = textureAtlas.entries.get(upperName);
  if (!entry) return -1;

  return atlasEntryList.indexOf(entry);
}

// Get atlas UV for a texture
function getAtlasUV(textureName: string, localU: number, localV: number): Vec2 {
  if (!textureAtlas) return { u: localU, v: localV };

  const upperName = textureName.toUpperCase().replace(/\0/g, '').replace(/-/g, '');
  if (!upperName || upperName === '-') return { u: localU, v: localV };

  const entry = textureAtlas.entries.get(upperName);
  if (!entry) return { u: localU, v: localV };

  // Convert local UV (0-1 within texture) to atlas UV
  // Note: we allow tiling so localU/V can be > 1
  const atlasU = (entry.x + (localU % 1) * entry.width) / textureAtlas.width;
  const atlasV = (entry.y + (localV % 1) * entry.height) / textureAtlas.height;

  return { u: atlasU, v: atlasV };
}

export function convertLevelToScene(level: LevelData): SceneData {
  const triangles: Triangle[] = [];
  const materials: Material[] = [];
  const materialCache: Map<string, number> = new Map();

  // Helper to get or create a material
  function getMaterial(
    type: 'wall' | 'floor' | 'ceiling' | 'sky',
    lightLevel: number,
    textureName: string = ''
  ): number {
    const isEmissive = isEmissiveTexture(textureName);
    const brightness = lightLevelToBrightness(lightLevel);
    const key = `${type}-${lightLevel}-${textureName}-${isEmissive}`;

    if (materialCache.has(key)) {
      return materialCache.get(key)!;
    }

    const index = materials.length;
    materialCache.set(key, index);

    if (type === 'sky') {
      // Sky is always emissive
      materials.push({
        albedo: { x: 0.6, y: 0.7, z: 0.9 },
        emissive: { x: 1.5, y: 2.0, z: 3.0 },
        roughness: 1.0,
        materialType: MATERIAL_EMISSIVE,
      });
    } else if (isEmissive) {
      const emissiveColor = getEmissiveColor(textureName);
      materials.push({
        albedo: { x: 1.0, y: 1.0, z: 1.0 },
        emissive: emissiveColor,
        roughness: 1.0,
        materialType: MATERIAL_EMISSIVE,
      });
    } else {
      // Apply brightness from sector light level
      // Shader will use this as brightness multiplier for textured surfaces
      materials.push({
        albedo: {
          x: brightness,
          y: brightness,
          z: brightness,
        },
        emissive: { x: 0, y: 0, z: 0 },
        roughness: 0.85,
        materialType: MATERIAL_DIFFUSE,
      });
    }

    return index;
  }

  // Convert vertices from Doom coordinates to our coordinate system
  const convertVertex = (v: Vertex, height: number): Vec3 => ({
    x: v.x * SCALE,
    y: height * SCALE,
    z: v.y * SCALE,
  });

  // Helper function to create a wall quad with UVs
  function createWallQuad(
    v1: Vertex,
    v2: Vertex,
    bottomHeight: number,
    topHeight: number,
    materialIndex: number,
    flip: boolean,
    textureName: string = '',
    xOffset: number = 0,
    yOffset: number = 0
  ): Triangle[] {
    const p1 = convertVertex(v1, bottomHeight);
    const p2 = convertVertex(v2, bottomHeight);
    const p3 = convertVertex(v2, topHeight);
    const p4 = convertVertex(v1, topHeight);

    // Calculate wall dimensions in Doom units
    const wallLength = Math.sqrt(
      (v2.x - v1.x) * (v2.x - v1.x) + (v2.y - v1.y) * (v2.y - v1.y)
    );
    const wallHeight = topHeight - bottomHeight;

    // Get texture dimensions (default to 64x64 if not found)
    let texWidth = 64;
    let texHeight = 64;
    const texIndex = getTextureIndex(textureName);

    if (textureAtlas && textureName) {
      const upperName = textureName.toUpperCase().replace(/\0/g, '').replace(/-/g, '');
      const entry = textureAtlas.entries.get(upperName);
      if (entry) {
        texWidth = entry.width;
        texHeight = entry.height;
      }
    }

    // Calculate UV coordinates
    // U runs along the wall length, V runs vertically
    const uvU0 = xOffset / texWidth;
    const uvU1 = (xOffset + wallLength) / texWidth;
    const uvV0 = yOffset / texHeight;
    const uvV1 = (yOffset + wallHeight) / texHeight;

    // Create UV coordinates for quad corners
    // p1 = bottom-left, p2 = bottom-right, p3 = top-right, p4 = top-left
    const uv1: Vec2 = { u: uvU0, v: uvV1 }; // bottom-left
    const uv2: Vec2 = { u: uvU1, v: uvV1 }; // bottom-right
    const uv3: Vec2 = { u: uvU1, v: uvV0 }; // top-right
    const uv4: Vec2 = { u: uvU0, v: uvV0 }; // top-left

    const tris: Triangle[] = [];

    if (flip) {
      tris.push(createTriangleWithUV(p2, p1, p4, materialIndex, uv2, uv1, uv4, texIndex));
      tris.push(createTriangleWithUV(p2, p4, p3, materialIndex, uv2, uv4, uv3, texIndex));
    } else {
      tris.push(createTriangleWithUV(p1, p2, p3, materialIndex, uv1, uv2, uv3, texIndex));
      tris.push(createTriangleWithUV(p1, p3, p4, materialIndex, uv1, uv3, uv4, texIndex));
    }

    return tris;
  }

  // Process walls from linedefs
  for (let i = 0; i < level.linedefs.length; i++) {
    const linedef = level.linedefs[i];
    const v1 = level.vertices[linedef.startVertex];
    const v2 = level.vertices[linedef.endVertex];

    // Process right sidedef
    if (linedef.rightSidedef !== -1) {
      const sidedef = level.sidedefs[linedef.rightSidedef];
      const sector = level.sectors[sidedef.sector];

      if (linedef.flags & ML_TWOSIDED) {
        if (linedef.leftSidedef !== -1) {
          const backSidedef = level.sidedefs[linedef.leftSidedef];
          const backSector = level.sectors[backSidedef.sector];

          // Upper wall
          if (sector.ceilingHeight > backSector.ceilingHeight) {
            const mat = getMaterial('wall', sector.lightLevel, sidedef.upperTexture);
            triangles.push(...createWallQuad(
              v1, v2, backSector.ceilingHeight, sector.ceilingHeight, mat, false,
              sidedef.upperTexture, sidedef.xOffset, sidedef.yOffset
            ));
          }

          // Lower wall
          if (sector.floorHeight < backSector.floorHeight) {
            const mat = getMaterial('wall', sector.lightLevel, sidedef.lowerTexture);
            triangles.push(...createWallQuad(
              v1, v2, sector.floorHeight, backSector.floorHeight, mat, false,
              sidedef.lowerTexture, sidedef.xOffset, sidedef.yOffset
            ));
          }

          // Middle texture (if present, for fences/gratings)
          if (sidedef.middleTexture && sidedef.middleTexture !== '-') {
            const mat = getMaterial('wall', sector.lightLevel, sidedef.middleTexture);
            const top = Math.min(sector.ceilingHeight, backSector.ceilingHeight);
            const bottom = Math.max(sector.floorHeight, backSector.floorHeight);
            if (top > bottom) {
              triangles.push(...createWallQuad(
                v1, v2, bottom, top, mat, false,
                sidedef.middleTexture, sidedef.xOffset, sidedef.yOffset
              ));
            }
          }
        }
      } else {
        // One-sided linedef
        const mat = getMaterial('wall', sector.lightLevel, sidedef.middleTexture);
        triangles.push(...createWallQuad(
          v1, v2, sector.floorHeight, sector.ceilingHeight, mat, false,
          sidedef.middleTexture, sidedef.xOffset, sidedef.yOffset
        ));
      }
    }

    // Process left sidedef
    if (linedef.leftSidedef !== -1) {
      const sidedef = level.sidedefs[linedef.leftSidedef];
      const sector = level.sectors[sidedef.sector];

      if (linedef.flags & ML_TWOSIDED) {
        if (linedef.rightSidedef !== -1) {
          const frontSidedef = level.sidedefs[linedef.rightSidedef];
          const frontSector = level.sectors[frontSidedef.sector];

          // Upper wall (from back side)
          if (sector.ceilingHeight > frontSector.ceilingHeight) {
            const mat = getMaterial('wall', sector.lightLevel, sidedef.upperTexture);
            triangles.push(...createWallQuad(
              v1, v2, frontSector.ceilingHeight, sector.ceilingHeight, mat, true,
              sidedef.upperTexture, sidedef.xOffset, sidedef.yOffset
            ));
          }

          // Lower wall (from back side)
          if (sector.floorHeight < frontSector.floorHeight) {
            const mat = getMaterial('wall', sector.lightLevel, sidedef.lowerTexture);
            triangles.push(...createWallQuad(
              v1, v2, sector.floorHeight, frontSector.floorHeight, mat, true,
              sidedef.lowerTexture, sidedef.xOffset, sidedef.yOffset
            ));
          }
        }
      }
    }
  }

  // Build floor and ceiling polygons for each sector
  const sectorPolygons = buildSectorPolygonsFromLinedefs(level);

  for (const polygon of sectorPolygons) {
    const sector = level.sectors[polygon.sectorIndex];

    // Check if ceiling is sky
    const isSky = sector.ceilingTexture.toUpperCase().startsWith('F_SKY');

    // Floor material
    const floorMat = getMaterial('floor', sector.lightLevel, sector.floorTexture);

    // Ceiling material
    const ceilingMat = isSky
      ? getMaterial('sky', 255, 'SKY')
      : getMaterial('ceiling', sector.lightLevel, sector.ceilingTexture);

    // Triangulate and add floor
    const floorTris = triangulatePolygon(
      polygon.vertices, sector.floorHeight * SCALE, false,
      sector.floorTexture
    );
    for (const tri of floorTris) {
      triangles.push({ ...tri, materialIndex: floorMat });
    }

    // Triangulate and add ceiling
    const ceilingTris = triangulatePolygon(
      polygon.vertices, sector.ceilingHeight * SCALE, true,
      isSky ? '' : sector.ceilingTexture  // No texture for sky
    );
    for (const tri of ceilingTris) {
      triangles.push({ ...tri, materialIndex: ceilingMat });
    }
  }

  console.log(`Converted level ${level.name}: ${triangles.length} triangles, ${materials.length} materials`);

  return { triangles, materials };
}

// Create a triangle with computed normal (no texture)
function createTriangle(v0: Vec3, v1: Vec3, v2: Vec3, materialIndex: number): Triangle {
  const edge1 = subtract(v1, v0);
  const edge2 = subtract(v2, v0);
  const normal = normalize(cross(edge1, edge2));

  return {
    v0, v1, v2, normal, materialIndex,
    uv0: { u: 0, v: 0 },
    uv1: { u: 1, v: 0 },
    uv2: { u: 1, v: 1 },
    textureIndex: -1,
  };
}

// Create a triangle with computed normal and UVs
function createTriangleWithUV(
  v0: Vec3, v1: Vec3, v2: Vec3,
  materialIndex: number,
  uv0: Vec2, uv1: Vec2, uv2: Vec2,
  textureIndex: number
): Triangle {
  const edge1 = subtract(v1, v0);
  const edge2 = subtract(v2, v0);
  const normal = normalize(cross(edge1, edge2));

  return { v0, v1, v2, normal, materialIndex, uv0, uv1, uv2, textureIndex };
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
  if (len === 0) return { x: 0, y: 1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

// Build polygons from BSP subsectors (these are convex, easy to triangulate)
function buildSectorPolygonsFromSubsectors(level: LevelData): SectorPolygon[] {
  const polygons: SectorPolygon[] = [];

  // If no subsector data, fall back to linedef tracing
  if (!level.subsectors || level.subsectors.length === 0 || !level.segs || level.segs.length === 0) {
    console.warn('No subsector data, falling back to linedef polygon building');
    return buildSectorPolygonsFromLinedefs(level);
  }

  for (const subsector of level.subsectors) {
    const vertices: Vec3[] = [];
    let sectorIndex = -1;

    // Collect vertices from segs
    for (let i = 0; i < subsector.segCount; i++) {
      const segIndex = subsector.firstSeg + i;
      if (segIndex >= level.segs.length) continue;

      const seg = level.segs[segIndex];
      const v = level.vertices[seg.startVertex];
      vertices.push({ x: v.x * SCALE, y: 0, z: v.y * SCALE });

      // Get sector from the linedef's sidedef
      if (sectorIndex === -1 && seg.linedef < level.linedefs.length) {
        const linedef = level.linedefs[seg.linedef];
        // seg.direction: 0 = same as linedef (use right sidedef), 1 = opposite (use left sidedef)
        const sidedefIndex = seg.direction === 0 ? linedef.rightSidedef : linedef.leftSidedef;
        if (sidedefIndex !== -1 && sidedefIndex < level.sidedefs.length) {
          sectorIndex = level.sidedefs[sidedefIndex].sector;
        }
      }
    }

    if (vertices.length >= 3 && sectorIndex !== -1) {
      polygons.push({ sectorIndex, vertices });
    }
  }

  console.log(`Built ${polygons.length} polygons from ${level.subsectors.length} subsectors`);
  return polygons;
}

// Fallback: Build polygons by tracing linedef edges
function buildSectorPolygonsFromLinedefs(level: LevelData): SectorPolygon[] {
  const polygons: SectorPolygon[] = [];

  const sectorLinedefs: Map<number, { linedef: Linedef; startVertex: number; endVertex: number }[]> = new Map();

  for (const linedef of level.linedefs) {
    if (linedef.rightSidedef !== -1) {
      const sectorIndex = level.sidedefs[linedef.rightSidedef].sector;
      if (!sectorLinedefs.has(sectorIndex)) {
        sectorLinedefs.set(sectorIndex, []);
      }
      sectorLinedefs.get(sectorIndex)!.push({
        linedef,
        startVertex: linedef.startVertex,
        endVertex: linedef.endVertex,
      });
    }

    if (linedef.leftSidedef !== -1) {
      const sectorIndex = level.sidedefs[linedef.leftSidedef].sector;
      if (!sectorLinedefs.has(sectorIndex)) {
        sectorLinedefs.set(sectorIndex, []);
      }
      sectorLinedefs.get(sectorIndex)!.push({
        linedef,
        startVertex: linedef.endVertex,
        endVertex: linedef.startVertex,
      });
    }
  }

  for (const [sectorIndex, edges] of sectorLinedefs) {
    const usedEdges = new Set<number>();

    while (usedEdges.size < edges.length) {
      let startEdgeIndex = -1;
      for (let i = 0; i < edges.length; i++) {
        if (!usedEdges.has(i)) {
          startEdgeIndex = i;
          break;
        }
      }
      if (startEdgeIndex === -1) break;

      const polygon: Vec3[] = [];
      let currentEdgeIndex = startEdgeIndex;
      let currentVertex = edges[currentEdgeIndex].startVertex;
      const firstVertex = currentVertex;

      let safety = 0;
      const maxIterations = edges.length + 1;

      while (safety < maxIterations) {
        safety++;

        if (currentEdgeIndex === -1) break;
        if (usedEdges.has(currentEdgeIndex)) {
          if (edges[currentEdgeIndex].startVertex === firstVertex) break;
          currentEdgeIndex = -1;
          break;
        }

        usedEdges.add(currentEdgeIndex);
        const edge = edges[currentEdgeIndex];

        const v = level.vertices[edge.startVertex];
        polygon.push({ x: v.x * SCALE, y: 0, z: v.y * SCALE });

        currentVertex = edge.endVertex;

        currentEdgeIndex = -1;
        for (let i = 0; i < edges.length; i++) {
          if (!usedEdges.has(i) && edges[i].startVertex === currentVertex) {
            currentEdgeIndex = i;
            break;
          }
        }

        if (currentVertex === firstVertex) break;
      }

      if (polygon.length >= 3) {
        polygons.push({ sectorIndex, vertices: polygon });
      }
    }
  }

  return polygons;
}

// Cross product for 2D vectors (returns z component)
function cross2D(ax: number, az: number, bx: number, bz: number): number {
  return ax * bz - az * bx;
}

// Check if point P is inside triangle ABC using barycentric coordinates
function pointInTriangle(
  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number,
  cx: number, cz: number
): boolean {
  const v0x = cx - ax, v0z = cz - az;
  const v1x = bx - ax, v1z = bz - az;
  const v2x = px - ax, v2z = pz - az;

  const dot00 = v0x * v0x + v0z * v0z;
  const dot01 = v0x * v1x + v0z * v1z;
  const dot02 = v0x * v2x + v0z * v2z;
  const dot11 = v1x * v1x + v1z * v1z;
  const dot12 = v1x * v2x + v1z * v2z;

  const denom = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denom) < 1e-10) return false;

  const invDenom = 1 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

  // Use small epsilon for edge cases
  return (u >= -1e-6) && (v >= -1e-6) && (u + v <= 1 + 1e-6);
}

// Ear clipping triangulation
function triangulatePolygon(
  vertices: Vec3[],
  height: number,
  flip: boolean,
  flatTexture: string = ''
): Triangle[] {
  if (vertices.length < 3) return [];

  const triangles: Triangle[] = [];

  // Get texture index for flat
  const texIndex = getTextureIndex(flatTexture);

  // Work with indices into original array
  const indices: number[] = [];
  for (let i = 0; i < vertices.length; i++) {
    indices.push(i);
  }

  // Remove duplicate/near-duplicate vertices
  const cleaned: number[] = [];
  for (let i = 0; i < indices.length; i++) {
    const curr = indices[i];
    const next = indices[(i + 1) % indices.length];
    const dx = vertices[curr].x - vertices[next].x;
    const dz = vertices[curr].z - vertices[next].z;
    if (dx * dx + dz * dz > 1e-10) {
      cleaned.push(curr);
    }
  }

  if (cleaned.length < 3) return [];

  // Calculate signed area to determine winding
  let area = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const j = (i + 1) % cleaned.length;
    area += vertices[cleaned[i]].x * vertices[cleaned[j]].z;
    area -= vertices[cleaned[j]].x * vertices[cleaned[i]].z;
  }
  const clockwise = area < 0;

  // Ear clipping
  const remaining = [...cleaned];
  let safety = 0;
  const maxIter = remaining.length * remaining.length;

  while (remaining.length > 3 && safety < maxIter) {
    safety++;
    let earFound = false;

    for (let i = 0; i < remaining.length; i++) {
      const n = remaining.length;
      const prevIdx = remaining[(i + n - 1) % n];
      const currIdx = remaining[i];
      const nextIdx = remaining[(i + 1) % n];

      const ax = vertices[prevIdx].x, az = vertices[prevIdx].z;
      const bx = vertices[currIdx].x, bz = vertices[currIdx].z;
      const cx = vertices[nextIdx].x, cz = vertices[nextIdx].z;

      // Check if this is a convex vertex
      const cross = cross2D(bx - ax, bz - az, cx - bx, cz - bz);
      const isConvex = clockwise ? cross <= 0 : cross >= 0;

      if (!isConvex) continue;

      // Check no other vertex is inside this triangle
      let hasPointInside = false;
      for (let j = 0; j < remaining.length; j++) {
        if (j === (i + n - 1) % n || j === i || j === (i + 1) % n) continue;
        const idx = remaining[j];
        if (pointInTriangle(vertices[idx].x, vertices[idx].z, ax, az, bx, bz, cx, cz)) {
          hasPointInside = true;
          break;
        }
      }

      if (!hasPointInside) {
        // This is an ear - create triangle
        const v0 = { x: vertices[prevIdx].x, y: height, z: vertices[prevIdx].z };
        const v1 = { x: vertices[currIdx].x, y: height, z: vertices[currIdx].z };
        const v2 = { x: vertices[nextIdx].x, y: height, z: vertices[nextIdx].z };

        if (flip) {
          triangles.push(createTriangleWithUV(
            v0, v2, v1, 0,
            { u: v0.x, v: v0.z },
            { u: v2.x, v: v2.z },
            { u: v1.x, v: v1.z },
            texIndex
          ));
        } else {
          triangles.push(createTriangleWithUV(
            v0, v1, v2, 0,
            { u: v0.x, v: v0.z },
            { u: v1.x, v: v1.z },
            { u: v2.x, v: v2.z },
            texIndex
          ));
        }

        remaining.splice(i, 1);
        earFound = true;
        break;
      }
    }

    if (!earFound) {
      // Fallback: just create a triangle from first 3 vertices
      const prevIdx = remaining[0];
      const currIdx = remaining[1];
      const nextIdx = remaining[2];

      const v0 = { x: vertices[prevIdx].x, y: height, z: vertices[prevIdx].z };
      const v1 = { x: vertices[currIdx].x, y: height, z: vertices[currIdx].z };
      const v2 = { x: vertices[nextIdx].x, y: height, z: vertices[nextIdx].z };

      if (flip) {
        triangles.push(createTriangleWithUV(
          v0, v2, v1, 0,
          { u: v0.x, v: v0.z },
          { u: v2.x, v: v2.z },
          { u: v1.x, v: v1.z },
          texIndex
        ));
      } else {
        triangles.push(createTriangleWithUV(
          v0, v1, v2, 0,
          { u: v0.x, v: v0.z },
          { u: v1.x, v: v1.z },
          { u: v2.x, v: v2.z },
          texIndex
        ));
      }
      remaining.splice(1, 1);
    }
  }

  // Handle final triangle
  if (remaining.length === 3) {
    const v0 = { x: vertices[remaining[0]].x, y: height, z: vertices[remaining[0]].z };
    const v1 = { x: vertices[remaining[1]].x, y: height, z: vertices[remaining[1]].z };
    const v2 = { x: vertices[remaining[2]].x, y: height, z: vertices[remaining[2]].z };

    if (flip) {
      triangles.push(createTriangleWithUV(
        v0, v2, v1, 0,
        { u: v0.x, v: v0.z },
        { u: v2.x, v: v2.z },
        { u: v1.x, v: v1.z },
        texIndex
      ));
    } else {
      triangles.push(createTriangleWithUV(
        v0, v1, v2, 0,
        { u: v0.x, v: v0.z },
        { u: v1.x, v: v1.z },
        { u: v2.x, v: v2.z },
        texIndex
      ));
    }
  }

  return triangles;
}
