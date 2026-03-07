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

struct Triangle {
  v0: vec3f,
  _pad0: f32,
  v1: vec3f,
  _pad1: f32,
  v2: vec3f,
  _pad2: f32,
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
  _pad0: u32,
  _pad1: u32,
}

struct HitInfo {
  t: f32,
  normal: vec3f,
  material_index: u32,
  hit: bool,
  uv: vec2f,
  texture_index: i32,
}

@group(0) @binding(0) var output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var<storage, read> triangles: array<Triangle>;
@group(0) @binding(3) var<storage, read> materials: array<Material>;
@group(0) @binding(4) var<storage, read> bvh_nodes: array<BVHNode>;
@group(0) @binding(5) var<uniform> scene_info: SceneInfo;
@group(0) @binding(6) var output_normal: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var output_depth: texture_storage_2d<r32float, write>;
@group(0) @binding(8) var texture_atlas: texture_2d<f32>;
@group(0) @binding(9) var atlas_sampler: sampler;
@group(0) @binding(10) var<storage, read> atlas_entries: array<AtlasEntry>;

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

// Brute-force trace all triangles (no BVH)
fn trace_brute(ray_origin: vec3f, ray_dir: vec3f) -> HitInfo {
  var closest_hit: HitInfo;
  closest_hit.t = 1e30;
  closest_hit.hit = false;
  closest_hit.material_index = 0u;
  closest_hit.uv = vec2f(0.0, 0.0);
  closest_hit.texture_index = -1;

  for (var i = 0u; i < scene_info.triangle_count; i++) {
    let tri = triangles[i];
    let hit_result = intersect_triangle_uv(ray_origin, ray_dir, tri.v0, tri.v1, tri.v2);
    if (hit_result.t > 0.0 && hit_result.t < closest_hit.t) {
      closest_hit.t = hit_result.t;
      closest_hit.normal = tri.normal;
      closest_hit.material_index = tri.material_index;
      closest_hit.hit = true;
      closest_hit.texture_index = tri.texture_index;
      let w = 1.0 - hit_result.u - hit_result.v;
      closest_hit.uv = w * tri.uv0 + hit_result.u * tri.uv1 + hit_result.v * tri.uv2;
    }
  }

  return closest_hit;
}

// Trace ray using BVH with ordered traversal
fn trace_bvh_accel(ray_origin: vec3f, ray_dir: vec3f) -> HitInfo {
  var closest_hit: HitInfo;
  closest_hit.t = 1e30;
  closest_hit.hit = false;
  closest_hit.material_index = 0u;
  closest_hit.uv = vec2f(0.0, 0.0);
  closest_hit.texture_index = -1;

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
        let hit_result = intersect_triangle_uv(ray_origin, ray_dir, tri.v0, tri.v1, tri.v2);

        if (hit_result.t > 0.0 && hit_result.t < closest_hit.t) {
          closest_hit.t = hit_result.t;
          closest_hit.normal = tri.normal;
          closest_hit.material_index = tri.material_index;
          closest_hit.hit = true;
          closest_hit.texture_index = tri.texture_index;

          // Interpolate UV using barycentric coordinates
          let w = 1.0 - hit_result.u - hit_result.v;
          closest_hit.uv = w * tri.uv0 + hit_result.u * tri.uv1 + hit_result.v * tri.uv2;
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
fn trace_scene(ray_origin: vec3f, ray_dir: vec3f) -> HitInfo {
  var hit: HitInfo;
  if (scene_info.node_count == 0u) {
    hit = trace_brute(ray_origin, ray_dir);
  } else {
    hit = trace_bvh_accel(ray_origin, ray_dir);
  }

  // Test dynamic (non-BVH) triangles
  for (var i = 0u; i < scene_info.dynamic_tri_count; i++) {
    let tri_idx = scene_info.dynamic_tri_offset + i;
    let tri = triangles[tri_idx];
    let hit_result = intersect_triangle_uv(ray_origin, ray_dir, tri.v0, tri.v1, tri.v2);
    if (hit_result.t > 0.0 && hit_result.t < hit.t) {
      hit.t = hit_result.t;
      hit.normal = tri.normal;
      hit.material_index = tri.material_index;
      hit.hit = true;
      hit.texture_index = tri.texture_index;
      let w = 1.0 - hit_result.u - hit_result.v;
      hit.uv = w * tri.uv0 + hit_result.u * tri.uv1 + hit_result.v * tri.uv2;
    }
  }

  // Player light sphere — emissive sphere at camera position
  // Only test if ray origin is outside the sphere (skip primary rays from camera)
  if (scene_info.player_light_radius > 0.0 && length(ray_origin - camera.position) > scene_info.player_light_radius + 0.01) {
    let sphere_t = intersect_sphere(ray_origin, ray_dir, camera.position, scene_info.player_light_radius);
    if (sphere_t > 0.0 && sphere_t < hit.t) {
      hit.t = sphere_t;
      let hit_pos = ray_origin + ray_dir * sphere_t;
      hit.normal = normalize(hit_pos - camera.position);
      hit.material_index = 0u;
      hit.hit = true;
      hit.texture_index = -2; // sentinel for player light sphere
      hit.uv = vec2f(0.0, 0.0);
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

// Path trace a single ray, optionally outputting primary hit info for G-buffer
fn path_trace(ray_origin_in: vec3f, ray_dir_in: vec3f, rng_state: ptr<function, u32>, out_normal: ptr<function, vec3f>, out_depth: ptr<function, f32>) -> vec3f {
  var ray_origin = ray_origin_in;
  var ray_dir = ray_dir_in;
  var throughput = vec3f(1.0);
  var radiance = vec3f(0.0);

  for (var bounce = 0u; bounce < scene_info.max_bounces; bounce++) {
    let hit = trace_scene(ray_origin, ray_dir);

    if (!hit.hit) {
      // Miss - return background (dark for indoor scene)
      break;
    }

    // Output primary hit info for G-buffer on first bounce
    if (bounce == 0u) {
      var pn = hit.normal;
      if (dot(ray_dir, pn) > 0.0) {
        pn = -pn;
      }
      *out_normal = pn;
      *out_depth = hit.t;
    }

    // Player light sphere hit — treat as emissive and stop
    if (hit.texture_index == -2) {
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

    // Add emissive contribution
    radiance += throughput * mat.emissive;

    // Calculate hit position
    let hit_pos = ray_origin + ray_dir * hit.t;

    // Ensure we're on the correct side of the surface
    var normal = hit.normal;
    if (dot(ray_dir, normal) > 0.0) {
      normal = -normal;
    }

    // Handle different material types
    if (mat.material_type == MATERIAL_EMISSIVE) {
      // Pure emissive surface - stop tracing
      break;
    } else if (mat.material_type == MATERIAL_SPECULAR) {
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
    } else {
      // Diffuse material (MATERIAL_DIFFUSE)
      // Update throughput with textured surface color
      throughput *= surface_color;

      ray_origin = hit_pos + normal * 0.001;

      // Sample new direction (cosine-weighted hemisphere)
      let r1 = pcg(rng_state);
      let r2 = pcg(rng_state);
      ray_dir = cosine_hemisphere(normal, r1, r2);

      // For cosine-weighted sampling, the PDF cancels with the cosine term in rendering equation
      // So we don't need to explicitly multiply by cos(theta) / PDF
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

  // Initialize RNG
  var rng_state = rand_seed(global_id.xy, scene_info.frame);

  let samples_per_pixel = scene_info.samples_per_pixel;

  var color = vec3f(0.0);
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
    color += path_trace(ray_origin, ray_dir, &rng_state, &sample_normal, &sample_depth);

    if (s == 0u) {
      primary_normal = sample_normal;
      primary_depth = sample_depth;
    }
  }

  // Average samples
  color /= f32(samples_per_pixel);

  // Clamp to prevent fireflies
  color = clamp(color, vec3f(0.0), vec3f(5.0));

  // Write G-buffer
  textureStore(output_normal, global_id.xy, vec4f(primary_normal, 1.0));
  textureStore(output_depth, global_id.xy, vec4f(primary_depth, 0.0, 0.0, 0.0));

  // Output averaged sample
  textureStore(output, global_id.xy, vec4f(color, 1.0));
}
