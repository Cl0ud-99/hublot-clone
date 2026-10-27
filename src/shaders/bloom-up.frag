/**
 * Bloom：上采样（tent filter）
 *
 * 从低一级（更模糊、分辨率更低）的 mip 累加回高一级。
 * 用的是 9-tap 的帐篷形权重：
 *
 *       1  2  1
 *       2  4  2     × 1/16
 *       1  2  1
 *
 * 为什么用帐篷而不是双线性：
 *   双线性在放大时会留下方块感（尤其 4 倍以上放大），
 *   帐篷核让每一级的过渡更柔和，叠加三级后光晕非常平滑。
 */

uniform sampler2D tLow;   // 低分辨率（更模糊）的 bloom
uniform sampler2D tHigh;  // 当前级已累积的 bloom
uniform vec2 uTexelSize;  // 1 / 当前级尺寸
uniform float uScatter;   // 散射强度（每个级累加时的权重）

varying vec2 vUv;

void main() {
  vec2 t = uTexelSize;

  // 对低分辨率纹理做 9-tap 帐篷采样
  vec3 s = texture2D(tLow, vUv).rgb * 4.0;
  s += texture2D(tLow, vUv + vec2(-1.0,  0.0) * t).rgb * 2.0;
  s += texture2D(tLow, vUv + vec2( 1.0,  0.0) * t).rgb * 2.0;
  s += texture2D(tLow, vUv + vec2( 0.0, -1.0) * t).rgb * 2.0;
  s += texture2D(tLow, vUv + vec2( 0.0,  1.0) * t).rgb * 2.0;
  s += texture2D(tLow, vUv + vec2(-1.0, -1.0) * t).rgb;
  s += texture2D(tLow, vUv + vec2( 1.0, -1.0) * t).rgb;
  s += texture2D(tLow, vUv + vec2(-1.0,  1.0) * t).rgb;
  s += texture2D(tLow, vUv + vec2( 1.0,  1.0) * t).rgb;
  s *= 1.0 / 16.0;

  // 与当前级已有内容叠加。
  // uScatter 控制「光晕向外扩散的强度」，越大越雾。
  vec3 current = texture2D(tHigh, vUv).rgb;
  gl_FragColor = vec4(current + s * uScatter, 1.0);
}
