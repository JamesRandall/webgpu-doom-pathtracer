// Temporal reprojection shader
// Blends current frame with reprojected history for stable image during movement

struct TemporalParams {
  screen_width: f32,
  screen_height: f32,
  blend_factor: f32,    // Base blend factor when history is valid
  depth_threshold: f32, // Threshold for depth rejection
  static_frame_count: u32, // Number of frames camera has been static (0 = moving)
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

struct CameraMatrices {
  inv_view_proj: mat4x4f,      // Current frame inverse view-projection
  prev_view_proj: mat4x4f,     // Previous frame view-projection
}

@group(0) @binding(0) var current_color: texture_2d<f32>;
@group(0) @binding(1) var current_depth: texture_2d<f32>;
@group(0) @binding(2) var current_normal: texture_2d<f32>;
@group(0) @binding(3) var history_color: texture_2d<f32>;
@group(0) @binding(4) var history_depth: texture_2d<f32>;
@group(0) @binding(5) var output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var<uniform> params: TemporalParams;
@group(0) @binding(7) var<uniform> matrices: CameraMatrices;

// Reconstruct world position from pixel coordinates and depth
fn reconstruct_world_pos(pixel: vec2f, depth: f32) -> vec3f {
  let ndc = vec2f(
    (pixel.x / params.screen_width) * 2.0 - 1.0,
    1.0 - (pixel.y / params.screen_height) * 2.0
  );

  // Use depth as view-space z for reconstruction
  // We store ray t-value, so world pos = camera_pos + ray_dir * t
  // For proper reconstruction, we need inv_view_proj
  let clip = vec4f(ndc, 0.0, 1.0);
  let view_dir = matrices.inv_view_proj * clip;
  let ray_dir = normalize(view_dir.xyz / view_dir.w);

  // Get camera position from inverse view-proj (last column transformed)
  let cam_pos_h = matrices.inv_view_proj * vec4f(0.0, 0.0, 0.0, 1.0);
  let cam_pos = cam_pos_h.xyz / cam_pos_h.w;

  return cam_pos + ray_dir * depth;
}

// Reproject world position to previous frame screen coordinates
fn reproject(world_pos: vec3f) -> vec2f {
  let clip = matrices.prev_view_proj * vec4f(world_pos, 1.0);
  let ndc = clip.xy / clip.w;
  return vec2f(
    (ndc.x * 0.5 + 0.5) * params.screen_width,
    (0.5 - ndc.y * 0.5) * params.screen_height
  );
}

// Compute expected depth at world position in previous frame
fn compute_expected_depth(world_pos: vec3f) -> f32 {
  let clip = matrices.prev_view_proj * vec4f(world_pos, 1.0);
  // Return the w component which represents distance from camera
  return clip.w;
}

// Sample 3x3 neighbourhood and compute min/max for clamping
fn get_neighbourhood_bounds(center: vec2i) -> array<vec3f, 2> {
  var min_col = vec3f(1e10);
  var max_col = vec3f(-1e10);

  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let sample_pos = center + vec2i(dx, dy);
      let col = textureLoad(current_color, sample_pos, 0).rgb;
      min_col = min(min_col, col);
      max_col = max(max_col, col);
    }
  }

  return array<vec3f, 2>(min_col, max_col);
}

// Bilinear sample from history (manual implementation for storage texture compatibility)
fn sample_history_bilinear(pos: vec2f) -> vec3f {
  let dims = vec2f(params.screen_width, params.screen_height);
  let pos_clamped = clamp(pos, vec2f(0.5), dims - vec2f(0.5));

  let p0 = vec2i(floor(pos_clamped - 0.5));
  let f = fract(pos_clamped - 0.5);

  let c00 = textureLoad(history_color, clamp(p0, vec2i(0), vec2i(dims) - 1), 0).rgb;
  let c10 = textureLoad(history_color, clamp(p0 + vec2i(1, 0), vec2i(0), vec2i(dims) - 1), 0).rgb;
  let c01 = textureLoad(history_color, clamp(p0 + vec2i(0, 1), vec2i(0), vec2i(dims) - 1), 0).rgb;
  let c11 = textureLoad(history_color, clamp(p0 + vec2i(1, 1), vec2i(0), vec2i(dims) - 1), 0).rgb;

  let c0 = mix(c00, c10, f.x);
  let c1 = mix(c01, c11, f.x);
  return mix(c0, c1, f.y);
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

  let d0 = mix(d00, d10, f.x);
  let d1 = mix(d01, d11, f.x);
  return mix(d0, d1, f.y);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let dims = textureDimensions(current_color);

  if (global_id.x >= dims.x || global_id.y >= dims.y) {
    return;
  }

  let pixel_coord = vec2i(global_id.xy);
  let pixel = vec2f(global_id.xy) + 0.5;

  // Load current frame data
  let current_col = textureLoad(current_color, pixel_coord, 0).rgb;
  let depth = textureLoad(current_depth, pixel_coord, 0).r;
  let normal = textureLoad(current_normal, pixel_coord, 0).rgb;

  // If no hit (background), just output current colour
  if (depth > 1e20) {
    textureStore(output, pixel_coord, vec4f(current_col, 1.0));
    return;
  }

  var valid_history = true;
  var history_col = vec3f(0.0);

  // When camera is static, use exact pixel coordinates (no reprojection blur)
  if (params.static_frame_count > 0u) {
    history_col = textureLoad(history_color, pixel_coord, 0).rgb;
    let prev_depth = textureLoad(history_depth, pixel_coord, 0).r;
    let depth_diff = abs(prev_depth - depth) / max(depth, 0.001);
    valid_history = depth_diff < params.depth_threshold;
  } else {
    // Camera moving - reconstruct world position and reproject
    let world_pos = reconstruct_world_pos(pixel, depth);
    let prev_pixel = reproject(world_pos);

    // Check if reprojected position is on screen
    let on_screen = prev_pixel.x >= 0.0 && prev_pixel.x < params.screen_width &&
                    prev_pixel.y >= 0.0 && prev_pixel.y < params.screen_height;

    valid_history = on_screen;

    if (on_screen) {
      // Sample history with bilinear interpolation for sub-pixel accuracy
      history_col = sample_history_bilinear(prev_pixel);
      let prev_depth = sample_history_depth_bilinear(prev_pixel);

      // Disocclusion detection
      let depth_diff = abs(prev_depth - depth) / max(depth, 0.001);
      valid_history = depth_diff < params.depth_threshold;
    }
  }

  // Blend factor - use what's passed in (already computed on CPU based on static/moving)
  var blend = select(1.0, params.blend_factor, valid_history);

  var result: vec3f;

  // When camera is static, skip neighbourhood clamping for proper convergence
  if (params.static_frame_count > 0u) {
    // Static camera - simple accumulation without clamping
    result = mix(history_col, current_col, blend);
  } else {
    // Moving camera - use neighbourhood clamping to reduce ghosting
    let bounds = get_neighbourhood_bounds(pixel_coord);
    let min_col = bounds[0];
    let max_col = bounds[1];

    // Expand bounds slightly to allow some temporal variance
    let bounds_expand = 0.25;
    let range = max_col - min_col;
    let clamped_history = clamp(history_col, min_col - range * bounds_expand, max_col + range * bounds_expand);

    // Increase blend factor if history was significantly clamped
    let clamp_amount = length(history_col - clamped_history);
    blend = mix(blend, min(blend * 4.0, 0.5), saturate(clamp_amount * 2.0));

    result = mix(clamped_history, current_col, blend);
  }

  textureStore(output, pixel_coord, vec4f(result, 1.0));
}
