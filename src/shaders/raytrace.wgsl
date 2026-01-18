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

@group(0) @binding(0) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> camera: Camera;

// Hardcoded triangle vertices (colorful triangle)
const v0 = vec3f(-1.0, -1.0, 2.0);
const v1 = vec3f(1.0, -1.0, 2.0);
const v2 = vec3f(0.0, 1.0, 2.0);

// Triangle vertex colors
const c0 = vec3f(1.0, 0.0, 0.0); // Red
const c1 = vec3f(0.0, 1.0, 0.0); // Green
const c2 = vec3f(0.0, 0.0, 1.0); // Blue

// Ray-Triangle intersection using Moller-Trumbore algorithm
// Returns vec4(t, u, v, hit) where hit > 0 means intersection
fn intersect_triangle(ray_origin: vec3f, ray_dir: vec3f, v0: vec3f, v1: vec3f, v2: vec3f) -> vec4f {
  let edge1 = v1 - v0;
  let edge2 = v2 - v0;
  let h = cross(ray_dir, edge2);
  let a = dot(edge1, h);

  // Check if ray is parallel to triangle
  if (abs(a) < 0.00001) {
    return vec4f(-1.0, 0.0, 0.0, 0.0);
  }

  let f = 1.0 / a;
  let s = ray_origin - v0;
  let u = f * dot(s, h);

  if (u < 0.0 || u > 1.0) {
    return vec4f(-1.0, 0.0, 0.0, 0.0);
  }

  let q = cross(s, edge1);
  let v = f * dot(ray_dir, q);

  if (v < 0.0 || u + v > 1.0) {
    return vec4f(-1.0, 0.0, 0.0, 0.0);
  }

  let t = f * dot(edge2, q);

  if (t > 0.00001) {
    return vec4f(t, u, v, 1.0);
  }

  return vec4f(-1.0, 0.0, 0.0, 0.0);
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

  // Test intersection with hardcoded triangle
  let hit = intersect_triangle(ray_origin, ray_dir, v0, v1, v2);

  var color: vec3f;
  if (hit.w > 0.0) {
    // Hit - interpolate colors using barycentric coordinates
    let u = hit.y;
    let v = hit.z;
    let w = 1.0 - u - v;
    color = c0 * w + c1 * u + c2 * v;
  } else {
    // Miss - background gradient
    let t = 0.5 * (ray_dir.y + 1.0);
    color = mix(vec3f(0.1, 0.1, 0.15), vec3f(0.3, 0.3, 0.4), t);
  }

  textureStore(output, global_id.xy, vec4f(color, 1.0));
}
