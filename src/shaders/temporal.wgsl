// Temporal reprojection shader
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
