/**
 * 合成：场景 HDR + bloom → ACES → sRGB
 *
 * 这是整条链路的最后一站，也是唯一做色调映射的地方。
 *
 * ── 顺序为什么很重要 ──
 *   正确：scene(HDR) + bloom(HDR) → 色调映射 → sRGB
 *   错误：scene → 色调映射 → sRGB → 提取高光 → bloom   ← 光晕会发灰
 *
 * 早期版本就是这么错的（在 sky.frag 里先做了 ACES + sRGB），
 * 导致 bloom 只能从已经压扁的画面上抠高光，城市灯光扩不出通透的光晕。
 *
 * ── 为什么要加 filmic grain 和轻微色散 ──
 * 原站的夜景有一层很细的胶片颗粒，这是「不像 CG」的关键细节之一。
 * 颗粒在色调映射之后加（模拟感光介质的颗粒），才不会有塑料感。
 */

uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uResolution;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uGrainAmount;
uniform float uTime;
uniform float uVignette;
/** 调试：>0.5 时直接把 bloom 缓冲可视化 */
uniform float uDebugBloom;

varying vec2 vUv;

// ACES 电影级色调映射（Narkowicz 有理近似）。
// 它把 >1 的 HDR 值平滑压进 0~1，高光不会硬剪切，
// 同时保留暗部的对比 —— 这正是 bloom 后需要的「肩部」曲线。
vec3 acesToneMap(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// 线性 → sRGB
vec3 linearToSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

// 无需纹理的哈希噪声（用于胶片颗粒）
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 scene = texture2D(tScene, vUv).rgb;
  vec3 bloom = texture2D(tBloom, vUv).rgb;

  // --- 叠加 bloom ---
  // 用加法而不是 mix：光晕是「额外进入镜头的光」，物理上是相加的。
  vec3 color = scene + bloom * uBloomStrength;

  // --- 调试：直接可视化 bloom 缓冲 ---
  // 排查「bloom 看起来没生效」时，把它单独画出来最直接：
  // 如果这里是全黑，说明亮部提取或金字塔环节没产出内容，
  // 而不是合成阶段的问题。
  if (uDebugBloom > 0.5) {
    vec3 dbg = bloom * 8.0; // 放大以便观察弱信号
    gl_FragColor = vec4(linearToSRGB(clamp(dbg, 0.0, 1.0)), 1.0);
    return;
  }

  // --- 曝光 ---
  // 放在 bloom 之后、色调映射之前。
  // 这样调整曝光时 bloom 的相对强度保持不变，符合相机的行为。
  color *= uExposure;

  // --- 色调映射 ---
  color = acesToneMap(color);

  // --- 胶片颗粒 ---
  // 在色调映射后加，且强度随亮度变化（暗部颗粒更明显，
  // 这是真实胶片的特性，也让暗部不至于「死黑一片」）。
  if (uGrainAmount > 0.0) {
    float grain = hash12(vUv * uResolution + uTime * 60.0) - 0.5;
    // 中间调颗粒最明显，纯黑和纯白处减弱
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float weight = 1.0 - abs(luma * 2.0 - 1.0);
    color += grain * uGrainAmount * weight;
  }

  // --- 暗角 ---
  // 轻微的椭圆暗角，模拟镜头边缘失光。
  if (uVignette > 0.0) {
    vec2 d = (vUv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
    float r2 = dot(d, d);
    color *= 1.0 - uVignette * smoothstep(0.15, 0.85, r2);
  }

  // --- sRGB 编码 ---
  color = linearToSRGB(clamp(color, 0.0, 1.0));

  gl_FragColor = vec4(color, 1.0);
}
