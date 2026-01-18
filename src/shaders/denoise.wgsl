// À-trous wavelet edge-aware denoiser
// Uses G-buffer (normals, depth) to preserve edges while smoothing noise

struct DenoiseParams {
  step_size: u32,
  sigma_color: f32,
  sigma_normal: f32,
  sigma_depth: f32,
}

@group(0) @binding(0) var input_color: texture_2d<f32>;
@group(0) @binding(1) var input_normal: texture_2d<f32>;
@group(0) @binding(2) var input_depth: texture_2d<f32>;
@group(0) @binding(3) var output_color: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> params: DenoiseParams;

// 5x5 à-trous kernel weights (B3 spline)
const KERNEL_SIZE = 5;
const kernel_weights = array<f32, 5>(
  1.0 / 16.0,
  4.0 / 16.0,
  6.0 / 16.0,
  4.0 / 16.0,
  1.0 / 16.0
);

fn edge_weight(
  center_normal: vec3f,
  sample_normal: vec3f,
  center_depth: f32,
  sample_depth: f32,
  center_color: vec3f,
  sample_color: vec3f,
  sigma_normal: f32,
  sigma_depth: f32,
  sigma_color: f32
) -> f32 {
  // Normal similarity weight
  let normal_dot = max(0.0, dot(center_normal, sample_normal));
  let normal_weight = pow(normal_dot, sigma_normal);

  // Depth similarity weight
  let depth_diff = abs(center_depth - sample_depth);
  let depth_weight = exp(-depth_diff * sigma_depth);

  // Color similarity weight (helps preserve texture detail)
  let color_diff = length(center_color - sample_color);
  let color_weight = exp(-color_diff * color_diff * sigma_color);

  return normal_weight * depth_weight * color_weight;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let dims = textureDimensions(input_color);

  if (global_id.x >= dims.x || global_id.y >= dims.y) {
    return;
  }

  let center_coord = vec2i(global_id.xy);
  let step = i32(params.step_size);

  // Load center pixel data
  let center_color = textureLoad(input_color, center_coord, 0).rgb;
  let center_normal = textureLoad(input_normal, center_coord, 0).rgb;
  let center_depth = textureLoad(input_depth, center_coord, 0).r;

  // If no hit (depth is very large), just pass through
  if (center_depth > 1e20) {
    textureStore(output_color, center_coord, vec4f(center_color, 1.0));
    return;
  }

  var sum_color = vec3f(0.0);
  var sum_weight = 0.0;

  // Sample 5x5 sparse kernel
  for (var j = 0; j < KERNEL_SIZE; j++) {
    for (var i = 0; i < KERNEL_SIZE; i++) {
      let offset = vec2i(i - 2, j - 2) * step;
      let sample_coord = center_coord + offset;

      // Clamp to image bounds
      let clamped_coord = clamp(sample_coord, vec2i(0), vec2i(dims) - 1);

      // Load sample data
      let sample_color = textureLoad(input_color, clamped_coord, 0).rgb;
      let sample_normal = textureLoad(input_normal, clamped_coord, 0).rgb;
      let sample_depth = textureLoad(input_depth, clamped_coord, 0).r;

      // Compute spatial weight from kernel
      let spatial_weight = kernel_weights[i] * kernel_weights[j];

      // Compute edge-aware weight
      let edge_w = edge_weight(
        center_normal, sample_normal,
        center_depth, sample_depth,
        center_color, sample_color,
        params.sigma_normal,
        params.sigma_depth,
        params.sigma_color
      );

      let weight = spatial_weight * edge_w;
      sum_color += sample_color * weight;
      sum_weight += weight;
    }
  }

  // Normalize
  var result = center_color;
  if (sum_weight > 0.0001) {
    result = sum_color / sum_weight;
  }

  textureStore(output_color, center_coord, vec4f(result, 1.0));
}
