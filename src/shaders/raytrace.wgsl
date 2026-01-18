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

struct SceneInfo {
  triangle_count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
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
@group(0) @binding(3) var<uniform> scene_info: SceneInfo;

// Hardcoded light direction (normalized, pointing down and to the right)
const LIGHT_DIR = vec3f(0.5, 0.7, 0.3);

// Ray-Triangle intersection using Moller-Trumbore algorithm
// Returns t value, or -1 if no hit
fn intersect_triangle(ray_origin: vec3f, ray_dir: vec3f, v0: vec3f, v1: vec3f, v2: vec3f) -> f32 {
  let edge1 = v1 - v0;
  let edge2 = v2 - v0;
  let h = cross(ray_dir, edge2);
  let a = dot(edge1, h);

  // Check if ray is parallel to triangle
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

// Trace ray against all triangles in the scene
fn trace_scene(ray_origin: vec3f, ray_dir: vec3f) -> HitInfo {
  var closest_hit: HitInfo;
  closest_hit.t = 1e30;
  closest_hit.hit = false;

  for (var i = 0u; i < scene_info.triangle_count; i++) {
    let tri = triangles[i];
    let t = intersect_triangle(ray_origin, ray_dir, tri.v0, tri.v1, tri.v2);

    if (t > 0.0 && t < closest_hit.t) {
      closest_hit.t = t;
      closest_hit.normal = tri.normal;
      closest_hit.color = tri.color;
      closest_hit.hit = true;
    }
  }

  return closest_hit;
}

// Generate camera ray for a given pixel
fn generate_ray(pixel: vec2f) -> vec3f {
  let aspect = camera.resolution.x / camera.resolution.y;
  let fov_scale = tan(camera.fov * 0.5);

  // Normalize pixel coordinates to [-1, 1]
  let ndc = vec2f(
    (2.0 * pixel.x / camera.resolution.x - 1.0) * aspect * fov_scale,
    (1.0 - 2.0 * pixel.y / camera.resolution.y) * fov_scale
  );

  // Build camera coordinate system
  let forward = normalize(camera.direction);
  let right = normalize(cross(forward, camera.up));
  let up = cross(right, forward);

  // Generate ray direction
  let ray_dir = normalize(forward + right * ndc.x + up * ndc.y);

  return ray_dir;
}

// Lambertian diffuse shading
fn shade(hit: HitInfo) -> vec3f {
  let light_dir = normalize(LIGHT_DIR);

  // Compute diffuse term (Lambertian)
  let ndotl = max(dot(hit.normal, light_dir), 0.0);

  // Add ambient term to prevent completely black shadows
  let ambient = 0.15;
  let diffuse = ndotl * 0.85;

  return hit.color * (ambient + diffuse);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let dims = textureDimensions(output);

  // Bounds check
  if (global_id.x >= dims.x || global_id.y >= dims.y) {
    return;
  }

  let pixel = vec2f(f32(global_id.x) + 0.5, f32(global_id.y) + 0.5);
  let ray_origin = camera.position;
  let ray_dir = generate_ray(pixel);

  // Trace against all triangles
  let hit = trace_scene(ray_origin, ray_dir);

  var color: vec3f;
  if (hit.hit) {
    // Apply Lambertian shading
    color = shade(hit);
  } else {
    // Miss - background gradient
    let t = 0.5 * (ray_dir.y + 1.0);
    color = mix(vec3f(0.1, 0.1, 0.15), vec3f(0.3, 0.3, 0.4), t);
  }

  textureStore(output, global_id.xy, vec4f(color, 1.0));
}
