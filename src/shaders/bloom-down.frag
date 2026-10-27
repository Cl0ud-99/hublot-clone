/**
 * Bloom：降采样（13-tap）
 *
 * 用的是 CoD:AW / Jimenez 在 SIGGRAPH 2014 发表的经典方案：
 * 「Next Generation Post Processing in Call of Duty: Advanced Warfare」。
 *
 * 为什么用 13-tap 而不是直接双线性缩小：
 *   双线性缩小只采样 4 个点，高频内容会闪烁（尤其在运动中）。
 *   13-tap 的采样核覆盖范围更大、分布更均匀，等效于一次
 *   质量不错的抗锯齿 + 低通滤波，多级叠加后几乎没有闪烁。
 *
 * 13 个采样点分为 5 组：
 *   - 4 个角点（权重小，覆盖范围）
 *   - 4 个边中点
 *   - 4 个中心偏移点
 *   - 1 个正中心（权重最大）
 */

uniform sampler2D tDiffuse;
uniform vec2 uTexelSize; // 1 / 源纹理尺寸
uniform float uThreshold; // 第一级才用；后续级传 0

varying vec2 vUv;

// Karis 平均：在亮度域做加权平均，抑制极亮像素（如太阳）造成的闪点。
// 这是 UE4 / CoD 都在用的技巧，不加的话太阳会在 bloom 里跳帧闪烁。
vec3 karisAverage(vec3 a, vec3 b, vec3 c, vec3 d, float wa, float wb, float wc, float wd) {
  float la = 1.0 / (1.0 + dot(a, vec3(0.2126, 0.7152, 0.0722)));
  float lb = 1.0 / (1.0 + dot(b, vec3(0.2126, 0.7152, 0.0722)));
  float lc = 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722)));
  float ld = 1.0 / (1.0 + dot(d, vec3(0.2126, 0.7152, 0.0722)));
  return (a * la * wa + b * lb * wb + c * lc * wc + d * ld * wd) /
         (la * wa + lb * wb + lc * wc + ld * wd + 1e-5);
}

void main() {
  vec2 t = uTexelSize;

  // --- 5 组 13 tap ---
  // A: 左上角 4 点（跨 2 个 texel）
  vec3 a = texture2D(tDiffuse, vUv + vec2(-2.0, -2.0) * t).rgb;
  vec3 b = texture2D(tDiffuse, vUv + vec2( 0.0, -2.0) * t).rgb;
  vec3 c = texture2D(tDiffuse, vUv + vec2( 2.0, -2.0) * t).rgb;
  vec3 d = texture2D(tDiffuse, vUv + vec2(-2.0,  0.0) * t).rgb;
  vec3 e = texture2D(tDiffuse, vUv + vec2( 0.0,  0.0) * t).rgb; // 中心
  vec3 f = texture2D(tDiffuse, vUv + vec2( 2.0,  0.0) * t).rgb;
  vec3 g = texture2D(tDiffuse, vUv + vec2(-2.0,  2.0) * t).rgb;
  vec3 h = texture2D(tDiffuse, vUv + vec2( 0.0,  2.0) * t).rgb;
  vec3 i = texture2D(tDiffuse, vUv + vec2( 2.0,  2.0) * t).rgb;

  // B: 4 个边中点（跨 1 个 texel）
  vec3 j = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * t).rgb;
  vec3 k = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * t).rgb;
  vec3 l = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * t).rgb;
  vec3 m = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * t).rgb;

  // 第一级做 Karis 平均抑制闪光，后续级用普通平均
  vec3 result;
  if (uThreshold > 0.0) {
    // 中心 5 点用加权平均
    vec3 group0 = karisAverage(j, k, l, m, 1.0, 1.0, 1.0, 1.0);
    // 外围 4 角与 4 边
    vec3 group1 = (a + b + d + e) * 0.25;
    vec3 group2 = (b + c + e + f) * 0.25;
    vec3 group3 = (d + e + g + h) * 0.25;
    vec3 group4 = (e + f + h + i) * 0.25;
    result = group0 * 0.5 + (group1 + group2 + group3 + group4) * 0.125;
  } else {
    vec3 group0 = (j + k + l + m) * 0.25;
    vec3 group1 = (a + b + d + e) * 0.25;
    vec3 group2 = (b + c + e + f) * 0.25;
    vec3 group3 = (d + e + g + h) * 0.25;
    vec3 group4 = (e + f + h + i) * 0.25;
    result = group0 * 0.5 + (group1 + group2 + group3 + group4) * 0.125;
  }

  gl_FragColor = vec4(max(result, vec3(0.0)), 1.0);
}
