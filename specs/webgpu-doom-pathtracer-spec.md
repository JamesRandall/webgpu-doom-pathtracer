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
