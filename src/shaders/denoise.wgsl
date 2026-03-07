// Configurable denoiser with two modes:
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
