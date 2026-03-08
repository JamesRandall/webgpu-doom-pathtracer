var PathTracer=function(N){"use strict";var kt=Object.defineProperty;var Lt=(N,G,K)=>G in N?kt(N,G,{enumerable:!0,configurable:!0,writable:!0,value:K}):N[G]=K;var u=(N,G,K)=>Lt(N,typeof G!="symbol"?G+"":G,K);var G=typeof document<"u"?document.currentScript:null;const K=`const PI = 3.14159265359;

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

struct DebugResult {
  color: vec3f,
  wire: f32, // 0.0 = no wireframe, 1.0 = wireframe line
}

fn compute_debug_color(ray_origin: vec3f, ray_dir: vec3f) -> DebugResult {
  var result: DebugResult;
  result.color = vec3f(0.0);
  result.wire = 0.0;

  if (scene_info.debug_mode == 1u) {
    let debug_hit = trace_bvh_debug(ray_origin, ray_dir);
    if (debug_hit.hit.hit) {
      result.color = heatmap(f32(debug_hit.nodes_visited), 100.0);
    }
  } else if (scene_info.debug_mode == 2u) {
    let debug_hit = trace_bvh_debug(ray_origin, ray_dir);
    if (debug_hit.hit.hit) {
      result.color = heatmap(f32(debug_hit.leaf_depth), 20.0);
    }
  } else if (scene_info.debug_mode == 3u) {
    let debug_hit = trace_bvh_debug(ray_origin, ray_dir);
    if (debug_hit.hit.hit) {
      result.color = heatmap(f32(debug_hit.leaf_tri_count), 16.0);
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
    result.wire = trace_aabb_wireframe(ray_origin, ray_dir, scene_info.debug_depth);
    result.color = mix(base_color, vec3f(0.0, 1.0, 0.0), result.wire);
  }

  return result;
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
    let debug_result = compute_debug_color(ray_origin, ray_dir);

    textureStore(output, global_id.xy, vec4f(debug_result.color, 0.0));
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
    let debug_result = compute_debug_color(camera.position, generate_ray(dbg_pixel));
    // Wireframe lines stay fully opaque in overlay mode; scene fades at debug_opacity
    let effective_opacity = max(debug_result.wire, scene_info.debug_opacity);
    color = mix(color, debug_result.color, effective_opacity);
  }

  // Output averaged sample with variance in alpha
  textureStore(output, global_id.xy, vec4f(color, lum_variance));
}
`,Re=`// Configurable denoiser with two modes:
// Mode 0: À-trous wavelet (edge-aware blur — smoother but softer)
// Mode 1: Outlier rejection (only clamps statistical outliers — sharper)

struct DenoiseParams {
  step_size: u32,
  sigma_color: f32,
  sigma_normal: f32,
  mode: u32,  // 0 = à-trous, 1 = outlier rejection
}

@group(0) @binding(0) var input_color: texture_2d<f32>;
@group(0) @binding(1) var input_normal: texture_2d<f32>;
@group(0) @binding(2) var input_depth: texture_2d<f32>;
@group(0) @binding(3) var output_color: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> params: DenoiseParams;

// ---- À-trous wavelet ----

const KERNEL_SIZE = 5;
const kernel_weights = array<f32, 5>(
  1.0 / 16.0,
  4.0 / 16.0,
  6.0 / 16.0,
  4.0 / 16.0,
  1.0 / 16.0
);

fn denoise_atrous(center_coord: vec2i, dims: vec2u) -> vec4f {
  let step = i32(params.step_size);
  let center_data = textureLoad(input_color, center_coord, 0);
  let center_color = center_data.rgb;
  let center_variance = center_data.a;
  let center_normal = textureLoad(input_normal, center_coord, 0).rgb;
  let center_depth = textureLoad(input_depth, center_coord, 0).r;

  if (center_depth > 1e20) {
    return center_data;
  }

  // --- Compute spatial variance from 3x3 immediate neighbourhood ---
  // Provides a noise estimate that works even at 1 spp where per-pixel variance is zero.
  var local_sum = vec3f(0.0);
  var local_sum_sq = vec3f(0.0);
  var local_count = 0.0;

  for (var sy = -1; sy <= 1; sy++) {
    for (var sx = -1; sx <= 1; sx++) {
      let local_coord = clamp(center_coord + vec2i(sx, sy), vec2i(0), vec2i(dims) - 1);
      let local_col = textureLoad(input_color, local_coord, 0).rgb;

      // Only include geometrically similar neighbours
      let local_normal = textureLoad(input_normal, local_coord, 0).rgb;
      let local_depth = textureLoad(input_depth, local_coord, 0).r;
      let n_sim = dot(center_normal, local_normal);
      let d_diff = abs(center_depth - local_depth) / max(center_depth, 0.001);

      if (n_sim > 0.9 && d_diff < 0.1) {
        local_sum += local_col;
        local_sum_sq += local_col * local_col;
        local_count += 1.0;
      }
    }
  }

  var spatial_variance = 0.0;
  if (local_count > 1.0) {
    let local_mean = local_sum / local_count;
    let local_var = max(local_sum_sq / local_count - local_mean * local_mean, vec3f(0.0));
    spatial_variance = dot(local_var, vec3f(0.299, 0.587, 0.114));
  }

  // Use the larger of path tracer variance and spatial variance
  let effective_variance = max(center_variance, spatial_variance);

  // --- Main à-trous filter loop ---
  var sum_color = vec3f(0.0);
  var sum_variance = 0.0;
  var sum_weight = 0.0;

  for (var j = 0; j < KERNEL_SIZE; j++) {
    for (var i = 0; i < KERNEL_SIZE; i++) {
      let offset = vec2i(i - 2, j - 2) * step;
      let sample_coord = clamp(center_coord + offset, vec2i(0), vec2i(dims) - 1);

      let sample_data = textureLoad(input_color, sample_coord, 0);
      let sample_color = sample_data.rgb;
      let sample_variance = sample_data.a;
      let sample_normal = textureLoad(input_normal, sample_coord, 0).rgb;
      let sample_depth = textureLoad(input_depth, sample_coord, 0).r;

      let spatial_weight = kernel_weights[i] * kernel_weights[j];

      // Normal similarity
      let normal_dot = max(0.0, dot(center_normal, sample_normal));
      let normal_weight = pow(normal_dot, 128.0);

      // Depth similarity (relative to distance — far surfaces get more tolerance)
      let relative_depth_diff = abs(center_depth - sample_depth) / max(center_depth, 0.001);
      let depth_weight = exp(-relative_depth_diff * relative_depth_diff * 100.0);

      // Variance-guided color similarity
      let noise_estimate = sqrt(max(effective_variance, 0.0));
      //let adaptive_sigma = max(noise_estimate * params.sigma_color, 0.0001);
      let adaptive_sigma = clamp(noise_estimate * params.sigma_color, 0.01, 0.5);
      let color_diff = length(center_color - sample_color);
      let color_weight = 1.0; //exp(-color_diff * color_diff / (2.0 * adaptive_sigma * adaptive_sigma));

      let weight = spatial_weight * normal_weight * depth_weight * color_weight;
      sum_color += sample_color * weight;
      sum_variance += sample_variance * weight;
      sum_weight += weight;
    }
  }

  if (sum_weight > 0.0001) {
    let filtered_variance = sum_variance / sum_weight;
    let output_variance = max(filtered_variance, spatial_variance * 0.5);
    return vec4f(sum_color / sum_weight, output_variance);
  }
  return center_data;
}

// ---- Median filter (edge-aware) ----
// Sorts per-channel across geometrically similar neighbors.
// Median is robust to outliers — texture detail passes through untouched.

// Partial sort to find median of up to 9 values
// We only need the middle element, so we use a selection approach
fn median3(a: f32, b: f32, c: f32) -> f32 {
  return max(min(a, b), min(max(a, b), c));
}

fn denoise_median(center_coord: vec2i, dims: vec2u) -> vec4f {
  let step = i32(params.step_size);
  let center_data = textureLoad(input_color, center_coord, 0);
  let center_normal = textureLoad(input_normal, center_coord, 0).rgb;
  let center_depth = textureLoad(input_depth, center_coord, 0).r;

  if (center_depth > 1e20) {
    return center_data;
  }

  // Gather up to 9 samples from geometrically similar neighbors
  var r_vals: array<f32, 9>;
  var g_vals: array<f32, 9>;
  var b_vals: array<f32, 9>;
  var n = 0u;

  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let sample_coord = clamp(center_coord + vec2i(dx, dy) * step, vec2i(0), vec2i(dims) - 1);

      let sample_normal = textureLoad(input_normal, sample_coord, 0).rgb;
      let sample_depth = textureLoad(input_depth, sample_coord, 0).r;

      let normal_sim = dot(center_normal, sample_normal);
      let depth_diff = abs(center_depth - sample_depth) / max(center_depth, 0.001);

      if (normal_sim > 0.85 && depth_diff < 0.15) {
        let col = textureLoad(input_color, sample_coord, 0).rgb;
        r_vals[n] = col.r;
        g_vals[n] = col.g;
        b_vals[n] = col.b;
        n += 1u;
      }
    }
  }

  // Need at least 3 samples for meaningful median
  if (n < 3u) {
    return center_data;
  }

  // Bubble sort (small N, runs fast on GPU)
  for (var i = 0u; i < n; i++) {
    for (var j = i + 1u; j < n; j++) {
      if (r_vals[j] < r_vals[i]) { let tmp = r_vals[i]; r_vals[i] = r_vals[j]; r_vals[j] = tmp; }
      if (g_vals[j] < g_vals[i]) { let tmp = g_vals[i]; g_vals[i] = g_vals[j]; g_vals[j] = tmp; }
      if (b_vals[j] < b_vals[i]) { let tmp = b_vals[i]; b_vals[i] = b_vals[j]; b_vals[j] = tmp; }
    }
  }

  let mid = n / 2u;
  let median_color = vec3f(r_vals[mid], g_vals[mid], b_vals[mid]);

  return vec4f(median_color, center_data.a);
}

// ---- Adaptive (variance-guided) ----
// Only smooths pixels that the path tracer flagged as uncertain.
// Clean texture pixels (low variance) pass through completely untouched.

fn denoise_adaptive(center_coord: vec2i, dims: vec2u) -> vec4f {
  let step = i32(params.step_size);
  let center_data = textureLoad(input_color, center_coord, 0);
  let center_color = center_data.rgb;
  let center_variance = center_data.a;
  let center_normal = textureLoad(input_normal, center_coord, 0).rgb;
  let center_depth = textureLoad(input_depth, center_coord, 0).r;

  if (center_depth > 1e20) {
    return center_data;
  }

  // How noisy is this pixel? Map variance to a 0-1 blend factor.
  // Low variance = confident = keep original. High variance = noisy = filter.
  let noise_level = clamp(sqrt(center_variance) * 4.0, 0.0, 1.0);

  // If pixel is clean, skip filtering entirely
  if (noise_level < 0.05) {
    return center_data;
  }

  // Compute edge-aware neighborhood mean (G-buffer guided)
  var sum_color = vec3f(0.0);
  var sum_weight = 0.0;

  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let sample_coord = clamp(center_coord + vec2i(dx, dy) * step, vec2i(0), vec2i(dims) - 1);

      let sample_normal = textureLoad(input_normal, sample_coord, 0).rgb;
      let sample_depth = textureLoad(input_depth, sample_coord, 0).r;

      // Geometric edge weight — only average within the same surface
      let normal_sim = max(0.0, dot(center_normal, sample_normal));
      let depth_diff = abs(center_depth - sample_depth) / max(center_depth, 0.001);
      let geo_weight = select(0.0, 1.0, normal_sim > 0.8 && depth_diff < 0.15);

      if (geo_weight > 0.0) {
        let sample_data = textureLoad(input_color, sample_coord, 0);
        // Weight by inverse variance — trust cleaner neighbors more
        let sample_confidence = 1.0 / (1.0 + sample_data.a * 10.0);
        let w = geo_weight * sample_confidence;
        sum_color += sample_data.rgb * w;
        sum_weight += w;
      }
    }
  }

  if (sum_weight < 0.001) {
    return center_data;
  }

  let filtered = sum_color / sum_weight;

  // Blend: noisy pixels use filtered result, clean pixels keep original
  let result = mix(center_color, filtered, noise_level);

  // Reduce variance estimate after filtering
  let new_variance = center_variance * (1.0 - noise_level * 0.5);

  return vec4f(result, new_variance);
}

// ---- Entry point ----

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let dims = textureDimensions(input_color);

  if (global_id.x >= dims.x || global_id.y >= dims.y) {
    return;
  }

  let center_coord = vec2i(global_id.xy);

  var result: vec4f;
  if (params.mode == 0u) {
    result = denoise_atrous(center_coord, dims);
  } else if (params.mode == 1u) {
    result = denoise_median(center_coord, dims);
  } else {
    result = denoise_adaptive(center_coord, dims);
  }

  textureStore(output_color, center_coord, result);
}
`,He=`// Temporal reprojection shader
// Blends current noisy frame with reprojected history for progressive accumulation.
// Static camera: true 1/N Monte Carlo averaging.
// Moving camera: conservative blend with YCoCg neighbourhood clamping.

struct TemporalParams {
  screen_width: f32,
  screen_height: f32,
  moving_blend_factor: f32, // Current frame weight when camera is moving (0.05 = 5%)
  depth_threshold: f32,     // Relative depth threshold for disocclusion
  static_frame_count: u32,  // Frames camera has been static (0 = moving)
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

struct CameraMatrices {
  inv_view_proj: mat4x4f,
  prev_view_proj: mat4x4f,
}

@group(0) @binding(0) var current_color: texture_2d<f32>;
@group(0) @binding(1) var current_depth: texture_2d<f32>;
@group(0) @binding(2) var current_normal: texture_2d<f32>;
@group(0) @binding(3) var history_color: texture_2d<f32>;
@group(0) @binding(4) var history_depth: texture_2d<f32>;
@group(0) @binding(5) var output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var<uniform> params: TemporalParams;
@group(0) @binding(7) var<uniform> matrices: CameraMatrices;

// --- Colour space conversion ---

fn rgb_to_ycocg(rgb: vec3f) -> vec3f {
  let y  =  0.25 * rgb.r + 0.5 * rgb.g + 0.25 * rgb.b;
  let co =  0.5  * rgb.r                - 0.5  * rgb.b;
  let cg = -0.25 * rgb.r + 0.5 * rgb.g - 0.25 * rgb.b;
  return vec3f(y, co, cg);
}

fn ycocg_to_rgb(ycocg: vec3f) -> vec3f {
  let y  = ycocg.x;
  let co = ycocg.y;
  let cg = ycocg.z;
  return vec3f(y + co - cg, y + cg, y - co - cg);
}

// --- World position reconstruction ---

fn reconstruct_world_pos(pixel: vec2f, depth: f32) -> vec3f {
  let ndc = vec2f(
    (pixel.x / params.screen_width) * 2.0 - 1.0,
    1.0 - (pixel.y / params.screen_height) * 2.0
  );

  let clip = vec4f(ndc, 0.0, 1.0);
  let view_dir = matrices.inv_view_proj * clip;
  // Ray tracer uses normalized direction, so normalize here to match
  let ray_dir = normalize(view_dir.xyz / view_dir.w);

  let cam_pos_h = matrices.inv_view_proj * vec4f(0.0, 0.0, 0.0, 1.0);
  let cam_pos = cam_pos_h.xyz / cam_pos_h.w;

  return cam_pos + ray_dir * depth;
}

// --- Reprojection ---

fn reproject(world_pos: vec3f) -> vec2f {
  let clip = matrices.prev_view_proj * vec4f(world_pos, 1.0);
  let ndc = clip.xy / clip.w;
  return vec2f(
    (ndc.x * 0.5 + 0.5) * params.screen_width,
    (0.5 - ndc.y * 0.5) * params.screen_height
  );
}

// Compute expected depth (view-space distance) at world position in previous frame
fn compute_expected_depth(world_pos: vec3f) -> f32 {
  let clip = matrices.prev_view_proj * vec4f(world_pos, 1.0);
  return clip.w;
}

// --- Neighbourhood statistics in YCoCg ---

fn get_neighbourhood_stats(center: vec2i) -> array<vec3f, 2> {
  // Returns [mean, stddev] in YCoCg space
  var sum = vec3f(0.0);
  var sum_sq = vec3f(0.0);

  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let col = textureLoad(current_color, center + vec2i(dx, dy), 0).rgb;
      let ycocg = rgb_to_ycocg(col);
      sum += ycocg;
      sum_sq += ycocg * ycocg;
    }
  }

  let mean = sum / 9.0;
  let variance = max(sum_sq / 9.0 - mean * mean, vec3f(0.0));
  let stddev = sqrt(variance);
  return array<vec3f, 2>(mean, stddev);
}

// --- Bilinear history sampling ---

fn sample_history_bilinear(pos: vec2f) -> vec3f {
  let dims = vec2f(params.screen_width, params.screen_height);
  let pos_clamped = clamp(pos, vec2f(0.5), dims - vec2f(0.5));

  let p0 = vec2i(floor(pos_clamped - 0.5));
  let f = fract(pos_clamped - 0.5);

  let c00 = textureLoad(history_color, clamp(p0, vec2i(0), vec2i(dims) - 1), 0).rgb;
  let c10 = textureLoad(history_color, clamp(p0 + vec2i(1, 0), vec2i(0), vec2i(dims) - 1), 0).rgb;
  let c01 = textureLoad(history_color, clamp(p0 + vec2i(0, 1), vec2i(0), vec2i(dims) - 1), 0).rgb;
  let c11 = textureLoad(history_color, clamp(p0 + vec2i(1, 1), vec2i(0), vec2i(dims) - 1), 0).rgb;

  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

fn sample_history_depth_bilinear(pos: vec2f) -> f32 {
  let dims = vec2f(params.screen_width, params.screen_height);
  let pos_clamped = clamp(pos, vec2f(0.5), dims - vec2f(0.5));

  let p0 = vec2i(floor(pos_clamped - 0.5));
  let f = fract(pos_clamped - 0.5);

  let d00 = textureLoad(history_depth, clamp(p0, vec2i(0), vec2i(dims) - 1), 0).r;
  let d10 = textureLoad(history_depth, clamp(p0 + vec2i(1, 0), vec2i(0), vec2i(dims) - 1), 0).r;
  let d01 = textureLoad(history_depth, clamp(p0 + vec2i(0, 1), vec2i(0), vec2i(dims) - 1), 0).r;
  let d11 = textureLoad(history_depth, clamp(p0 + vec2i(1, 1), vec2i(0), vec2i(dims) - 1), 0).r;

  return mix(mix(d00, d10, f.x), mix(d01, d11, f.x), f.y);
}

// --- Main ---

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let dims = textureDimensions(current_color);

  if (global_id.x >= dims.x || global_id.y >= dims.y) {
    return;
  }

  let pixel_coord = vec2i(global_id.xy);
  let pixel = vec2f(global_id.xy) + 0.5;

  // Load current frame data
  let current_data = textureLoad(current_color, pixel_coord, 0);
  let current_col = current_data.rgb;
  let current_variance = current_data.a;
  let depth = textureLoad(current_depth, pixel_coord, 0).r;

  // No hit — pass through
  if (depth > 1e20) {
    textureStore(output, pixel_coord, vec4f(current_col, current_variance));
    return;
  }

  var valid_history = false;
  var history_col = vec3f(0.0);

  if (params.static_frame_count > 0u) {
    // --- Static camera: direct pixel lookup, no reprojection needed ---
    history_col = textureLoad(history_color, pixel_coord, 0).rgb;
    let prev_depth = textureLoad(history_depth, pixel_coord, 0).r;
    let depth_diff = abs(prev_depth - depth) / max(depth, 0.001);
    valid_history = depth_diff < params.depth_threshold;
  } else {
    // --- Moving camera: reconstruct and reproject ---
    let world_pos = reconstruct_world_pos(pixel, depth);
    let prev_pixel = reproject(world_pos);

    let on_screen = prev_pixel.x >= 0.0 && prev_pixel.x < params.screen_width &&
                    prev_pixel.y >= 0.0 && prev_pixel.y < params.screen_height;

    if (on_screen) {
      history_col = sample_history_bilinear(prev_pixel);

      // Use expected depth in previous frame's space for proper comparison
      let expected_depth = compute_expected_depth(world_pos);
      let prev_depth = sample_history_depth_bilinear(prev_pixel);
      let depth_diff = abs(prev_depth - expected_depth) / max(expected_depth, 0.001);
      valid_history = depth_diff < params.depth_threshold;

      // Velocity rejection: large reprojection distance = less trustworthy
      let velocity = length(prev_pixel - pixel);
      if (velocity > 50.0) {
        valid_history = false;
      }
    }
  }

  // --- Compute blend factor (per-pixel confidence) ---
  var blend: f32;
  if (!valid_history) {
    // No usable history — use current frame only
    blend = 1.0;
  } else if (params.static_frame_count > 0u) {
    // Static camera — check if this pixel's content has changed
    // (dynamic objects, moving shadows, animated lights)
    let lum_current = dot(current_col, vec3f(0.299, 0.587, 0.114));
    let lum_history = dot(history_col, vec3f(0.299, 0.587, 0.114));
    let lum_diff = abs(lum_current - lum_history) / max(lum_history, 0.01);

    if (lum_diff > 0.3) {
      // Significant change — content changed, not just noise
      blend = 0.15;
    } else {
      // Pixel is stable — full 1/N Monte Carlo accumulation
      let accumulated = f32(params.static_frame_count + 1u);
      blend = 1.0 / (accumulated + 1.0);
    }
  } else {
    // Camera is moving — conservative fixed blend
    blend = params.moving_blend_factor;
  }

  // --- Neighbourhood clamp in YCoCg to reduce ghosting ---
  if (valid_history && params.static_frame_count == 0u) {
    let stats = get_neighbourhood_stats(pixel_coord);
    let mean_ycocg = stats[0];
    let stddev_ycocg = stats[1];
    let sigma_scale = 1.25;

    let history_ycocg = rgb_to_ycocg(history_col);
    let clamped_ycocg = clamp(
      history_ycocg,
      mean_ycocg - stddev_ycocg * sigma_scale,
      mean_ycocg + stddev_ycocg * sigma_scale
    );
    history_col = ycocg_to_rgb(clamped_ycocg);
  }

  let result = mix(history_col, current_col, blend);

  // Pass through variance for denoise stage
  textureStore(output, pixel_coord, vec4f(result, current_variance));
}
`,A=0,ue=1,Y=2;function ze(s,e){return{x:s.x-e.x,y:s.y-e.y,z:s.z-e.z}}function Ne(s,e){return{x:s.y*e.z-s.z*e.y,y:s.z*e.x-s.x*e.z,z:s.x*e.y-s.y*e.x}}function Ve(s){const e=Math.sqrt(s.x*s.x+s.y*s.y+s.z*s.z);return e===0?{x:0,y:0,z:0}:{x:s.x/e,y:s.y/e,z:s.z/e}}function $e(s,e,t){const n=ze(e,s),i=ze(t,s);return Ve(Ne(n,i))}function Te(s,e,t,n){return{v0:s,v1:e,v2:t,normal:$e(s,e,t),materialIndex:n,uv0:{u:0,v:0},uv1:{u:1,v:0},uv2:{u:1,v:1},textureIndex:-1}}function E(s,e,t,n,i){return[Te(s,e,t,i),Te(s,t,n,i)]}function We(){const s=[],e=[];e.push({albedo:{x:.73,y:.73,z:.73},emissive:{x:0,y:0,z:0},roughness:1,materialType:A}),e.push({albedo:{x:.65,y:.05,z:.05},emissive:{x:0,y:0,z:0},roughness:1,materialType:A}),e.push({albedo:{x:.12,y:.45,z:.15},emissive:{x:0,y:0,z:0},roughness:1,materialType:A}),e.push({albedo:{x:1,y:1,z:1},emissive:{x:40,y:40,z:40},roughness:1,materialType:Y}),e.push({albedo:{x:.95,y:.95,z:.95},emissive:{x:0,y:0,z:0},roughness:0,materialType:ue}),e.push({albedo:{x:.9,y:.7,z:.5},emissive:{x:0,y:0,z:0},roughness:.15,materialType:ue}),e.push({albedo:{x:.8,y:.8,z:.8},emissive:{x:0,y:0,z:0},roughness:.4,materialType:ue});const i=0,r=1,a=2,o=3,l=4,c=5,h=6;s.push(...E({x:-2.5,y:-2.5,z:-2.5},{x:2.5,y:-2.5,z:-2.5},{x:2.5,y:-2.5,z:2.5},{x:-2.5,y:-2.5,z:2.5},i)),s.push(...E({x:-2.5,y:2.5,z:-2.5},{x:-2.5,y:2.5,z:2.5},{x:2.5,y:2.5,z:2.5},{x:2.5,y:2.5,z:-2.5},i)),s.push(...E({x:-2.5,y:-2.5,z:2.5},{x:2.5,y:-2.5,z:2.5},{x:2.5,y:2.5,z:2.5},{x:-2.5,y:2.5,z:2.5},i)),s.push(...E({x:-2.5,y:-2.5,z:-2.5},{x:-2.5,y:-2.5,z:2.5},{x:-2.5,y:2.5,z:2.5},{x:-2.5,y:2.5,z:-2.5},r)),s.push(...E({x:2.5,y:-2.5,z:2.5},{x:2.5,y:-2.5,z:-2.5},{x:2.5,y:2.5,z:-2.5},{x:2.5,y:2.5,z:2.5},a));const p=1,d=2.5-.01;s.push(...E({x:-p/2,y:d,z:-p/2},{x:-p/2,y:d,z:p/2},{x:p/2,y:d,z:p/2},{x:p/2,y:d,z:-p/2},o));const g={x:-1,y:-2.5+1.5,z:.5},f=1.5;s.push(...Se(g,f,f,3,l,.3,h));const z={x:1,y:-2.5+.75,z:-.5},y=1.5;return s.push(...Se(z,y,y,1.5,c,-.25)),{triangles:s,materials:e}}function Se(s,e,t,n,i,r,a){const o=[],l=e/2,c=t/2,h=n/2,p=Math.cos(r),d=Math.sin(r);function g(y,m){return{x:y*p-m*d,z:y*d+m*p}}function f(y,m,x){const v=g(y,x);return{x:s.x+v.x,y:s.y+m,z:s.z+v.z}}const _=[f(-l,-h,-c),f(l,-h,-c),f(l,-h,c),f(-l,-h,c),f(-l,h,-c),f(l,h,-c),f(l,h,c),f(-l,h,c)],z=a??i;return o.push(...E(_[1],_[0],_[4],_[5],z)),o.push(...E(_[3],_[2],_[6],_[7],i)),o.push(...E(_[0],_[3],_[7],_[4],i)),o.push(...E(_[2],_[1],_[5],_[6],i)),o.push(...E(_[7],_[6],_[5],_[4],i)),o.push(...E(_[0],_[1],_[2],_[3],i)),o}function ne(s){const t=new Float32Array(s.length*12);for(let n=0;n<s.length;n++){const i=s[n],r=n*12;t[r+0]=i.v0.x,t[r+1]=i.v0.y,t[r+2]=i.v0.z,t[r+3]=0,t[r+4]=i.v1.x,t[r+5]=i.v1.y,t[r+6]=i.v1.z,t[r+7]=0,t[r+8]=i.v2.x,t[r+9]=i.v2.y,t[r+10]=i.v2.z,t[r+11]=0}return t}function ie(s){const t=new ArrayBuffer(s.length*12*4),n=new Float32Array(t),i=new Uint32Array(t),r=new Int32Array(t);for(let a=0;a<s.length;a++){const o=s[a],l=a*12;n[l+0]=o.normal.x,n[l+1]=o.normal.y,n[l+2]=o.normal.z,i[l+3]=o.materialIndex,n[l+4]=o.uv0.u,n[l+5]=o.uv0.v,n[l+6]=o.uv1.u,n[l+7]=o.uv1.v,n[l+8]=o.uv2.u,n[l+9]=o.uv2.v,r[l+10]=o.textureIndex,n[l+11]=0}return n}function Xe(s){const t=new ArrayBuffer(s.length*8*4),n=new Float32Array(t),i=new Uint32Array(t);for(let r=0;r<s.length;r++){const a=s[r],o=r*8;n[o+0]=a.albedo.x,n[o+1]=a.albedo.y,n[o+2]=a.albedo.z,n[o+3]=a.roughness,n[o+4]=a.emissive.x,n[o+5]=a.emissive.y,n[o+6]=a.emissive.z,i[o+7]=a.materialType}return n}function Z(){return{minX:1/0,minY:1/0,minZ:1/0,maxX:-1/0,maxY:-1/0,maxZ:-1/0}}function re(s,e){return{minX:Math.min(s.minX,e.minX),minY:Math.min(s.minY,e.minY),minZ:Math.min(s.minZ,e.minZ),maxX:Math.max(s.maxX,e.maxX),maxY:Math.max(s.maxY,e.maxY),maxZ:Math.max(s.maxZ,e.maxZ)}}function de(s){const e=s.maxX-s.minX,t=s.maxY-s.minY,n=s.maxZ-s.minZ;return 2*(e*t+t*n+n*e)}function qe(s){return{x:(s.minX+s.maxX)*.5,y:(s.minY+s.maxY)*.5,z:(s.minZ+s.maxZ)*.5}}const Ke=4,Ye=1,fe=2,O=12;function Ze(s){const e=Z();return e.minX=Math.min(s.v0.x,s.v1.x,s.v2.x),e.minY=Math.min(s.v0.y,s.v1.y,s.v2.y),e.minZ=Math.min(s.v0.z,s.v1.z,s.v2.z),e.maxX=Math.max(s.v0.x,s.v1.x,s.v2.x),e.maxY=Math.max(s.v0.y,s.v1.y,s.v2.y),e.maxZ=Math.max(s.v0.z,s.v1.z,s.v2.z),e}class Ce{constructor(){u(this,"nodes",[]);u(this,"triangleInfos",[]);u(this,"orderedTriangles",[])}build(e){if(e.length===0)return{nodes:[],orderedTriangles:[]};this.nodes=[],this.orderedTriangles=[],this.triangleInfos=e.map((o,l)=>{const c=Ze(o);return{index:l,bounds:c,centroid:qe(c)}}),this.buildRecursive(e,0,e.length);let t=0,n=0,i=0,r=0;const a=(o,l)=>{const c=this.nodes[o];c.triangleCount>0?(t=Math.max(t,l),n++,i=Math.max(i,c.triangleCount),r+=c.triangleCount):(a(c.leftChild,l+1),a(c.rightChild,l+1))};return this.nodes.length>0&&a(0,0),console.log(`BVH: ${this.nodes.length} nodes, depth=${t}, ${n} leaves, avg ${(r/n).toFixed(1)} tris/leaf, max ${i} tris/leaf`),{nodes:this.nodes,orderedTriangles:this.orderedTriangles}}buildRecursive(e,t,n){const i=this.nodes.length,r={bounds:Z(),leftChild:-1,rightChild:-1,firstTriangle:0,triangleCount:0};this.nodes.push(r);for(let h=t;h<n;h++)r.bounds=re(r.bounds,this.triangleInfos[h].bounds);const a=n-t;if(a<=Ke){r.firstTriangle=this.orderedTriangles.length,r.triangleCount=a;for(let h=t;h<n;h++)this.orderedTriangles.push(e[this.triangleInfos[h].index]);return i}let o=Z();for(let h=t;h<n;h++){const p=this.triangleInfos[h].centroid;o.minX=Math.min(o.minX,p.x),o.minY=Math.min(o.minY,p.y),o.minZ=Math.min(o.minZ,p.z),o.maxX=Math.max(o.maxX,p.x),o.maxY=Math.max(o.maxY,p.y),o.maxZ=Math.max(o.maxZ,p.z)}const l=this.findBestSplit(t,n,r.bounds,o);if(l.axis===-1||l.cost>=a*fe){r.firstTriangle=this.orderedTriangles.length,r.triangleCount=a;for(let h=t;h<n;h++)this.orderedTriangles.push(e[this.triangleInfos[h].index]);return i}const c=this.partition(t,n,l.axis,l.splitPos);if(c===t||c===n){const h=l.axis,p=this.triangleInfos.slice(t,n),d=["x","y","z"][h];p.sort((f,_)=>f.centroid[d]-_.centroid[d]);for(let f=0;f<p.length;f++)this.triangleInfos[t+f]=p[f];const g=t+Math.floor(a/2);r.leftChild=this.buildRecursive(e,t,g),r.rightChild=this.buildRecursive(e,g,n)}else r.leftChild=this.buildRecursive(e,t,c),r.rightChild=this.buildRecursive(e,c,n);return i}findBestSplit(e,t,n,i){let r=-1,a=0,o=1/0;const l=de(n);if(l<=0)return{axis:-1,splitPos:0,cost:1/0};for(let c=0;c<3;c++){const h=["x","y","z"][c],p=["minX","minY","minZ"][c],d=["maxX","maxY","maxZ"][c],g=i[p],f=i[d];if(f-g<1e-6)continue;const _=[];for(let w=0;w<O;w++)_.push({count:0,bounds:Z()});const z=O/(f-g);for(let w=e;w<t;w++){const M=this.triangleInfos[w].centroid[h];let P=Math.floor((M-g)*z);P=Math.min(P,O-1),_[P].count++,_[P].bounds=re(_[P].bounds,this.triangleInfos[w].bounds)}const y=new Array(O-1),m=new Array(O-1),x=new Array(O-1),v=new Array(O-1);let b=Z(),T=0;for(let w=0;w<O-1;w++)b=re(b,_[w].bounds),T+=_[w].count,m[w]={...b},y[w]=T;b=Z(),T=0;for(let w=O-1;w>0;w--)b=re(b,_[w].bounds),T+=_[w].count,v[w-1]={...b},x[w-1]=T;for(let w=0;w<O-1;w++){if(y[w]===0||x[w]===0)continue;const M=de(m[w]),P=de(v[w]),$=Ye+M/l*y[w]*fe+P/l*x[w]*fe;$<o&&(o=$,r=c,a=g+(w+1)*(f-g)/O)}}return{axis:r,splitPos:a,cost:o}}partition(e,t,n,i){const r=["x","y","z"][n];let a=e,o=t-1;for(;a<=o;){for(;a<=o&&this.triangleInfos[a].centroid[r]<i;)a++;for(;a<=o&&this.triangleInfos[o].centroid[r]>=i;)o--;if(a<o){const l=this.triangleInfos[a];this.triangleInfos[a]=this.triangleInfos[o],this.triangleInfos[o]=l,a++,o--}}return a}}const je=2147483648;function Pe(s){return s.map(e=>e.triangleCount>0?{minX:e.bounds.minX,minY:e.bounds.minY,minZ:e.bounds.minZ,leftChildOrFirstTriangle:e.firstTriangle,maxX:e.bounds.maxX,maxY:e.bounds.maxY,maxZ:e.bounds.maxZ,rightChildOrTriangleCount:e.triangleCount|je}:{minX:e.bounds.minX,minY:e.bounds.minY,minZ:e.bounds.minZ,leftChildOrFirstTriangle:e.leftChild,maxX:e.bounds.maxX,maxY:e.bounds.maxY,maxZ:e.bounds.maxZ,rightChildOrTriangleCount:e.rightChild})}function Ae(s){const e=new ArrayBuffer(s.length*8*4),t=new Float32Array(e),n=new Uint32Array(e);for(let i=0;i<s.length;i++){const r=s[i],a=i*8;t[a+0]=r.minX,t[a+1]=r.minY,t[a+2]=r.minZ,n[a+3]=r.leftChildOrFirstTriangle,t[a+4]=r.maxX,t[a+5]=r.maxY,t[a+6]=r.maxZ,n[a+7]=r.rightChildOrTriangleCount}return e}const J=class J{constructor(e,t,n,i,r,a,o,l,c=null,h){u(this,"device");u(this,"context");u(this,"format");u(this,"canvasWidth");u(this,"canvasHeight");u(this,"renderWidth");u(this,"renderHeight");u(this,"camera");u(this,"triangles");u(this,"materials");u(this,"textureAtlas");u(this,"walkablePositions");u(this,"resolutionScale",1);u(this,"frameCount",0);u(this,"nodeCount",0);u(this,"triangleCount",0);u(this,"computePipeline");u(this,"temporalPipeline");u(this,"denoisePipeline");u(this,"renderPipeline");u(this,"outputTexture");u(this,"temporalOutputTexture");u(this,"denoisedTexture");u(this,"normalTexture");u(this,"depthTexture");u(this,"historyColorTexture");u(this,"historyDepthTexture");u(this,"computeBindGroup");u(this,"temporalBindGroup");u(this,"denoiseBindGroups");u(this,"renderBindGroup");u(this,"cameraBuffer");u(this,"triangleBuffer");u(this,"triAttribsBuffer");u(this,"lightsBuffer");u(this,"materialBuffer");u(this,"bvhBuffer");u(this,"sceneInfoBuffer");u(this,"temporalParamsBuffer");u(this,"cameraMatricesBuffer");u(this,"sampler");u(this,"denoiseParamsBuffers",[]);u(this,"pingPongTexture");u(this,"atlasTexture");u(this,"atlasEntriesBuffer");u(this,"atlasSampler");u(this,"atlasWidth",1);u(this,"atlasHeight",1);u(this,"prevCamera",null);u(this,"staticFrameCount",0);u(this,"denoisePasses",1);u(this,"denoiseMode","atrous");u(this,"temporalFrames",1);u(this,"samplesPerPixel",4);u(this,"maxBounces",3);u(this,"debugMode",0);u(this,"debugDepth",3);u(this,"debugOpacity",1);u(this,"debugWindow",0);u(this,"playerLightColor",{x:0,y:0,z:0});u(this,"playerLightRadius",0);u(this,"playerLightFalloff",.5);u(this,"renderDistance",10);u(this,"allTriangles",[]);u(this,"precomputedBVHs",new Map);u(this,"currentTileKey","");u(this,"dynamicTriangles",[]);u(this,"dynamicTriOffset",0);u(this,"dynamicAABBMin",{x:0,y:0,z:0});u(this,"dynamicAABBMax",{x:0,y:0,z:0});u(this,"lightCount",0);this.device=e,this.context=t,this.format=n,this.canvasWidth=i,this.canvasHeight=r,this.renderWidth=Math.floor(i*this.resolutionScale),this.renderHeight=Math.floor(r*this.resolutionScale),this.camera=a,this.triangles=o,this.materials=l,this.textureAtlas=c,this.walkablePositions=h,console.log(`Render resolution: ${this.renderWidth}x${this.renderHeight} (${this.resolutionScale}x scale)`)}async initialize(){let e,t;if(this.allTriangles=this.triangles,this.walkablePositions&&this.walkablePositions.length>0){this.precomputeBVHsForPositions();const v=`${this.walkablePositions[0].x},${this.walkablePositions[0].z}`,b=this.precomputedBVHs.get(v);t=b.bvhData,e=this.triangles,this.nodeCount=b.nodeCount,this.triangleCount=b.triCount,this.currentTileKey=v}else{const b=new Ce().build(this.triangles);e=b.orderedTriangles;const T=Pe(b.nodes);t=Ae(T),this.nodeCount=b.nodes.length,console.log(`BVH built: ${b.nodes.length} nodes for ${e.length} triangles`)}(!this.walkablePositions||this.walkablePositions.length===0)&&(this.triangleCount=e.length),this.outputTexture=this.device.createTexture({size:{width:this.renderWidth,height:this.renderHeight},format:"rgba16float",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC}),this.temporalOutputTexture=this.device.createTexture({size:{width:this.renderWidth,height:this.renderHeight},format:"rgba16float",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST}),this.historyColorTexture=this.device.createTexture({size:{width:this.renderWidth,height:this.renderHeight},format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),this.historyDepthTexture=this.device.createTexture({size:{width:this.renderWidth,height:this.renderHeight},format:"r32float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),this.denoisedTexture=this.device.createTexture({size:{width:this.renderWidth,height:this.renderHeight},format:"rgba16float",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),this.normalTexture=this.device.createTexture({size:{width:this.renderWidth,height:this.renderHeight},format:"rgba16float",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING}),this.depthTexture=this.device.createTexture({size:{width:this.renderWidth,height:this.renderHeight},format:"r32float",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC}),this.pingPongTexture=this.device.createTexture({size:{width:this.renderWidth,height:this.renderHeight},format:"rgba16float",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC}),this.cameraBuffer=this.device.createBuffer({size:96,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.updateCameraBuffer();const n=512,i=12*4,r=12*4;let a=ne(e).byteLength+n*i,o=ie(e).byteLength+n*r,l=t.byteLength;if(this.precomputedBVHs.size>0)for(const v of this.precomputedBVHs.values())a=Math.max(a,v.triVertsData.byteLength+n*i),o=Math.max(o,v.triAttribsData.byteLength+n*r),l=Math.max(l,v.bvhData.byteLength);this.triangleBuffer=this.device.createBuffer({size:Math.max(a,32),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.triAttribsBuffer=this.device.createBuffer({size:Math.max(o,32),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});let c=8;if(this.precomputedBVHs.size>0){const v=this.precomputedBVHs.get(this.currentTileKey);this.device.queue.writeBuffer(this.triangleBuffer,0,v.triVertsData.buffer),this.device.queue.writeBuffer(this.triAttribsBuffer,0,v.triAttribsData.buffer),this.triangleCount=v.triCount,this.dynamicTriOffset=v.triCount,this.lightCount=v.lightCount;for(const b of this.precomputedBVHs.values())c=Math.max(c,b.lightData.byteLength)}else{const v=ne(e),b=ie(e);this.device.queue.writeBuffer(this.triangleBuffer,0,v.buffer),this.device.queue.writeBuffer(this.triAttribsBuffer,0,b.buffer),this.triangleCount=e.length,this.dynamicTriOffset=e.length}const h=this.precomputedBVHs.size>0?this.precomputedBVHs.get(this.currentTileKey).lightData:this.buildLightList(e);this.precomputedBVHs.size===0&&(this.lightCount=h.length/2,c=Math.max(h.byteLength,8)),this.lightsBuffer=this.device.createBuffer({size:Math.max(c,8),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.device.queue.writeBuffer(this.lightsBuffer,0,h.buffer),console.log(`Lights: ${this.lightCount} emissive triangles`);const p=Xe(this.materials);if(this.materialBuffer=this.device.createBuffer({size:Math.max(p.byteLength,32),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.device.queue.writeBuffer(this.materialBuffer,0,p.buffer),console.log(`Materials: ${this.materials.length}`),this.bvhBuffer=this.device.createBuffer({size:Math.max(l,32),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.device.queue.writeBuffer(this.bvhBuffer,0,t),this.sceneInfoBuffer=this.device.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.textureAtlas&&this.textureAtlas.width>0){this.atlasWidth=this.textureAtlas.width,this.atlasHeight=this.textureAtlas.height,this.atlasTexture=this.device.createTexture({size:{width:this.atlasWidth,height:this.atlasHeight},format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),this.device.queue.writeTexture({texture:this.atlasTexture},this.textureAtlas.image.buffer,{bytesPerRow:this.atlasWidth*4},{width:this.atlasWidth,height:this.atlasHeight});const v=Array.from(this.textureAtlas.entries.values()),b=new Float32Array(v.length*4);for(let T=0;T<v.length;T++){const w=v[T];b[T*4+0]=w.x,b[T*4+1]=w.y,b[T*4+2]=w.width,b[T*4+3]=w.height}this.atlasEntriesBuffer=this.device.createBuffer({size:Math.max(b.byteLength,16),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.device.queue.writeBuffer(this.atlasEntriesBuffer,0,b),console.log(`Atlas: ${this.atlasWidth}x${this.atlasHeight}, ${v.length} entries`)}else this.atlasTexture=this.device.createTexture({size:{width:1,height:1},format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),this.device.queue.writeTexture({texture:this.atlasTexture},new Uint8Array([255,255,255,255]),{bytesPerRow:4},{width:1,height:1}),this.atlasEntriesBuffer=this.device.createBuffer({size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});this.atlasSampler=this.device.createSampler({magFilter:"nearest",minFilter:"nearest",addressModeU:"repeat",addressModeV:"repeat"}),this.updateSceneInfoBuffer();const d=this.device.createShaderModule({code:K}),g=this.device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba16float",viewDimension:"2d"}},{binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform"}},{binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},{binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},{binding:4,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},{binding:5,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform"}},{binding:6,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba16float",viewDimension:"2d"}},{binding:7,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"r32float",viewDimension:"2d"}},{binding:8,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"float",viewDimension:"2d"}},{binding:9,visibility:GPUShaderStage.COMPUTE,sampler:{type:"filtering"}},{binding:10,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},{binding:11,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},{binding:12,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}}]});this.computePipeline=this.device.createComputePipeline({layout:this.device.createPipelineLayout({bindGroupLayouts:[g]}),compute:{module:d,entryPoint:"main"}}),this.computeBindGroup=this.device.createBindGroup({layout:g,entries:[{binding:0,resource:this.outputTexture.createView()},{binding:1,resource:{buffer:this.cameraBuffer}},{binding:2,resource:{buffer:this.triangleBuffer}},{binding:3,resource:{buffer:this.materialBuffer}},{binding:4,resource:{buffer:this.bvhBuffer}},{binding:5,resource:{buffer:this.sceneInfoBuffer}},{binding:6,resource:this.normalTexture.createView()},{binding:7,resource:this.depthTexture.createView()},{binding:8,resource:this.atlasTexture.createView()},{binding:9,resource:this.atlasSampler},{binding:10,resource:{buffer:this.atlasEntriesBuffer}},{binding:11,resource:{buffer:this.triAttribsBuffer}},{binding:12,resource:{buffer:this.lightsBuffer}}]}),this.temporalParamsBuffer=this.device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.cameraMatricesBuffer=this.device.createBuffer({size:128,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});const f=this.device.createShaderModule({code:He}),_=this.device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"float",viewDimension:"2d"}},{binding:1,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"unfilterable-float",viewDimension:"2d"}},{binding:2,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"float",viewDimension:"2d"}},{binding:3,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"float",viewDimension:"2d"}},{binding:4,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"unfilterable-float",viewDimension:"2d"}},{binding:5,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba16float",viewDimension:"2d"}},{binding:6,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform"}},{binding:7,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform"}}]});this.temporalPipeline=this.device.createComputePipeline({layout:this.device.createPipelineLayout({bindGroupLayouts:[_]}),compute:{module:f,entryPoint:"main"}}),this.temporalBindGroup=this.device.createBindGroup({layout:_,entries:[{binding:0,resource:this.outputTexture.createView()},{binding:1,resource:this.depthTexture.createView()},{binding:2,resource:this.normalTexture.createView()},{binding:3,resource:this.historyColorTexture.createView()},{binding:4,resource:this.historyDepthTexture.createView()},{binding:5,resource:this.temporalOutputTexture.createView()},{binding:6,resource:{buffer:this.temporalParamsBuffer}},{binding:7,resource:{buffer:this.cameraMatricesBuffer}}]});const z=this.device.createShaderModule({code:Re}),y=this.device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"float",viewDimension:"2d"}},{binding:1,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"float",viewDimension:"2d"}},{binding:2,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"unfilterable-float",viewDimension:"2d"}},{binding:3,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba16float",viewDimension:"2d"}},{binding:4,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform"}}]});this.denoisePipeline=this.device.createComputePipeline({layout:this.device.createPipelineLayout({bindGroupLayouts:[y]}),compute:{module:z,entryPoint:"main"}}),this.denoiseParamsBuffers=[],this.denoiseBindGroups=[];for(let v=0;v<J.MAX_DENOISE_PASSES;v++){const b=this.device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),T=1<<v,w=new ArrayBuffer(16),M=new Uint32Array(w),P=new Float32Array(w);M[0]=T,P[1]=4,P[2]=128,M[3]=0,this.device.queue.writeBuffer(b,0,w),this.denoiseParamsBuffers.push(b)}for(let v=0;v<J.MAX_DENOISE_PASSES;v++){let b,T;v===0?(b=this.temporalOutputTexture,T=this.pingPongTexture):v%2===1?(b=this.pingPongTexture,T=this.denoisedTexture):(b=this.denoisedTexture,T=this.pingPongTexture),this.denoiseBindGroups.push(this.device.createBindGroup({layout:y,entries:[{binding:0,resource:b.createView()},{binding:1,resource:this.normalTexture.createView()},{binding:2,resource:this.depthTexture.createView()},{binding:3,resource:T.createView()},{binding:4,resource:{buffer:this.denoiseParamsBuffers[v]}}]}))}this.sampler=this.device.createSampler({magFilter:"linear",minFilter:"linear"});const m=this.device.createShaderModule({code:`
        @group(0) @binding(0) var outputTex: texture_2d<f32>;
        @group(0) @binding(1) var outputSampler: sampler;

        struct VertexOutput {
          @builtin(position) position: vec4f,
          @location(0) uv: vec2f,
        }

        @vertex
        fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
          var positions = array<vec2f, 3>(
            vec2f(-1.0, -1.0),
            vec2f(3.0, -1.0),
            vec2f(-1.0, 3.0)
          );
          var uvs = array<vec2f, 3>(
            vec2f(0.0, 1.0),
            vec2f(2.0, 1.0),
            vec2f(0.0, -1.0)
          );

          var output: VertexOutput;
          output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
          output.uv = uvs[vertexIndex];
          return output;
        }

        @fragment
        fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
          var color = textureSample(outputTex, outputSampler, uv).rgb;
          // Exposure adjustment
          color *= 1.5;
          // Simple tone mapping (Reinhard) and gamma correction
          let mapped = color / (color + vec3f(1.0));
          let gamma_corrected = pow(mapped, vec3f(1.0 / 2.2));
          return vec4f(gamma_corrected, 1.0);
        }
      `}),x=this.device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"2d"}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:"filtering"}}]});this.renderPipeline=this.device.createRenderPipeline({layout:this.device.createPipelineLayout({bindGroupLayouts:[x]}),vertex:{module:m,entryPoint:"vs"},fragment:{module:m,entryPoint:"fs",targets:[{format:this.format}]},primitive:{topology:"triangle-list"}}),this.renderBindGroup=this.device.createBindGroup({layout:x,entries:[{binding:0,resource:this.denoisedTexture.createView()},{binding:1,resource:this.sampler}]})}updateCameraBuffer(){const e=new Float32Array([this.camera.position.x,this.camera.position.y,this.camera.position.z,0,this.camera.direction.x,this.camera.direction.y,this.camera.direction.z,0,this.camera.up.x,this.camera.up.y,this.camera.up.z,0,this.renderWidth,this.renderHeight,this.camera.fov*(Math.PI/180),0]);this.device.queue.writeBuffer(this.cameraBuffer,0,e)}precomputeBVHsForPositions(){const e=this.walkablePositions,t=this.renderDistance,n=t*t;let i=0,r=0;const a=performance.now();for(const l of e){const c=[];for(const x of this.allTriangles){const v=(x.v0.x-l.x)**2+(x.v0.z-l.z)**2,b=(x.v1.x-l.x)**2+(x.v1.z-l.z)**2,T=(x.v2.x-l.x)**2+(x.v2.z-l.z)**2;Math.min(v,b,T)<=n&&c.push(x)}const h=new Ce,{nodes:p,orderedTriangles:d}=h.build(c),g=Pe(p),f=Ae(g),_=ne(d),z=ie(d),y=this.buildLightList(d),m=`${l.x},${l.z}`;this.precomputedBVHs.set(m,{bvhData:f,triVertsData:_,triAttribsData:z,lightData:y,nodeCount:p.length,triCount:d.length,lightCount:y.length/2}),i=Math.max(i,d.length),r=Math.max(r,p.length)}const o=(performance.now()-a).toFixed(0);console.log(`Precomputed ${e.length} BVHs in ${o}ms (max ${i} tris, ${r} nodes per tile)`)}swapBVHForTile(){if(this.precomputedBVHs.size===0)return;const e=this.camera.position.x,t=this.camera.position.z;let n=this.currentTileKey,i=1/0;for(const a of this.walkablePositions){const o=a.x-e,l=a.z-t,c=o*o+l*l;c<i&&(i=c,n=`${a.x},${a.z}`)}if(n===this.currentTileKey)return;const r=this.precomputedBVHs.get(n);r&&(this.device.queue.writeBuffer(this.bvhBuffer,0,r.bvhData),this.device.queue.writeBuffer(this.triangleBuffer,0,r.triVertsData.buffer),this.device.queue.writeBuffer(this.triAttribsBuffer,0,r.triAttribsData.buffer),this.device.queue.writeBuffer(this.lightsBuffer,0,r.lightData.buffer),this.nodeCount=r.nodeCount,this.triangleCount=r.triCount,this.dynamicTriOffset=r.triCount,this.lightCount=r.lightCount,this.currentTileKey=n,this.dynamicTriangles.length>0&&this.setDynamicTriangles(this.dynamicTriangles))}buildLightList(e){const t=[];for(let a=0;a<e.length;a++){const o=this.materials[e[a].materialIndex];if(o.emissive.x>0||o.emissive.y>0||o.emissive.z>0){const l=e[a],c=l.v1.x-l.v0.x,h=l.v1.y-l.v0.y,p=l.v1.z-l.v0.z,d=l.v2.x-l.v0.x,g=l.v2.y-l.v0.y,f=l.v2.z-l.v0.z,_=h*f-p*g,z=p*d-c*f,y=c*g-h*d,m=.5*Math.sqrt(_*_+z*z+y*y);m>0&&t.push({triIndex:a,area:m})}}const n=new ArrayBuffer(Math.max(t.length*8,8)),i=new Uint32Array(n),r=new Float32Array(n);for(let a=0;a<t.length;a++)i[a*2]=t[a].triIndex,r[a*2+1]=t[a].area;return r}updateSceneInfoBuffer(){const e=new ArrayBuffer(112),t=new Uint32Array(e),n=new Float32Array(e);t[0]=this.triangleCount,t[1]=this.nodeCount,t[2]=this.frameCount,t[3]=this.maxBounces,t[4]=this.samplesPerPixel,t[5]=this.atlasWidth,t[6]=this.atlasHeight,n[7]=this.playerLightFalloff,n[8]=this.playerLightColor.x,n[9]=this.playerLightColor.y,n[10]=this.playerLightColor.z,n[11]=this.playerLightRadius,t[12]=this.dynamicTriOffset,t[13]=this.dynamicTriangles.length,t[14]=this.lightCount,t[15]=this.debugMode,n[16]=this.dynamicAABBMin.x,n[17]=this.dynamicAABBMin.y,n[18]=this.dynamicAABBMin.z,n[19]=this.debugOpacity,n[20]=this.dynamicAABBMax.x,n[21]=this.dynamicAABBMax.y,n[22]=this.dynamicAABBMax.z,t[23]=this.debugDepth,t[24]=this.debugWindow,t[25]=0,t[26]=0,t[27]=0,this.device.queue.writeBuffer(this.sceneInfoBuffer,0,e)}buildViewMatrix(e){const t=this.normalize3([e.direction.x,e.direction.y,e.direction.z]),n=this.normalize3(this.cross3(t,[e.up.x,e.up.y,e.up.z])),i=this.cross3(n,t);return new Float32Array([n[0],i[0],-t[0],0,n[1],i[1],-t[1],0,n[2],i[2],-t[2],0,-this.dot3(n,[e.position.x,e.position.y,e.position.z]),-this.dot3(i,[e.position.x,e.position.y,e.position.z]),this.dot3(t,[e.position.x,e.position.y,e.position.z]),1])}buildProjectionMatrix(e,t,n,i){const r=1/Math.tan(e/2),a=1/(n-i);return new Float32Array([r/t,0,0,0,0,r,0,0,0,0,(n+i)*a,-1,0,0,n*i*a*2,0])}multiplyMatrices(e,t){const n=new Float32Array(16);for(let i=0;i<4;i++)for(let r=0;r<4;r++)n[i*4+r]=e[i*4+0]*t[0+r]+e[i*4+1]*t[4+r]+e[i*4+2]*t[8+r]+e[i*4+3]*t[12+r];return n}invertMatrix(e){const t=new Float32Array(16);t[0]=e[5]*e[10]*e[15]-e[5]*e[11]*e[14]-e[9]*e[6]*e[15]+e[9]*e[7]*e[14]+e[13]*e[6]*e[11]-e[13]*e[7]*e[10],t[4]=-e[4]*e[10]*e[15]+e[4]*e[11]*e[14]+e[8]*e[6]*e[15]-e[8]*e[7]*e[14]-e[12]*e[6]*e[11]+e[12]*e[7]*e[10],t[8]=e[4]*e[9]*e[15]-e[4]*e[11]*e[13]-e[8]*e[5]*e[15]+e[8]*e[7]*e[13]+e[12]*e[5]*e[11]-e[12]*e[7]*e[9],t[12]=-e[4]*e[9]*e[14]+e[4]*e[10]*e[13]+e[8]*e[5]*e[14]-e[8]*e[6]*e[13]-e[12]*e[5]*e[10]+e[12]*e[6]*e[9],t[1]=-e[1]*e[10]*e[15]+e[1]*e[11]*e[14]+e[9]*e[2]*e[15]-e[9]*e[3]*e[14]-e[13]*e[2]*e[11]+e[13]*e[3]*e[10],t[5]=e[0]*e[10]*e[15]-e[0]*e[11]*e[14]-e[8]*e[2]*e[15]+e[8]*e[3]*e[14]+e[12]*e[2]*e[11]-e[12]*e[3]*e[10],t[9]=-e[0]*e[9]*e[15]+e[0]*e[11]*e[13]+e[8]*e[1]*e[15]-e[8]*e[3]*e[13]-e[12]*e[1]*e[11]+e[12]*e[3]*e[9],t[13]=e[0]*e[9]*e[14]-e[0]*e[10]*e[13]-e[8]*e[1]*e[14]+e[8]*e[2]*e[13]+e[12]*e[1]*e[10]-e[12]*e[2]*e[9],t[2]=e[1]*e[6]*e[15]-e[1]*e[7]*e[14]-e[5]*e[2]*e[15]+e[5]*e[3]*e[14]+e[13]*e[2]*e[7]-e[13]*e[3]*e[6],t[6]=-e[0]*e[6]*e[15]+e[0]*e[7]*e[14]+e[4]*e[2]*e[15]-e[4]*e[3]*e[14]-e[12]*e[2]*e[7]+e[12]*e[3]*e[6],t[10]=e[0]*e[5]*e[15]-e[0]*e[7]*e[13]-e[4]*e[1]*e[15]+e[4]*e[3]*e[13]+e[12]*e[1]*e[7]-e[12]*e[3]*e[5],t[14]=-e[0]*e[5]*e[14]+e[0]*e[6]*e[13]+e[4]*e[1]*e[14]-e[4]*e[2]*e[13]-e[12]*e[1]*e[6]+e[12]*e[2]*e[5],t[3]=-e[1]*e[6]*e[11]+e[1]*e[7]*e[10]+e[5]*e[2]*e[11]-e[5]*e[3]*e[10]-e[9]*e[2]*e[7]+e[9]*e[3]*e[6],t[7]=e[0]*e[6]*e[11]-e[0]*e[7]*e[10]-e[4]*e[2]*e[11]+e[4]*e[3]*e[10]+e[8]*e[2]*e[7]-e[8]*e[3]*e[6],t[11]=-e[0]*e[5]*e[11]+e[0]*e[7]*e[9]+e[4]*e[1]*e[11]-e[4]*e[3]*e[9]-e[8]*e[1]*e[7]+e[8]*e[3]*e[5],t[15]=e[0]*e[5]*e[10]-e[0]*e[6]*e[9]-e[4]*e[1]*e[10]+e[4]*e[2]*e[9]+e[8]*e[1]*e[6]-e[8]*e[2]*e[5];const n=e[0]*t[0]+e[1]*t[4]+e[2]*t[8]+e[3]*t[12];if(Math.abs(n)<1e-10)return new Float32Array(16);const i=1/n;for(let r=0;r<16;r++)t[r]*=i;return t}normalize3(e){const t=Math.sqrt(e[0]*e[0]+e[1]*e[1]+e[2]*e[2]);return t>0?[e[0]/t,e[1]/t,e[2]/t]:[0,0,0]}cross3(e,t){return[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]]}dot3(e,t){return e[0]*t[0]+e[1]*t[1]+e[2]*t[2]}buildViewProjMatrix(e){const t=this.buildViewMatrix(e),n=e.fov*(Math.PI/180),i=this.renderWidth/this.renderHeight,r=this.buildProjectionMatrix(n,i,.1,1e3);return this.multiplyMatrices(r,t)}setDynamicTriangles(e){if(this.dynamicTriangles=e,e.length>0){const t=ne(e),n=ie(e);this.device.queue.writeBuffer(this.triangleBuffer,this.dynamicTriOffset*12*4,t.buffer),this.device.queue.writeBuffer(this.triAttribsBuffer,this.dynamicTriOffset*12*4,n.buffer);let i=1/0,r=1/0,a=1/0,o=-1/0,l=-1/0,c=-1/0;for(const h of e)for(const p of[h.v0,h.v1,h.v2])i=Math.min(i,p.x),r=Math.min(r,p.y),a=Math.min(a,p.z),o=Math.max(o,p.x),l=Math.max(l,p.y),c=Math.max(c,p.z);this.dynamicAABBMin={x:i,y:r,z:a},this.dynamicAABBMax={x:o,y:l,z:c}}else this.dynamicAABBMin={x:0,y:0,z:0},this.dynamicAABBMax={x:0,y:0,z:0}}updateCamera(e){if(this.prevCamera!==null){const t=Math.abs(e.position.x-this.prevCamera.position.x)>1e-4||Math.abs(e.position.y-this.prevCamera.position.y)>1e-4||Math.abs(e.position.z-this.prevCamera.position.z)>1e-4,n=Math.abs(e.direction.x-this.prevCamera.direction.x)>1e-4||Math.abs(e.direction.y-this.prevCamera.direction.y)>1e-4||Math.abs(e.direction.z-this.prevCamera.direction.z)>1e-4;t||n?this.staticFrameCount=0:this.staticFrameCount++}this.prevCamera={position:{...this.camera.position},direction:{...this.camera.direction},up:{...this.camera.up},fov:this.camera.fov},this.camera=e,this.updateCameraBuffer()}render(){this.precomputedBVHs.size>0&&this.swapBVHForTile(),this.updateSceneInfoBuffer(),this.frameCount++;const e=new ArrayBuffer(32),t=new Float32Array(e),n=new Uint32Array(e);t[0]=this.renderWidth,t[1]=this.renderHeight,t[2]=.05,t[3]=.1,n[4]=this.staticFrameCount,this.device.queue.writeBuffer(this.temporalParamsBuffer,0,e);const i=this.buildViewProjMatrix(this.camera),r=this.invertMatrix(i),a=this.prevCamera?this.buildViewProjMatrix(this.prevCamera):i,o=new Float32Array(32);o.set(r,0),o.set(a,16),this.device.queue.writeBuffer(this.cameraMatricesBuffer,0,o);const l=this.device.createCommandEncoder(),c=8,h=Math.ceil(this.renderWidth/c),p=Math.ceil(this.renderHeight/c),d=l.beginComputePass();if(d.setPipeline(this.computePipeline),d.setBindGroup(0,this.computeBindGroup),d.dispatchWorkgroups(h,p),d.end(),this.temporalFrames>0){const y=l.beginComputePass();y.setPipeline(this.temporalPipeline),y.setBindGroup(0,this.temporalBindGroup),y.dispatchWorkgroups(h,p),y.end(),l.copyTextureToTexture({texture:this.temporalOutputTexture},{texture:this.historyColorTexture},{width:this.renderWidth,height:this.renderHeight}),l.copyTextureToTexture({texture:this.depthTexture},{texture:this.historyDepthTexture},{width:this.renderWidth,height:this.renderHeight})}const g=this.temporalFrames>0?this.temporalOutputTexture:this.outputTexture,f=this.denoisePasses;if(f>0){const m={atrous:0,median:1,adaptive:2}[this.denoiseMode],x=this.denoiseMode==="atrous"?1:1.5;for(let v=0;v<f;v++){const b=new ArrayBuffer(16),T=new Uint32Array(b),w=new Float32Array(b);T[0]=1<<v,w[1]=x,w[2]=128,T[3]=m,this.device.queue.writeBuffer(this.denoiseParamsBuffers[v],0,b)}this.temporalFrames>0||l.copyTextureToTexture({texture:this.outputTexture},{texture:this.temporalOutputTexture},{width:this.renderWidth,height:this.renderHeight});for(let v=0;v<f;v++){const b=l.beginComputePass();b.setPipeline(this.denoisePipeline),b.setBindGroup(0,this.denoiseBindGroups[v]),b.dispatchWorkgroups(h,p),b.end()}f%2===1&&l.copyTextureToTexture({texture:this.pingPongTexture},{texture:this.denoisedTexture},{width:this.renderWidth,height:this.renderHeight})}else l.copyTextureToTexture({texture:g},{texture:this.denoisedTexture},{width:this.renderWidth,height:this.renderHeight});const _=this.context.getCurrentTexture().createView(),z=l.beginRenderPass({colorAttachments:[{view:_,loadOp:"clear",storeOp:"store",clearValue:{r:0,g:0,b:0,a:1}}]});z.setPipeline(this.renderPipeline),z.setBindGroup(0,this.renderBindGroup),z.draw(3),z.end(),this.device.queue.submit([l.finish()]),this.prevCamera={position:{...this.camera.position},direction:{...this.camera.direction},up:{...this.camera.up},fov:this.camera.fov}}};u(J,"MAX_DENOISE_PASSES",5);let pe=J;class ge{constructor(e={x:0,y:0,z:0},t=0,n=0,i=60,r=5,a=.002){u(this,"position");u(this,"yaw");u(this,"pitch");u(this,"up",{x:0,y:1,z:0});u(this,"fov");u(this,"keys",new Set);u(this,"moveSpeed");u(this,"lookSensitivity");u(this,"isLocked",!1);u(this,"collision",null);u(this,"canvas",null);u(this,"keyTarget",null);u(this,"onKeyDown",null);u(this,"onKeyUp",null);u(this,"onClick",null);u(this,"onPointerLockChange",null);u(this,"onMouseMove",null);this.position={...e},this.yaw=t,this.pitch=n,this.fov=i,this.moveSpeed=r,this.lookSensitivity=a}setCollision(e){this.collision=e}attach(e,t){this.detach(),this.canvas=e,this.keyTarget=t||window,this.onKeyDown=n=>{this.keys.add(n.code)},this.onKeyUp=n=>{this.keys.delete(n.code)},this.keyTarget.addEventListener("keydown",this.onKeyDown),this.keyTarget.addEventListener("keyup",this.onKeyUp),this.onClick=()=>{e.requestPointerLock()},e.addEventListener("click",this.onClick),this.onPointerLockChange=()=>{this.isLocked=document.pointerLockElement===e},document.addEventListener("pointerlockchange",this.onPointerLockChange),this.onMouseMove=n=>{if(!this.isLocked)return;const i=n;this.yaw-=i.movementX*this.lookSensitivity,this.pitch-=i.movementY*this.lookSensitivity;const r=Math.PI/2-.01;this.pitch=Math.max(-r,Math.min(r,this.pitch))},document.addEventListener("mousemove",this.onMouseMove)}detach(){this.keyTarget&&this.onKeyDown&&(this.keyTarget.removeEventListener("keydown",this.onKeyDown),this.keyTarget.removeEventListener("keyup",this.onKeyUp)),this.canvas&&this.onClick&&this.canvas.removeEventListener("click",this.onClick),this.onPointerLockChange&&document.removeEventListener("pointerlockchange",this.onPointerLockChange),this.onMouseMove&&document.removeEventListener("mousemove",this.onMouseMove),this.keys.clear(),this.canvas=null,this.keyTarget=null}update(e){const t={x:Math.sin(this.yaw),z:Math.cos(this.yaw)},n={x:-Math.cos(this.yaw),z:Math.sin(this.yaw)},i=this.moveSpeed*e;let r={...this.position};this.keys.has("KeyW")&&(r.x+=t.x*i,r.z+=t.z*i),this.keys.has("KeyS")&&(r.x-=t.x*i,r.z-=t.z*i),this.keys.has("KeyA")&&(r.x-=n.x*i,r.z-=n.z*i),this.keys.has("KeyD")&&(r.x+=n.x*i,r.z+=n.z*i),this.keys.has("Space")&&(r.y+=i),(this.keys.has("ShiftLeft")||this.keys.has("ShiftRight"))&&(r.y-=i),this.collision&&(r=this.collision.checkMove(this.position,r)),this.position=r;const a=2*e;this.keys.has("KeyQ")&&(this.yaw+=a),this.keys.has("KeyE")&&(this.yaw-=a)}getCamera(){const e={x:Math.sin(this.yaw)*Math.cos(this.pitch),y:Math.sin(this.pitch),z:Math.cos(this.yaw)*Math.cos(this.pitch)};return{position:{...this.position},direction:e,up:{...this.up},fov:this.fov}}}class Qe{constructor(e){u(this,"data");u(this,"header");u(this,"directory",[]);this.data=new DataView(e),this.header=this.parseHeader(),this.parseDirectory()}parseHeader(){const e=this.readString(0,4),t=this.data.getInt32(4,!0),n=this.data.getInt32(8,!0);if(e!=="IWAD"&&e!=="PWAD")throw new Error(`Invalid WAD identification: ${e}`);return{identification:e,numLumps:t,directoryOffset:n}}parseDirectory(){const{numLumps:e,directoryOffset:t}=this.header;for(let n=0;n<e;n++){const i=t+n*16,r=this.data.getInt32(i,!0),a=this.data.getInt32(i+4,!0),o=this.readString(i+8,8).replace(/\0/g,"");this.directory.push({offset:r,size:a,name:o})}}readString(e,t){let n="";for(let i=0;i<t;i++){const r=this.data.getUint8(e+i);if(r===0)break;n+=String.fromCharCode(r)}return n}getLumpByName(e){return this.directory.find(t=>t.name===e)}getLumpIndex(e){return this.directory.findIndex(t=>t.name===e)}getLumpData(e){return new DataView(this.data.buffer,e.offset,e.size)}getDirectory(){return this.directory}getLevelNames(){const e=[];for(const t of this.directory)/^E\dM\d$/.test(t.name)&&e.push(t.name),/^MAP\d\d$/.test(t.name)&&e.push(t.name);return e}parseLevel(e){const t=this.getLumpIndex(e);if(t===-1)throw new Error(`Level ${e} not found`);const n=p=>{for(let d=t+1;d<this.directory.length&&d<t+12;d++)if(this.directory[d].name===p)return this.directory[d]},i=n("VERTEXES"),r=n("LINEDEFS"),a=n("SIDEDEFS"),o=n("SECTORS"),l=n("THINGS"),c=n("SSECTORS"),h=n("SEGS");if(!i||!r||!a||!o)throw new Error(`Missing required lumps for level ${e}`);return{name:e,vertices:this.parseVertices(i),linedefs:this.parseLinedefs(r),sidedefs:this.parseSidedefs(a),sectors:this.parseSectors(o),things:l?this.parseThings(l):[],subsectors:c?this.parseSubsectors(c):[],segs:h?this.parseSegs(h):[]}}parseVertices(e){const t=this.getLumpData(e),n=[],i=e.size/4;for(let r=0;r<i;r++){const a=t.getInt16(r*4,!0),o=t.getInt16(r*4+2,!0);n.push({x:a,y:o})}return n}parseLinedefs(e){const t=this.getLumpData(e),n=[],i=e.size/14;for(let r=0;r<i;r++){const a=r*14;n.push({startVertex:t.getUint16(a,!0),endVertex:t.getUint16(a+2,!0),flags:t.getUint16(a+4,!0),specialType:t.getUint16(a+6,!0),sectorTag:t.getUint16(a+8,!0),rightSidedef:t.getInt16(a+10,!0),leftSidedef:t.getInt16(a+12,!0)})}return n}parseSidedefs(e){const t=this.getLumpData(e),n=[],i=e.size/30;for(let r=0;r<i;r++){const a=r*30;n.push({xOffset:t.getInt16(a,!0),yOffset:t.getInt16(a+2,!0),upperTexture:this.readStringFromData(t,a+4,8),lowerTexture:this.readStringFromData(t,a+12,8),middleTexture:this.readStringFromData(t,a+20,8),sector:t.getUint16(a+28,!0)})}return n}parseSectors(e){const t=this.getLumpData(e),n=[],i=e.size/26;for(let r=0;r<i;r++){const a=r*26;n.push({floorHeight:t.getInt16(a,!0),ceilingHeight:t.getInt16(a+2,!0),floorTexture:this.readStringFromData(t,a+4,8),ceilingTexture:this.readStringFromData(t,a+12,8),lightLevel:t.getUint16(a+20,!0),specialType:t.getUint16(a+22,!0),tag:t.getUint16(a+24,!0)})}return n}parseThings(e){const t=this.getLumpData(e),n=[],i=e.size/10;for(let r=0;r<i;r++){const a=r*10;n.push({x:t.getInt16(a,!0),y:t.getInt16(a+2,!0),angle:t.getUint16(a+4,!0),type:t.getUint16(a+6,!0),flags:t.getUint16(a+8,!0)})}return n}parseSubsectors(e){const t=this.getLumpData(e),n=[],i=e.size/4;for(let r=0;r<i;r++){const a=r*4;n.push({segCount:t.getUint16(a,!0),firstSeg:t.getUint16(a+2,!0)})}return n}parseSegs(e){const t=this.getLumpData(e),n=[],i=e.size/12;for(let r=0;r<i;r++){const a=r*12;n.push({startVertex:t.getUint16(a,!0),endVertex:t.getUint16(a+2,!0),angle:t.getInt16(a+4,!0),linedef:t.getUint16(a+6,!0),direction:t.getUint16(a+8,!0),offset:t.getInt16(a+10,!0)})}return n}readStringFromData(e,t,n){let i="";for(let r=0;r<n;r++){const a=e.getUint8(t+r);if(a===0)break;i+=String.fromCharCode(a)}return i}}const W=1/64,U=3,Me=4,Je=["LITE","TLITE","BFALL","SFALL","FIREBLU","FIRELAV","FIREMAG","FIREWALA","FIREWALB","FIREWALL","NUKAGE","FWATER","LAVA","BLOOD","COMP","COMPSTA","SW1COMP","SW2COMP"];function et(s){const e=s.toUpperCase().replace(/\0/g,"");for(const t of Je)if(e.startsWith(t))return!0;return!1}function tt(s){const e=s.toUpperCase();return e.includes("BLU")||e.includes("COMP")?{x:.3*U,y:.5*U,z:1*U}:e.includes("FIRE")||e.includes("LAV")||e.includes("RED")?{x:1*U,y:.4*U,z:.1*U}:e.includes("NUK")||e.includes("SLIME")||e.includes("SFALL")?{x:.2*U,y:1*U,z:.2*U}:e.includes("BLOOD")||e.includes("BFALL")?{x:.8*U,y:.1*U,z:.1*U}:{x:1*U,y:.95*U,z:.8*U}}function nt(s){return .3+.7*(s/255)}let Q=null,_e=[];function it(s){Q=s,s?_e=Array.from(s.entries.values()):_e=[]}function Be(s){if(!Q)return-1;const e=s.toUpperCase().replace(/\0/g,"").replace(/-/g,"");if(!e||e==="-")return-1;const t=Q.entries.get(e);return t?_e.indexOf(t):-1}function rt(s){const e=[],t=[],n=new Map;function i(l,c,h=""){const p=et(h),d=nt(c),g=`${l}-${c}-${h}-${p}`;if(n.has(g))return n.get(g);const f=t.length;if(n.set(g,f),l==="sky")t.push({albedo:{x:.6,y:.7,z:.9},emissive:{x:1.5,y:2,z:3},roughness:1,materialType:Y});else if(p){const _=tt(h);t.push({albedo:{x:1,y:1,z:1},emissive:_,roughness:1,materialType:Y})}else t.push({albedo:{x:d,y:d,z:d},emissive:{x:0,y:0,z:0},roughness:.85,materialType:A});return f}const r=(l,c)=>({x:l.x*W,y:c*W,z:l.y*W});function a(l,c,h,p,d,g,f="",_=0,z=0){const y=r(l,h),m=r(c,h),x=r(c,p),v=r(l,p),b=Math.sqrt((c.x-l.x)*(c.x-l.x)+(c.y-l.y)*(c.y-l.y)),T=p-h;let w=64,M=64;const P=Be(f);if(Q&&f){const Ut=f.toUpperCase().replace(/\0/g,"").replace(/-/g,""),we=Q.entries.get(Ut);we&&(w=we.width,M=we.height)}const $=_/w,ee=(_+b)/w,B=z/M,D=(z+T)/M,H={u:$,v:D},xe={u:ee,v:D},ve={u:ee,v:B},be={u:$,v:B},te=[];return g?(te.push(R(m,y,v,d,xe,H,be,P)),te.push(R(m,v,x,d,xe,be,ve,P))):(te.push(R(y,m,x,d,H,xe,ve,P)),te.push(R(y,x,v,d,H,ve,be,P))),te}for(let l=0;l<s.linedefs.length;l++){const c=s.linedefs[l],h=s.vertices[c.startVertex],p=s.vertices[c.endVertex];if(c.rightSidedef!==-1){const d=s.sidedefs[c.rightSidedef],g=s.sectors[d.sector];if(c.flags&Me){if(c.leftSidedef!==-1){const f=s.sidedefs[c.leftSidedef],_=s.sectors[f.sector];if(g.ceilingHeight>_.ceilingHeight){const z=i("wall",g.lightLevel,d.upperTexture);e.push(...a(h,p,_.ceilingHeight,g.ceilingHeight,z,!1,d.upperTexture,d.xOffset,d.yOffset))}if(g.floorHeight<_.floorHeight){const z=i("wall",g.lightLevel,d.lowerTexture);e.push(...a(h,p,g.floorHeight,_.floorHeight,z,!1,d.lowerTexture,d.xOffset,d.yOffset))}if(d.middleTexture&&d.middleTexture!=="-"){const z=i("wall",g.lightLevel,d.middleTexture),y=Math.min(g.ceilingHeight,_.ceilingHeight),m=Math.max(g.floorHeight,_.floorHeight);y>m&&e.push(...a(h,p,m,y,z,!1,d.middleTexture,d.xOffset,d.yOffset))}}}else{const f=i("wall",g.lightLevel,d.middleTexture);e.push(...a(h,p,g.floorHeight,g.ceilingHeight,f,!1,d.middleTexture,d.xOffset,d.yOffset))}}if(c.leftSidedef!==-1){const d=s.sidedefs[c.leftSidedef],g=s.sectors[d.sector];if(c.flags&Me&&c.rightSidedef!==-1){const f=s.sidedefs[c.rightSidedef],_=s.sectors[f.sector];if(g.ceilingHeight>_.ceilingHeight){const z=i("wall",g.lightLevel,d.upperTexture);e.push(...a(h,p,_.ceilingHeight,g.ceilingHeight,z,!0,d.upperTexture,d.xOffset,d.yOffset))}if(g.floorHeight<_.floorHeight){const z=i("wall",g.lightLevel,d.lowerTexture);e.push(...a(h,p,g.floorHeight,_.floorHeight,z,!0,d.lowerTexture,d.xOffset,d.yOffset))}}}}const o=ot(s);for(const l of o){const c=s.sectors[l.sectorIndex],h=c.ceilingTexture.toUpperCase().startsWith("F_SKY"),p=i("floor",c.lightLevel,c.floorTexture),d=h?i("sky",255,"SKY"):i("ceiling",c.lightLevel,c.ceilingTexture),g=ke(l.vertices,c.floorHeight*W,!1,c.floorTexture);for(const _ of g)e.push({..._,materialIndex:p});const f=ke(l.vertices,c.ceilingHeight*W,!0,h?"":c.ceilingTexture);for(const _ of f)e.push({..._,materialIndex:d})}return console.log(`Converted level ${s.name}: ${e.length} triangles, ${t.length} materials`),{triangles:e,materials:t}}function R(s,e,t,n,i,r,a,o){const l=Ue(e,s),c=Ue(t,s),h=at(st(l,c));return{v0:s,v1:e,v2:t,normal:h,materialIndex:n,uv0:i,uv1:r,uv2:a,textureIndex:o}}function Ue(s,e){return{x:s.x-e.x,y:s.y-e.y,z:s.z-e.z}}function st(s,e){return{x:s.y*e.z-s.z*e.y,y:s.z*e.x-s.x*e.z,z:s.x*e.y-s.y*e.x}}function at(s){const e=Math.sqrt(s.x*s.x+s.y*s.y+s.z*s.z);return e===0?{x:0,y:1,z:0}:{x:s.x/e,y:s.y/e,z:s.z/e}}function ot(s){const e=[],t=new Map;for(const n of s.linedefs){if(n.rightSidedef!==-1){const i=s.sidedefs[n.rightSidedef].sector;t.has(i)||t.set(i,[]),t.get(i).push({linedef:n,startVertex:n.startVertex,endVertex:n.endVertex})}if(n.leftSidedef!==-1){const i=s.sidedefs[n.leftSidedef].sector;t.has(i)||t.set(i,[]),t.get(i).push({linedef:n,startVertex:n.endVertex,endVertex:n.startVertex})}}for(const[n,i]of t){const r=new Set;for(;r.size<i.length;){let a=-1;for(let g=0;g<i.length;g++)if(!r.has(g)){a=g;break}if(a===-1)break;const o=[];let l=a,c=i[l].startVertex;const h=c;let p=0;const d=i.length+1;for(;p<d&&(p++,l!==-1);){if(r.has(l)){if(i[l].startVertex===h)break;l=-1;break}r.add(l);const g=i[l],f=s.vertices[g.startVertex];o.push({x:f.x*W,y:0,z:f.y*W}),c=g.endVertex,l=-1;for(let _=0;_<i.length;_++)if(!r.has(_)&&i[_].startVertex===c){l=_;break}if(c===h)break}o.length>=3&&e.push({sectorIndex:n,vertices:o})}}return e}function lt(s,e,t,n){return s*n-e*t}function ct(s,e,t,n,i,r,a,o){const l=a-t,c=o-n,h=i-t,p=r-n,d=s-t,g=e-n,f=l*l+c*c,_=l*h+c*p,z=l*d+c*g,y=h*h+p*p,m=h*d+p*g,x=f*y-_*_;if(Math.abs(x)<1e-10)return!1;const v=1/x,b=(y*z-_*m)*v,T=(f*m-_*z)*v;return b>=-1e-6&&T>=-1e-6&&b+T<=1.000001}function ke(s,e,t,n=""){if(s.length<3)return[];const i=[],r=Be(n),a=[];for(let g=0;g<s.length;g++)a.push(g);const o=[];for(let g=0;g<a.length;g++){const f=a[g],_=a[(g+1)%a.length],z=s[f].x-s[_].x,y=s[f].z-s[_].z;z*z+y*y>1e-10&&o.push(f)}if(o.length<3)return[];let l=0;for(let g=0;g<o.length;g++){const f=(g+1)%o.length;l+=s[o[g]].x*s[o[f]].z,l-=s[o[f]].x*s[o[g]].z}const c=l<0,h=[...o];let p=0;const d=h.length*h.length;for(;h.length>3&&p<d;){p++;let g=!1;for(let f=0;f<h.length;f++){const _=h.length,z=h[(f+_-1)%_],y=h[f],m=h[(f+1)%_],x=s[z].x,v=s[z].z,b=s[y].x,T=s[y].z,w=s[m].x,M=s[m].z,P=lt(b-x,T-v,w-b,M-T);if(!(c?P<=0:P>=0))continue;let ee=!1;for(let B=0;B<h.length;B++){if(B===(f+_-1)%_||B===f||B===(f+1)%_)continue;const D=h[B];if(ct(s[D].x,s[D].z,x,v,b,T,w,M)){ee=!0;break}}if(!ee){const B={x:s[z].x,y:e,z:s[z].z},D={x:s[y].x,y:e,z:s[y].z},H={x:s[m].x,y:e,z:s[m].z};t?i.push(R(B,H,D,0,{u:B.x,v:B.z},{u:H.x,v:H.z},{u:D.x,v:D.z},r)):i.push(R(B,D,H,0,{u:B.x,v:B.z},{u:D.x,v:D.z},{u:H.x,v:H.z},r)),h.splice(f,1),g=!0;break}}if(!g){const f=h[0],_=h[1],z=h[2],y={x:s[f].x,y:e,z:s[f].z},m={x:s[_].x,y:e,z:s[_].z},x={x:s[z].x,y:e,z:s[z].z};t?i.push(R(y,x,m,0,{u:y.x,v:y.z},{u:x.x,v:x.z},{u:m.x,v:m.z},r)):i.push(R(y,m,x,0,{u:y.x,v:y.z},{u:m.x,v:m.z},{u:x.x,v:x.z},r)),h.splice(1,1)}}if(h.length===3){const g={x:s[h[0]].x,y:e,z:s[h[0]].z},f={x:s[h[1]].x,y:e,z:s[h[1]].z},_={x:s[h[2]].x,y:e,z:s[h[2]].z};t?i.push(R(g,_,f,0,{u:g.x,v:g.z},{u:_.x,v:_.z},{u:f.x,v:f.z},r)):i.push(R(g,f,_,0,{u:g.x,v:g.z},{u:f.x,v:f.z},{u:_.x,v:_.z},r))}return i}const j=1/64,se=.35,ae=.875,Le=.375,ht=1,ut=4;class dt{constructor(e){u(this,"lines",[]);u(this,"sectors",[]);this.sectors=e.sectors.map(t=>({floor:t.floorHeight*j,ceiling:t.ceilingHeight*j}));for(const t of e.linedefs){const n=e.vertices[t.startVertex],i=e.vertices[t.endVertex],r=t.rightSidedef!==-1?e.sidedefs[t.rightSidedef].sector:-1,a=t.leftSidedef!==-1?e.sidedefs[t.leftSidedef].sector:-1;this.lines.push({x1:n.x*j,z1:n.y*j,x2:i.x*j,z2:i.y*j,frontSector:r,backSector:a,isTwoSided:(t.flags&ut)!==0,isBlocking:(t.flags&ht)!==0})}console.log(`Collision: ${this.lines.length} lines, ${this.sectors.length} sectors`)}checkMove(e,t){const n=t.x-e.x,i=t.z-e.z,r=Math.sqrt(n*n+i*i),a=se*.5,o=Math.max(1,Math.ceil(r/a));let l={...e};for(let g=0;g<o;g++){const f=(g+1)/o,_={x:e.x+n*f,y:e.y+(t.y-e.y)*f,z:e.z+i*f};l=this.tryMove(l,_)}const c=this.getFloorHeightAt(l.x,l.z,e.y),h=this.getCeilingHeightAt(l.x,l.z),p=c+ae;l.y<p&&(l.y=p);const d=h-.05;return l.y>d&&(l.y=d),l}tryMove(e,t){const n=e.y;return this.isPositionBlocked(t.x,t.z,n)?this.isPositionBlocked(t.x,e.z,n)?this.isPositionBlocked(e.x,t.z,n)?{x:e.x,y:t.y,z:e.z}:{x:e.x,y:t.y,z:t.z}:{x:t.x,y:t.y,z:e.z}:t}isPositionBlocked(e,t,n){const i=n-ae;for(const r of this.lines){if(this.pointToSegmentDistance(e,t,r.x1,r.z1,r.x2,r.z2)>=se)continue;if(!r.isTwoSided||r.frontSector===-1||r.backSector===-1||r.isBlocking)return!0;const o=this.sectors[r.frontSector].floor,l=this.sectors[r.frontSector].ceiling,c=this.sectors[r.backSector].floor,h=this.sectors[r.backSector].ceiling,p=Math.max(o,c),d=Math.min(l,h);if(d-p<ae||p-i>Le||n>d-.1)return!0}return!1}pointToSegmentDistance(e,t,n,i,r,a){const o=r-n,l=a-i,c=o*o+l*l;if(c<1e-4)return Math.sqrt((e-n)*(e-n)+(t-i)*(t-i));let h=((e-n)*o+(t-i)*l)/c;h=Math.max(0,Math.min(1,h));const p=n+h*o,d=i+h*l;return Math.sqrt((e-p)*(e-p)+(t-d)*(t-d))}getFloorHeightAt(e,t,n){let i=-1e3;const r=n-ae;for(const a of this.lines){if(a.frontSector===-1||this.pointToSegmentDistance(e,t,a.x1,a.z1,a.x2,a.z2)>se*2)continue;const l=(e-a.x1)*(a.z2-a.z1)-(t-a.z1)*(a.x2-a.x1);let c;l>=0?c=a.frontSector:a.backSector!==-1?c=a.backSector:c=a.frontSector;const h=this.sectors[c].floor;h-r<=Le&&h>i&&(i=h)}return i>-999?i:0}getCeilingHeightAt(e,t){let n=1e3;for(const i of this.lines){if(i.frontSector===-1||this.pointToSegmentDistance(e,t,i.x1,i.z1,i.x2,i.z2)>se*2)continue;const a=(e-i.x1)*(i.z2-i.z1)-(t-i.z1)*(i.x2-i.x1);let o;a>=0?o=i.frontSector:i.backSector!==-1?o=i.backSector:o=i.frontSector;const l=this.sectors[o].ceiling;l<n&&(n=l)}return n<999?n:10}getFloorHeight(e,t){return this.getFloorHeightAt(e,t,1e3)}}class ft{constructor(e){u(this,"wad");u(this,"palette",null);u(this,"patchNames",[]);u(this,"patches",new Map);u(this,"textureDefs",new Map);u(this,"flats",new Map);u(this,"composedTextures",new Map);this.wad=e}extractAll(){console.log("Extracting textures from WAD..."),this.extractPalette(),this.extractPatchNames(),this.extractPatches(),this.extractTextureDefs(),this.extractFlats(),this.composeTextures(),console.log(`Extracted: ${this.patchNames.length} patch names, ${this.patches.size} patches, ${this.textureDefs.size} texture defs, ${this.flats.size} flats`)}extractPalette(){const e=this.wad.getLumpByName("PLAYPAL");if(!e){console.warn("PLAYPAL not found");return}const t=this.wad.getLumpData(e);this.palette=new Uint8Array(768);for(let n=0;n<768;n++)this.palette[n]=t.getUint8(n);console.log("Extracted palette")}extractPatchNames(){const e=this.wad.getLumpByName("PNAMES");if(!e){console.warn("PNAMES not found");return}const t=this.wad.getLumpData(e),n=t.getInt32(0,!0);for(let i=0;i<n;i++){let r="";for(let a=0;a<8;a++){const o=t.getUint8(4+i*8+a);if(o===0)break;r+=String.fromCharCode(o)}this.patchNames.push(r.toUpperCase())}console.log(`Extracted ${this.patchNames.length} patch names`)}extractPatches(){if(!this.palette)return;const e=this.wad.getDirectory();for(const n of this.patchNames){if(this.patches.has(n))continue;const i=this.wad.getLumpByName(n);if(i&&i.size>0){const r=this.parsePatch(i,n);r&&this.patches.set(n,r)}}let t=!1;for(let n=0;n<e.length;n++){const i=e[n],r=i.name.toUpperCase();if(r==="P_START"||r==="P1_START"||r==="P2_START"||r==="PP_START"){t=!0;continue}if(r==="P_END"||r==="P1_END"||r==="P2_END"||r==="PP_END"){t=!1;continue}if(t&&i.size>0&&!this.patches.has(r)){const a=this.parsePatch(i,r);a&&this.patches.set(r,a)}}console.log(`Extracted ${this.patches.size} patches`)}parsePatch(e,t){if(!this.palette)return null;try{const n=this.wad.getLumpData(e),i=n.getUint16(0,!0),r=n.getUint16(2,!0),a=n.getInt16(4,!0),o=n.getInt16(6,!0);if(i===0||r===0||i>4096||r>4096)return null;const l=new Uint8Array(i*r*4);l.fill(0);const c=[];for(let h=0;h<i;h++)c.push(n.getUint32(8+h*4,!0));for(let h=0;h<i;h++){let p=c[h];if(!(p>=e.size))for(;;){const d=n.getUint8(p);if(d===255)break;const g=n.getUint8(p+1);p+=3;for(let f=0;f<g;f++){const _=d+f;if(_>=r)break;const z=n.getUint8(p+f),y=(_*i+h)*4;l[y]=this.palette[z*3],l[y+1]=this.palette[z*3+1],l[y+2]=this.palette[z*3+2],l[y+3]=255}p+=g+1}}return{name:t,width:i,height:r,leftOffset:a,topOffset:o,pixels:l}}catch{return null}}extractTextureDefs(){for(const e of["TEXTURE1","TEXTURE2"]){const t=this.wad.getLumpByName(e);if(!t)continue;const n=this.wad.getLumpData(t),i=n.getInt32(0,!0),r=[];for(let a=0;a<i;a++)r.push(n.getInt32(4+a*4,!0));for(const a of r){let o="";for(let d=0;d<8;d++){const g=n.getUint8(a+d);if(g===0)break;o+=String.fromCharCode(g)}o=o.toUpperCase();const l=n.getUint16(a+12,!0),c=n.getUint16(a+14,!0),h=n.getUint16(a+20,!0),p=[];for(let d=0;d<h;d++){const g=a+22+d*10;p.push({originX:n.getInt16(g,!0),originY:n.getInt16(g+2,!0),patchIndex:n.getUint16(g+4,!0)})}this.textureDefs.set(o,{name:o,width:l,height:c,patches:p})}}console.log(`Extracted ${this.textureDefs.size} texture definitions`)}extractFlats(){if(!this.palette)return;const e=this.wad.getDirectory();let t=!1;for(let n=0;n<e.length;n++){const i=e[n],r=i.name.toUpperCase();if(r==="F_START"||r==="F1_START"||r==="F2_START"||r==="FF_START"){t=!0;continue}if(r==="F_END"||r==="F1_END"||r==="F2_END"||r==="FF_END"){t=!1;continue}if(t&&i.size===4096){const a=this.parseFlat(i,r);a&&this.flats.set(r,a)}}console.log(`Extracted ${this.flats.size} flats`)}parseFlat(e,t){if(!this.palette)return null;const n=this.wad.getLumpData(e),i=new Uint8Array(64*64*4);for(let r=0;r<4096;r++){const a=n.getUint8(r);i[r*4]=this.palette[a*3],i[r*4+1]=this.palette[a*3+1],i[r*4+2]=this.palette[a*3+2],i[r*4+3]=255}return{name:t,pixels:i}}composeTextures(){for(const[e,t]of this.textureDefs){const n=new Uint8Array(t.width*t.height*4);for(let i=0;i<n.length;i+=4)n[i]=255,n[i+1]=0,n[i+2]=255,n[i+3]=0;for(const i of t.patches){if(i.patchIndex>=this.patchNames.length)continue;const r=this.patchNames[i.patchIndex],a=this.patches.get(r);if(a)for(let o=0;o<a.height;o++){const l=i.originY+o;if(!(l<0||l>=t.height))for(let c=0;c<a.width;c++){const h=i.originX+c;if(h<0||h>=t.width)continue;const p=(o*a.width+c)*4,d=(l*t.width+h)*4;a.pixels[p+3]>0&&(n[d]=a.pixels[p],n[d+1]=a.pixels[p+1],n[d+2]=a.pixels[p+2],n[d+3]=a.pixels[p+3])}}}this.composedTextures.set(e,n)}console.log(`Composed ${this.composedTextures.size} textures`)}buildAtlas(){const e=new Map,t=[];for(const[a,o]of this.textureDefs){const l=this.composedTextures.get(a);l&&t.push({name:a,width:o.width,height:o.height,pixels:l})}for(const[a,o]of this.flats)t.push({name:a,width:64,height:64,pixels:o.pixels});if(t.length===0)return{image:new Uint8Array(4),width:1,height:1,entries:e};t.sort((a,o)=>o.height-a.height);let n=1024,i=!1;for(;!i&&n<=8192;){e.clear();let a=0,o=0,l=0;i=!0;for(const c of t){if(l+c.width>n&&(a+=o,o=0,l=0),a+c.height>n){i=!1;break}e.set(c.name,{name:c.name,x:l,y:a,width:c.width,height:c.height}),l+=c.width,o=Math.max(o,c.height)}i||(n*=2)}i||console.error("Failed to pack all textures into atlas"),console.log(`Atlas size: ${n}x${n}, ${e.size} textures`);const r=new Uint8Array(n*n*4);for(let a=0;a<r.length;a+=4)r[a]=255,r[a+1]=0,r[a+2]=255,r[a+3]=255;for(const a of t){const o=e.get(a.name);if(o)for(let l=0;l<a.height;l++)for(let c=0;c<a.width;c++){const h=(l*a.width+c)*4,p=((o.y+l)*n+(o.x+c))*4;r[p]=a.pixels[h],r[p+1]=a.pixels[h+1],r[p+2]=a.pixels[h+2],r[p+3]=a.pixels[h+3]}}return{image:r,width:n,height:n,entries:e}}getTextureDimensions(e){const t=e.toUpperCase().replace(/\0/g,""),n=this.textureDefs.get(t);return n?{width:n.width,height:n.height}:this.flats.has(t)?{width:64,height:64}:null}hasTexture(e){const t=e.toUpperCase().replace(/\0/g,"");return this.textureDefs.has(t)||this.flats.has(t)}}const F=[[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,1],[1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,1],[1,0,0,0,1,0,0,1,1,1,0,0,1,1,1,1],[1,1,0,1,1,0,0,1,0,0,0,0,0,0,0,1],[1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1],[1,0,0,0,0,0,0,1,0,0,1,1,1,0,0,1],[1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,1],[1,1,1,0,0,1,1,1,0,0,1,0,0,0,0,1],[1,0,0,0,0,0,0,1,0,0,1,0,0,1,1,1],[1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],[1,0,0,1,1,1,0,0,0,0,0,0,0,0,0,1],[1,0,0,1,0,0,0,0,1,1,1,1,0,0,0,1],[1,0,0,1,0,0,0,0,1,0,0,0,0,0,0,1],[1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,1],[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]],C=2,ye=2.5,pt=1.2,gt=1,_t=1,yt=1;function Ee(){return F}function mt(){return pt}function xt(s,e,t){const n={x:e.x-s.x,y:e.y-s.y,z:e.z-s.z},i={x:t.x-s.x,y:t.y-s.y,z:t.z-s.z},r={x:n.y*i.z-n.z*i.y,y:n.z*i.x-n.x*i.z,z:n.x*i.y-n.y*i.x},a=Math.sqrt(r.x*r.x+r.y*r.y+r.z*r.z);return a===0?{x:0,y:1,z:0}:{x:r.x/a,y:r.y/a,z:r.z/a}}function Ie(s,e,t,n,i={u:0,v:0},r={u:1,v:0},a={u:1,v:1},o=-1){return{v0:s,v1:e,v2:t,normal:xt(s,e,t),materialIndex:n,uv0:i,uv1:r,uv2:a,textureIndex:o}}function X(s,e,t,n,i,r=-1){return[Ie(s,e,t,i,{u:0,v:0},{u:1,v:0},{u:1,v:1},r),Ie(s,t,n,i,{u:0,v:0},{u:1,v:1},{u:0,v:1},r)]}function vt(s,e,t,n,i,r=-1){const a=[],o=C,l=ye,c=o*.15,h=o*.85,p=l*.25,d=l*.75,g=[{u0:0,v0:0,u1:o,v1:p,mat:n},{u0:0,v0:p,u1:c,v1:d,mat:n},{u0:c,v0:p,u1:h,v1:d,mat:i},{u0:h,v0:p,u1:o,v1:d,mat:n},{u0:0,v0:d,u1:o,v1:l,mat:n}];for(const f of g){let _;switch(t){case 0:_=[{x:s+o,y:f.v0,z:e+f.u0},{x:s+o,y:f.v0,z:e+f.u1},{x:s+o,y:f.v1,z:e+f.u1},{x:s+o,y:f.v1,z:e+f.u0}];break;case 1:_=[{x:s,y:f.v0,z:e+o-f.u0},{x:s,y:f.v0,z:e+o-f.u1},{x:s,y:f.v1,z:e+o-f.u1},{x:s,y:f.v1,z:e+o-f.u0}];break;case 2:_=[{x:s+o-f.u0,y:f.v0,z:e+o},{x:s+o-f.u1,y:f.v0,z:e+o},{x:s+o-f.u1,y:f.v1,z:e+o},{x:s+o-f.u0,y:f.v1,z:e+o}];break;case 3:default:_=[{x:s+f.u0,y:f.v0,z:e},{x:s+f.u1,y:f.v0,z:e},{x:s+f.u1,y:f.v1,z:e},{x:s+f.u0,y:f.v1,z:e}];break}a.push(...X(_[0],_[1],_[2],_[3],f.mat,f.mat===i?-1:r))}return a}function bt(s,e,t,n,i=-1){const r=C,a=ye;switch(t){case 0:return X({x:s+r,y:0,z:e},{x:s+r,y:0,z:e+r},{x:s+r,y:a,z:e+r},{x:s+r,y:a,z:e},n,i);case 1:return X({x:s,y:0,z:e+r},{x:s,y:0,z:e},{x:s,y:a,z:e},{x:s,y:a,z:e+r},n,i);case 2:return X({x:s+r,y:0,z:e+r},{x:s,y:0,z:e+r},{x:s,y:a,z:e+r},{x:s+r,y:a,z:e+r},n,i);case 3:default:return X({x:s,y:0,z:e},{x:s+r,y:0,z:e},{x:s+r,y:a,z:e},{x:s,y:a,z:e},n,i)}}function wt(s){var z,y;const e=[],t=[],n=!!s;t.push({albedo:n?{x:1,y:1,z:1}:{x:.35,y:.33,z:.3},emissive:{x:0,y:0,z:0},roughness:1,materialType:A}),t.push({albedo:n?{x:1,y:1,z:1}:{x:.45,y:.42,z:.38},emissive:{x:0,y:0,z:0},roughness:1,materialType:A}),t.push({albedo:n?{x:1,y:1,z:1}:{x:.3,y:.28,z:.25},emissive:{x:0,y:0,z:0},roughness:1,materialType:A}),t.push({albedo:{x:.9,y:.75,z:.45},emissive:{x:12,y:8,z:3},roughness:1,materialType:Y});const i=0,r=1,a=2,o=3,l=s?s.wall:-1,c=s?s.floor:-1,h=s?s.ceiling:-1,p=F.length,d=F[0].length,g=new Set;for(let m=1;m<p-1;m++)for(let x=1;x<d-1;x++)F[m][x]===1&&(x+m)%3===0&&(F[m][x+1]===0?g.add(`${x},${m},0`):F[m][x-1]===0?g.add(`${x},${m},1`):((z=F[m+1])==null?void 0:z[x])===0?g.add(`${x},${m},2`):((y=F[m-1])==null?void 0:y[x])===0&&g.add(`${x},${m},3`));g.add("4,3,1");let f=0;for(let m=0;m<p;m++)for(let x=0;x<d;x++){const v=x*C,b=m*C;if(F[m][x]===1){const T=[{dx:1,dz:0,facing:0},{dx:-1,dz:0,facing:1},{dx:0,dz:1,facing:2},{dx:0,dz:-1,facing:3}];for(const w of T){const M=x+w.dx,P=m+w.dz;if(M<0||M>=d||P<0||P>=p||F[P][M]!==0)continue;const $=`${x},${m},${w.facing}`;g.has($)?(e.push(...vt(v,b,w.facing,r,o,l)),f++):e.push(...bt(v,b,w.facing,r,l))}}else{e.push(...X({x:v,y:0,z:b},{x:v+C,y:0,z:b},{x:v+C,y:0,z:b+C},{x:v,y:0,z:b+C},i,c));const T=ye-.005;e.push(...X({x:v,y:T,z:b+C},{x:v+C,y:T,z:b+C},{x:v+C,y:T,z:b},{x:v,y:T,z:b},a,h))}}const _=[];for(let m=0;m<p;m++)for(let x=0;x<d;x++)F[m][x]===0&&_.push({x:x*C+C/2,z:m*C+C/2});return console.log(`Dungeon scene: ${e.length} triangles, ${t.length} materials, ${f} wall torches, ${_.length} walkable tiles`),{triangles:e,materials:t,walkablePositions:_}}const oe=[0,1,0,-1],le=[1,0,-1,0],De=[0,Math.PI/2,Math.PI,-Math.PI/2];function zt(s,e,t){let n=e-s;for(;n>Math.PI;)n-=2*Math.PI;for(;n<-Math.PI;)n+=2*Math.PI;return s+n*t}class Tt{constructor(){u(this,"tileX");u(this,"tileZ");u(this,"facing");u(this,"worldX");u(this,"worldZ");u(this,"worldYaw");u(this,"animating",!1);u(this,"animFrom",{x:0,z:0,yaw:0});u(this,"animTo",{x:0,z:0,yaw:0});u(this,"animProgress",0);u(this,"animDuration",.25);u(this,"bobPhase",0);u(this,"bobActive",!1);u(this,"pendingActions",[]);u(this,"keysDown",new Set);u(this,"active",!1);u(this,"fov",75);u(this,"map");u(this,"eyeHeight");u(this,"keyTarget",null);u(this,"onKeyDown",null);u(this,"onKeyUp",null);this.tileX=gt,this.tileZ=_t,this.facing=yt,this.map=Ee(),this.eyeHeight=mt(),this.worldX=this.tileToWorldX(this.tileX),this.worldZ=this.tileToWorldZ(this.tileZ),this.worldYaw=De[this.facing]}tileToWorldX(e){return e*C+C/2}tileToWorldZ(e){return e*C+C/2}isWalkable(e,t){return t<0||t>=this.map.length||e<0||e>=this.map[0].length?!1:this.map[t][e]===0}attach(e,t){this.detach(),this.keyTarget=t||window,this.onKeyDown=n=>{if(!this.active)return;const i=n.code;if(!this.keysDown.has(i))switch(this.keysDown.add(i),i){case"KeyW":case"KeyA":case"KeyD":case"KeyS":case"KeyQ":case"KeyE":this.pendingActions.push(i);break}},this.onKeyUp=n=>{this.keysDown.delete(n.code)},this.keyTarget.addEventListener("keydown",this.onKeyDown),this.keyTarget.addEventListener("keyup",this.onKeyUp)}detach(){this.keyTarget&&this.onKeyDown&&(this.keyTarget.removeEventListener("keydown",this.onKeyDown),this.keyTarget.removeEventListener("keyup",this.onKeyUp)),this.keysDown.clear(),this.pendingActions=[],this.keyTarget=null}update(e){if(this.animating){if(this.animProgress+=e/this.animDuration,this.animProgress>=1)this.animProgress=1,this.animating=!1,this.bobActive=!1,this.worldX=this.animTo.x,this.worldZ=this.animTo.z,this.worldYaw=this.animTo.yaw;else{const n=this.animProgress,i=n*n*(3-2*n);this.worldX=this.animFrom.x+(this.animTo.x-this.animFrom.x)*i,this.worldZ=this.animFrom.z+(this.animTo.z-this.animFrom.z)*i,this.worldYaw=zt(this.animFrom.yaw,this.animTo.yaw,i)}this.bobActive&&(this.bobPhase+=e*12);return}if(this.pendingActions.length===0)return;const t=this.pendingActions.shift();switch(this.animFrom={x:this.worldX,z:this.worldZ,yaw:this.worldYaw},t){case"KeyW":{const n=this.tileX+oe[this.facing],i=this.tileZ+le[this.facing];this.isWalkable(n,i)&&(this.tileX=n,this.tileZ=i,this.startMoveAnim());break}case"KeyS":{const n=(this.facing+2)%4,i=this.tileX+oe[n],r=this.tileZ+le[n];this.isWalkable(i,r)&&(this.tileX=i,this.tileZ=r,this.startMoveAnim());break}case"KeyA":{const n=(this.facing+1)%4,i=this.tileX+oe[n],r=this.tileZ+le[n];this.isWalkable(i,r)&&(this.tileX=i,this.tileZ=r,this.startMoveAnim());break}case"KeyD":{const n=(this.facing+3)%4,i=this.tileX+oe[n],r=this.tileZ+le[n];this.isWalkable(i,r)&&(this.tileX=i,this.tileZ=r,this.startMoveAnim());break}case"KeyQ":{this.facing=(this.facing+1)%4,this.startTurnAnim();break}case"KeyE":{this.facing=(this.facing+3)%4,this.startTurnAnim();break}}}startMoveAnim(){this.animTo={x:this.tileToWorldX(this.tileX),z:this.tileToWorldZ(this.tileZ),yaw:this.worldYaw},this.animating=!0,this.animProgress=0,this.bobActive=!0,this.bobPhase=0}startTurnAnim(){this.animTo={x:this.worldX,z:this.worldZ,yaw:De[this.facing]},this.animating=!0,this.animProgress=0,this.bobActive=!1}getCamera(){let e=0;this.bobActive&&this.animating&&(e=Math.sin(this.bobPhase)*.06);const t={x:Math.sin(this.worldYaw),y:0,z:Math.cos(this.worldYaw)};return{position:{x:this.worldX,y:this.eyeHeight+e,z:this.worldZ},direction:t,up:{x:0,y:1,z:0},fov:this.fov}}}function St(s){return{materials:[{albedo:{x:.55,y:.08,z:.05},emissive:{x:0,y:0,z:0},roughness:1,materialType:A},{albedo:{x:.4,y:.05,z:.03},emissive:{x:0,y:0,z:0},roughness:1,materialType:A},{albedo:{x:.1,y:.05,z:.4},emissive:{x:.8,y:.2,z:.2},roughness:1,materialType:Y}],indices:{body:s,head:s+1,eye:s+2}}}function Ct(s,e,t){const n={x:e.x-s.x,y:e.y-s.y,z:e.z-s.z},i={x:t.x-s.x,y:t.y-s.y,z:t.z-s.z},r={x:n.y*i.z-n.z*i.y,y:n.z*i.x-n.x*i.z,z:n.x*i.y-n.y*i.x},a=Math.sqrt(r.x*r.x+r.y*r.y+r.z*r.z);return a===0?{x:0,y:1,z:0}:{x:r.x/a,y:r.y/a,z:r.z/a}}function Ge(s,e,t,n){return{v0:s,v1:e,v2:t,normal:Ct(s,e,t),materialIndex:n,uv0:{u:0,v:0},uv1:{u:1,v:0},uv2:{u:1,v:1},textureIndex:-1}}function V(s,e,t,n,i){return[Ge(s,e,t,i),Ge(s,t,n,i)]}function L(s,e,t,n,i,r,a){const o=[];return o.push(...V({x:s,y:e,z:r},{x:n,y:e,z:r},{x:n,y:i,z:r},{x:s,y:i,z:r},a)),o.push(...V({x:n,y:e,z:t},{x:s,y:e,z:t},{x:s,y:i,z:t},{x:n,y:i,z:t},a)),o.push(...V({x:n,y:e,z:r},{x:n,y:e,z:t},{x:n,y:i,z:t},{x:n,y:i,z:r},a)),o.push(...V({x:s,y:e,z:t},{x:s,y:e,z:r},{x:s,y:i,z:r},{x:s,y:i,z:t},a)),o.push(...V({x:s,y:i,z:r},{x:n,y:i,z:r},{x:n,y:i,z:t},{x:s,y:i,z:t},a)),o.push(...V({x:s,y:e,z:t},{x:n,y:e,z:t},{x:n,y:e,z:r},{x:s,y:e,z:r},a)),o}function Oe(s,e,t){const n=[];return n.push(...L(s-.22,0,e-.15,s+.22,.45,e+.15,t.body)),n.push(...L(s-.25,.45,e-.16,s+.25,1.15,e+.16,t.body)),n.push(...L(s-.2,1.15,e-.14,s+.2,1.3,e+.14,t.body)),n.push(...L(s-.16,1.3,e-.12,s+.16,1.55,e+.12,t.head)),n.push(...L(s-.04,1.55,e-.04,s+.04,1.72,e+.04,t.head)),n.push(...L(s-.14,1.55,e-.03,s-.08,1.65,e+.03,t.head)),n.push(...L(s+.08,1.55,e-.03,s+.14,1.65,e+.03,t.head)),n.push(...L(s-.18,1.5,e-.02,s-.13,1.58,e+.02,t.head)),n.push(...L(s+.13,1.5,e-.02,s+.18,1.58,e+.02,t.head)),n.push(...V({x:s-.08,y:1.36,z:e-.125},{x:s+.08,y:1.36,z:e-.125},{x:s+.06,y:1.48,z:e-.125},{x:s-.06,y:1.48,z:e-.125},t.eye)),n.push(...V({x:s+.08,y:1.36,z:e+.125},{x:s-.08,y:1.36,z:e+.125},{x:s-.06,y:1.48,z:e+.125},{x:s+.06,y:1.48,z:e+.125},t.eye)),n.push(...L(s-.35,.5,e-.06,s-.25,1.15,e+.06,t.body)),n.push(...L(s-.4,.35,e-.05,s-.3,.8,e+.05,t.body)),n.push(...L(s+.25,.5,e-.06,s+.35,1.15,e+.06,t.body)),n.push(...L(s+.3,.35,e-.05,s+.4,.8,e+.05,t.body)),n}const me={u:0,v:0};function ce(s,e,t,n,i){return{v0:s,v1:e,v2:t,normal:n,materialIndex:i,uv0:me,uv1:me,uv2:me,textureIndex:-1}}function k(s,e,t,n,i,r){return[ce(s,e,t,i,r),ce(s,t,n,i,r)]}function I(s,e,t,n,i,r,a){const o=n/2,l=i/2,c=r/2,h=[{x:s-o,y:e-l,z:t-c},{x:s+o,y:e-l,z:t-c},{x:s+o,y:e+l,z:t-c},{x:s-o,y:e+l,z:t-c},{x:s-o,y:e-l,z:t+c},{x:s+o,y:e-l,z:t+c},{x:s+o,y:e+l,z:t+c},{x:s-o,y:e+l,z:t+c}],p=[],d=[[0,1,2,3,{x:0,y:0,z:-1}],[5,4,7,6,{x:0,y:0,z:1}],[4,0,3,7,{x:-1,y:0,z:0}],[1,5,6,2,{x:1,y:0,z:0}],[3,2,6,7,{x:0,y:1,z:0}],[4,5,1,0,{x:0,y:-1,z:0}]];for(const[g,f,_,z,y]of d)p.push(...k(h[g],h[f],h[_],h[z],y,a));return p}function Fe(s,e,t,n,i,r,a){const o=n/2,l=i/2,c=r/2,h=[{x:s-o,y:e-l,z:t-c},{x:s+o,y:e-l,z:t-c},{x:s+o,y:e+l,z:t-c},{x:s-o,y:e+l,z:t-c},{x:s-o,y:e-l,z:t+c},{x:s+o,y:e-l,z:t+c},{x:s+o,y:e+l,z:t+c},{x:s-o,y:e+l,z:t+c}],p=[];return p.push(...k(h[5],h[4],h[7],h[6],{x:0,y:0,z:1},a)),p.push(...k(h[4],h[0],h[3],h[7],{x:-1,y:0,z:0},a)),p.push(...k(h[1],h[5],h[6],h[2],{x:1,y:0,z:0},a)),p.push(...k(h[3],h[2],h[6],h[7],{x:0,y:1,z:0},a)),p.push(...k(h[4],h[5],h[1],h[0],{x:0,y:-1,z:0},a)),p}function Pt(){const s=[{albedo:{x:.8,y:.8,z:.8},roughness:1,emissive:{x:0,y:0,z:0},materialType:A},{albedo:{x:.8,y:.15,z:.1},roughness:1,emissive:{x:0,y:0,z:0},materialType:A},{albedo:{x:.1,y:.15,z:.8},roughness:1,emissive:{x:0,y:0,z:0},materialType:A},{albedo:{x:.1,y:.7,z:.15},roughness:1,emissive:{x:0,y:0,z:0},materialType:A},{albedo:{x:.8,y:.75,z:.1},roughness:1,emissive:{x:0,y:0,z:0},materialType:A},{albedo:{x:.9,y:.5,z:.1},roughness:1,emissive:{x:0,y:0,z:0},materialType:A},{albedo:{x:.1,y:.7,z:.7},roughness:1,emissive:{x:0,y:0,z:0},materialType:A},{albedo:{x:0,y:0,z:0},roughness:1,emissive:{x:8,y:7.5,z:6.5},materialType:Y},{albedo:{x:.3,y:.3,z:.3},roughness:1,emissive:{x:0,y:0,z:0},materialType:A}],e=[];e.push(...k({x:-10,y:0,z:0},{x:10,y:0,z:0},{x:10,y:0,z:8},{x:-10,y:0,z:8},{x:0,y:1,z:0},0)),e.push(...k({x:-10,y:10,z:0},{x:-10,y:10,z:8},{x:10,y:10,z:8},{x:10,y:10,z:0},{x:0,y:-1,z:0},0)),e.push(...k({x:-10,y:0,z:8},{x:10,y:0,z:8},{x:10,y:10,z:8},{x:-10,y:10,z:8},{x:0,y:0,z:-1},0)),e.push(...k({x:-10,y:0,z:0},{x:-10,y:0,z:8},{x:-10,y:10,z:8},{x:-10,y:10,z:0},{x:1,y:0,z:0},0)),e.push(...k({x:10,y:0,z:0},{x:10,y:10,z:0},{x:10,y:10,z:8},{x:10,y:0,z:8},{x:-1,y:0,z:0},0)),e.push(...k({x:-10,y:0,z:0},{x:-10,y:10,z:0},{x:10,y:10,z:0},{x:10,y:0,z:0},{x:0,y:0,z:1},0)),e.push(...k({x:-2,y:9.99,z:3},{x:2,y:9.99,z:3},{x:2,y:9.99,z:5},{x:-2,y:9.99,z:5},{x:0,y:-1,z:0},7)),e.push(...I(-7,1,5,2,2,2,1)),e.push(...I(-5,4,3,1.5,1.5,1.5,3)),e.push(...I(-7,1.5,7,1.5,3,1.5,2));const t=.8;e.push(...I(5.5,1.5,4.5,t,t,t,1)),e.push(...I(6.5,1.5,4.5,t,t,t,2)),e.push(...I(5.5,2.5,4.5,t,t,t,3)),e.push(...I(6.5,2.5,4.5,t,t,t,4)),e.push(...I(5.5,1.5,5.5,t,t,t,5)),e.push(...I(6.5,1.5,5.5,t,t,t,6)),e.push(...I(5.5,2.5,5.5,t,t,t,1)),e.push(...I(6.5,2.5,5.5,t,t,t,2)),e.push(...Fe(0,3,5,4,4,4,4)),e.push(...Fe(0,3,5,2.5,2.5,2.5,5)),e.push(...I(0,3,5,1,1,1,1));{const n={x:-9,y:.5,z:1},i={x:9,y:9,z:7},r={x:i.x-n.x,y:i.y-n.y,z:i.z-n.z},a={x:0,y:1,z:0},o=r.y*a.z-r.z*a.y,l=r.z*a.x-r.x*a.z,c=r.x*a.y-r.y*a.x,h=Math.sqrt(o*o+l*l+c*c),p=.25,d={x:o/h*p,y:l/h*p,z:c/h*p},g={x:n.x-d.x,y:n.y-d.y,z:n.z-d.z},f={x:n.x+d.x,y:n.y+d.y,z:n.z+d.z},_={x:i.x+d.x,y:i.y+d.y,z:i.z+d.z},z={x:i.x-d.x,y:i.y-d.y,z:i.z-d.z},y={x:f.x-g.x,y:f.y-g.y,z:f.z-g.z},m={x:_.x-g.x,y:_.y-g.y,z:_.z-g.z},x=y.y*m.z-y.z*m.y,v=y.z*m.x-y.x*m.z,b=y.x*m.y-y.y*m.x,T=Math.sqrt(x*x+v*v+b*b),w={x:x/T,y:v/T,z:b/T};e.push(ce(g,f,_,w,8)),e.push(ce(g,_,z,w,8))}{const o=[[0,.05,0,.05],[.05,0,.05,0],[0,.05,0,.05],[.05,0,.05,0]];for(let l=0;l<4;l++)for(let c=0;c<4;c++){const h=2+c*1.75,p=.5+l*.625,d=o[l][c],g=(l+c)%2===0?0:8;e.push(...k({x:h,y:d,z:p},{x:h+1.75,y:d,z:p},{x:h+1.75,y:d,z:p+.625},{x:h,y:d,z:p+.625},{x:0,y:1,z:0},g))}}return console.log(`BVH Teaching scene: ${e.length} triangles, ${s.length} materials`),{triangles:e,materials:s}}const At=(()=>{try{return new URL(".",G&&G.tagName.toUpperCase()==="SCRIPT"&&G.src||new URL("path-tracer.js",document.baseURI).href).href}catch{}return document.currentScript instanceof HTMLScriptElement?new URL(".",document.currentScript.src).href:""})(),S={scene:"doom",samples:4,bounces:3,resolution:1,temporal:1,denoise:"atrous","denoise-passes":1,"debug-mode":0,"debug-opacity":100,"debug-window":!0,"debug-depth":3,"player-light":17,"player-falloff":17,"render-distance":10,phantom:!0,width:1280,height:800},Mt=`
  :host {
    display: block;
    position: relative;
    background: #000;
    font-family: system-ui, sans-serif;
  }
  canvas {
    display: block;
    max-width: 100%;
    max-height: 100vh;
  }
  #error {
    color: #ff6b6b;
    padding: 2rem;
    text-align: center;
    display: none;
  }
  #hint {
    position: absolute;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.875rem;
    pointer-events: none;
    transition: opacity 0.3s;
  }
  #hint.hidden { opacity: 0; }
  #controls {
    position: absolute;
    top: 1rem;
    right: 1rem;
    background: rgba(0, 0, 0, 0.8);
    padding: 1rem;
    border-radius: 8px;
    color: white;
    font-size: 0.875rem;
    min-width: 220px;
  }
  #controls label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }
  #controls input[type="range"] { width: 80px; }
  #controls input[type="checkbox"] { width: 18px; height: 18px; }
  #controls .value {
    min-width: 45px;
    text-align: right;
    font-family: monospace;
  }
  #controls select {
    background: #333;
    color: white;
    border: none;
    padding: 4px 8px;
    border-radius: 4px;
  }
  #stats {
    font-family: monospace;
    font-size: 0.8rem;
    margin-bottom: 0.75rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.2);
    line-height: 1.4;
  }
  #stats .stat-row {
    display: flex;
    justify-content: space-between;
  }
  #stats .stat-value { color: #8f8; }
  #container.paused canvas {
    filter: brightness(0.4);
    transition: filter 0.3s;
  }
  #container.paused #controls {
    opacity: 0.3;
    pointer-events: none;
    transition: opacity 0.3s;
  }
  #controls.hidden, #hint.hidden { display: none; }
  #play-overlay {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    display: none;
    justify-content: center;
    align-items: center;
    cursor: pointer;
    z-index: 10;
  }
  #play-overlay.visible { display: flex; }
  #play-btn {
    width: 80px;
    height: 80px;
    background: #000;
    border-radius: 50%;
    display: flex;
    justify-content: center;
    align-items: center;
    transition: transform 0.15s;
  }
  #play-btn:hover { transform: scale(1.1); }
  #play-btn svg {
    width: 36px;
    height: 36px;
    margin-left: 4px;
  }
`,Bt=`
  <div id="stats">
    <div class="stat-row"><span>FPS:</span> <span class="stat-value" id="fps-value">--</span></div>
    <div class="stat-row"><span>Rays/sec:</span> <span class="stat-value" id="rays-value">--</span></div>
    <div class="stat-row"><span>Samples:</span> <span class="stat-value" id="samples-display">--</span></div>
    <div class="stat-row"><span>Resolution:</span> <span class="stat-value" id="res-display">--</span></div>
  </div>
  <label>
    <span>Scene</span>
    <select id="scene-select">
      <option value="doom">Doom E1M1</option>
      <option value="dungeon">Dungeon</option>
      <option value="bvh">BVH Teaching</option>
    </select>
  </label>
  <label>
    <span>Samples/pixel</span>
    <input type="range" id="samples" min="1" max="64" value="4" step="1">
    <span class="value" id="samples-value">4</span>
  </label>
  <label>
    <span>Max bounces</span>
    <input type="range" id="bounces" min="1" max="10" value="3">
    <span class="value" id="bounces-value">3</span>
  </label>
  <label>
    <span>Resolution</span>
    <select id="resolution">
      <option value="0.25">0.25x</option>
      <option value="0.5">0.5x</option>
      <option value="0.75">0.75x</option>
      <option value="1.0">1.0x</option>
      <option value="2.0">2.0x</option>
    </select>
  </label>
  <label>
    <span>Temporal</span>
    <input type="range" id="temporal" min="0" max="5" value="1" step="1">
    <span class="value" id="temporal-value">1</span>
  </label>
  <label>
    <span>Denoise</span>
    <select id="denoise-mode">
      <option value="off">Off</option>
      <option value="median">Median</option>
      <option value="adaptive">Adaptive</option>
      <option value="atrous">À-trous</option>
    </select>
  </label>
  <label id="denoise-passes-label">
    <span>Denoise passes</span>
    <input type="range" id="denoise" min="1" max="5" value="1" step="1">
    <span class="value" id="denoise-value">1</span>
  </label>
  <label>
    <span>Debug BVH</span>
    <select id="debug-mode">
      <option value="0">Off</option>
      <option value="1">Traversal</option>
      <option value="2">Depth</option>
      <option value="3">Leaf count</option>
      <option value="4">Wireframe</option>
    </select>
  </label>
  <label id="debug-opacity-label" style="display: none;">
    <span>Debug opacity</span>
    <input type="range" id="debug-opacity" min="0" max="100" value="100" step="5">
    <span class="value" id="debug-opacity-value">100%</span>
  </label>
  <label id="debug-window-label" style="display: none;">
    <span>Window mode</span>
    <input type="checkbox" id="debug-window" checked>
  </label>
  <label id="debug-depth-label" style="display: none;">
    <span>BVH depth</span>
    <input type="range" id="debug-depth" min="0" max="20" value="3" step="1">
    <span class="value" id="debug-depth-value">3</span>
  </label>
  <label id="player-light-label" style="display: none;">
    <span>Player torch</span>
    <input type="range" id="player-light" min="0" max="20" value="17" step="1">
    <span class="value" id="player-light-value">17</span>
  </label>
  <label id="player-falloff-label" style="display: none;">
    <span>Torch size</span>
    <input type="range" id="player-falloff" min="1" max="20" value="17" step="1">
    <span class="value" id="player-falloff-value">17</span>
  </label>
  <label id="render-dist-label" style="display: none;">
    <span>View distance</span>
    <input type="range" id="render-dist" min="2" max="10" value="10" step="1">
    <span class="value" id="render-dist-value">10</span>
  </label>
  <label id="phantom-label" style="display: none;">
    <span>Phantom</span>
    <input type="checkbox" id="phantom" checked>
  </label>
`,q=class q extends HTMLElement{constructor(){super();u(this,"shadow");u(this,"canvas");u(this,"initialized",!1);u(this,"animFrameId",0);u(this,"paused",!1);u(this,"userPaused",!1);u(this,"scrollPaused",!1);u(this,"warmupFrames",0);u(this,"intersectionObserver",null);u(this,"pendingScreenshot",!1);u(this,"device");u(this,"gpuContext");u(this,"format");u(this,"renderer");u(this,"doomScene");u(this,"doomTextureAtlas",null);u(this,"doomCameraController");u(this,"dungeonScene");u(this,"dungeonTextureAtlas",null);u(this,"dungeonCameraController");u(this,"bvhScene");u(this,"bvhCameraController");u(this,"activeScene",S.scene);u(this,"currentCamera");u(this,"dungeonMap");u(this,"phantomMats");u(this,"phantomX",0);u(this,"phantomZ",0);u(this,"phantomDirZ",1);u(this,"phantomSpeed",1);u(this,"phantomTriangles",[]);u(this,"lastTime",0);u(this,"frameCount",0);u(this,"fpsAccumulator",0);u(this,"lastFpsUpdate",0);this.shadow=this.attachShadow({mode:"open"})}assetURL(t){const n=this.getAttribute("asset-base")||At;return n?new URL(t,n).href:t}getNum(t,n){const i=this.getAttribute(t);if(i===null)return n;const r=parseFloat(i);return isNaN(r)?n:r}getStr(t,n){return this.getAttribute(t)??n}getBool(t,n){if(!this.hasAttribute(t))return this.initialized?!1:n;const i=this.getAttribute(t);return!(i==="false"||i==="0")}connectedCallback(){this.setAttribute("tabindex","0"),this.buildDOM(),this.init().catch(t=>{console.error("PathTracer init failed:",t),this.showError(String(t))})}disconnectedCallback(){var t,n,i,r;this.animFrameId&&cancelAnimationFrame(this.animFrameId),(t=this.intersectionObserver)==null||t.disconnect(),(n=this.doomCameraController)==null||n.detach(),(i=this.dungeonCameraController)==null||i.detach(),(r=this.bvhCameraController)==null||r.detach()}attributeChangedCallback(t,n,i){!this.initialized||n===i||this.applyAttribute(t)}buildDOM(){const t=this.getNum("width",S.width),n=this.getNum("height",S.height),i=this.hasAttribute("controls");this.shadow.innerHTML=`
      <style>${Mt}</style>
      <div id="error"></div>
      <div id="container">
        <canvas width="${t}" height="${n}"></canvas>
        <div id="play-overlay">
          <div id="play-btn">
            <svg viewBox="0 0 24 24" fill="white"><polygon points="6,3 20,12 6,21"/></svg>
          </div>
        </div>
        <div id="hint">Click to capture mouse | WASD to move | Q/E to rotate | Space/Shift for up/down | ESC to release</div>
        ${i?`<div id="controls">${Bt}</div>`:""}
      </div>
    `,this.canvas=this.shadow.querySelector("canvas")}showError(t){const n=this.shadow.querySelector("#error");n&&(n.textContent=t,n.style.display="block"),this.canvas.style.display="none"}async init(){var n;if(!navigator.gpu){this.showError("WebGPU is not supported in this browser.");return}const t=await navigator.gpu.requestAdapter();if(!t){this.showError("Failed to get WebGPU adapter.");return}if(this.device=await t.requestDevice(),this.gpuContext=this.canvas.getContext("webgpu"),!this.gpuContext){this.showError("Failed to get WebGPU context.");return}this.format=navigator.gpu.getPreferredCanvasFormat(),this.gpuContext.configure({device:this.device,format:this.format,alphaMode:"premultiplied"}),await Promise.all([this.loadDoom(),this.loadDungeon(),this.loadBVH()]),this.activeScene=this.getStr("scene",S.scene),this.setActiveCamera(),await this.createRenderer(),this.hasAttribute("controls")&&this.wireControls(),(n=this.shadow.getElementById("play-overlay"))==null||n.addEventListener("click",()=>{this.warmupFrames=q.WARMUP_COUNT+1,this.userPaused=!1,this.resume()}),window.addEventListener("keydown",i=>{var r,a;i.code==="KeyC"?((r=this.shadow.getElementById("controls"))==null||r.classList.toggle("hidden"),(a=this.shadow.getElementById("hint"))==null||a.classList.toggle("hidden")):i.code==="Digit0"&&(this.pendingScreenshot=!0)}),this.initialized=!0,!this.hasAttribute("debug-window")&&S["debug-window"]&&this.setAttribute("debug-window",""),!this.hasAttribute("phantom")&&S.phantom&&this.setAttribute("phantom","");for(const i of q.observedAttributes)this.hasAttribute(i)&&i!=="width"&&i!=="height"&&i!=="controls"&&this.applyAttribute(i);this.setupVisibilityObserver(),this.lastTime=performance.now(),this.lastFpsUpdate=this.lastTime,this.animFrameId=requestAnimationFrame(i=>this.frame(i))}async loadDoom(){try{const t=await fetch(this.assetURL("wads/DOOM1.WAD"));if(!t.ok)throw new Error("WAD not found");const n=await t.arrayBuffer(),i=new Qe(n);console.log("Available levels:",i.getLevelNames());const r=new ft(i);r.extractAll(),this.doomTextureAtlas=r.buildAtlas(),it(this.doomTextureAtlas);const a=i.parseLevel("E1M1");this.doomScene=rt(a);const o=a.things.find(f=>f.type===1),l=o?o.x/64:0,c=o?o.y/64:0,h=o?o.angle*Math.PI/180:0,p=new dt(a),d=p.getFloorHeight(l,c),g=.875;this.doomCameraController=new ge({x:l,y:d+g,z:c},h-Math.PI/2,0,90,5,.002),this.doomCameraController.setCollision(p),console.log(`Loaded Doom: ${this.doomScene.triangles.length} triangles`)}catch(t){console.warn("Failed to load WAD, using Cornell box:",t),this.doomScene=We(),this.doomCameraController=new ge({x:0,y:0,z:-4.5},0,0,60,3,.002)}}async loadDungeon(){let t;try{const i=new Image;i.src=this.assetURL("heretic64x64.png"),await new Promise((h,p)=>{i.onload=()=>h(),i.onerror=()=>p(new Error("Failed to load dungeon atlas"))});const r=document.createElement("canvas");r.width=i.width,r.height=i.height;const a=r.getContext("2d");a.drawImage(i,0,0);const o=a.getImageData(0,0,i.width,i.height),l=64,c=new Map;c.set("wall",{name:"wall",x:0,y:0,width:l,height:l}),c.set("floor",{name:"floor",x:0,y:7*l,width:l,height:l}),c.set("ceiling",{name:"ceiling",x:4*l,y:0,width:l,height:l}),this.dungeonTextureAtlas={image:new Uint8Array(o.data.buffer),width:i.width,height:i.height,entries:c},t={wall:0,floor:1,ceiling:2},console.log(`Dungeon atlas loaded: ${i.width}x${i.height}`)}catch(i){console.warn("Failed to load dungeon texture atlas:",i)}this.dungeonScene=wt(t),this.dungeonCameraController=new Tt;const n=St(this.dungeonScene.materials.length);this.dungeonScene.materials.push(...n.materials),this.dungeonMap=Ee(),this.phantomMats=n.indices,this.phantomX=3*C+C/2,this.phantomZ=1*C+C/2,this.phantomTriangles=Oe(this.phantomX,this.phantomZ,this.phantomMats)}async loadBVH(){this.bvhScene=Pt(),this.bvhCameraController=new ge({x:0,y:5,z:1},0,0,90,5,.002)}getSceneData(){return this.activeScene==="dungeon"?{scene:this.dungeonScene,atlas:this.dungeonTextureAtlas}:this.activeScene==="bvh"?{scene:this.bvhScene,atlas:null}:{scene:this.doomScene,atlas:this.doomTextureAtlas}}setActiveCamera(){var t,n,i;(t=this.doomCameraController)==null||t.detach(),(n=this.dungeonCameraController)==null||n.detach(),(i=this.bvhCameraController)==null||i.detach(),this.activeScene==="dungeon"?(this.dungeonCameraController.active=!0,this.dungeonCameraController.attach(this.canvas,this),this.currentCamera=this.dungeonCameraController):this.activeScene==="bvh"?(this.bvhCameraController.attach(this.canvas,this),this.currentCamera=this.bvhCameraController):(this.doomCameraController.attach(this.canvas,this),this.currentCamera=this.doomCameraController)}async createRenderer(){const{scene:t,atlas:n}=this.getSceneData();this.renderer=new pe(this.device,this.gpuContext,this.format,this.canvas.width,this.canvas.height,this.currentCamera.getCamera(),t.triangles,t.materials,n,t.walkablePositions),this.renderer.resolutionScale=this.getNum("resolution",S.resolution),this.activeScene==="dungeon"&&(this.renderer.renderDistance=this.getNum("render-distance",S["render-distance"])*C),await this.renderer.initialize(),this.renderer.samplesPerPixel=this.getNum("samples",S.samples),this.renderer.maxBounces=this.getNum("bounces",S.bounces),this.renderer.temporalFrames=this.getNum("temporal",S.temporal),this.renderer.debugMode=this.getNum("debug-mode",S["debug-mode"]),this.renderer.debugDepth=this.getNum("debug-depth",S["debug-depth"]),this.renderer.debugOpacity=this.getNum("debug-opacity",S["debug-opacity"])/100,this.renderer.debugWindow=this.getBool("debug-window",S["debug-window"])?1:0,this.applyDenoise(),this.applyPlayerLight(),this.applyPhantom()}async recreateRenderer(){this.initialized&&(this.setActiveCamera(),await this.createRenderer(),this.syncControlsToState())}applyAttribute(t){if(this.renderer)switch(t){case"samples":{const n=this.getNum("samples",S.samples);this.renderer.samplesPerPixel=n,this.syncControl("samples",n,"samples-value");break}case"bounces":{const n=this.getNum("bounces",S.bounces);this.renderer.maxBounces=n,this.syncControl("bounces",n,"bounces-value");break}case"temporal":{const n=this.getNum("temporal",S.temporal);this.renderer.temporalFrames=n,this.syncControl("temporal",n,"temporal-value");break}case"denoise":case"denoise-passes":this.applyDenoise();break;case"debug-mode":{const n=this.getNum("debug-mode",S["debug-mode"]);this.renderer.debugMode=n,this.updateDebugVisibility();break}case"debug-opacity":{const n=this.getNum("debug-opacity",S["debug-opacity"]);this.renderer.debugOpacity=n/100,this.syncControl("debug-opacity",n,"debug-opacity-value",n+"%");break}case"debug-window":{this.renderer.debugWindow=this.getBool("debug-window",!1)?1:0;break}case"debug-depth":{const n=this.getNum("debug-depth",S["debug-depth"]);this.renderer.debugDepth=n,this.syncControl("debug-depth",n,"debug-depth-value");break}case"player-light":case"player-falloff":this.applyPlayerLight();break;case"phantom":this.applyPhantom();break;case"scene":{const n=this.getStr("scene",S.scene);n!==this.activeScene&&(this.activeScene=n,this.recreateRenderer());break}case"resolution":this.recreateRenderer();break;case"render-distance":this.activeScene==="dungeon"&&this.recreateRenderer();break}}applyDenoise(){if(!this.renderer)return;const t=this.getStr("denoise",S.denoise);t==="off"?this.renderer.denoisePasses=0:(this.renderer.denoiseMode=t,this.renderer.denoisePasses=this.getNum("denoise-passes",S["denoise-passes"]))}applyPlayerLight(){if(!this.renderer)return;const t=this.getNum("player-light",S["player-light"])/10,n=this.getNum("player-falloff",S["player-falloff"]);this.activeScene==="dungeon"&&t>0?(this.renderer.playerLightColor={x:3.5*t,y:2.4*t,z:1*t},this.renderer.playerLightRadius=n*.02):(this.renderer.playerLightColor={x:0,y:0,z:0},this.renderer.playerLightRadius=0)}applyPhantom(){this.renderer&&(this.activeScene==="dungeon"&&this.getBool("phantom",S.phantom)?this.renderer.setDynamicTriangles(this.phantomTriangles):this.renderer.setDynamicTriangles([]))}$(t){return this.shadow.getElementById(t)}syncControl(t,n,i,r){const a=this.$(t),o=this.$(i);a&&(a.value=String(n)),o&&(o.textContent=r??String(n))}syncControlsToState(){if(!this.hasAttribute("controls"))return;const t=this.$("scene-select");t&&(t.value=this.activeScene),this.syncControl("samples",this.renderer.samplesPerPixel,"samples-value"),this.syncControl("bounces",this.renderer.maxBounces,"bounces-value"),this.syncControl("temporal",this.renderer.temporalFrames,"temporal-value");const n=this.$("resolution");n&&(n.value=String(this.renderer.resolutionScale));const i=this.$("denoise-mode");i&&(i.value=this.renderer.denoisePasses===0?"off":this.renderer.denoiseMode),this.syncControl("denoise",this.renderer.denoisePasses,"denoise-value");const r=this.$("debug-mode");r&&(r.value=String(this.renderer.debugMode)),this.syncControl("debug-opacity",Math.round(this.renderer.debugOpacity*100),"debug-opacity-value",Math.round(this.renderer.debugOpacity*100)+"%"),this.syncControl("debug-depth",this.renderer.debugDepth,"debug-depth-value"),this.syncControl("player-light",this.getNum("player-light",S["player-light"]),"player-light-value"),this.syncControl("player-falloff",this.getNum("player-falloff",S["player-falloff"]),"player-falloff-value"),this.syncControl("render-dist",this.getNum("render-distance",S["render-distance"]),"render-dist-value");const a=this.activeScene==="dungeon"?"":"none";this.$("player-light-label").style.display=a,this.$("player-falloff-label").style.display=a,this.$("render-dist-label").style.display=a,this.$("phantom-label").style.display=a,this.updateDebugVisibility();const o=this.$("denoise-passes-label");o&&(o.style.display=this.renderer.denoisePasses===0?"none":"")}updateDebugVisibility(){var a;const t=((a=this.renderer)==null?void 0:a.debugMode)>0,n=this.$("debug-opacity-label"),i=this.$("debug-window-label"),r=this.$("debug-depth-label");n&&(n.style.display=t?"":"none"),i&&(i.style.display=t?"":"none"),r&&(r.style.display=t?"":"none")}wireControls(){var n,i,r,a,o,l,c,h,p,d,g,f,_,z;this.syncControlsToState(),(n=this.$("scene-select"))==null||n.addEventListener("change",y=>{this.setAttribute("scene",y.target.value)}),(i=this.$("samples"))==null||i.addEventListener("input",y=>{this.setAttribute("samples",y.target.value)}),(r=this.$("bounces"))==null||r.addEventListener("input",y=>{this.setAttribute("bounces",y.target.value)}),(a=this.$("resolution"))==null||a.addEventListener("change",y=>{this.setAttribute("resolution",y.target.value)}),(o=this.$("temporal"))==null||o.addEventListener("input",y=>{this.setAttribute("temporal",y.target.value)}),(l=this.$("denoise-mode"))==null||l.addEventListener("change",y=>{const m=y.target.value;this.setAttribute("denoise",m);const x=this.$("denoise-passes-label");x&&(x.style.display=m==="off"?"none":"")}),(c=this.$("denoise"))==null||c.addEventListener("input",y=>{const m=y.target.value;this.setAttribute("denoise-passes",m);const x=this.$("denoise-value");x&&(x.textContent=m)}),(h=this.$("debug-mode"))==null||h.addEventListener("change",y=>{this.setAttribute("debug-mode",y.target.value)}),(p=this.$("debug-opacity"))==null||p.addEventListener("input",y=>{this.setAttribute("debug-opacity",y.target.value)}),(d=this.$("debug-window"))==null||d.addEventListener("change",y=>{y.target.checked?this.setAttribute("debug-window",""):this.removeAttribute("debug-window")}),(g=this.$("debug-depth"))==null||g.addEventListener("input",y=>{this.setAttribute("debug-depth",y.target.value)}),(f=this.$("player-light"))==null||f.addEventListener("input",y=>{const m=y.target.value;this.setAttribute("player-light",m);const x=this.$("player-light-value");x&&(x.textContent=m)}),(_=this.$("player-falloff"))==null||_.addEventListener("input",y=>{const m=y.target.value;this.setAttribute("player-falloff",m);const x=this.$("player-falloff-value");x&&(x.textContent=m)});const t=this.$("render-dist");t==null||t.addEventListener("input",y=>{const m=y.target.value,x=this.$("render-dist-value");x&&(x.textContent=m)}),t==null||t.addEventListener("change",y=>{this.setAttribute("render-distance",y.target.value)}),(z=this.$("phantom"))==null||z.addEventListener("change",y=>{y.target.checked?this.setAttribute("phantom",""):this.removeAttribute("phantom")})}pause(){var n;if(this.paused)return;this.paused=!0,this.animFrameId&&(cancelAnimationFrame(this.animFrameId),this.animFrameId=0);const t=this.shadow.getElementById("container");t==null||t.classList.add("paused"),this.userPaused&&((n=this.shadow.getElementById("play-overlay"))==null||n.classList.add("visible"))}resume(){var n;if(!this.paused||this.userPaused||this.scrollPaused)return;this.paused=!1;const t=this.shadow.getElementById("container");t==null||t.classList.remove("paused"),(n=this.shadow.getElementById("play-overlay"))==null||n.classList.remove("visible"),this.lastTime=performance.now(),this.animFrameId=requestAnimationFrame(i=>this.frame(i))}setupVisibilityObserver(){this.intersectionObserver=new IntersectionObserver(([t])=>{t.isIntersecting?(this.scrollPaused=!1,this.resume()):(this.scrollPaused=!0,this.pause())},{threshold:0}),this.intersectionObserver.observe(this)}frame(t){var i;const n=(t-this.lastTime)/1e3;if(this.lastTime=t,this.currentCamera.update(n),this.activeScene==="dungeon"&&this.getBool("phantom",S.phantom)){const r=this.phantomZ+this.phantomDirZ*this.phantomSpeed*n,a=Math.floor(this.phantomX/C),o=Math.floor(r/C);((i=this.dungeonMap[o])==null?void 0:i[a])===1?this.phantomDirZ=-this.phantomDirZ:this.phantomZ=r,this.phantomTriangles=Oe(this.phantomX,this.phantomZ,this.phantomMats),this.renderer.setDynamicTriangles(this.phantomTriangles)}if(this.renderer.updateCamera(this.currentCamera.getCamera()),this.renderer.render(),this.pendingScreenshot&&(this.pendingScreenshot=!1,this.canvas.toBlob(r=>{r&&navigator.clipboard.write([new ClipboardItem({[r.type]:r})])})),this.warmupFrames++,this.warmupFrames===q.WARMUP_COUNT){this.userPaused=!0,this.pause();return}if(this.frameCount++,this.fpsAccumulator+=n,t-this.lastFpsUpdate>=500){const r=this.frameCount/this.fpsAccumulator,a=Math.floor(this.canvas.width*this.renderer.resolutionScale),o=Math.floor(this.canvas.height*this.renderer.resolutionScale),l=a*o,c=this.renderer.samplesPerPixel,h=l*c*r,p=this.$("fps-value"),d=this.$("rays-value"),g=this.$("samples-display"),f=this.$("res-display");p&&(p.textContent=r.toFixed(1)),d&&(d.textContent=this.formatNumber(h)),g&&(g.textContent=`${c}/px`),f&&(f.textContent=`${a}x${o}`),this.frameCount=0,this.fpsAccumulator=0,this.lastFpsUpdate=t}this.animFrameId=requestAnimationFrame(r=>this.frame(r))}formatNumber(t){return t>=1e9?(t/1e9).toFixed(2)+"B":t>=1e6?(t/1e6).toFixed(2)+"M":t>=1e3?(t/1e3).toFixed(1)+"K":t.toFixed(0)}};u(q,"observedAttributes",["scene","samples","bounces","resolution","temporal","denoise","denoise-passes","debug-mode","debug-opacity","debug-window","debug-depth","player-light","player-falloff","render-distance","phantom","width","height","controls"]),u(q,"WARMUP_COUNT",3);let he=q;return customElements.define("path-tracer",he),N.PathTracerElement=he,Object.defineProperty(N,Symbol.toStringTag,{value:"Module"}),N}({});
