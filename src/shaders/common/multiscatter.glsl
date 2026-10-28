/**
 * 多重散射 LUT 的参数化与采样
 *
 * ── 为什么需要它 ──
 * 单次散射只积了「太阳 → 散射点 → 相机」一条折线。太阳落到地平线以下后，
 * 低层大气整片进入地球本影，单次散射几乎归零，天空会瞬间变黑。
 * 但真实世界里高层大气（20~60 km）仍然被照亮，那里的光经过 2 次、3 次……
 * 散射后落到观测者眼里 —— 这就是「蓝色时刻」。
 *
 * ── LUT 存的是什么 ──
 * 记 F_n(x) 为「在 x 点、经过 n 次散射后到达的方向平均辐亮度」：
 *
 *     F_1(x) = (1/4π) ∫_Ω L_1(x, ω) dω
 *     F_n(x) = (1/4π) ∫_Ω ∫_0^tmax T(x,x_t) σ_s(x_t) F_{n-1}(x_t) dt dω
 *
 * （n ≥ 2 时把相位函数近似为各向同性 —— 多次散射后方向信息基本被抹平，
 *   这也是 Hillaire 2020 的标准做法。）
 *
 * 主着色器里只要把 `σ_s(x) · F_total(x)` 当作各向同性的内散射源加进
 * ray-march 即可，其中 F_total = Σ F_n。
 *
 * ── 为什么可以只用两个维度 ──
 * 大气是球对称的，所以某个点的「周围散射光平均值」只取决于
 *   1) 该点海拔 h
 *   2) 太阳天顶角的余弦 cos(zenith)
 * 方位角无关（绕本地垂线旋转对称）。
 *
 * ── 高度参数化 ──
 * 不用均匀高度：0~10 km 集中了 70% 的质量，必须密采。
 * 用 h = 100 · u²，则 u=0..0.32 覆盖 0~10 km，共约 10 个 texel，
 * 分辨率 ~1 km，正好匹配 Rayleigh 标高 8 km。
 */

#ifndef MULTISCATTER_GLSL
#define MULTISCATTER_GLSL

/** LUT 覆盖的最大高度（km）。100 km 以上密度可忽略。 */
const float MS_TOP_KM = 100.0;

/** LUT 的 u 坐标 → 海拔（km）。平方映射，低空密、高空疏。 */
float msAltitudeFromU(float u) {
  return MS_TOP_KM * u * u;
}

/** 海拔（km）→ LUT 的 u 坐标。 */
float msUFromAltitude(float h) {
  return sqrt(clamp(h / MS_TOP_KM, 0.0, 1.0));
}

/**
 * 查询 x 点处的「多次散射平均辐亮度场」。
 *
 * 返回值的物理含义：在这个点上，来自四面八方（不含太阳直射）的
 * 散射光按方向平均后的辐亮度。乘上 σ_s 就是各向同性内散射源。
 *
 * @param pos    世界坐标（球心在原点，km）
 * @param sunDir 太阳单位方向
 */
vec3 msLookup(vec3 pos, vec3 sunDir) {
  float h = max(length(pos) - uEarthRadius, 0.0);
  float cosSunZenith = dot(normalize(pos), sunDir);
  vec2 uv = vec2(msUFromAltitude(h), cosSunZenith * 0.5 + 0.5);
  return texture2D(uMultiScatterLUT, uv).rgb;
}

#endif
