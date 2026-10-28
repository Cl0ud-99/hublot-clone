/**
 * 天空 / 地面 主片元着色器
 *
 * 本项目最重要的文件。它负责：
 *   1. 由像素构造视线方向
 *   2. 与地面球求交，得到地表点
 *   3. 地表程序化着色（农田 / 森林 / 低云）
 *   4. 大气单次散射
 *   5. 太阳圆盘 + 光晕
 *   6. 星空（日出前可见）
 *   7. 卷云
 *
 * 这是一个全屏三角形，不需要任何几何体。
 * 世界单位：1 单位 = 1 km，球心为原点。
 */

uniform vec2 uResolution;
uniform float uTime;

// --- 相机 ---
uniform vec3 uCamPos;        // 世界坐标（km）
uniform mat3 uCamBasis;      // 相机 → 世界：列向量 = right / up / back
uniform float uTanHalfFov;

// --- 太阳 ---
uniform vec3 uSunDir;        // 单位向量
uniform vec3 uSunColor;      // 线性辐照度
uniform float uSunAngularRadius;

// --- 曝光 ---
uniform float uExposure;

// --- 噪声纹理（RGBA 四个频段）---
uniform sampler2D uNoiseTex;

// --- 人口密度图（城市灯光引导）---
uniform sampler2D uPopulationTex;
uniform vec4 uPopBounds;     // (lonMin, lonMax, latMin, latMax)

// --- 每个像素的张角（弧度），由 fov 与分辨率决定 ---
uniform float uPixelAngle;

/**
 * 飞行位移（km）。
 *
 * 这是「动起来」最关键的参数：真实巡航 900 km/h ≈ 0.25 km/s，
 * 地面景物必须持续后退。做法是把地表采样坐标整体平移，
 * 而不是移动相机 —— 移动相机会让地平线抖动，
 * 而平移采样坐标只是让「地表的图案」流过，几何完全稳定。
 *
 * REV: 原站用 elapsed * 0.21 km/s（约 756 km/h）
 */
uniform vec2 uFlightOffset;

// --- 城市灯光 ---
uniform float uCities;

// --- 天气 ---
uniform float uLowClouds;
uniform float uCirrus;

// --- 性能 ---
uniform int uSteps;

// --- 调试通道 ---
// 0 = 正常渲染
// 1 = 人口密度场   2 = 像素足迹(km)   3 = 城市灯光原值
// 4 = 大气透射率   5 = 地面反照率     6 = 天空散射分量
uniform int uDebugMode;

varying vec2 vUv;

#include "./common/constants.glsl"
#include "./common/noise.glsl"
#include "./common/atmosphere.glsl"

// ===========================================================================
// 噪声纹理
// ===========================================================================

/**
 * 纹理版 fbm。
 *
 * 关键点：噪声纹理的 R/G/B/A 四个通道已经分别是 4/16/64/256 倍频，
 * 所以这里 **不要** 再对 UV 乘 2 —— 否则每个八度会跳 8 倍，看起来像噪点。
 * 只需给每个八度加一点偏移去相关。
 */
float fbmTex(vec2 uv, int octaves) {
  float v = 0.0;
  float a = 0.5;
  float norm = 0.0;
  vec2 q = uv;
  for (int i = 0; i < 4; i++) {
    if (i >= octaves) break;
    vec4 n = texture2D(uNoiseTex, q);
    float s = (i == 0) ? n.r : (i == 1) ? n.g : (i == 2) ? n.b : n.a;
    v += a * s;
    norm += a;
    // 只做去相关的偏移，不放大
    q += vec2(0.137, 0.271);
    a *= 0.5;
  }
  return v / max(norm, 1e-5);
}

/** 单通道采样（按频段选择） */
float noiseBand(vec2 uv, int band) {
  vec4 n = texture2D(uNoiseTex, uv);
  if (band == 0) return n.r;
  if (band == 1) return n.g;
  if (band == 2) return n.b;
  return n.a;
}

// ===========================================================================
// 地表
// ===========================================================================

/**
 * 地表反照率。
 * @param pKm    地表点沿球面的公里坐标（近似平面）
 * @param detail 细节权重，远处衰减到 0 防闪烁
 */
vec3 groundAlbedo(vec2 pKm, float detail) {
  // 大尺度：农林分区（周期约 20 km）
  float macro = fbmTex(pKm * 0.012, 3);
  float forest = smoothstep(0.48, 0.72, macro);

  // 中尺度：田块（周期约 45 m）
  float field = noiseBand(pKm * 0.35, 2);
  float fieldMix = smoothstep(0.32, 0.68, field);

  // 农田偏黄绿 / 森林偏暗绿
  vec3 farm = mix(vec3(0.118, 0.128, 0.072), vec3(0.160, 0.108, 0.064), fieldMix);
  vec3 wood = vec3(0.030, 0.044, 0.026);
  vec3 c = mix(farm, wood, forest);

  // 远处退化成平均色
  return mix(vec3(0.098, 0.108, 0.080), c, detail);
}

/**
 * 低云：返回 (密度, 高度扰动)。
 *
 * 尺度很关键：从 10 km 高空俯瞰，真正决定观感的是 20~150 km 的云系结构，
 * 不是单个积云（那在远处只有几个像素）。之前用 550 km 的周期，
 * 结果整片地面被低频噪声糊成「海面泡沫」。
 *
 * 同时边缘必须柔和：`d * 40` 那种硬阈值会得到剪纸一样的云，
 * 用 smoothstep 过渡才像云。
 */
vec2 lowCloud(vec2 pKm, float cover) {
  // 大尺度：云系分布（约 120 km 周期）
  float big = fbmTex(pKm * 0.002, 4);
  // 中尺度：云团（约 25 km 周期），做成细胞状
  float cellsN = fbmTex(pKm * 0.01 + vec2(3.1, 7.7), 3);
  float cells = 1.0 - abs(cellsN * 2.0 - 1.0);
  // 云量：cover=0 无云，cover=1 接近满云
  float n = big * 0.65 + cells * 0.35;
  float d = max(n - (1.0 - cover), 0.0);
  // 柔和过渡，避免硬边
  float density = smoothstep(0.0, 0.14, d);
  return vec2(density, d * 0.5 + cells * 0.12 * step(0.001, d));
}

/**
 * 卷云：高层纤维状薄云。
 *
 * ── 采样频率是这个函数最容易搞错的地方 ──
 * 噪声纹理的四个通道分别是 4 / 16 / 64 / 256 周期每 UV 单位。
 * 如果传入的 p 在整片天空里只跨越 0.02 个 UV（早期版本就是这样），
 * 那么基频（4 周期/UV）只会走 0.08 个周期 —— 完全不变，
 * 画面里能看到的全是 64 / 256 周期那两个高频通道，
 * 它们混叠成**极其规则的横向条纹**（像梳齿）。
 *
 * 所以调用方必须把「公里」换算到「一个能让基频走 2~3 个周期」的 UV 尺度。
 * 本函数内部的所有频率都以「基频格子」为单位：
 *   flow  ≈ 0.7 倍基频（比主图案略低，负责弯曲走向）
 *   main  = 1.0 倍基频（云的主体）
 *   fiber = 2.2 倍基频（纤维细节）
 *   field = 0.35 倍基频（大尺度疏密）
 *
 * 真实卷云的特征：
 *   1) 有大尺度的「云带」走向，但每条带内部是破碎、卷曲的
 *   2) 纤维方向随位置缓慢变化（不是全局统一）
 *   3) 边缘非常柔和，几乎没有硬边
 */
float cirrusLayer(vec2 p, float cover) {
  // 低频场：决定云的走向与疏密
  //
  // 早期这里写的是 p * 0.15，但 p 本身跨度极小，
  // 结果 flow 在整片天空里几乎是个常数 —— 等于没做域扭曲，
  // 纤维方向全局统一，进一步加剧了条纹感。
  // 现在改成 0.7 倍基频，让扭曲方向在视野内真正变化起来。
  vec2 flow = vec2(
    fbmTex(p * 0.7, 2),
    fbmTex(p * 0.7 + vec2(5.3, 2.7), 2)
  ) - 0.5;

  // 用 flow 做域扭曲，让纤维走向自然弯曲
  vec2 q = p + flow * 1.8;

  // 各向异性只保留轻微（约 1.7:1），不要拉成硬条
  q *= vec2(0.75, 1.15);

  // 二次扭曲：叠一层更细的扰动，打碎规则性
  vec2 w = vec2(
    fbmTex(q * 1.1 + vec2(1.7, 9.2), 2),
    fbmTex(q * 1.1 + vec2(8.3, 2.8), 2)
  ) - 0.5;
  q += w * 0.9;

  // 主体密度
  float n = fbmTex(q, 4);

  // 纤维细节：脊线噪声，强度压低（只做质感，不做主体）
  float ridge = 1.0 - abs(fbmTex(q * 2.2 + w * 1.5, 3) * 2.0 - 1.0);
  ridge = ridge * ridge * ridge; // 三次方，让纤维更细更柔

  // 大尺度覆盖场
  float field = fbmTex(p * 0.35, 2);

  /**
   * ── 覆盖率映射要能让 cover=0.5 也出云 ──
   * 各项权重之和：n*0.62 + ridge*0.14 + field*0.36，
   * 而 fbm 的典型值在 0.5 左右，所以 d 的典型值只有约 0.56。
   * 早期写成 -(1.0 - cover*0.55)，cover=0.5 时阈值是 0.725，
   * 比典型 d 还高 —— 结果默认参数下几乎看不到云。
   *
   * 现在改成 (0.75 - cover*0.5)：
   *   cover=0   → 阈值 0.75（基本无云）
   *   cover=0.5 → 阈值 0.50（典型 d≈0.56，能出一半云）✓
   *   cover=1   → 阈值 0.25（接近满云）
   */
  float d = n * 0.62 + ridge * 0.14 + field * 0.36 - (0.75 - cover * 0.5);

  // 边缘柔化：卷云不该有硬边
  return smoothstep(0.0, 0.22, d) * 1.25;
}

// ===========================================================================
// 城市灯光
// ===========================================================================

/** 世界方向 → 人口密度图 UV。返回 (u, v, 是否有效)。 */
vec3 populationUV(vec3 dir) {
  float lon = atan(dir.z, dir.x) * RAD2DEG;
  float lat = asin(clamp(dir.y, -1.0, 1.0)) * RAD2DEG;
  vec2 uv = vec2(
    (lon - uPopBounds.x) / (uPopBounds.y - uPopBounds.x),
    (uPopBounds.w - lat) / (uPopBounds.w - uPopBounds.z)
  );
  float valid = (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) ? 1.0 : 0.0;
  return vec3(uv, valid);
}

/**
 * 由世界方向求人口密度。
 *
 * ── 为什么不能直接用 textureGrad / textureLod ──
 * three 的 ShaderMaterial 走 GLSL ES 1.00：
 *   - textureGrad 在 ES 1.00 里根本不存在
 *   - texture2DLodEXT 需要 GL_EXT_shader_texture_lod 扩展，不是所有驱动都有
 *   - dFdx/dFdy 需要 GL_OES_standard_derivatives（WebGL2 基本都有，但仍多一层不确定）
 *
 * 所以这里走**零扩展依赖**的路线：用普通 texture2D（硬件自动 mip）
 * 加上一层**自适应的多 tap 模糊**来压掉远处的混叠。
 *
 * 为什么自动 mip 在这里够用：经纬投影只在「经度 ±180° 接缝」和
 * 「两极」处导数失效，而本项目观测点在法国（47°N），
 * 视野里既没有接缝也没有极点，自动导数是正常的。
 *
 * @param blur 额外的模糊半径（uv 单位），由像素足迹决定，远处加大
 */
float populationAt(vec3 dir, float blur) {
  vec3 base = populationUV(dir);
  vec2 uv = base.xy;
  if (base.z < 0.5) return 0.0;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;

  // 近处：单次采样（硬件 mip 已经处理好）
  float s = texture2D(uPopulationTex, uv).r;
  if (blur <= 0.0001) return s;

  // 远处：4 个对角偏移取平均，等效于把采样核展宽到像素足迹大小。
  // 这比强行选 mip 更稳，且不依赖任何扩展。
  vec2 o = vec2(blur, blur);
  float s1 = texture2D(uPopulationTex, uv + vec2(o.x, o.y)).r;
  float s2 = texture2D(uPopulationTex, uv + vec2(-o.x, o.y)).r;
  float s3 = texture2D(uPopulationTex, uv + vec2(o.x, -o.y)).r;
  float s4 = texture2D(uPopulationTex, uv + vec2(-o.x, -o.y)).r;
  return (s * 2.0 + s1 + s2 + s3 + s4) / 6.0;
}

/**
 * 城市灯光。
 *
 * ── 关键设计（这是整个项目最容易翻车的地方）──
 *
 * 1) 点光源的屏幕空间 splat
 *    一盏灯在远距离下小于一个像素。若直接采样，它会在像素之间「漏掉」，
 *    产生闪烁。解决办法是把每个光源当成屏幕空间的高斯，
 *    宽度取 max(像素角, 光源自身角尺寸)，这样永远不会丢。
 *
 * 2) 手动计算细节层级（不用导数函数）
 *    经纬投影在球面上不连续，自动导数会在接缝/极点处失效，
 *    所以用「投影的前向差分」手算 mip，再显式采样两级混合。
 *
 * 3) 宏观/微观分层
 *    远看只有「城市团辉光」，近看才需要「街道与路灯」。
 *
 * 4) 晶格必须有三个尺度的叠加 + 域扭曲
 *    单一尺度的规整晶格会得到「棋盘」。真实城市是多尺度自相似的：
 *    都市圈 → 城区 → 街区 → 路灯。再叠加一层扭曲噪声打散规则性。
 */
vec3 cityLights(vec3 groundPoint, vec3 normal, float tGround, float detail) {
  if (uCities <= 0.0) return vec3(0.0);

  // 像素在地面上的足迹（km）。
  //
  // 用几何方式估算：远处一个像素跨越很大面积，
  // 而且掠射时（视线几乎平行地表）还要再放大 1/cos(入射角)。
  float cosIncidence = max(dot(normal, -normalize(groundPoint - uCamPos)), 0.02);
  float footprintKm = (tGround * uPixelAngle) / cosIncidence;
  footprintKm = clamp(footprintKm, 0.001, 4000.0);

  // 人口密度（引导场）。
  // 模糊半径按足迹给：远处多模糊，近处不模糊。
  // 模糊量换算成 uv 单位（纹理横向覆盖 44° 经度）。
  float blurUv = clamp(footprintKm * 0.0009, 0.0, 0.03);
  float pop = populationAt(normal, blurUv);
  if (pop < 0.015) return vec3(0.0);

  // 地面公里坐标（含飞行位移）。
  // 城市灯光必须跟着位移，否则地面在动、灯光却钉死在原地。
  vec2 pKm = vec2(
    atan(groundPoint.z, groundPoint.x),
    asin(clamp(groundPoint.y / uEarthRadius, -1.0, 1.0))
  ) * uEarthRadius + uFlightOffset;

  // 域扭曲：把规整晶格打散成有机形状
  vec2 warp = (vec2(fbmTex(pKm * 0.06, 2), fbmTex(pKm * 0.06 + vec2(4.7, 1.3), 2)) - 0.5) * 3.5;
  vec2 pw = pKm + warp;

  vec3 col = vec3(0.0);
  vec3 lampCol = vec3(1.0, 0.74, 0.42);
  vec3 warmCol = vec3(1.0, 0.58, 0.26);

  // --- 宏观层：都市圈辉光 ---
  // 用 smoothstep 而不是 pop²，否则「有人的地方」会整片发亮。
  // 真实高空夜景是「黑色大地 + 稀疏亮点」，只有真正的大城市才有光晕。
  float cityMask = smoothstep(0.18, 0.62, pop);
  col += vec3(1.0, 0.68, 0.38) * cityMask * 0.40;

  // --- 微观层：三个尺度的灯点叠加 ---
  // 尺度单位 km：都市圈 6、城区 1.5、街区 0.4
  const float S1 = 6.0;
  const float S2 = 1.5;
  const float S3 = 0.4;

  // ── 能量守恒的关键 ──
  // 一盏灯的物理尺寸远小于像素时，高斯峰值会随光源尺寸缩小而「消失」
  // （总能量被摊薄到亚像素尺度上）。正确做法是把结果乘以
  // (光源尺寸 / 像素足迹)² 的补偿因子，让「积分后的亮度」保持不变 ——
  // 这样远处的一团灯会退化成一个小亮斑，而不是消失。
  //
  // 同时用 smoothstep 在「足迹远大于光源」时把该层逐渐淡出，
  // 避免超过像素尺度后产生摩尔纹。

  // 第 1 层：都市圈（6 km）
  if (footprintKm < S1 * 1.8) {
    vec2 cell = floor(pw / S1);
    vec2 f = fract(pw / S1);
    float h = hash21(cell + 3.1);
    float lit = step(0.30, h) * smoothstep(0.06, 0.30, pop);
    vec2 lp = 0.2 + 0.6 * hash22(cell + 11.3);
    vec2 d = (f - lp) * S1;
    float srcSize = max(S1 * 0.32, footprintKm * 0.7);
    float glow = exp(-dot(d, d) / (srcSize * srcSize));
    float fade = 1.0 - smoothstep(S1 * 0.5, S1 * 1.8, footprintKm);
    // 能量补偿：光源被 mip 平均掉的部分补回来
    float energy = clamp((S1 * 0.32 * S1 * 0.32) / (srcSize * srcSize), 0.0, 1.0);
    col += mix(lampCol, warmCol, h) * lit * glow * fade * energy * 1.4;
  }

  // 第 2 层：城区（1.5 km）
  if (footprintKm < S2 * 1.8) {
    vec2 cell = floor(pw / S2);
    vec2 f = fract(pw / S2);
    float h = hash21(cell + 17.7);
    float lit = step(0.62, h) * smoothstep(0.05, 0.25, pop);
    vec2 lp = 0.2 + 0.6 * hash22(cell + 23.9);
    vec2 d = (f - lp) * S2;
    float srcSize = max(S2 * 0.30, footprintKm * 0.7);
    float glow = exp(-dot(d, d) / (srcSize * srcSize));
    float fade = 1.0 - smoothstep(S2 * 0.5, S2 * 1.8, footprintKm);
    float energy = clamp((S2 * 0.30 * S2 * 0.30) / (srcSize * srcSize), 0.0, 1.0);
    col += mix(lampCol, warmCol, h) * lit * glow * fade * energy * 2.2;
  }
  // 第 3 层：街区 / 路灯（0.4 km）
  if (footprintKm < S3 * 1.8) {
    vec2 cell = floor(pw / S3);
    vec2 f = fract(pw / S3);
    float h = hash21(cell + 41.3);
    float lit = step(0.80, h) * smoothstep(0.04, 0.20, pop);
    vec2 lp = 0.25 + 0.5 * hash22(cell + 53.1);
    vec2 d = (f - lp) * S3;
    float srcSize = max(S3 * 0.26, footprintKm * 0.7);
    float glow = exp(-dot(d, d) / (srcSize * srcSize));
    float fade = 1.0 - smoothstep(S3 * 0.5, S3 * 1.8, footprintKm);
    float energy = clamp((S3 * 0.26 * S3 * 0.26) / (srcSize * srcSize), 0.0, 1.0);
    col += warmCol * lit * glow * fade * energy * 3.0;
  }

  // 远处被大气吸收（雾会遮挡灯光）
  float haze = 1.0 - smoothstep(30.0, 320.0, tGround);
  col *= mix(0.15, 1.0, haze);

  return col * uCities;
}

/**
 * 星空。
 * 必须用解析高斯：MSAA 对高频点无效，硬阈值会闪烁。
 */
vec3 starField(vec3 dir, float pixelAngle, float t) {
  float lon = atan(dir.z, dir.x);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  float cs = 0.007;
  vec2 p = vec2(lon * cos(lat), lat) / cs;
  vec2 c = floor(p);
  vec2 h = hash22(c);
  vec2 h2 = hash22(c + vec2(5.1, 3.3));
  if (h2.x > 0.0355) return vec3(0.0);

  float mag = max(6.5 + 2.0 * log(max(h2.y, 1e-4)) * 0.4343, -1.5);
  float irr = 2.0e-9 * pow(10.0, -0.4 * mag);
  vec2 sp = (c + 0.2 + 0.6 * h - p) * cs;
  float s = max(pixelAngle, 1e-4) * 0.8;
  float twinkle = 0.93 + 0.07 * sin(t * (6.0 + 9.0 * h.x) + h.y * 40.0);
  vec3 tint = mix(vec3(1.0, 0.8, 0.6), vec3(0.75, 0.85, 1.0), h.y);
  return tint * irr * twinkle / (3.14159 * s * s) * exp(-dot(sp, sp) / (s * s));
}

// ===========================================================================
// 主函数
// ===========================================================================

void main() {
  // --- 视线方向（相机空间 → 世界空间）---
  vec2 ndc = vUv * 2.0 - 1.0;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec3 viewVec = vec3(ndc.x * aspect * uTanHalfFov, ndc.y * uTanHalfFov, -1.0);
  vec3 dir = normalize(uCamBasis * viewVec);

  // 每个像素的张角，供城市灯光的足迹估算使用
  float pixelAngle = uPixelAngle;

  vec3 camPos = uCamPos;
  float camR = length(camPos);
  vec3 upDir = camPos / camR;          // 本地垂直
  float camAltKm = camR - uEarthRadius;

  // 几何地平线：视线方向与 upDir 的点积低于这个值就看不到天空
  float horizonSin = -sqrt(max(0.0, 1.0 - (uEarthRadius / camR) * (uEarthRadius / camR)));
  bool aboveHorizon = dot(dir, upDir) > horizonSin;

  // =========================================================================
  // 1. 大气（天空散射）
  // =========================================================================
  vec3 color = skyRadiance(camPos, dir, uSunDir, uSunColor, 0.0, uSteps);

  // --- 暮光补光 ---
  // 单次散射有一个已知缺陷：太阳落到地平线以下后，天空会迅速变全黑，
  // 但真实世界里高层大气仍被照亮，形成「蓝色时刻」。
  // 原因是那些光要经过「太阳 → 高层大气散射 → 相机」两段以上的路径，
  // 而单次散射只积分了「相机 → 单次散射点」这一段。
  //
  // 这里补一个解析项：以「太阳高度」为强度、以「视线相对太阳方向的
  // 角距离」为分布的经验暮光模型。这不是物理精确解，但视觉上足以
  // 覆盖单次散射的盲区，且成本几乎为零（原站用多重散射 LUT 解决同一问题）。
  {
    float sunAltSin = dot(uSunDir, upDir);
    // 太阳在地平线下方 8° 以内都有暮光
    float twilight = smoothstep(-0.16, 0.02, sunAltSin);
    if (twilight > 0.001) {
      // 暮光集中在太阳方位一侧的地平线附近
      vec3 sunHoriz = normalize(uSunDir - upDir * sunAltSin + vec3(1e-6, 0.0, 0.0));
      float towardSun = max(dot(normalize(dir - upDir * dot(dir, upDir) + vec3(1e-6, 0.0, 0.0)), sunHoriz), 0.0);
      // 地平线附近的仰角权重
      float horizonBand = exp(-max(dot(dir, upDir), -0.15) * 5.5);
      // 向着太阳的方向更亮更暖
      float warm = pow(towardSun, 1.6);
      // 冷色（背光侧）+ 暖色（朝阳侧）
      vec3 cool = vec3(0.10, 0.16, 0.32);
      vec3 warmCol = vec3(0.85, 0.42, 0.18);
      vec3 tint = mix(cool, warmCol, warm);
      // 太阳越接近地平线，暖色越强（日出/日落的红霞）
      float lowness = 1.0 - smoothstep(-0.16, 0.02, sunAltSin);
      tint = mix(tint, warmCol, lowness * warm * 0.7);
      color += tint * horizonBand * twilight * 0.42;
    }
  }

  // =========================================================================
  // 2. 地面
  // =========================================================================
  float tGround = raySphereNearest(camPos, dir, uEarthRadius);
  if (tGround > 0.0) {
    vec3 gp = camPos + dir * tGround;
    vec3 nrm = normalize(gp);

    // 球面经纬 → 公里坐标
    float lonAngle = atan(gp.z, gp.x);
    float latAngle = asin(clamp(gp.y / uEarthRadius, -1.0, 1.0));
    vec2 pKm = vec2(lonAngle, latAngle) * uEarthRadius;

    // 叠加飞行位移：地表图案随时间流过（地面后退感）。
    // 注意这里只偏移「采样坐标」，不移动相机 ——
    // 几何（地平线位置、球面求交）完全稳定，只有纹理内容在动。
    vec2 pKmFlight = pKm + uFlightOffset;

    // 距离越远细节越少
    float detail = 1.0 - smoothstep(120.0, 700.0, tGround);

    vec3 albedo = groundAlbedo(pKmFlight, detail);

    // --- 直射太阳 ---
    float cosSun = max(dot(nrm, uSunDir), 0.0);
    float tSunAtmo = raySphereFar(gp, uSunDir, uAtmosphereRadius);
    vec3 sunTrans = atmosphereTransmittance(opticalDepth(gp, uSunDir, tSunAtmo, 6));
    float shadow = (raySphereNearest(gp, uSunDir, uEarthRadius) > 0.0) ? 0.0 : 1.0;
    vec3 direct = uSunColor * sunTrans * (cosSun * shadow / PI);

    // --- 天空环境光（粗略）---
    vec3 ambient = uSunColor * 0.055 * (0.35 + 0.65 * (1.0 - cosSun));

    vec3 groundCol = albedo * (direct + ambient);

    // --- 低云 ---
    // 云层也要跟着位移，否则会出现「地面在动、云不动」的撕裂感。
    // 不过云是大气层里的东西，移动速度略慢于地面（不同高度层）。
    if (uLowClouds > 0.001) {
      vec2 cloud = lowCloud(pKm + uFlightOffset * 0.85, uLowClouds);
      if (cloud.x > 0.0) {
        vec3 cloudP = gp + nrm * (1.6 + cloud.y * 0.4);
        float tC = raySphereFar(cloudP, uSunDir, uAtmosphereRadius);
        vec3 cloudTrans = atmosphereTransmittance(opticalDepth(cloudP, uSunDir, tC, 5));
        float cloudShadow = (raySphereNearest(cloudP, uSunDir, uEarthRadius) > 0.0) ? 0.0 : 1.0;
        vec3 cloudLight = uSunColor * cloudTrans * (max(cosSun, 0.0) * cloudShadow / PI);
        vec3 cloudCol = vec3(0.92) * cloudLight + ambient * 0.8;
        groundCol = mix(groundCol, cloudCol, clamp(cloud.x, 0.0, 1.0) * 0.95);
      }
    }

    // --- 地面到相机的衰减（提前算，城市灯光也要用）---
    vec3 viewTrans = atmosphereTransmittance(opticalDepth(camPos, dir, tGround, 10));

    // --- 城市灯光 ---
    // 乘 viewTrans 让远处灯光被大气吸收；nightWeight 让白天不亮灯
    vec3 lights = cityLights(gp, nrm, tGround, detail);
    float sunAltitudeSin = dot(uSunDir, upDir);
    float nightWeight = 1.0 - smoothstep(-0.08, 0.10, sunAltitudeSin);
    groundCol += lights * viewTrans * nightWeight;

    vec3 haze = uSunColor * 0.0009 * (1.0 - viewTrans);

    color += groundCol * viewTrans + haze;
  }

  // =========================================================================
  // 3. 卷云
  //
  // ── 之前为什么看起来「静止」──
  // 云层高度设成 11 km，而相机在 10.4 km —— 只高出 0.6 km。
  // 视线向上 45° 时，云层距离只有 0.85 km，采样到的水平范围不到 1 km，
  // 整片云被放大成一个几乎恒定的色块，任何漂移都看不出来。
  //
  // 修正：卷云本来就该在 8~10 km 以上，但为了让它在画面里有结构，
  // 这里把「等效采样高度」拉到 14 km（相机上方 3.6 km），
  // 向上 45° 时距离 5 km、水平覆盖约 5 km，才能看到纤维状结构。
  //
  // 流动：卷云相对空气静止，飞机以 0.21 km/s 穿过它，
  // 所以采样坐标要按飞行位移反向移动（比地面慢一点，因为风也在吹）。
  // =========================================================================
  if (uCirrus > 0.001 && aboveHorizon) {
    float dirUp = dot(dir, upDir);

    /**
     * ── 地平线附近的退化情形 ──
     * tCi = (14 - camAltKm) / dirUp 在视线接近地平线时（dirUp → 0）
     * 会暴涨到几百公里，卷云平面被极度拉伸。
     *
     * ── 淡出区间必须完全覆盖钳制区间 ──
     * 关键教训：如果「淡出区间」和「dirUp 钳制」有重叠，
     * 重叠区里平面已经被钳住、UV 不再随角度变化，
     * 云会被拉成一根根**竖向拖尾**，而淡出系数还没降到 0，
     * 这些拖尾就会露在画面上 —— 这比原来的横条更难看。
     *
     * 所以现在的安排是：
     *   钳制点 dirUp = 0.10（约 5.7° 仰角）
     *   淡出区间 0.10 → 0.30（5.7° → 17.5°）
     * 淡出在钳制点处正好为 0，两者严格不重叠 ——
     * 也就是说凡是 fade > 0 的地方，dirUp 都大于钳制点，
     * 平面没有被拉伸，不会出现竖条拖尾。
     *
     * 这样卷云能覆盖窗口从 5.7° 往上的区域，比之前只留顶部一条更有存在感。
     */
    float ciFade = smoothstep(0.10, 0.30, dirUp);
    if (ciFade > 0.001) {
      float dirUpSafe = max(dirUp, 0.10);
      float tCi = min((14.0 - camAltKm) / dirUpSafe, 36.0);
      vec3 ciP = camPos + dir * tCi;
      // 投到本地切平面，得到公里坐标
      vec3 d = ciP - upDir * uEarthRadius;
      vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), upDir) + vec3(1e-5, 0.0, 0.0));
      vec3 north = cross(upDir, east);
      vec2 p2 = vec2(dot(d, east), dot(d, north));

      /**
       * ── 公里 → UV 的换算系数（决定卷云的「颗粒度」）──
       *
       * 视野内 p2 大约跨越 5~40 km。噪声纹理基频是 4 周期/UV，
       * 我们希望基频在视野里走 2~3 个周期，所以：
       *   UV 跨度 ≈ 0.5~0.75  →  系数 ≈ 0.5 / 10km ≈ 0.05
       *
       * 早期用的是 0.004（UV 跨度仅 0.02），基频完全没变化，
       * 只剩高频通道在混叠 —— 这就是顶部「梳齿状横条」的根因。
       */
      const float CIRRUS_KM_TO_UV = 0.05;

      // 叠加飞行位移 + 缓慢的风向漂移
      vec2 ciOffset = uFlightOffset * 0.72 + vec2(uTime * 0.012, uTime * 0.004);
      float ci = cirrusLayer(p2 * CIRRUS_KM_TO_UV + ciOffset * CIRRUS_KM_TO_UV, uCirrus);
      if (ci > 0.0) {
        float sunFacing = max(dot(dir, uSunDir), 0.0);
        vec3 ciColor = uSunColor * (0.05 + 0.03 * sunFacing);
        color = mix(color, color + ciColor, clamp(ci * 0.35 * ciFade, 0.0, 0.5));
      }
    }
  }

  // =========================================================================
  // 4. 星空
  // =========================================================================
  {
    float sunAlt = dot(uSunDir, upDir);           // 太阳高度的正弦
    float night = 1.0 - smoothstep(-0.10, 0.06, sunAlt);
    if (night > 0.001 && aboveHorizon) {
      color += starField(dir, pixelAngle, uTime) * night * 55.0;
    }
  }

  // =========================================================================
  // 5. 太阳圆盘 + 光晕
  // =========================================================================
  {
    float cosTheta = clamp(dot(dir, uSunDir), -1.0, 1.0);
    float angle = acos(cosTheta);

    // 圆盘：用像素角做抗锯齿，边缘刚好一个像素
    float disc = 1.0 - smoothstep(uSunAngularRadius - pixelAngle, uSunAngularRadius + pixelAngle, angle);

    vec3 sunTransView = atmosphereTransmittance(
      opticalDepth(camPos, dir, raySphereFar(camPos, dir, uAtmosphereRadius), 8)
    );

    color += uSunColor * disc * sunTransView * 180.0;

    // 光晕：单次散射不足以产生日晕，补两个解析项
    // 指数别开太大，pow 在移动端对 3000 次方精度不稳
    float c = max(cosTheta, 0.0);
    float c2 = c * c;
    float c4 = c2 * c2;
    float c8 = c4 * c4;
    float tight = c8 * c8 * c8 * c8 * c8;      // ≈ cos^40
    float halo = tight * 2.5 + c8 * c8 * 0.08; // ≈ cos^40 与 cos^16
    color += uSunColor * halo * sunTransView * 0.55;
  }

  // =========================================================================
  // 6. 调试通道
  //
  // 做大气/地形这类效果时，最耗时间的不是写代码而是「猜」：
  // 画面不对时你不知道是密度场错了、足迹算错了、还是光照错了。
  // 这些通道把中间量直接画出来，一次就能定位问题。
  // =========================================================================
  if (uDebugMode > 0) {
    if (uDebugMode == 1) {
      // 人口密度场。
      // 注意：必须用「地表法线」而不是「视线方向」去查表 ——
      // 视线方向是个单位向量，拿它当球面坐标只会得到「看向哪个方位」的纬度，
      // 而不是地表点的位置。用错会得到一片全黑。
      vec3 nrm = (tGround > 0.0) ? normalize(camPos + dir * tGround) : upDir;
      float pop = populationAt(nrm, 0.0);
      gl_FragColor = vec4(vec3(pow(pop, 0.6)), 1.0);
      return;
    } else if (uDebugMode == 2) {
      // 像素足迹（km）：对数显示，从 0.01 到 1000 km
      float fp = 0.5;
      if (tGround > 0.0) {
        vec3 gp = camPos + dir * tGround;
        vec3 nrm = normalize(gp);
        float cosInc = max(dot(nrm, -dir), 0.02);
        fp = clamp(tGround * uPixelAngle / cosInc, 0.001, 4000.0);
      }
      float v = log(fp / 0.01) / log(100000.0);
      gl_FragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
      return;
    } else if (uDebugMode == 3) {
      // 城市灯光原值
      vec3 lights = (tGround > 0.0)
        ? cityLights(camPos + dir * tGround, normalize(camPos + dir * tGround), tGround, 1.0)
        : vec3(0.0);
      gl_FragColor = vec4(clamp(lights, 0.0, 1.0), 1.0);
      return;
    } else if (uDebugMode == 4) {
      // 大气透射率
      float tEnd = (tGround > 0.0) ? tGround : raySphereFar(camPos, dir, uAtmosphereRadius);
      vec3 tr = atmosphereTransmittance(opticalDepth(camPos, dir, tEnd, 10));
      gl_FragColor = vec4(tr, 1.0);
      return;
    } else if (uDebugMode == 5) {
      // 地面反照率
      vec3 c = vec3(0.0);
      if (tGround > 0.0) {
        vec3 gp = camPos + dir * tGround;
        vec2 pKm = vec2(atan(gp.z, gp.x), asin(clamp(gp.y / uEarthRadius, -1.0, 1.0))) * uEarthRadius;
        float detail = 1.0 - smoothstep(120.0, 700.0, tGround);
        c = groundAlbedo(pKm, detail);
      }
      gl_FragColor = vec4(c, 1.0);
      return;
    } else if (uDebugMode == 6) {
      // 纯天空散射（不含地面/云/太阳盘）
      vec3 c = skyRadiance(camPos, dir, uSunDir, uSunColor, 0.0, uSteps);
      // 用固定曝光看结构
      c = pow(clamp(c * 4.0, 0.0, 1.0), vec3(1.0 / 2.2));
      gl_FragColor = vec4(c, 1.0);
      return;
    }
  }

  // =========================================================================
  // 7. 输出线性 HDR
  //
  // ── 为什么这里不做色调映射 ──
  // 早期版本是在 sky.frag 里手写 ACES + sRGB 的，但那样会毁掉 bloom：
  // 画面一旦被压到 0~1，城市灯光、太阳这类真正的高光就和普通亮部
  // 挤进同一区间，后期只能「从已压缩的画面里抠高光」，
  // 结果就是发灰、没层次、也扩不出光晕。
  //
  // 现在改成标准 HDR 管线：
  //   场景（线性 HDR，>1 保留） → 亮部提取 → 多级模糊 →
  //   bloom 叠加 → 统一 ACES → sRGB
  //
  // 附带好处：天空和机舱终于走同一条后期，
  // 不再有「天空一套、机舱另一套」的色调映射撕裂。
  //
  // 曝光也移到后期统一应用，这里只输出纯线性辐亮度。
  // =========================================================================

  // 镜头暗角。物理上是镜头衰减，属于成像前的作用，留在这里。
  vec2 vuv = vUv - 0.5;
  float vig = 1.0 - dot(vuv, vuv) * 0.42;
  color *= vig;

  // 不 clamp —— 高光要超过 1 才能被 bloom 抓到
  gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
}
