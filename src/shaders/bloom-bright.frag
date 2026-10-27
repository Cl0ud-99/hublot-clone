/**
 * Bloom：亮部提取
 *
 * 只保留超过阈值的部分，并做一个「软膝盖」（soft knee）过渡，
 * 避免阈值处出现硬边亮圈。
 *
 * 为什么要软膝盖：
 *   直接 step(threshold, luma) 会让亮度刚过阈值的区域突然全量参与 bloom，
 *   画面上会出现一圈明显的光晕边界。用二次曲线过渡后，
 *   阈值附近是渐变的，视觉上自然得多。
 */

uniform sampler2D tDiffuse;
uniform float uThreshold; // 起辉阈值（线性辐亮度，通常 0.8~1.5）
uniform float uSoftKnee; // 膝盖宽度（相对阈值的比例，0.3~0.7）
uniform float uExposure; // 曝光（在进入 bloom 前统一乘上）

varying vec2 vUv;

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure;
  c = max(c, vec3(0.0));

  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));

  // 软膝盖：在 [threshold-knee, threshold+knee] 之间平滑过渡
  float knee = max(uThreshold * uSoftKnee, 1e-4);
  float lower = uThreshold - knee;
  float upper = uThreshold + knee;

  // 二次曲线，保证在 lower 处值和导数都连续
  float soft = clamp(luma - lower, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-5);

  float weight = max(soft, luma - uThreshold) / max(luma, 1e-5);

  gl_FragColor = vec4(c * weight, 1.0);
}
