/**
 * 哈希与噪声
 *
 * 纯整数哈希在移动端可能慢，这里的 hash21/hash22 用法与 shadertoy 上的常见实现一致，
 * 数值稳定且没有 sin 调用的精度问题。
 */

// ---------------------------------------------------------------------------
// 哈希
// ---------------------------------------------------------------------------

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

// ---------------------------------------------------------------------------
// 值噪声（不依赖纹理的版本，用于 UV 已扭曲或低频场合）
// ---------------------------------------------------------------------------

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/**
 * fbm（fractal brownian motion）。
 * 注意：正式渲染路径请优先用纹理版 fbmNoise()，这个只用于低频/调试。
 */
float fbm(vec2 p0, int octaves) {
  vec2 p = p0;
  float a = 0.5;
  float s = 0.0;
  float n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    s += a * vnoise(p);
    n += a;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(5.3, 1.7);
    a *= 0.5;
  }
  return s / max(n, 1e-5);
}

/**
 * 脊线噪声（用于山脉）。
 */
float ridged(vec2 p, int octaves) {
  float s = 0.0;
  float a = 0.5;
  float n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    float v = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
    v *= v;
    s += a * v;
    n += a;
    p *= 2.03;
    a *= 0.5;
  }
  return s / max(n, 1e-5);
}
