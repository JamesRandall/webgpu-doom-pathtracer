const PI = 3.14159265359;

// Material types
const MATERIAL_DIFFUSE = 0u;
const MATERIAL_SPECULAR = 1u;
const MATERIAL_EMISSIVE = 2u;

struct Camera {
  position: vec3f,
  _pad0: f32,
  direction: vec3f,
  _pad1: f32,
  up: vec3f,
  _pad2: f32,
  resolution: vec2f,
  fov: f32,
  _pad3: f32,
}

struct TriangleVerts {
  v0: vec3f,
  _pad0: f32,
  v1: vec3f,
  _pad1: f32,
  v2: vec3f,
  _pad2: f32,
}

struct TriangleAttribs {
  normal: vec3f,
  material_index: u32,
  uv0: vec2f,
  uv1: vec2f,
  uv2: vec2f,
  texture_index: i32,
  _pad3: f32,
}

// Atlas entry for texture lookup
struct AtlasEntry {
  x: f32,
  y: f32,
  width: f32,
  height: f32,
}

struct Material {
  albedo: vec3f,
  roughness: f32,
  emissive: vec3f,
  material_type: u32,
}

struct BVHNode {
  min_bounds: vec3f,
  left_child_or_first_tri: u32,
  max_bounds: vec3f,
  right_child_or_count: u32,
}

struct SceneInfo {
  triangle_count: u32,
  node_count: u32,
  frame: u32,
  max_bounces: u32,
  samples_per_pixel: u32,
  atlas_width: u32,
  atlas_height: u32,
  player_light_falloff: f32,
  player_light_color: vec3f,
  player_light_radius: f32,
  dynamic_tri_offset: u32,
  dynamic_tri_count: u32,
  light_count: u32,
  debug_mode: u32,
  dynamic_aabb_min: vec3f,
  debug_opacity: f32,
  dynamic_aabb_max: vec3f,
  debug_depth: u32,
  debug_window: u32,
  _pad4: u32,
  _pad5: u32,
  _pad6: u32,
}

struct HitInfo {
  t: f32,
  tri_index: u32,
  bary_u: f32,
  bary_v: f32,
  hit: bool,
  is_player_light: bool,
}

struct ResolvedHit {
  t: f32,
  normal: vec3f,
  material_index: u32,
  uv: vec2f,
  texture_index: i32,
  hit: bool,
  is_player_light: bool,
}

@group(0) @binding(0) var output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var<storage, read> tri_verts: array<TriangleVerts>;
@group(0) @binding(3) var<storage, read> materials: array<Material>;
@group(0) @binding(4) var<storage, read> bvh_nodes: array<BVHNode>;
@group(0) @binding(5) var<uniform> scene_info: SceneInfo;
@group(0) @binding(6) var output_normal: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var output_depth: texture_storage_2d<r32float, write>;
@group(0) @binding(8) var texture_atlas: texture_2d<f32>;
@group(0) @binding(9) var atlas_sampler: sampler;
@group(0) @binding(10) var<storage, read> atlas_entries: array<AtlasEntry>;
@group(0) @binding(11) var<storage, read> tri_attribs: array<TriangleAttribs>;

struct LightInfo {
  tri_index: u32,
  area: f32,
}

@group(0) @binding(12) var<storage, read> lights: array<LightInfo>;

const MAX_STACK_SIZE = 32u;
const LEAF_FLAG = 0x80000000u;

// PCG random number generator
fn pcg(state: ptr<function, u32>) -> f32 {
  *state = *state * 747796405u + 2891336453u;
  let word = ((*state >> ((*state >> 28u) + 4u)) ^ *state) * 277803737u;
  return f32((word >> 22u) ^ word) / 4294967295.0;
}

// Seed RNG based on pixel and frame
fn rand_seed(pixel: vec2u, frame: u32) -> u32 {
  return pixel.x * 1973u + pixel.y * 9277u + frame * 26699u;
}

// Cosine-weighted hemisphere sampling
fn cosine_hemisphere(normal: vec3f, r1: f32, r2: f32) -> vec3f {
  let phi = 2.0 * PI * r1;
  let cos_theta = sqrt(r2);
  let sin_theta = sqrt(1.0 - r2);

  let x = cos(phi) * sin_theta;
  let y = sin(phi) * sin_theta;
  let z = cos_theta;

  // Build tangent space from normal
  var tangent: vec3f;
  if (abs(normal.y) > 0.999) {
    tangent = normalize(cross(vec3f(1.0, 0.0, 0.0), normal));
  } else {
    tangent = normalize(cross(vec3f(0.0, 1.0, 0.0), normal));
  }
  let bitangent = cross(normal, tangent);

  return tangent * x + bitangent * y + normal * z;
}

fn sample_triangle_point(v0: vec3f, v1: vec3f, v2: vec3f, r1: f32, r2: f32) -> vec3f {
  let sqrt_r1 = sqrt(r1);
  let u = 1.0 - sqrt_r1;
  let v = r2 * sqrt_r1;
  return v0 * u + v1 * v + v2 * (1.0 - u - v);
}

// Build orthonormal basis from normal
fn build_basis(normal: vec3f) -> mat3x3f {
  var tangent: vec3f;
  if (abs(normal.y) > 0.999) {
    tangent = normalize(cross(vec3f(1.0, 0.0, 0.0), normal));
  } else {
    tangent = normalize(cross(vec3f(0.0, 1.0, 0.0), normal));
  }
  let bitangent = cross(normal, tangent);
  return mat3x3f(tangent, bitangent, normal);
}

// GGX normal distribution function
fn ggx_d(n_dot_h: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let d = n_dot_h * n_dot_h * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

// GGX geometry function (Smith)
fn ggx_g1(n_dot_v: f32, roughness: f32) -> f32 {
  let k = roughness * roughness / 2.0;
  return n_dot_v / (n_dot_v * (1.0 - k) + k);
}

fn ggx_g(n_dot_v: f32, n_dot_l: f32, roughness: f32) -> f32 {
  return ggx_g1(n_dot_v, roughness) * ggx_g1(n_dot_l, roughness);
}

// Fresnel-Schlick approximation
fn fresnel_schlick(cos_theta: f32, f0: vec3f) -> vec3f {
  return f0 + (1.0 - f0) * pow(1.0 - cos_theta, 5.0);
}

// Sample GGX distribution (importance sampling)
fn sample_ggx(normal: vec3f, roughness: f32, r1: f32, r2: f32) -> vec3f {
  let a = roughness * roughness;
  let a2 = a * a;

  // Sample spherical coordinates
  let phi = 2.0 * PI * r1;
  let cos_theta = sqrt((1.0 - r2) / (1.0 + (a2 - 1.0) * r2));
  let sin_theta = sqrt(1.0 - cos_theta * cos_theta);

  // Convert to Cartesian in tangent space
  let h_local = vec3f(
    cos(phi) * sin_theta,
    sin(phi) * sin_theta,
    cos_theta
  );

  // Transform to world space
  let basis = build_basis(normal);
  return normalize(basis * h_local);
}

// Reflect direction around normal
fn reflect_dir(incident: vec3f, normal: vec3f) -> vec3f {
  return incident - 2.0 * dot(incident, normal) * normal;
}

// Increase saturation of a color
fn saturate_color(color: vec3f, saturation: f32) -> vec3f {
  let luminance = dot(color, vec3f(0.299, 0.587, 0.114));
  return mix(vec3f(luminance), color, saturation);
}

// Sample texture from atlas with saturation boost
fn sample_texture(texture_index: i32, uv: vec2f, atlas_size: vec2f) -> vec4f {
  if (texture_index < 0) {
    return vec4f(1.0, 1.0, 1.0, 1.0);  // No texture, return white
  }

  let entry = atlas_entries[texture_index];

  // Calculate atlas UV with tiling
  let local_u = fract(uv.x);
  let local_v = fract(uv.y);

  let atlas_u = (entry.x + local_u * entry.width) / atlas_size.x;
  let atlas_v = (entry.y + local_v * entry.height) / atlas_size.y;

  var color = textureSampleLevel(texture_atlas, atlas_sampler, vec2f(atlas_u, atlas_v), 0.0);

  // Boost saturation (1.0 = normal, >1.0 = more saturated)
  // Extra boost for warm colors (reds/browns)
  let warmth = max(color.r - max(color.g, color.b), 0.0);
  let saturation_boost = 1.4 + warmth * 0.4;  // 1.4 base, up to 1.8 for warm colors

  color = vec4f(saturate_color(color.rgb, saturation_boost), color.a);

  return color;
}

// Triangle hit result with barycentric coordinates
struct TriangleHitResult {
  t: f32,
  u: f32,
  v: f32,
}

// Ray-Triangle intersection using Moller-Trumbore algorithm
fn intersect_triangle(ray_origin: vec3f, ray_dir: vec3f, v0: vec3f, v1: vec3f, v2: vec3f) -> f32 {
  let edge1 = v1 - v0;
  let edge2 = v2 - v0;
  let h = cross(ray_dir, edge2);
  let a = dot(edge1, h);

  if (abs(a) < 0.00001) {
    return -1.0;
  }

  let f = 1.0 / a;
  let s = ray_origin - v0;
  let u = f * dot(s, h);

  if (u < 0.0 || u > 1.0) {
    return -1.0;
  }

  let q = cross(s, edge1);
  let v = f * dot(ray_dir, q);

  if (v < 0.0 || u + v > 1.0) {
    return -1.0;
  }

  let t = f * dot(edge2, q);

  if (t > 0.0001) {
    return t;
  }

  return -1.0;
}

// Ray-Triangle intersection with barycentric coordinates for UV interpolation
fn intersect_triangle_uv(ray_origin: vec3f, ray_dir: vec3f, v0: vec3f, v1: vec3f, v2: vec3f) -> TriangleHitResult {
  var result: TriangleHitResult;
  result.t = -1.0;
  result.u = 0.0;
  result.v = 0.0;

  let edge1 = v1 - v0;
  let edge2 = v2 - v0;
  let h = cross(ray_dir, edge2);
  let a = dot(edge1, h);

  if (abs(a) < 0.00001) {
    return result;
  }

  let f = 1.0 / a;
  let s = ray_origin - v0;
  let u = f * dot(s, h);

  if (u < 0.0 || u > 1.0) {
    return result;
  }

  let q = cross(s, edge1);
  let v = f * dot(ray_dir, q);

  if (v < 0.0 || u + v > 1.0) {
    return result;
  }

  let t = f * dot(edge2, q);

  if (t > 0.0001) {
    result.t = t;
    result.u = u;
    result.v = v;
  }

  return result;
}

// Ray-AABB intersection
fn intersect_aabb(ray_origin: vec3f, ray_dir_inv: vec3f, box_min: vec3f, box_max: vec3f, max_t: f32) -> bool {
  let t1 = (box_min - ray_origin) * ray_dir_inv;
  let t2 = (box_max - ray_origin) * ray_dir_inv;

  let tmin = max(max(min(t1.x, t2.x), min(t1.y, t2.y)), min(t1.z, t2.z));
  let tmax = min(min(max(t1.x, t2.x), max(t1.y, t2.y)), max(t1.z, t2.z));

  return tmax >= tmin && tmin < max_t && tmax > 0.0;
}

fn is_leaf(node: BVHNode) -> bool {
  return (node.right_child_or_count & LEAF_FLAG) != 0u;
}

fn get_tri_count(node: BVHNode) -> u32 {
  return node.right_child_or_count & 0x7FFFFFFFu;
}

// Ray-AABB intersection returning t values for ordered traversal
fn intersect_aabb_t(ray_origin: vec3f, ray_dir_inv: vec3f, box_min: vec3f, box_max: vec3f) -> vec2f {
  let t1 = (box_min - ray_origin) * ray_dir_inv;
  let t2 = (box_max - ray_origin) * ray_dir_inv;

  let tmin = max(max(min(t1.x, t2.x), min(t1.y, t2.y)), min(t1.z, t2.z));
  let tmax = min(min(max(t1.x, t2.x), max(t1.y, t2.y)), max(t1.z, t2.z));

  return vec2f(tmin, tmax);
}

// Ray-sphere intersection, returns t or -1
fn intersect_sphere(ray_origin: vec3f, ray_dir: vec3f, center: vec3f, radius: f32) -> f32 {
  let oc = ray_origin - center;
  let b = dot(oc, ray_dir);
  let c = dot(oc, oc) - radius * radius;
  let disc = b * b - c;
  if (disc < 0.0) { return -1.0; }
  let sqrt_disc = sqrt(disc);
  var t = -b - sqrt_disc;
  if (t < 0.001) {
    t = -b + sqrt_disc;
  }
  if (t < 0.001) { return -1.0; }
  return t;
}

// Resolve attributes from closest hit (cold data lookup, done once per ray)
fn resolve_hit(hit: HitInfo) -> ResolvedHit {
  var r: ResolvedHit;
  r.t = hit.t;
  r.hit = hit.hit;
  r.is_player_light = hit.is_player_light;

  if (!hit.hit || hit.is_player_light) {
    r.material_index = 0u;
    r.uv = vec2f(0.0, 0.0);
    r.texture_index = -1;
    r.normal = vec3f(0.0);
    return r;
  }

  let attrib = tri_attribs[hit.tri_index];
  r.normal = attrib.normal;
  r.material_index = attrib.material_index;
  r.texture_index = attrib.texture_index;

  let w = 1.0 - hit.bary_u - hit.bary_v;
  r.uv = w * attrib.uv0 + hit.bary_u * attrib.uv1 + hit.bary_v * attrib.uv2;

  return r;
}

// Brute-force trace all triangles (no BVH)
fn trace_brute(ray_origin: vec3f, ray_dir: vec3f) -> HitInfo {
  var closest_hit: HitInfo;
  closest_hit.t = 1e30;
  closest_hit.hit = false;
  closest_hit.is_player_light = false;
  closest_hit.tri_index = 0u;
  closest_hit.bary_u = 0.0;
  closest_hit.bary_v = 0.0;

  for (var i = 0u; i < scene_info.triangle_count; i++) {
    let verts = tri_verts[i];
    let hit_result = intersect_triangle_uv(ray_origin, ray_dir, verts.v0, verts.v1, verts.v2);
    if (hit_result.t > 0.0 && hit_result.t < closest_hit.t) {
      closest_hit.t = hit_result.t;
      closest_hit.tri_index = i;
      closest_hit.bary_u = hit_result.u;
      closest_hit.bary_v = hit_result.v;
      closest_hit.hit = true;
    }
  }

  return closest_hit;
}

// Trace ray using BVH with ordered traversal (reads only verts — hot data)
fn trace_bvh_accel(ray_origin: vec3f, ray_dir: vec3f) -> HitInfo {
  var closest_hit: HitInfo;
  closest_hit.t = 1e30;
  closest_hit.hit = false;
  closest_hit.is_player_light = false;
  closest_hit.tri_index = 0u;
  closest_hit.bary_u = 0.0;
  closest_hit.bary_v = 0.0;

  let ray_dir_inv = 1.0 / ray_dir;

  var stack: array<u32, MAX_STACK_SIZE>;
  var stack_ptr = 0u;

  stack[0] = 0u;
  stack_ptr = 1u;

  while (stack_ptr > 0u) {
    stack_ptr -= 1u;
    let node_idx = stack[stack_ptr];
    let node = bvh_nodes[node_idx];

    if (!intersect_aabb(ray_origin, ray_dir_inv, node.min_bounds, node.max_bounds, closest_hit.t)) {
      continue;
    }

    if (is_leaf(node)) {
      let tri_count = get_tri_count(node);
      let first_tri = node.left_child_or_first_tri;

      for (var i = 0u; i < tri_count; i++) {
        let tri_idx = first_tri + i;
        let verts = tri_verts[tri_idx];
        let hit_result = intersect_triangle_uv(ray_origin, ray_dir, verts.v0, verts.v1, verts.v2);

        if (hit_result.t > 0.0 && hit_result.t < closest_hit.t) {
          closest_hit.t = hit_result.t;
          closest_hit.tri_index = tri_idx;
          closest_hit.bary_u = hit_result.u;
          closest_hit.bary_v = hit_result.v;
          closest_hit.hit = true;
        }
      }
    } else {
      let left_child = node.left_child_or_first_tri;
      let right_child = node.right_child_or_count;

      if (stack_ptr < MAX_STACK_SIZE - 1u) {
        let left_node = bvh_nodes[left_child];
        let right_node = bvh_nodes[right_child];

        let left_t = intersect_aabb_t(ray_origin, ray_dir_inv, left_node.min_bounds, left_node.max_bounds);
        let right_t = intersect_aabb_t(ray_origin, ray_dir_inv, right_node.min_bounds, right_node.max_bounds);

        let left_hit = left_t.y >= left_t.x && left_t.x < closest_hit.t && left_t.y > 0.0;
        let right_hit = right_t.y >= right_t.x && right_t.x < closest_hit.t && right_t.y > 0.0;

        if (left_hit && right_hit) {
          if (left_t.x < right_t.x) {
            stack[stack_ptr] = right_child;
            stack_ptr += 1u;
            stack[stack_ptr] = left_child;
            stack_ptr += 1u;
          } else {
            stack[stack_ptr] = left_child;
            stack_ptr += 1u;
            stack[stack_ptr] = right_child;
            stack_ptr += 1u;
          }
        } else if (left_hit) {
          stack[stack_ptr] = left_child;
          stack_ptr += 1u;
        } else if (right_hit) {
          stack[stack_ptr] = right_child;
          stack_ptr += 1u;
        }
      }
    }
  }

  return closest_hit;
}

// Unified trace: BVH for static geometry, then brute-force dynamic triangles + player light sphere
fn trace_scene(ray_origin: vec3f, ray_dir: vec3f, bounce: u32) -> HitInfo {
  var hit: HitInfo;
  if (scene_info.node_count == 0u) {
    hit = trace_brute(ray_origin, ray_dir);
  } else {
    hit = trace_bvh_accel(ray_origin, ray_dir);
  }

  // Test dynamic (non-BVH) triangles — AABB early-out, first 2 bounces (visibility + shadow)
  if (bounce < 2u && scene_info.dynamic_tri_count > 0u && intersect_aabb(ray_origin, 1.0 / ray_dir, scene_info.dynamic_aabb_min, scene_info.dynamic_aabb_max, hit.t)) {
    for (var i = 0u; i < scene_info.dynamic_tri_count; i++) {
      let tri_idx = scene_info.dynamic_tri_offset + i;
      let verts = tri_verts[tri_idx];
      let hit_result = intersect_triangle_uv(ray_origin, ray_dir, verts.v0, verts.v1, verts.v2);
      if (hit_result.t > 0.0 && hit_result.t < hit.t) {
        hit.t = hit_result.t;
        hit.tri_index = tri_idx;
        hit.bary_u = hit_result.u;
        hit.bary_v = hit_result.v;
        hit.hit = true;
      }
    }
  }

  // Player light sphere — emissive sphere at camera position
  // Only test if ray origin is outside the sphere (skip primary rays from camera)
  if (scene_info.player_light_radius > 0.0 && length(ray_origin - camera.position) > scene_info.player_light_radius + 0.01) {
    let sphere_t = intersect_sphere(ray_origin, ray_dir, camera.position, scene_info.player_light_radius);
    if (sphere_t > 0.0 && sphere_t < hit.t) {
      hit.t = sphere_t;
      hit.hit = true;
      hit.is_player_light = true;
    }
  }

  return hit;
}

// Generate camera ray for a given pixel
fn generate_ray(pixel: vec2f) -> vec3f {
  let aspect = camera.resolution.x / camera.resolution.y;
  let fov_scale = tan(camera.fov * 0.5);

  let ndc = vec2f(
    (2.0 * pixel.x / camera.resolution.x - 1.0) * aspect * fov_scale,
    (1.0 - 2.0 * pixel.y / camera.resolution.y) * fov_scale
  );

  let forward = normalize(camera.direction);
  let right = normalize(cross(forward, camera.up));
  let up = cross(right, forward);

  return normalize(forward + right * ndc.x + up * ndc.y);
}

// --- Debug visualisation ---

fn heatmap(value: f32, max_value: f32) -> vec3f {
  let t = clamp(value / max_value, 0.0, 1.0);
  if (t < 0.25) {
    let s = t / 0.25;
    return vec3f(0.0, s, 1.0);
  } else if (t < 0.5) {
    let s = (t - 0.25) / 0.25;
    return vec3f(0.0, 1.0, 1.0 - s);
  } else if (t < 0.75) {
    let s = (t - 0.5) / 0.25;
    return vec3f(s, 1.0, 0.0);
  } else {
    let s = (t - 0.75) / 0.25;
    return vec3f(1.0, 1.0 - s, 0.0);
  }
}

struct DebugHitInfo {
  hit: HitInfo,
  nodes_visited: u32,
  leaf_depth: u32,
  leaf_tri_count: u32,
}

fn trace_bvh_debug(ray_origin: vec3f, ray_dir: vec3f) -> DebugHitInfo {
  var result: DebugHitInfo;
  result.nodes_visited = 0u;
  result.leaf_depth = 0u;
  result.leaf_tri_count = 0u;
  result.hit.t = 1e30;
  result.hit.hit = false;
  result.hit.is_player_light = false;
  result.hit.tri_index = 0u;
  result.hit.bary_u = 0.0;
  result.hit.bary_v = 0.0;

  let ray_dir_inv = 1.0 / ray_dir;

  var stack: array<u32, MAX_STACK_SIZE>;
  var depth_stack: array<u32, MAX_STACK_SIZE>;
  var stack_ptr = 0u;

  stack[0] = 0u;
  depth_stack[0] = 0u;
  stack_ptr = 1u;

  while (stack_ptr > 0u) {
    stack_ptr -= 1u;
    let node_idx = stack[stack_ptr];
    let current_depth = depth_stack[stack_ptr];
    let node = bvh_nodes[node_idx];

    result.nodes_visited += 1u;

    if (!intersect_aabb(ray_origin, ray_dir_inv, node.min_bounds, node.max_bounds, result.hit.t)) {
      continue;
    }

    if (is_leaf(node)) {
      let tri_count = get_tri_count(node);
      let first_tri = node.left_child_or_first_tri;

      for (var i = 0u; i < tri_count; i++) {
        let tri_idx = first_tri + i;
        let verts = tri_verts[tri_idx];
        let hit_result = intersect_triangle_uv(ray_origin, ray_dir, verts.v0, verts.v1, verts.v2);

        if (hit_result.t > 0.0 && hit_result.t < result.hit.t) {
          result.hit.t = hit_result.t;
          result.hit.hit = true;
          result.hit.tri_index = tri_idx;
          result.hit.bary_u = hit_result.u;
          result.hit.bary_v = hit_result.v;
          result.leaf_depth = current_depth;
          result.leaf_tri_count = tri_count;
        }
      }
    } else {
      let left_child = node.left_child_or_first_tri;
      let right_child = node.right_child_or_count;

      if (stack_ptr < MAX_STACK_SIZE - 1u) {
        stack[stack_ptr] = left_child;
        depth_stack[stack_ptr] = current_depth + 1u;
        stack_ptr += 1u;
        stack[stack_ptr] = right_child;
        depth_stack[stack_ptr] = current_depth + 1u;
        stack_ptr += 1u;
      }
    }
  }

  return result;
}

fn trace_aabb_wireframe(ray_origin: vec3f, ray_dir: vec3f, target_depth: u32) -> f32 {
  let ray_dir_inv = 1.0 / ray_dir;

  var stack: array<u32, MAX_STACK_SIZE>;
  var depth_stack: array<u32, MAX_STACK_SIZE>;
  var stack_ptr = 0u;
  var wireframe = 0.0;

  stack[0] = 0u;
  depth_stack[0] = 0u;
  stack_ptr = 1u;

  while (stack_ptr > 0u) {
    stack_ptr -= 1u;
    let node_idx = stack[stack_ptr];
    let current_depth = depth_stack[stack_ptr];
    let node = bvh_nodes[node_idx];

    let t_vals = intersect_aabb_t(ray_origin, ray_dir_inv, node.min_bounds, node.max_bounds);
    let hit_aabb = t_vals.y >= t_vals.x && t_vals.y > 0.0;

    if (!hit_aabb) { continue; }

    if (current_depth == target_depth) {
      let t_enter = max(t_vals.x, 0.001);
      let hit_point = ray_origin + ray_dir * t_enter;
      let box_size = node.max_bounds - node.min_bounds;
      let local = (hit_point - node.min_bounds) / max(box_size, vec3f(0.001));

      let edge_threshold = 0.02;
      let near_x = local.x < edge_threshold || local.x > (1.0 - edge_threshold);
      let near_y = local.y < edge_threshold || local.y > (1.0 - edge_threshold);
      let near_z = local.z < edge_threshold || local.z > (1.0 - edge_threshold);

      if ((near_x && near_y) || (near_x && near_z) || (near_y && near_z)) {
        wireframe = 1.0;
      }
      continue;
    }

    if (!is_leaf(node) && current_depth < target_depth) {
      let left_child = node.left_child_or_first_tri;
      let right_child = node.right_child_or_count;

      if (stack_ptr < MAX_STACK_SIZE - 1u) {
        stack[stack_ptr] = left_child;
        depth_stack[stack_ptr] = current_depth + 1u;
        stack_ptr += 1u;
        stack[stack_ptr] = right_child;
        depth_stack[stack_ptr] = current_depth + 1u;
        stack_ptr += 1u;
      }
    }
  }

  return wireframe;
}

fn compute_debug_color(ray_origin: vec3f, ray_dir: vec3f) -> vec3f {
  var debug_color = vec3f(0.0);

  if (scene_info.debug_mode == 1u) {
    let debug_hit = trace_bvh_debug(ray_origin, ray_dir);
    if (debug_hit.hit.hit) {
      debug_color = heatmap(f32(debug_hit.nodes_visited), 100.0);
    }
  } else if (scene_info.debug_mode == 2u) {
    let debug_hit = trace_bvh_debug(ray_origin, ray_dir);
    if (debug_hit.hit.hit) {
      debug_color = heatmap(f32(debug_hit.leaf_depth), 20.0);
    }
  } else if (scene_info.debug_mode == 3u) {
    let debug_hit = trace_bvh_debug(ray_origin, ray_dir);
    if (debug_hit.hit.hit) {
      debug_color = heatmap(f32(debug_hit.leaf_tri_count), 16.0);
    }
  } else if (scene_info.debug_mode == 4u) {
    let debug_hit = trace_bvh_debug(ray_origin, ray_dir);
    var base_color = vec3f(0.0);
    if (debug_hit.hit.hit) {
      let hit = resolve_hit(debug_hit.hit);
      var n = hit.normal;
      if (dot(ray_dir, n) > 0.0) { n = -n; }
      let ndl = max(dot(n, normalize(vec3f(1.0, 1.0, -1.0))), 0.1);
      base_color = vec3f(ndl * 0.7);
    }
    let wire = trace_aabb_wireframe(ray_origin, ray_dir, scene_info.debug_depth);
    debug_color = mix(base_color, vec3f(0.0, 1.0, 0.0), wire);
  }

  return debug_color;
}

// Path trace a single ray, optionally outputting primary hit info for G-buffer
fn path_trace(ray_origin_in: vec3f, ray_dir_in: vec3f, rng_state: ptr<function, u32>, out_normal: ptr<function, vec3f>, out_depth: ptr<function, f32>) -> vec3f {
  var ray_origin = ray_origin_in;
  var ray_dir = ray_dir_in;
  var throughput = vec3f(1.0);
  var radiance = vec3f(0.0);
  var last_bsdf_pdf = 0.0;
  var last_was_specular = true;

  for (var bounce = 0u; bounce < scene_info.max_bounces; bounce++) {
    let raw_hit = trace_scene(ray_origin, ray_dir, bounce);

    if (!raw_hit.hit) {
      // Miss - return background (dark for indoor scene)
      break;
    }

    // Resolve attributes from cold buffer (once per bounce, only for closest hit)
    let hit = resolve_hit(raw_hit);

    // Output primary hit info for G-buffer on first bounce
    if (bounce == 0u) {
      if (hit.is_player_light) {
        let sphere_hit_pos = ray_origin + ray_dir * hit.t;
        *out_normal = normalize(sphere_hit_pos - camera.position);
      } else {
        var pn = hit.normal;
        if (dot(ray_dir, pn) > 0.0) {
          pn = -pn;
        }
        *out_normal = pn;
      }
      *out_depth = hit.t;
    }

    // Player light sphere hit — treat as emissive and stop
    if (hit.is_player_light) {
      radiance += throughput * scene_info.player_light_color;
      break;
    }

    // Get material properties
    let mat = materials[hit.material_index];

    // Sample texture if available
    let atlas_size = vec2f(f32(scene_info.atlas_width), f32(scene_info.atlas_height));
    let tex_color = sample_texture(hit.texture_index, hit.uv, atlas_size);

    // Combine texture color with material
    var surface_color: vec3f;
    if (hit.texture_index >= 0) {
      let brightness = (mat.albedo.x + mat.albedo.y + mat.albedo.z) / 3.0;
      surface_color = tex_color.rgb * brightness;
    } else {
      surface_color = mat.albedo;
    }

    // Handle emissive surfaces with MIS weighting
    if (mat.material_type == MATERIAL_EMISSIVE) {
      var w = 1.0;
      // Apply MIS weight for BSDF-sampled diffuse bounces that hit a light
      if (!last_was_specular && scene_info.light_count > 0u && bounce > 0u) {
        let ev = tri_verts[raw_hit.tri_index];
        let e1 = ev.v1 - ev.v0;
        let e2 = ev.v2 - ev.v0;
        let tri_area = 0.5 * length(cross(e1, e2));
        let cos_light = max(abs(dot(hit.normal, -ray_dir)), 0.001);
        let p_light = (hit.t * hit.t) / (f32(scene_info.light_count) * tri_area * max(cos_light, 0.001));
        let p_bsdf = last_bsdf_pdf;
        w = p_bsdf / (0.5 * (p_bsdf + p_light));
      }
      radiance += throughput * mat.emissive * w;
      break;
    }
    radiance += throughput * mat.emissive;

    // Calculate hit position
    let hit_pos = ray_origin + ray_dir * hit.t;

    // Ensure we're on the correct side of the surface
    var normal = hit.normal;
    if (dot(ray_dir, normal) > 0.0) {
      normal = -normal;
    }

    // Handle different material types
    if (mat.material_type == MATERIAL_SPECULAR) {
      // Specular/metallic material with GGX microfacet model
      let roughness = max(mat.roughness, 0.001);  // Clamp to avoid singularities

      if (roughness < 0.01) {
        // Perfect mirror reflection
        ray_dir = reflect_dir(ray_dir, normal);
        throughput *= surface_color;
      } else {
        // GGX importance sampling
        let r1 = pcg(rng_state);
        let r2 = pcg(rng_state);

        // Sample microfacet normal (half vector)
        let h = sample_ggx(normal, roughness, r1, r2);

        // Reflect view direction around half vector
        let new_dir = reflect_dir(ray_dir, h);

        // Check if reflection is valid (above surface)
        if (dot(new_dir, normal) <= 0.0) {
          break;
        }

        // Calculate BRDF terms
        let n_dot_l = max(dot(normal, new_dir), 0.001);
        let n_dot_v = max(dot(normal, -ray_dir), 0.001);
        let n_dot_h = max(dot(normal, h), 0.001);
        let v_dot_h = max(dot(-ray_dir, h), 0.001);

        // Fresnel (using surface color as F0 for metals)
        let f = fresnel_schlick(v_dot_h, surface_color);

        // Geometry term
        let g = ggx_g(n_dot_v, n_dot_l, roughness);

        // For importance sampling GGX, the weight is:
        // f * g * v_dot_h / (n_dot_h * n_dot_v)
        let weight = f * g * v_dot_h / (n_dot_h * n_dot_v);

        throughput *= weight;
        ray_dir = new_dir;
      }

      ray_origin = hit_pos + normal * 0.001;
      last_was_specular = true;
    } else {
      // Diffuse material with MIS (light sampling + BSDF sampling)
      throughput *= surface_color;
      ray_origin = hit_pos + normal * 0.001;
      last_was_specular = false;

      let r1 = pcg(rng_state);
      let r2 = pcg(rng_state);
      var use_light_dir = false;

      if (scene_info.light_count > 0u && pcg(rng_state) < 0.5) {
        // Light-directed sampling
        let light_idx = min(u32(pcg(rng_state) * f32(scene_info.light_count)), scene_info.light_count - 1u);
        let light = lights[light_idx];
        let lv = tri_verts[light.tri_index];
        let la = tri_attribs[light.tri_index];
        let light_point = sample_triangle_point(lv.v0, lv.v1, lv.v2, r1, r2);

        let to_light = light_point - ray_origin;
        let dist_sq = dot(to_light, to_light);
        let dist = sqrt(dist_sq);
        let light_dir = to_light / dist;
        let cos_theta = dot(normal, light_dir);
        let cos_light = abs(dot(la.normal, -light_dir));

        if (cos_theta > 0.0 && cos_light > 0.0) {
          let p_light = dist_sq / (f32(scene_info.light_count) * light.area * max(cos_light, 0.001));
          let p_bsdf = cos_theta / PI;
          // One-sample MIS: throughput = (cos/PI) / (0.5*(p_light+p_bsdf))
          throughput *= (cos_theta / PI) / (0.5 * (p_light + p_bsdf));
          ray_dir = light_dir;
          use_light_dir = true;
          // Mark as light-sampled so emissive handler skips MIS weight (already applied)
          last_was_specular = true;
        }
      }

      if (!use_light_dir) {
        // Standard cosine-weighted hemisphere
        ray_dir = cosine_hemisphere(normal, r1, r2);
        last_bsdf_pdf = max(dot(normal, ray_dir), 0.001) / PI;
      }
    }

    // Russian roulette for path termination (after a few bounces)
    if (bounce > 2u) {
      let p = max(throughput.x, max(throughput.y, throughput.z));
      if (pcg(rng_state) > p) {
        break;
      }
      throughput /= p;
    }
  }

  return radiance;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let dims = textureDimensions(output);

  if (global_id.x >= dims.x || global_id.y >= dims.y) {
    return;
  }

  // --- Debug visualisation modes ---
  // Window mode: debug only in top-left quarter; fullscreen: debug everywhere
  let debug_active = scene_info.debug_mode > 0u;
  let window_size = vec2u(dims.x / 3u, dims.y / 3u);
  let in_debug_window = scene_info.debug_window > 0u
    && global_id.x < window_size.x && global_id.y < window_size.y;
  let is_debug_pixel = debug_active && (scene_info.debug_window == 0u || in_debug_window);
  let is_window_border = debug_active && scene_info.debug_window > 0u
    && (global_id.x == window_size.x || global_id.y == window_size.y)
    && global_id.x <= window_size.x && global_id.y <= window_size.y;

  if (is_debug_pixel && scene_info.debug_opacity >= 1.0) {
    // Fully opaque debug — skip path tracing entirely (fast path)
    var debug_pixel = vec2f(f32(global_id.x) + 0.5, f32(global_id.y) + 0.5);
    if (scene_info.debug_window > 0u) {
      // Scale pixel coords so full scene fits in window
      debug_pixel = debug_pixel * vec2f(f32(dims.x), f32(dims.y)) / vec2f(f32(window_size.x), f32(window_size.y));
    }
    let ray_origin = camera.position;
    let ray_dir = generate_ray(debug_pixel);
    let debug_color = compute_debug_color(ray_origin, ray_dir);

    textureStore(output, global_id.xy, vec4f(debug_color, 0.0));
    textureStore(output_normal, global_id.xy, vec4f(0.0, 1.0, 0.0, 1.0));
    textureStore(output_depth, global_id.xy, vec4f(1e30, 0.0, 0.0, 0.0));
    return;
  }
  if (is_window_border) {
    textureStore(output, global_id.xy, vec4f(1.0, 1.0, 1.0, 0.0));
    textureStore(output_normal, global_id.xy, vec4f(0.0, 1.0, 0.0, 1.0));
    textureStore(output_depth, global_id.xy, vec4f(1e30, 0.0, 0.0, 0.0));
    return;
  }

  // Initialize RNG
  var rng_state = rand_seed(global_id.xy, scene_info.frame);

  let samples_per_pixel = scene_info.samples_per_pixel;

  var color = vec3f(0.0);
  var color_sq = vec3f(0.0);
  var primary_normal = vec3f(0.0);
  var primary_depth = 1e30;

  for (var s = 0u; s < samples_per_pixel; s++) {
    // Add sub-pixel jitter for anti-aliasing
    let jitter_x = pcg(&rng_state) - 0.5;
    let jitter_y = pcg(&rng_state) - 0.5;
    let pixel = vec2f(f32(global_id.x) + 0.5 + jitter_x, f32(global_id.y) + 0.5 + jitter_y);

    let ray_origin = camera.position;
    let ray_dir = generate_ray(pixel);

    // Path trace and accumulate (first sample also outputs G-buffer data)
    var sample_normal = vec3f(0.0);
    var sample_depth = 1e30;
    let sample_color = path_trace(ray_origin, ray_dir, &rng_state, &sample_normal, &sample_depth);
    // Clamp individual samples to prevent firefly variance
    let clamped_sample = clamp(sample_color, vec3f(0.0), vec3f(5.0));
    color += clamped_sample;
    color_sq += clamped_sample * clamped_sample;

    if (s == 0u) {
      primary_normal = sample_normal;
      primary_depth = sample_depth;
    }
  }

  // Average samples
  let n = f32(samples_per_pixel);
  color /= n;

  // Per-pixel luminance variance (for variance-guided denoising)
  let variance = max(color_sq / n - color * color, vec3f(0.0));
  let lum_variance = dot(variance, vec3f(0.299, 0.587, 0.114));

  // Write G-buffer
  textureStore(output_normal, global_id.xy, vec4f(primary_normal, 1.0));
  textureStore(output_depth, global_id.xy, vec4f(primary_depth, 0.0, 0.0, 0.0));

  // Blend debug overlay if active with opacity < 1.0
  if (is_debug_pixel && scene_info.debug_opacity < 1.0) {
    var dbg_pixel = vec2f(f32(global_id.x) + 0.5, f32(global_id.y) + 0.5);
    if (scene_info.debug_window > 0u) {
      dbg_pixel = dbg_pixel * vec2f(f32(dims.x), f32(dims.y)) / vec2f(f32(window_size.x), f32(window_size.y));
    }
    let debug_color = compute_debug_color(camera.position, generate_ray(dbg_pixel));
    color = mix(color, debug_color, scene_info.debug_opacity);
  }

  // Output averaged sample with variance in alpha
  textureStore(output, global_id.xy, vec4f(color, lum_variance));
}
