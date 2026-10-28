/**
 * 大气散射公共函数
 *
 * 物理模型：
 *   - Rayleigh 散射（分子，λ^-4，蓝色天空的来源）
 *   - Mie 散射 + 吸收（气溶胶，太阳周围的白色光晕、地平线雾霾）
 *   - 臭氧吸收（Chappuis 带，让「蓝色时刻」呈现深蓝而不是灰蓝）
 *   - 单次散射：沿视线 ray-march，逐点算光学厚度与太阳透射率
 *   - 多次散射：从预计算的 LUT 取各向同性散射场（见 multiscatter.glsl）
 *
 * 关键点：`uSunColor` 必须是**大气层外的太阳辐照度**，是一个常数。
 * 早先版本在 sunIrradiance() 里按太阳高度做了一次「经验红化 + 衰减」，
 * 而着色器里又按路径做了一次物理透射 —— 同一份消光被算了两次，
 * 结果日落时颜色过暗过红，且太阳一落到 -8° 就被强行熄灯，
 * 暮光完全靠一个手工加的 tint 撑着。现在把消光全部交还给物理。
 *
 * 单位：长度一律 km。方向一律单位向量。
 */

#ifndef ATMOSPHERE_GLSL
#define ATMOSPHERE_GLSL

#include "./atmo-uniforms.glsl"
#include "./multiscatter.glsl"

// ---------------------------------------------------------------------------
// 球体求交
// ---------------------------------------------------------------------------

/** 返回最近的正交点距离；无交点返回 -1。origin 相对球心。 */
float raySphereNearest(vec3 origin, vec3 dir, float radius) {
  float b = dot(origin, dir);
  float c = dot(origin, origin) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  float sq = sqrt(disc);
  float t0 = -b - sq;
  float t1 = -b + sq;
  if (t0 > 0.0) return t0;
  if (t1 > 0.0) return t1;
  return -1.0;
}

/** 返回远端正交点距离（用于找大气顶出口）。 */
float raySphereFar(vec3 origin, vec3 dir, float radius) {
  float b = dot(origin, dir);
  float c = dot(origin, origin) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  return -b + sqrt(disc);
}

// ---------------------------------------------------------------------------
// 密度模型
// ---------------------------------------------------------------------------

/** 返回 (rayleigh, mie, ozone) 相对密度。 */
vec3 atmosphereDensity(float altitudeKm) {
  float h = max(altitudeKm, 0.0);
  float rayleigh = exp(-h / uRayleighScaleHeight);
  float mie = exp(-h / uMieScaleHeight);
  float oz = exp(-pow((h - uOzoneCenter) / uOzoneWidth, 2.0));
  return vec3(rayleigh, mie, oz);
}

/** 在 origin→origin+dir*tEnd 之间积分光学厚度。 */
vec3 opticalDepth(vec3 origin, vec3 dir, float tEnd, int steps) {
  if (tEnd <= 0.0) return vec3(0.0);
  float ds = tEnd / float(steps);
  vec3 od = vec3(0.0);
  for (int i = 0; i < MAX_OD_STEPS; i++) {
    if (i >= steps) break;
    float t = (float(i) + 0.5) * ds;
    vec3 p = origin + dir * t;
    od += atmosphereDensity(length(p) - uEarthRadius) * ds;
  }
  return od;
}

/**
 * 光学厚度 → 透射率。
 *
 * ── 必须包含 Mie 吸收 ──
 * 消光 = 散射 + 吸收。早期版本只用了 uMieBeta（散射）算消光，
 * 相当于假设气溶胶不吸收 —— 这让地平线附近的雾霾偏薄、日落偏亮偏黄。
 * 真实气溶胶的单次散射反照率约 0.9，漏掉吸收会高估约 20% 的透过率。
 */
vec3 atmosphereTransmittance(vec3 od) {
  vec3 extinction = uRayleighBeta * od.x
                  + vec3((uMieBeta + uMieAbsorb) * od.y)
                  + uOzoneBeta * od.z;
  return exp(-extinction);
}

// ---------------------------------------------------------------------------
// 相位函数
// ---------------------------------------------------------------------------

float phaseRayleigh(float cosTheta) {
  return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

/** Henyey-Greenstein。g 接近 1 表示强前向散射。 */
float phaseMie(float cosTheta, float g) {
  float gg = g * g;
  float denom = pow(max(1.0 + gg - 2.0 * g * cosTheta, 1e-4), 1.5);
  return (1.0 - gg) / (4.0 * PI * denom);
}

/**
 * Cornette-Shanks 相位函数（气溶胶）。
 *
 *   P(θ) = 3(1-g²)/(8π(2+g²)) · (1+cos²θ) / (1+g²-2g·cosθ)^1.5
 *
 * ── 为什么不用 Henyey-Greenstein ──
 * HG 在 θ=0 处峰值偏低、在大角度处尾巴偏长，太阳周围的晕会「糊」。
 * 原站 bundle 里用的就是这一支（`3/(8π)·(1-g²)/(2+g²)`，g 默认 0.8），
 * 逆推出常量后在能量和形状上都比 HG 更贴近真实气溶胶。
 */
float phaseMieCS(float cosTheta, float g) {
  float g2 = g * g;
  float k = (3.0 / (8.0 * PI)) * ((1.0 - g2) / (2.0 + g2));
  float denom = pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5);
  return k * (1.0 + cosTheta * cosTheta) / denom;
}

/** 兼容旧调用：现在统一走 Cornette-Shanks。 */
float phaseMieDual(float cosTheta, float g) {
  return phaseMieCS(cosTheta, g);
}

// ---------------------------------------------------------------------------
// 单次 + 多次散射积分
// ---------------------------------------------------------------------------

/**
 * 天空辐亮度。
 *
 * @param rayOrigin 相机位置（球心原点，km）
 * @param rayDir    视线单位向量
 * @param sunDir    太阳单位方向
 * @param sunColor  大气层外的太阳辐照度（线性 RGB）
 * @param earthAlbedo 想要地面反照贡献时传 >0（本 shader 传 0）
 * @param steps     ray-march 步数
 * @param msMode    0 = 只要单次散射；1 = 单次 + 多次；2 = 只要多次散射
 */
vec3 skyRadiance(
  vec3 rayOrigin,
  vec3 rayDir,
  vec3 sunDir,
  vec3 sunColor,
  float earthAlbedo,
  int steps,
  int msMode
) {
  float tGround = raySphereNearest(rayOrigin, rayDir, uEarthRadius);
  float tAtmo = raySphereFar(rayOrigin, rayDir, uAtmosphereRadius);
  if (tAtmo <= 0.0) return vec3(0.0);

  // 视线终点：撞地则到地面，否则穿出大气
  float tMax = (tGround > 0.0) ? tGround : tAtmo;
  if (tMax <= 0.0) return vec3(0.0);

  float cosTheta = dot(rayDir, sunDir);
  float phaseR = phaseRayleigh(cosTheta);
  float phaseM = phaseMieDual(cosTheta, uMieG);

  vec3 sum = vec3(0.0);
  float odR = 0.0;
  float odM = 0.0;
  float odO = 0.0;

  int n = steps > 0 ? steps : 1;
  for (int i = 0; i < MAX_SKY_STEPS; i++) {
    if (i >= n) break;

    // 非均匀步长：平方分布，近端密
    float a = float(i) / float(n);
    float b = float(i + 1) / float(n);
    float tStart = tMax * a * a;
    float tEnd = tMax * b * b;
    float ds = tEnd - tStart;
    if (ds <= 0.0) continue;
    float tMid = (tStart + tEnd) * 0.5;

    vec3 p = rayOrigin + rayDir * tMid;
    vec3 dens = atmosphereDensity(length(p) - uEarthRadius);

    odR += dens.x * ds;
    odM += dens.y * ds;
    odO += dens.z * ds;

    vec3 viewTrans = atmosphereTransmittance(vec3(odR, odM, odO));

    // --- 多次散射项 ---
    // 注意：这里**不乘** sunTrans。LUT 里存的是「已经经历了完整路径」的
    // 散射场，太阳透射率、地球本影、上下各阶散射全都在里面了。
    vec3 msInscatter = vec3(0.0);
    if (msMode > 0 && uMSStrength > 0.0) {
      vec3 msField = msLookup(p, sunDir);
      msInscatter = (uRayleighBeta * dens.x + vec3(uMieBeta * dens.y)) * msField * uMSStrength;
    }

    if (msMode == 2) {
      sum += msInscatter * viewTrans * ds;
      continue;
    }

    // --- 单次散射项 ---
    // 采样点 → 太阳
    float tSun = raySphereFar(p, sunDir, uAtmosphereRadius);
    vec3 sunOD = opticalDepth(p, sunDir, tSun, 6);
    vec3 sunTrans = atmosphereTransmittance(sunOD);

    // 地球遮挡
    if (raySphereNearest(p, sunDir, uEarthRadius) > 0.0) {
      sunTrans = vec3(0.0);
    }

    vec3 inscatter = (uRayleighBeta * dens.x * phaseR + vec3(uMieBeta * dens.y * phaseM)) * ds;
    sum += (inscatter * sunTrans + msInscatter) * viewTrans;
  }

  vec3 color = sum * sunColor;

  // 可选的简化地面反射（本项目主路径不使用）
  if (earthAlbedo > 0.0 && tGround > 0.0) {
    vec3 gp = rayOrigin + rayDir * tGround;
    vec3 nrm = normalize(gp);
    float cosSun = max(dot(nrm, sunDir), 0.0);
    float sunT = raySphereFar(gp, sunDir, uAtmosphereRadius);
    vec3 sunODg = opticalDepth(gp, sunDir, sunT, 8);
    vec3 sunTransG = atmosphereTransmittance(sunODg);
    float shadow = (raySphereNearest(gp, sunDir, uEarthRadius) > 0.0) ? 0.0 : 1.0;
    vec3 reflected = sunColor * sunTransG * (cosSun * shadow / PI) * earthAlbedo;
    vec3 viewODg = opticalDepth(rayOrigin, rayDir, tGround, 10);
    color += reflected * atmosphereTransmittance(viewODg);
  }

  return max(color, vec3(0.0));
}

/** 兼容旧调用：默认只要单次散射。 */
vec3 skyRadiance(vec3 rayOrigin, vec3 rayDir, vec3 sunDir, vec3 sunColor, float earthAlbedo, int steps) {
  return skyRadiance(rayOrigin, rayDir, sunDir, sunColor, earthAlbedo, steps, 0);
}

#endif
