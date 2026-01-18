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

struct Triangle {
  v0: vec3f,
  _pad0: f32,
  v1: vec3f,
  _pad1: f32,
  v2: vec3f,
  _pad2: f32,
  normal: vec3f,
  _pad3: f32,
  color: vec3f,
  _pad4: f32,
}

struct BVHNode {
  min_bounds: vec3f,
  left_child_or_first_tri: u32,
  max_bounds: vec3f,
  right_child_or_count: u32,  // High bit set = leaf, lower bits = tri count
}

struct SceneInfo {
  triangle_count: u32,
  node_count: u32,
  _pad0: u32,
  _pad1: u32,
}

struct HitInfo {
  t: f32,
  normal: vec3f,
  color: vec3f,
  hit: bool,
}

@group(0) @binding(0) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var<storage, read> triangles: array<Triangle>;
@group(0) @binding(3) var<storage, read> bvh_nodes: array<BVHNode>;
@group(0) @binding(4) var<uniform> scene_info: SceneInfo;

const LIGHT_DIR = vec3f(0.5, 0.7, 0.3);
const MAX_STACK_SIZE = 32u;
const LEAF_FLAG = 0x80000000u;

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

  if (t > 0.00001) {
    return t;
  }

  return -1.0;
}

// Ray-AABB intersection
fn intersect_aabb(ray_origin: vec3f, ray_dir_inv: vec3f, box_min: vec3f, box_max: vec3f, max_t: f32) -> bool {
  let t1 = (box_min - ray_origin) * ray_dir_inv;
  let t2 = (box_max - ray_origin) * ray_dir_inv;

  let tmin = max(max(min(t1.x, t2.x), min(t1.y, t2.y)), min(t1.z, t2.z));
  let tmax = min(min(max(t1.x, t2.x), max(t1.y, t2.y)), max(t1.z, t2.z));

  return tmax >= tmin && tmin < max_t && tmax > 0.0;
}

// Check if node is a leaf (high bit set)
fn is_leaf(node: BVHNode) -> bool {
  return (node.right_child_or_count & LEAF_FLAG) != 0u;
}

// Get triangle count from leaf node
fn get_tri_count(node: BVHNode) -> u32 {
  return node.right_child_or_count & 0x7FFFFFFFu;
}

// Trace ray using BVH with iterative stack-based traversal
fn trace_bvh(ray_origin: vec3f, ray_dir: vec3f) -> HitInfo {
  var closest_hit: HitInfo;
  closest_hit.t = 1e30;
  closest_hit.hit = false;

  // Handle empty scene
  if (scene_info.node_count == 0u) {
    return closest_hit;
  }

  // Precompute inverse ray direction for AABB tests
  let ray_dir_inv = 1.0 / ray_dir;

  // Stack for iterative traversal
  var stack: array<u32, MAX_STACK_SIZE>;
  var stack_ptr = 0u;

  // Start with root node
  stack[0] = 0u;
  stack_ptr = 1u;

  while (stack_ptr > 0u) {
    stack_ptr -= 1u;
    let node_idx = stack[stack_ptr];
    let node = bvh_nodes[node_idx];

    // Test ray against node bounds
    if (!intersect_aabb(ray_origin, ray_dir_inv, node.min_bounds, node.max_bounds, closest_hit.t)) {
      continue;
    }

    if (is_leaf(node)) {
      // Leaf node - test triangles
      let tri_count = get_tri_count(node);
      let first_tri = node.left_child_or_first_tri;

      for (var i = 0u; i < tri_count; i++) {
        let tri_idx = first_tri + i;
        let tri = triangles[tri_idx];
        let t = intersect_triangle(ray_origin, ray_dir, tri.v0, tri.v1, tri.v2);

        if (t > 0.0 && t < closest_hit.t) {
          closest_hit.t = t;
          closest_hit.normal = tri.normal;
          closest_hit.color = tri.color;
          closest_hit.hit = true;
        }
      }
    } else {
      // Internal node - push both children onto stack
      let left_child = node.left_child_or_first_tri;
      let right_child = node.right_child_or_count;

      if (stack_ptr < MAX_STACK_SIZE - 1u) {
        stack[stack_ptr] = left_child;
        stack_ptr += 1u;
        stack[stack_ptr] = right_child;
        stack_ptr += 1u;
      }
    }
  }

  return closest_hit;
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

  let ray_dir = normalize(forward + right * ndc.x + up * ndc.y);

  return ray_dir;
}

// Lambertian diffuse shading
fn shade(hit: HitInfo) -> vec3f {
  let light_dir = normalize(LIGHT_DIR);
  let ndotl = max(dot(hit.normal, light_dir), 0.0);

  let ambient = 0.15;
  let diffuse = ndotl * 0.85;

  return hit.color * (ambient + diffuse);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let dims = textureDimensions(output);

  if (global_id.x >= dims.x || global_id.y >= dims.y) {
    return;
  }

  let pixel = vec2f(f32(global_id.x) + 0.5, f32(global_id.y) + 0.5);
  let ray_origin = camera.position;
  let ray_dir = generate_ray(pixel);

  // Trace using BVH
  let hit = trace_bvh(ray_origin, ray_dir);

  var color: vec3f;
  if (hit.hit) {
    color = shade(hit);
  } else {
    let t = 0.5 * (ray_dir.y + 1.0);
    color = mix(vec3f(0.1, 0.1, 0.15), vec3f(0.3, 0.3, 0.4), t);
  }

  textureStore(output, global_id.xy, vec4f(color, 1.0));
}
