const PI = 3.14159265359;

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
  emissive: vec3f,
  _pad5: f32,
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
}

struct HitInfo {
  t: f32,
  normal: vec3f,
  color: vec3f,
  emissive: vec3f,
  hit: bool,
}

@group(0) @binding(0) var output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var<storage, read> triangles: array<Triangle>;
@group(0) @binding(3) var<storage, read> bvh_nodes: array<BVHNode>;
@group(0) @binding(4) var<uniform> scene_info: SceneInfo;
@group(0) @binding(5) var accumulation: texture_2d<f32>;

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

// Trace ray using BVH
fn trace_bvh(ray_origin: vec3f, ray_dir: vec3f) -> HitInfo {
  var closest_hit: HitInfo;
  closest_hit.t = 1e30;
  closest_hit.hit = false;
  closest_hit.emissive = vec3f(0.0);

  if (scene_info.node_count == 0u) {
    return closest_hit;
  }

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
        let tri = triangles[tri_idx];
        let t = intersect_triangle(ray_origin, ray_dir, tri.v0, tri.v1, tri.v2);

        if (t > 0.0 && t < closest_hit.t) {
          closest_hit.t = t;
          closest_hit.normal = tri.normal;
          closest_hit.color = tri.color;
          closest_hit.emissive = tri.emissive;
          closest_hit.hit = true;
        }
      }
    } else {
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

  return normalize(forward + right * ndc.x + up * ndc.y);
}

// Path trace a single ray
fn path_trace(ray_origin_in: vec3f, ray_dir_in: vec3f, rng_state: ptr<function, u32>) -> vec3f {
  var ray_origin = ray_origin_in;
  var ray_dir = ray_dir_in;
  var throughput = vec3f(1.0);
  var radiance = vec3f(0.0);

  for (var bounce = 0u; bounce < scene_info.max_bounces; bounce++) {
    let hit = trace_bvh(ray_origin, ray_dir);

    if (!hit.hit) {
      // Miss - return background (dark for indoor scene)
      break;
    }

    // Add emissive contribution
    radiance += throughput * hit.emissive;

    // Update throughput with surface albedo
    throughput *= hit.color;

    // Russian roulette for path termination (after a few bounces)
    if (bounce > 2u) {
      let p = max(throughput.x, max(throughput.y, throughput.z));
      if (pcg(rng_state) > p) {
        break;
      }
      throughput /= p;
    }

    // Calculate hit position and offset slightly along normal
    let hit_pos = ray_origin + ray_dir * hit.t;

    // Ensure we're on the correct side of the surface
    var normal = hit.normal;
    if (dot(ray_dir, normal) > 0.0) {
      normal = -normal;
    }

    ray_origin = hit_pos + normal * 0.001;

    // Sample new direction (cosine-weighted hemisphere)
    let r1 = pcg(rng_state);
    let r2 = pcg(rng_state);
    ray_dir = cosine_hemisphere(normal, r1, r2);

    // For cosine-weighted sampling, the PDF cancels with the cosine term in rendering equation
    // So we don't need to explicitly multiply by cos(theta) / PDF
  }

  return radiance;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let dims = textureDimensions(output);

  if (global_id.x >= dims.x || global_id.y >= dims.y) {
    return;
  }

  // Initialize RNG
  var rng_state = rand_seed(global_id.xy, scene_info.frame);

  // Add sub-pixel jitter for anti-aliasing
  let jitter_x = pcg(&rng_state) - 0.5;
  let jitter_y = pcg(&rng_state) - 0.5;
  let pixel = vec2f(f32(global_id.x) + 0.5 + jitter_x, f32(global_id.y) + 0.5 + jitter_y);

  let ray_origin = camera.position;
  let ray_dir = generate_ray(pixel);

  // Path trace
  var color = path_trace(ray_origin, ray_dir, &rng_state);

  // Clamp to prevent fireflies
  color = clamp(color, vec3f(0.0), vec3f(10.0));

  // Temporal accumulation - blend with previous frames
  let frame = f32(scene_info.frame);
  if (frame > 0.0) {
    let prev_color = textureLoad(accumulation, vec2i(global_id.xy), 0).rgb;
    // Running average: new_avg = old_avg + (new_sample - old_avg) / (n + 1)
    color = prev_color + (color - prev_color) / (frame + 1.0);
  }

  textureStore(output, global_id.xy, vec4f(color, 1.0));
}
