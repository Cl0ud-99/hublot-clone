/**
 * 多重散射 LUT 生成
 *
 * 一次全屏 pass 写一张 32×32（或 64×64）的浮点纹理。
 * 每个 texel 对应 (海拔 h, 太阳天顶角余弦 cosZ) 的一个组合，
 * 存的是该点的「多次散射平均辐亮度场」F_n。
 *
 * 递推关系（详见 common/multiscatter.glsl 顶部注释）：
 *
 *   第一阶：F_1(x) = (1/4π) ∫_Ω [∫ T·σ_s·p(ω·ωs)·T_sun dt] dω
 *   高阶：  F_n(x) = (1/4π) ∫_Ω [∫ T·σ_s·F_{n-1}(x_t) dt] dω
 *
 * 高阶用各向同性相位（相位函数在球面上积分为 1，所以直接乘 F 即可）。
 *
 * ── 为什么第一阶需要更多方向样本 ──
 * 第一阶的积分核里有 Mie 前向散射峰（g=0.76，峰值约为 90° 方向的 140 倍），
 * 方向采样太稀会把它平均掉，太阳附近的天空会偏暗。
 * 高阶的核是已经平滑过的 F_{n-1}，方向数可以减半。
 */

uniform int uOrder;      // 1 = 从太阳算第一阶；>=2 = 从上一阶递推
uniform int uDirCount;   // 本次 pass 使用的方向采样数
uniform int uDebug;      // 0 = 正常；1/2/3 = 中间量可视化（调试用）

varying vec2 vUv;

#define MS_MAX_DIRS 64
#define MS_STEPS 28

#include "./common/constants.glsl"
#include "./common/atmosphere.glsl"

/**
 * 从 pos 沿 dir 积分，得到「沿该方向到达 pos 的散射辐亮度」。
 *
 * 返回的是归一化量：太阳辐照度取 1。主着色器再乘 uSunColor。
 */
vec3 msTraceDirection(vec3 pos, vec3 dir, vec3 sunDir) {
  float tGround = raySphereNearest(pos, dir, uEarthRadius);
  float tAtmo = raySphereFar(pos, dir, uAtmosphereRadius);
  if (tAtmo <= 0.0) return vec3(0.0);

  // 撞地就停在底面（地面反射不计入 —— 它由主着色器单独处理）
  float tMax = (tGround > 0.0) ? min(tGround, tAtmo) : tAtmo;
  if (tMax <= 0.0) return vec3(0.0);

  float cosTheta = dot(dir, sunDir);
  float phaseR = phaseRayleigh(cosTheta);
  float phaseM = phaseMieDual(cosTheta, uMieG);

  vec3 sum = vec3(0.0);
  float odR = 0.0;
  float odM = 0.0;
  float odO = 0.0;

  for (int i = 0; i < MS_STEPS; i++) {
    float a = float(i) / float(MS_STEPS);
    float b = float(i + 1) / float(MS_STEPS);
    float t0 = tMax * a * a;
    float t1 = tMax * b * b;
    float ds = t1 - t0;
    if (ds <= 0.0) continue;

    vec3 p = pos + dir * (0.5 * (t0 + t1));
    vec3 dens = atmosphereDensity(length(p) - uEarthRadius);

    odR += dens.x * ds;
    odM += dens.y * ds;
    odO += dens.z * ds;
    vec3 viewTrans = atmosphereTransmittance(vec3(odR, odM, odO));

    vec3 src;
    if (uOrder == 1) {
      // 第一阶：源是太阳直射光 × 相位函数 × 到太阳的透射率
      float tSun = raySphereFar(p, sunDir, uAtmosphereRadius);
      vec3 sunTrans = atmosphereTransmittance(opticalDepth(p, sunDir, tSun, 6));
      if (raySphereNearest(p, sunDir, uEarthRadius) > 0.0) sunTrans = vec3(0.0);
      src = (uRayleighBeta * dens.x * phaseR + vec3(uMieBeta * dens.y * phaseM)) * sunTrans;
    } else {
      // 高阶：源是上一阶的散射场（各向同性）× 散射系数
      src = (uRayleighBeta * dens.x + vec3(uMieBeta * dens.y)) * msLookup(p, sunDir);
    }

    sum += src * viewTrans * ds;
  }

  return sum;
}

void main() {
  float u = vUv.x;
  float v = vUv.y;

  // --- texel → (海拔, 太阳天顶角) ---
  float h = msAltitudeFromU(u);
  float sunCos = v * 2.0 - 1.0;

  // 本地坐标系：观测点放在 +y 轴，太阳在 xy 平面内
  vec3 pos = vec3(0.0, uEarthRadius + h, 0.0);
  float sinZ = sqrt(max(0.0, 1.0 - sunCos * sunCos));
  vec3 sunDir = vec3(sinZ, sunCos, 0.0);

  // --- 对入射方向做球面平均 ---
  // Fibonacci 螺旋：cosθ 在 [-1,1] 均匀分布 → 球面上等面积
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < MS_MAX_DIRS; i++) {
    if (i >= uDirCount) break;
    float fi = (float(i) + 0.5) / float(uDirCount);
    float ct = 1.0 - 2.0 * fi;
    float st = sqrt(max(0.0, 1.0 - ct * ct));
    float phi = float(i) * 2.399963229728653;
    vec3 w = vec3(st * cos(phi), ct, st * sin(phi));
    acc += msTraceDirection(pos, w, sunDir);
    wsum += 1.0;
  }

  gl_FragColor = vec4(acc / max(wsum, 1.0), 1.0);

  // 调试：把中间量直接画出来
  if (uDebug == 1) gl_FragColor = vec4(u, v, 0.0, 1.0);
  else if (uDebug == 2) gl_FragColor = vec4(abs(sunDir), 1.0);
  else if (uDebug == 3) gl_FragColor = vec4(acc / max(wsum, 1.0) * 1000.0, 1.0);
  else if (uDebug == 4) gl_FragColor = vec4(length(pos) - uEarthRadius > 0.0 ? 1.0 : 0.0, uDirCount > 0 ? 1.0 : 0.0, uOrder > 0 ? 1.0 : 0.0, 1.0);
}
