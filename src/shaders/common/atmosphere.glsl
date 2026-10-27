/**
 * 大气散射公共函数（单次散射版）
 *
 * 设计取舍：
 *   原站用预计算 LUT（Transmittance / Multi-scattering / Irradiance），
 *   代价是 3 个 compute pass + 复杂的纹理索引。
 *   在「固定巡航高度 + 固定舷窗机位」下，单次散射 + 数值 ray-march
 *   的误差通常在 5% 以内 —— 因为高空大气密度只剩地面的 ~30%，多次散射贡献极小。
 *
 * 这里提供：
 *   - 大气密度模型（Rayleigh + Mie 指数衰减，臭氧高斯层）
 *   - 光学厚度积分与透射率
 *   - 单次散射的天空辐亮度
 *   - 射线与球体求交
 *   - Rayleigh / Mie 相位函数
 *
 * 单位：长度一律 km。方向一律单位向量。
 */

#ifndef ATMOSPHERE_GLSL
#define ATMOSPHERE_GLSL

#include "./atmo-uniforms.glsl"

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

/** 光学厚度 → 透射率 */
vec3 atmosphereTransmittance(vec3 od) {
  return exp(-(uRayleighBeta * od.x + uMieBeta * od.y + uOzoneBeta * od.z));
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

// ---------------------------------------------------------------------------
// 单次散射积分
// ---------------------------------------------------------------------------

/**
 * 天空辐亮度（单次散射）。不含地面 —— 地面由调用方单独处理，
 * 因为地面需要程序化细节，而这里只算大气。
 *
 * @param rayOrigin 相机位置（球心原点，km）
 * @param rayDir    视线单位向量
 * @param sunDir    太阳单位向量
 * @param sunColor  太阳线性辐照度
 * @param earthAlbedo 想要地面反照贡献时传 >0（本 shader 传 0）
 * @param steps     ray-march 步数
 */
vec3 skyRadiance(
  vec3 rayOrigin,
  vec3 rayDir,
  vec3 sunDir,
  vec3 sunColor,
  float earthAlbedo,
  int steps
) {
  float tGround = raySphereNearest(rayOrigin, rayDir, uEarthRadius);
  float tAtmo = raySphereFar(rayOrigin, rayDir, uAtmosphereRadius);
  if (tAtmo <= 0.0) return vec3(0.0);

  // 视线终点：撞地则到地面，否则穿出大气
  float tMax = (tGround > 0.0) ? tGround : tAtmo;
  if (tMax <= 0.0) return vec3(0.0);

  float cosTheta = dot(rayDir, sunDir);
  float phaseR = phaseRayleigh(cosTheta);
  float phaseM = phaseMie(cosTheta, uMieG);

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

    // 采样点 → 太阳
    float tSun = raySphereFar(p, sunDir, uAtmosphereRadius);
    vec3 sunOD = opticalDepth(p, sunDir, tSun, 6);
    vec3 sunTrans = atmosphereTransmittance(sunOD);

    // 地球遮挡
    if (raySphereNearest(p, sunDir, uEarthRadius) > 0.0) {
      sunTrans = vec3(0.0);
    }

    vec3 inscatter = (uRayleighBeta * dens.x * phaseR + vec3(uMieBeta * dens.y * phaseM)) * ds;
    sum += inscatter * viewTrans * sunTrans;
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

#endif
