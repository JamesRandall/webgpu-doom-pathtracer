# WebGPU Path-Traced Doom Renderer

## Project Overview

A browser-based path tracing renderer using WebGPU compute shaders, culminating in rendering classic Doom levels with real-time global illumination.

**Target:** Real-time path tracing at 720p+ with temporal accumulation, running in modern browsers with WebGPU support.

**Stack:** TypeScript, WebGPU, WGSL

---

## Development Phases

### Phase 1: Minimal Ray Tracer

**Goal:** Render a single triangle via compute shader ray tracing.

**Deliverables:**
- TypeScript project scaffolding with WebGPU initialisation
- Compute shader that generates camera rays for each pixel
- Ray-triangle intersection in WGSL
- Output to storage texture, blit to canvas
- Hardcoded triangle in the shader

**Acceptance criteria:**
- Coloured triangle visible on screen
- Camera position/direction configurable from TypeScript
- Runs in Chrome/Edge with WebGPU enabled

**Key files:**
```
src/
  main.ts           # Entry point, WebGPU setup
  renderer.ts       # Compute pipeline, dispatch, present
  shaders/
    raytrace.wgsl   # Ray generation, intersection, output
```

---

### Phase 2: Multiple Primitives

**Goal:** Render multiple triangles with proper depth handling.

**Deliverables:**
- Triangle data passed via storage buffer (positions, normals, colours)
- Shader iterates all triangles, tracks closest hit
- Basic diffuse shading with a hardcoded light direction
- Scene defined in TypeScript, uploaded to GPU

**Acceptance criteria:**
- Render a cube (12 triangles) with correct faces visible
- Different colours per face
- Basic lambertian shading

---

### Phase 3: BVH Acceleration

**Goal:** Implement bounding volume hierarchy for efficient ray traversal.

**Deliverables:**
- BVH construction on CPU (surface area heuristic or median split)
- Flattened BVH structure suitable for GPU traversal
- Iterative stack-based BVH traversal in WGSL
- Performance comparison vs brute force

**Data structures:**

```typescript
interface BVHNode {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  leftChildOrFirstTriangle: number;  // Index
  triangleCount: number;             // 0 = internal node
}
```

```wgsl
struct BVHNode {
  min_bounds: vec3f,
  max_bounds: vec3f,
  left_child_or_first_tri: u32,
  tri_count: u32,
}
```

**Acceptance criteria:**
- BVH correctly accelerates ray queries
- Stack depth sufficient for reasonable tree depth (32 levels)
- Measurable performance improvement over brute force with 1000+ triangles

---

### Phase 4: Simple Room Scene

**Goal:** Render an enclosed room with basic path tracing.

**Deliverables:**
- Cornell box style room (floor, ceiling, four walls)
- Multiple ray bounces (configurable, start with 4)
- Emissive light source (ceiling quad or similar)
- Diffuse materials with albedo colours
- PCG random number generator for sampling
- Hemisphere sampling for diffuse bounces

**Acceptance criteria:**
- Visible colour bleeding between walls
- Soft shadows from area light
- Noise reduces over accumulated frames

---

### Phase 5: Temporal Accumulation

**Goal:** Progressive rendering with frame accumulation.

**Deliverables:**
- Accumulation buffer (storage texture, float32)
- Frame counter for weighted averaging
- Camera movement resets accumulation
- Basic tone mapping (Reinhard or ACES)

**Acceptance criteria:**
- Image converges to clean result over ~100 frames when static
- Smooth camera interaction (accumulation resets, low sample count still navigable)

---

### Phase 5b: Spatial Denoiser

**Goal:** Clean image during camera movement with low sample counts.

**Deliverables:**
- Edge-aware spatial filter (bilateral or à-trous wavelet)
- G-buffer generation: normals and depth written alongside colour
- Filter respects edges — doesn't blur across depth/normal discontinuities
- Configurable filter strength/radius

**G-buffer additions:**

Extend your raytrace shader to output:
- Colour (already have this)
- World-space normal at primary hit
- Depth (ray t value or linear depth)
```wgsl
@group(0) @binding(1) var output_colour: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var output_normal: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var output_depth: texture_storage_2d<r32float, write>;
```

**Bilateral filter (simple approach):**

Separate compute pass after path tracing:
```wgsl
fn bilateral_weight(
    centre_normal: vec3f, sample_normal: vec3f,
    centre_depth: f32, sample_depth: f32,
    spatial_dist_sq: f32
) -> f32 {
    let normal_weight = pow(max(0.0, dot(centre_normal, sample_normal)), 128.0);
    let depth_weight = exp(-abs(centre_depth - sample_depth) * 10.0);
    let spatial_weight = exp(-spatial_dist_sq / 8.0);
    return normal_weight * depth_weight * spatial_weight;
}
```

Sample a kernel (5x5 or 7x7), weight by similarity, normalise.

**À-trous wavelet (better quality):**

Multiple passes at increasing step sizes (1, 2, 4, 8, 16 pixels). Each pass is a sparse 5x5 kernel. Gives large effective radius without massive kernel.

**Acceptance criteria:**
- Navigable image at 1-4 samples per pixel
- Sharp edges preserved at geometry boundaries
- Noise visibly reduced in flat areas
- Minimal ghosting or smearing during motion

**Notes:**
- Filter strength should be tunable — too aggressive looks plastic, too weak stays noisy
- Consider running denoiser at lower resolution and upscaling for performance
- This is spatial only; temporal reprojection is a separate enhancement

---

### Phase 5c: Temporal Reprojection

**Goal:** Maintain stable image during camera movement by blending with reprojected history.

**Deliverables:**
- Store previous frame's camera matrix
- Reproject current pixel world position to previous screen space
- Blend current sample with history based on validity
- Disocclusion detection to reject invalid history
- History buffer (separate from accumulation buffer)

**Core concept:**

Each frame, instead of just averaging with the accumulation buffer (which assumes static camera), you ask: "where was this surface last frame?" and sample the history there.
```
current pixel → world position → previous frame screen position → sample history → blend
```

**World position reconstruction:**

You already have depth from the G-buffer. Reconstruct world position:
```wgsl
fn reconstruct_world_pos(pixel: vec2f, depth: f32, inv_view_proj: mat4x4f) -> vec3f {
    let ndc = vec2f(
        (pixel.x / screen_width) * 2.0 - 1.0,
        1.0 - (pixel.y / screen_height) * 2.0
    );
    let clip = vec4f(ndc, depth, 1.0);
    let world = inv_view_proj * clip;
    return world.xyz / world.w;
}
```

**Reprojection:**
```wgsl
fn reproject(world_pos: vec3f, prev_view_proj: mat4x4f) -> vec2f {
    let clip = prev_view_proj * vec4f(world_pos, 1.0);
    let ndc = clip.xy / clip.w;
    return vec2f(
        (ndc.x * 0.5 + 0.5) * screen_width,
        (0.5 - ndc.y * 0.5) * screen_height
    );
}
```

**Disocclusion detection:**

Compare current depth with reprojected previous depth. If they differ significantly, the surface wasn't visible last frame:
```wgsl
let prev_pixel = reproject(world_pos, prev_view_proj);
let prev_depth = sample_prev_depth(prev_pixel);
let expected_depth = compute_expected_depth(world_pos, prev_view_proj);

let depth_threshold = 0.1;
let valid_history = abs(prev_depth - expected_depth) < depth_threshold;
```

Also reject if reprojected position is off-screen.

**Blending:**
```wgsl
let blend_factor = select(1.0, 0.1, valid_history);  // 10% new if history valid, 100% new if not
let result = mix(history_colour, current_colour, blend_factor);
```

**Additional rejection heuristics:**

- Normal difference: if surface normal changed significantly, reject history
- Motion vectors: for very fast motion, increase blend factor toward current
- Clamping: clamp history colour to neighbourhood min/max of current frame to reduce ghosting

**Neighbourhood clamping (reduces ghosting):**
```wgsl
// Sample 3x3 neighbourhood of current frame
let min_colour = /* min of neighbourhood */;
let max_colour = /* max of neighbourhood */;
let clamped_history = clamp(history_colour, min_colour, max_colour);
let result = mix(clamped_history, current_colour, blend_factor);
```

**Buffers needed:**

- Current colour (path trace output)
- Current depth (G-buffer)
- Current normal (G-buffer)
- History colour (previous frame's output)
- History depth (previous frame's depth)
- Previous camera matrices (CPU uniform)

**Pipeline:**

1. Path trace → current colour, depth, normal
2. Temporal reprojection pass → blend with history
3. Spatial denoise (5b) → clean up remaining noise
4. Copy result to history buffer for next frame
5. Tonemap and present

**Acceptance criteria:**
- Smooth camera movement without obvious dotty noise
- Minimal ghosting on edges and thin geometry
- Disoccluded regions (coming around corners) converge within a few frames
- No smearing or trailing on moving camera

**Notes:**
- Order matters: temporal first, then spatial. Temporal brings in history, spatial cleans up what's left.
- The blend factor (0.1) is a starting point — tune based on how aggressive your denoiser is
- Neighbourhood clamping is essential to avoid ghosting; don't skip it
- You'll need to double-buffer or ping-pong the history texture

---

### Phase 6: Materials

**Goal:** Support multiple material types.

**Deliverables:**
- Material buffer with per-triangle material indices
- Material properties: albedo, emissive, roughness
- Diffuse and basic specular (GGX or simplified)
- Russian roulette path termination

**Data structures:**

```typescript
interface Material {
  albedoR: number; albedoG: number; albedoB: number;
  emissiveR: number; emissiveG: number; emissiveB: number;
  roughness: number;
  materialType: number;  // 0 = diffuse, 1 = specular, 2 = emissive
}
```

**Acceptance criteria:**
- Reflective surfaces show environment
- Emissive surfaces contribute light
- Energy conservation (scene doesn't blow out or darken over bounces)

---

### Phase 7: WAD Parsing

**Goal:** Load Doom level geometry from WAD files.

**Deliverables:**
- WAD file parser (TypeScript)
- THINGS, LINEDEFS, SIDEDEFS, VERTEXES, SECTORS lump parsing
- Conversion from Doom's 2.5D format to triangle meshes:
  - Walls: quads from floor to ceiling heights
  - Floors/ceilings: triangulated sector polygons
- Basic texture coordinate generation (for future use)

**Notes:**
- Doom coordinates: 1 unit ≈ 1 inch, scale appropriately
- Sector heights define floor/ceiling, linedefs define walls
- Two-sided linedefs need upper/lower textures for height differences

**Acceptance criteria:**
- E1M1 geometry loads and renders
- All walls, floors, ceilings present
- No missing or inverted faces

---

### Phase 8: Doom Lighting

**Goal:** Meaningful lighting in Doom levels.

**Deliverables:**
- Identify emissive textures (LITE*, torch textures, etc.)
- Sky texture handling (F_SKY1 sectors become emissive ceiling or sky dome)
- Optional: extract Doom's sector light levels as hints for emissive intensity
- Adjustable global emissive multiplier for tuning

**Acceptance criteria:**
- E1M1 has recognisable lighting
- Light sources illuminate nearby geometry
- Dark areas remain dark, lit areas glow appropriately

---

### Phase 9: Camera Controls

**Goal:** First-person navigation.

**Deliverables:**
- WASD + mouse look controls
- Collision detection (optional, can be deferred)
- Configurable movement speed
- Pointer lock API integration

**Acceptance criteria:**
- Smooth navigation through Doom levels
- Accumulation handles motion gracefully

---

### Phase 10: Optimisation & Polish

**Goal:** Production-quality renderer.

**Deliverables:**
- Tiled dispatch for better GPU occupancy
- Importance sampling for materials
- Simple temporal denoiser (optional, stretch goal)
- Resolution scaling
- Performance metrics overlay (rays/sec, samples/pixel)

**Acceptance criteria:**
- 30+ fps at 720p on mid-range hardware
- Clean image within 2-3 seconds of camera stop

---

### Phase 11: Doom Textures

**Goal:** Apply original Doom textures to level geometry.

**Deliverables:**
- WAD texture extraction (patches, textures, flats, palette)
- Texture atlas or texture array on GPU
- UV generation during geometry conversion
- Texture sampling in path trace shader
- Transparent texture handling

**WAD Lump Parsing:**

Extract these lumps from the WAD:

| Lump | Purpose |
|------|---------|
| `PLAYPAL` | 256-colour palette (768 bytes, RGB triplets) |
| `PNAMES` | List of patch names |
| `TEXTURE1`, `TEXTURE2` | Texture composition definitions |
| `P_START` to `P_END` | Patch graphics |
| `F_START` to `F_END` | Flat graphics (floors/ceilings) |

**Patch format:**
```typescript
interface PatchHeader {
  width: number;       // u16
  height: number;      // u16
  leftOffset: number;  // i16
  topOffset: number;   // i16
}
// Followed by column offsets and column data (run-length encoded)
```

**Texture composition:**

TEXTURE1/2 defines how patches combine:
```typescript
interface TextureDef {
  name: string;        // 8 chars
  width: number;
  height: number;
  patches: Array<{
    originX: number;
    originY: number;
    patchIndex: number;  // Index into PNAMES
  }>;
}
```

Composite patches onto a canvas to build final texture.

**Flat format:**

Simpler — raw 64x64 bytes, palette indices. No header.
```typescript
function parseFlat(data: Uint8Array, palette: Uint8Array): ImageData {
  // data is 4096 bytes, each byte is palette index
  // palette is 768 bytes, RGB triplets
}
```

**Texture atlas construction:**
```typescript
interface AtlasEntry {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TextureAtlas {
  image: ImageData;      // Or Uint8Array RGBA
  entries: Map<string, AtlasEntry>;
  size: number;          // Atlas is square, power of two
}
```

Pack textures using simple shelf algorithm or more sophisticated bin packing. 2048x2048 or 4096x4096 should fit everything.

**UV generation for walls:**

From sidedef data during geometry conversion:
```typescript
function computeWallUVs(
  linedef: Linedef,
  sidedef: Sidedef,
  texture: AtlasEntry,
  wallTop: number,
  wallBottom: number
): { uv0: vec2, uv1: vec2, uv2: vec2, uv3: vec2 } {
  
  const lineLength = length(linedef.end - linedef.start);
  
  // Doom units to texture pixels (textures tile at native resolution)
  const u0 = sidedef.xOffset / texture.width;
  const u1 = (sidedef.xOffset + lineLength) / texture.width;
  
  const wallHeight = wallTop - wallBottom;
  const v0 = sidedef.yOffset / texture.height;
  const v1 = (sidedef.yOffset + wallHeight) / texture.height;
  
  // Convert to atlas coordinates
  return atlasUVs(texture, u0, v0, u1, v1);
}
```

**UV generation for flats:**

World-aligned, 64-unit repeat:
```typescript
function computeFlatUV(worldPos: vec3, flat: AtlasEntry): vec2 {
  const u = worldPos.x / 64.0;
  const v = worldPos.y / 64.0;
  return atlasUV(flat, fract(u), fract(v));
}
```

Per-vertex during triangulation of sector polygons.

**Shader changes:**

Extend triangle data:
```wgsl
struct Triangle {
  v0: vec3f, v1: vec3f, v2: vec3f,
  n0: vec3f, n1: vec3f, n2: vec3f,
  uv0: vec2f, uv1: vec2f, uv2: vec2f,
  material_index: u32,
  texture_index: u32,  // Index into atlas entries buffer, or -1 for none
}
```

Sample at hit point:
```wgsl
fn get_albedo(hit: HitInfo, tri: Triangle) -> vec3f {
  if (tri.texture_index == 0xFFFFFFFFu) {
    return materials[tri.material_index].albedo;
  }
  
  // Barycentric interpolation
  let w = 1.0 - hit.u - hit.v;
  let uv = w * tri.uv0 + hit.u * tri.uv1 + hit.v * tri.uv2;
  
  // Sample atlas
  let tex_colour = textureSampleLevel(atlas, atlas_sampler, uv, 0.0);
  return tex_colour.rgb;
}
```

**Transparent textures:**

Doom uses palette index 255 for transparency. During atlas construction, set alpha to 0 for these pixels.

In shader, either:
- Alpha test and continue ray through surface
- Or mark transparent textures specially and handle in intersection
```wgsl
let tex_colour = textureSampleLevel(atlas, atlas_sampler, uv, 0.0);
if (tex_colour.a < 0.5) {
  // Transparent — ignore this hit, continue ray
  return trace_ray(ray_advance(ray, hit.t + 0.001));
}
```

Note: this requires rethinking your traversal slightly, or handling transparency as a special case after initial hit.

**Sky handling:**

Detect `F_SKY1` flat on ceilings. Options:

1. **Emissive sky colour:** Mark sky surfaces with high emissive value
2. **Environment map:** Sample a sky texture based on ray direction when hitting sky
3. **Simple gradient:** Return a procedural sky colour based on ray direction
```wgsl
if (hit.is_sky) {
  let sky_colour = mix(
    vec3f(0.5, 0.7, 1.0),  // Horizon
    vec3f(0.2, 0.4, 0.9),  // Zenith
    ray.direction.z
  );
  return sky_colour * sky_intensity;
}
```

**Sampler configuration:**
```typescript
const atlasSampler = device.createSampler({
  magFilter: 'nearest',    // Keep pixelated look
  minFilter: 'nearest',
  addressModeU: 'repeat',  // Textures tile
  addressModeV: 'repeat',
});
```

Use `nearest` filtering to preserve Doom's chunky aesthetic. Linear filtering will blur the pixels.

**Acceptance criteria:**
- E1M1 renders with correct wall and flat textures
- Textures align correctly (no obvious offset errors)
- Textures tile correctly on large surfaces
- Transparent sections of textures (gratings, etc.) handled
- Sky surfaces emit light or show sky colour
- Palette colours look authentic to original Doom

**Notes:**
- Start with flats only — simpler format, easier to debug
- Then add wall textures — more complex composition
- Leave animated textures for later (or out of scope)
- The palette has a distinctive look; resist the urge to "improve" the colours

---

## Technical Notes

### WebGPU Initialisation

```typescript
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
const context = canvas.getContext('webgpu');
context.configure({
  device,
  format: navigator.gpu.getPreferredCanvasFormat(),
  alphaMode: 'premultiplied',
});
```

### Compute Shader Dispatch

Output texture dimensions determine workgroup count:

```typescript
const workgroupSize = [8, 8];
const dispatchX = Math.ceil(width / workgroupSize[0]);
const dispatchY = Math.ceil(height / workgroupSize[1]);
passEncoder.dispatchWorkgroups(dispatchX, dispatchY);
```

### WGSL Limitations

- No recursion — all traversal must be iterative with explicit stacks
- No dynamic array indexing in some contexts — be careful with variable indices
- Storage buffer size limits vary by device — check `maxStorageBufferBindingSize`

### Random Number Generation

PCG is simple and effective:

```wgsl
fn pcg(state: ptr<function, u32>) -> f32 {
    *state = *state * 747796405u + 2891336453u;
    let word = ((*state >> ((*state >> 28u) + 4u)) ^ *state) * 277803737u;
    return f32((word >> 22u) ^ word) / 4294967295.0;
}

fn rand_seed(pixel: vec2u, frame: u32) -> u32 {
    return pixel.x * 1973u + pixel.y * 9277u + frame * 26699u;
}
```

### Hemisphere Sampling (Cosine-Weighted)

```wgsl
fn cosine_hemisphere(normal: vec3f, r1: f32, r2: f32) -> vec3f {
    let phi = 2.0 * PI * r1;
    let cos_theta = sqrt(r2);
    let sin_theta = sqrt(1.0 - r2);
    
    let x = cos(phi) * sin_theta;
    let y = sin(phi) * sin_theta;
    let z = cos_theta;
    
    // Build tangent space from normal
    let tangent = select(
        normalize(cross(vec3f(0.0, 1.0, 0.0), normal)),
        normalize(cross(vec3f(1.0, 0.0, 0.0), normal)),
        abs(normal.y) > 0.999
    );
    let bitangent = cross(normal, tangent);
    
    return tangent * x + bitangent * y + normal * z;
}
```

### Ray-Triangle Intersection (Möller–Trumbore)

```wgsl
fn intersect_triangle(ray_origin: vec3f, ray_dir: vec3f, v0: vec3f, v1: vec3f, v2: vec3f) -> f32 {
    let edge1 = v1 - v0;
    let edge2 = v2 - v0;
    let h = cross(ray_dir, edge2);
    let a = dot(edge1, h);
    
    if (abs(a) < 0.00001) { return -1.0; }
    
    let f = 1.0 / a;
    let s = ray_origin - v0;
    let u = f * dot(s, h);
    
    if (u < 0.0 || u > 1.0) { return -1.0; }
    
    let q = cross(s, edge1);
    let v = f * dot(ray_dir, q);
    
    if (v < 0.0 || u + v > 1.0) { return -1.0; }
    
    let t = f * dot(edge2, q);
    return select(-1.0, t, t > 0.00001);
}
```

### Ray-AABB Intersection

```wgsl
fn intersect_aabb(ray_origin: vec3f, ray_dir_inv: vec3f, box_min: vec3f, box_max: vec3f, max_t: f32) -> bool {
    let t1 = (box_min - ray_origin) * ray_dir_inv;
    let t2 = (box_max - ray_origin) * ray_dir_inv;
    
    let tmin = max(max(min(t1.x, t2.x), min(t1.y, t2.y)), min(t1.z, t2.z));
    let tmax = min(min(max(t1.x, t2.x), max(t1.y, t2.y)), max(t1.z, t2.z));
    
    return tmax >= tmin && tmin < max_t && tmax > 0.0;
}
```

---

## File Structure

```
webgpu-doom-pathtracer/
├── src/
│   ├── main.ts
│   ├── renderer.ts
│   ├── camera.ts
│   ├── bvh/
│   │   ├── builder.ts
│   │   └── types.ts
│   ├── scene/
│   │   ├── scene.ts
│   │   ├── materials.ts
│   │   └── geometry.ts
│   ├── doom/
│   │   ├── wad-parser.ts
│   │   ├── level-converter.ts
│   │   └── textures.ts
│   ├── shaders/
│   │   ├── raytrace.wgsl
│   │   ├── accumulate.wgsl
│   │   └── tonemap.wgsl
│   └── utils/
│       ├── webgpu-utils.ts
│       └── math.ts
├── public/
│   ├── index.html
│   └── wads/           # User-supplied WAD files
├── package.json
├── tsconfig.json
└── README.md
```

---

## Dependencies

```json
{
  "devDependencies": {
    "typescript": "^5.0.0",
    "vite": "^5.0.0",
    "@webgpu/types": "^0.1.0"
  }
}
```

No runtime dependencies required. Keep it lean.

---

## Success Metrics

1. **Phase 4 complete:** Soft shadows and colour bleeding visible in Cornell box
2. **Phase 7 complete:** E1M1 geometry renders correctly
3. **Phase 10 complete:** 30+ fps navigation through E1M1 with converging GI

---

## Out of Scope (For Now)

- Sprites (enemies, pickups, decorations)
- Animated textures
- Doors and moving platforms
- Sound
- Gameplay

These can be added later but are not part of the initial renderer scope.
