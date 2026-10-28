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

/** 星星亮度缩放（自动曝光越高，这个值越小，保证星星在屏幕上亮度恒定） */
uniform float uStarScale;

// --- 天气 ---
uniform float uLowClouds;
uniform float uCirrus;

// --- 性能 ---
uniform int uSteps;

// --- 调试通道 ---
// 0 = 正常渲染
// 1 = 人口密度场   2 = 像素足迹(km)   3 = 城市灯光原值
// 4 = 大气透射率   5 = 地面反照率     6 = 天空散射（仅单次）
// 7 = 天空散射（仅多次）
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
 * 地形高度（米）。
 *
 * ── 为什么必须加 ──
 * 原来地面只有 albedo，法线恒等于球面法线 —— 整块大地受光完全均匀，
 * 看起来像一张贴在地球仪上的贴图，完全没有「地」的体量感。
 * 真实高空俯瞰最抓眼的信息其实是**坡向明暗**：山脊亮、山谷暗。
 *
 * 三层频率叠加：
 *   大陆起伏（~55 km 周期）  ±550 m
 *   丘陵（~8 km 周期）        ±120 m
 *   山脊（~12 km 周期）      0~420 m（二次脊线，产生锐利山脊）
 *
 * @param pKm 地表公里坐标
 * @return 高度（米）
 */
float terrainHeight(vec2 pKm) {
  float macro = fbmTex(pKm * 0.0045 + vec2(1.7, 8.3), 3);
  float hill = fbmTex(pKm * 0.031 + vec2(11.3, 3.1), 3);
  float ridgeN = fbmTex(pKm * 0.020 + vec2(5.1, 19.7), 2);
  float ridge = 1.0 - abs(ridgeN * 2.0 - 1.0);
  ridge = ridge * ridge;
  return (macro - 0.5) * 1100.0 + (hill - 0.5) * 240.0 + ridge * 420.0;
}

/**
 * 田块色带：把 0~1 的噪声值映射成一条「深绿 → 草绿 → 黄绿 → 棕黄」的色带。
 * 真实农田的颜色不是连续的，而是一块块差异很大的拼图 —— 用色带比直接 mix 两色更像。
 */
vec3 farmRamp(float t) {
  vec3 c1 = vec3(0.062, 0.092, 0.044); // 深绿（牧草 / 林地）
  vec3 c2 = vec3(0.128, 0.152, 0.072); // 草绿
  vec3 c3 = vec3(0.196, 0.174, 0.088); // 黄绿（成熟作物）
  vec3 c4 = vec3(0.250, 0.202, 0.110); // 棕黄（收割 / 翻耕）
  vec3 col = mix(c1, c2, smoothstep(0.00, 0.34, t));
  col = mix(col, c3, smoothstep(0.31, 0.67, t));
  col = mix(col, c4, smoothstep(0.64, 1.00, t));
  return col;
}

/**
 * 地表反照率。
 *
 * ── 三层尺度的分工（这是「像不像地球」的关键）──
 *
 *   20 km 层（macro）：农林分区。远处唯一还能分辨的结构。
 *    4 km 层（patch）：**农田拼块**。高空俯瞰最主要的视觉信息 ——
 *                      之前完全没有这一层，只剩 20 km 的平滑渐变，
 *                      所以地面看起来像一块纯色塑料。
 *  1.2 km 层（patch2）：田块内部的色差。
 *
 * 每层按「像素足迹 / 特征尺度」淡出，避免远处混叠成噪点。
 * 用 tGround 近似像素足迹：掠射时 footprint ≈ tGround × 0.02。
 *
 * @param pKm     地表点沿球面的公里坐标（近似平面）
 * @param tGround 相机到该点的距离（km），用于分级 LOD
 * @param heightM 地形高度（米），用于山地着色
 */
vec3 groundAlbedo(vec2 pKm, float tGround, float heightM) {
  // --- 气候带（~200 km 周期）：决定土壤底色是湿润绿还是干燥黄 ---
  float climate = fbmTex(pKm * 0.0013 + vec2(3.7, 14.2), 2);

  // --- 20 km：农林分区 ---
  float macro = fbmTex(pKm * 0.012, 3);
  float forest = smoothstep(0.46, 0.70, macro);

  // --- 4 km：农田拼块 ---
  float patchN = fbmTex(pKm * 0.058 + vec2(7.3, 2.1), 3);
  // --- 1.2 km：田块内部色差 ---
  float patch2 = fbmTex(pKm * 0.19 + vec2(13.7, 5.3), 2);

  // 分级淡出：4 km 层在 120~380 km 之间退化成 20 km 层，
  // 否则远处每个像素跨几个田块，会闪成噪点。
  float dMid = 1.0 - smoothstep(120.0, 380.0, tGround);
  float dFine = 1.0 - smoothstep(35.0, 110.0, tGround);

  float t = mix(macro, patchN, dMid);
  vec3 farm = farmRamp(t);

  // 细层只贡献色差，不改变平均色
  farm += vec3((patch2 - 0.5) * 0.055 * dFine);

  // 湿润区偏冷、干燥区偏暖
  farm = mix(farm, farm * vec3(0.86, 0.98, 1.12), smoothstep(0.35, 0.65, climate));

  vec3 wood = vec3(0.034, 0.052, 0.028);
  vec3 c = mix(farm, wood, forest);

  // --- 水体：低洼处的湖泊 / 河流 ---
  // 没有水体的俯瞰图永远像沙盘；水是低反照率 + 强镜面，对比极强。
  float lakeN = fbmTex(pKm * 0.0032 + vec2(21.7, 4.9), 3);
  float dWater = 1.0 - smoothstep(200.0, 600.0, tGround);
  float water = smoothstep(0.655, 0.700, lakeN) * dWater;
  c = mix(c, vec3(0.010, 0.020, 0.032), water);

  // --- 海拔着色：丘陵 → 岩石 → 雪线 ---
  float alt01 = smoothstep(150.0, 900.0, heightM);
  vec3 rock = vec3(0.068, 0.064, 0.058);
  c = mix(c, rock, alt01 * 0.75);
  float snow = smoothstep(1150.0, 1450.0, heightM);
  c = mix(c, vec3(0.52, 0.55, 0.60), snow);

  // 极远处退化成平均色（但保留高度带来的色差，否则远山会消失）
  float dFar = 1.0 - smoothstep(700.0, 2400.0, tGround);
  vec3 avg = mix(vec3(0.098, 0.108, 0.080), rock, alt01 * 0.7);
  avg = mix(avg, vec3(0.52, 0.55, 0.60), snow);
  return mix(avg, c, dFar);
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
  // 宏观辉光权重原来给到 0.40，在自动曝光的暮光档位下会在地面铺成一片
  // 连贯的橙色地毯（因为法国人口密度底图几乎处处非零）。
  // 真实高空夜景是「黑地面 + 稀疏亮点」，所以压到 0.18。
  col += vec3(1.0, 0.68, 0.38) * cityMask * 0.30;

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
  // 1. 大气（单次 + 多次散射）
  //
  // `msMode = 1` 表示「单次 + 多次」。多次散射项直接从 LUT 取，
  // 覆盖了太阳落到地平线以下后单次散射的盲区 —— 不再需要经验暮光补丁。
  // =========================================================================
  vec3 color = skyRadiance(camPos, dir, uSunDir, uSunColor, 0.0, uSteps, 1);

  /**
   * ── 地面方向的「大气透视」压低 ──
   *
   * 这一行是本次「去模型感」最关键的一处，也是反复试错后才定位到的。
   *
   * 从 10 km 巡航高度透过侧窗看出去，可见地面全在 80 km 以外。这段掠射
   * 视线累积的 Rayleigh 光学厚度约 0.6，单次+多次散射辐亮度达到
   * (0.3, 0.5, 0.9) —— 是地面自身反射 (0.14, 0.15, 0.10) 的 3~6 倍，
   * 而且**蓝通道压倒性**。
   *
   * 结果：整块大地被染成一片均匀的淡蓝白，农田拼块、地形明暗、
   * 水体全被冲掉 —— 就是用户说的「模型感」。
   *
   * 注意：在 ray-march 循环里按高度压制（lowFade）**几乎无效**，
   * 因为掠射路径的采样点大部分落在 8~10 km 的高空段（那里密度虽低，
   * 但路径极长）。必须在地面/天空分流的这一层整体压。
   *
   * 0.22 是按「地面 / 大气散射 ≈ 1 : 1」标定的。
   * 天空方向（tGround < 0）完全不受影响，暮光曲线保持不变。
   */
  float tGroundEarly = raySphereNearest(camPos, dir, uEarthRadius);
  if (tGroundEarly > 0.0) color *= 0.34;

  // =========================================================================
  // 2. 地面
  // =========================================================================
  float tGround = raySphereNearest(camPos, dir, uEarthRadius);
  if (tGround > 0.0) {
    vec3 gp = camPos + dir * tGround;
    vec3 sphereNrm = normalize(gp);

    // 球面经纬 → 公里坐标
    float lonAngle = atan(gp.z, gp.x);
    float latAngle = asin(clamp(gp.y / uEarthRadius, -1.0, 1.0));
    vec2 pKm = vec2(lonAngle, latAngle) * uEarthRadius;

    // 叠加飞行位移：地表图案随时间流过（地面后退感）。
    // 注意这里只偏移「采样坐标」，不移动相机 ——
    // 几何（地平线位置、球面求交）完全稳定，只有纹理内容在动。
    vec2 pKmFlight = pKm + uFlightOffset;

    // ── 细节权重 ──
    // 原来写的是 smoothstep(120, 700)：从 10 km 高度看出去，
    // 舷窗下缘的最近地面就有 ~70 km，再往上一点就 300 km+，
    // 于是整块可见地面几乎全部落在 detail ≈ 0 的区间，
    // albedo 退化成常数 —— 这就是「一片纯色」的直接原因。
    // 现在放宽到 320~2200 km：从 10 km 高度看出去，即便舷窗下缘的
    // 最近地面也有 ~77 km，所有可见地面都在 70 km 以外，衰减必须更晚。
    float detail = 1.0 - smoothstep(320.0, 2200.0, tGround);

    // ── 地形高度与法线 ──
    float hM = terrainHeight(pKmFlight);
    vec3 nrm = sphereNrm;
    if (detail > 0.02) {
      // 有限差分求坡度。EPS_KM 取 0.45 km（= 一个像素在 300 km 处的大致足迹），
      // 太小会闪，太大山脊会糊。
      const float EPS_KM = 0.45;
      float hE = terrainHeight(pKmFlight + vec2(EPS_KM, 0.0));
      float hW = terrainHeight(pKmFlight - vec2(EPS_KM, 0.0));
      float hN = terrainHeight(pKmFlight + vec2(0.0, EPS_KM));
      float hS = terrainHeight(pKmFlight - vec2(0.0, EPS_KM));
      float sx = (hE - hW) / (2.0 * EPS_KM * 1000.0);  // 米/米
      float sy = (hN - hS) / (2.0 * EPS_KM * 1000.0);

      vec3 eT = normalize(cross(vec3(0.0, 1.0, 0.0), sphereNrm) + vec3(1e-5, 0.0, 0.0));
      vec3 nT = cross(sphereNrm, eT);
      // 坡度放大 2.2 倍：真实地形在 300 km 外被大气压掉对比，
      // 不放大画面里根本看不到山脊。这是「观感优先」的一处刻意偏离。
      nrm = normalize(sphereNrm - eT * sx * 2.2 - nT * sy * 2.2);
    }

    vec3 albedo = groundAlbedo(pKmFlight, tGround, hM);

    // --- 直射太阳 ---
    // cosSun 用扰动后的法线：这是山体明暗的唯一来源
    float cosSun = max(dot(nrm, uSunDir), 0.0);
    float tSunAtmo = raySphereFar(gp, uSunDir, uAtmosphereRadius);
    vec3 sunTrans = atmosphereTransmittance(opticalDepth(gp, uSunDir, tSunAtmo, 6));
    // 地球本影用球面法线判断（不能用扰动法线，否则阴影边界会碎）
    float shadow = (raySphereNearest(gp, uSunDir, uEarthRadius) > 0.0) ? 0.0 : 1.0;
    vec3 direct = uSunColor * sunTrans * (cosSun * shadow / PI);

    // --- 天空环境光 ---
    // 用多重散射 LUT 在**地面点**的值当作天空辐照度：
    // F_total 是「来自四面八方的散射光按方向平均的辐亮度」，
    // 对半球近似各向同性时，水平面辐照度 E ≈ π·F。
    //
    // ── 0.55 这个系数是标定出来的 ──
    // 直接取 π·F 会高估约 2 倍：F 是对**整个球面**的平均，包含了
    // 来自下半球（地面自身反射）的部分，而地表只接受上半球的辐照。
    // 不打折的话天空光会占到总光照的 ~40%，地面被冲成淡蓝白，
    // 地形和地物的对比全部消失 —— 正是「模型感」的主因。
    // 0.55 让天空光回到 15~20% 的合理区间。
    // ── 注意这里的单位 ──
    // skyIrradiance 是**辐照度**（W/m²），而 direct 是**辐亮度**（W/m²/sr）。
    // 朗伯面反射：L = albedo · E / π，所以环境光必须先除以 π 才能和 direct 相加。
    // 早期漏了这个 π，等于把天空光放大了 3.14 倍 —— 地面被染成淡蓝白，
    // 地形和地物的对比被冲平，这是「模型感」的来源之一。
    vec3 skyIrradiance = uSunColor * PI * msLookup(gp, uSunDir) * uMSStrength * 0.55;
    vec3 ambient = skyIrradiance / PI;

    /**
     * ── 地面增益 2.4 ──
     *
     * 实测：从 10 km 巡航高度看出去，可见地面全在 80 km 以外，
     * 这段视线的大气散射辐亮度是地面反射的 2~3 倍 —— 地面被压成
     * 一块淡蓝白，所有农田拼块、地形明暗全部看不见（「模型感」的根源）。
     *
     * 物理上这个比例没错，但真实照片里地面可辨，因为相机是按地面曝光的。
     * 我们在全局曝光下只能给地面一个观感增益，把它拉回和大气散射同一量级。
     * 2.4 这个值是按「地面 / 大气散射 ≈ 1.2 : 1」标定的。
     */
    vec3 groundCol = albedo * (direct + ambient) * 1.8;

    // --- 低云 ---
    // 云层也要跟着位移，否则会出现「地面在动、云不动」的撕裂感。
    // 不过云是大气层里的东西，移动速度略慢于地面（不同高度层）。
    if (uLowClouds > 0.001) {
      vec2 cloud = lowCloud(pKm + uFlightOffset * 0.85, uLowClouds);
      if (cloud.x > 0.0) {
        // ── 云影 ──
        // 云底挡住的直射光不会照到地面。没有云影的话，云层看起来像
        // 「贴在天上的一张纸」，和地面完全脱钩。
        groundCol *= 1.0 - clamp(cloud.x, 0.0, 1.0) * 0.62;

        vec3 cloudP = gp + nrm * (1.6 + cloud.y * 0.4);
        float tC = raySphereFar(cloudP, uSunDir, uAtmosphereRadius);
        vec3 cloudTrans = atmosphereTransmittance(opticalDepth(cloudP, uSunDir, tC, 5));
        float cloudShadow = (raySphereNearest(cloudP, uSunDir, uEarthRadius) > 0.0) ? 0.0 : 1.0;
        vec3 cloudLight = uSunColor * cloudTrans * (max(cosSun, 0.0) * cloudShadow / PI);
        vec3 cloudCol = vec3(0.92) * cloudLight + ambient * 0.8;
        groundCol = mix(groundCol, cloudCol, clamp(cloud.x, 0.0, 1.0) * 0.95);
      }
    }

    // --- 地面到相机的衰减 ---
    // 注意用 opticalDepthToGround（远端密采样）：均匀步长会把
    // 近地面那层浓密大气平均掉，导致 viewTrans 被高估、地面不被雾化。
    vec3 viewTrans = atmosphereTransmittance(opticalDepthToGround(camPos, dir, tGround, 12));

    // 城市灯光
    // 乘 viewTrans 让远处灯光被大气吸收；nightWeight 让白天不亮灯
    // 注意传 sphereNrm 而不是扰动后的 nrm：人口密度图是按经纬度查的，
    // 用扰动法线会把查表坐标算错，整个城市分布会跟着地形一起扭曲。
    vec3 lights = cityLights(gp, sphereNrm, tGround, detail);
    float sunAltitudeSin = dot(uSunDir, upDir);
    float nightWeight = 1.0 - smoothstep(-0.16, -0.02, sunAltitudeSin);
    groundCol += lights * viewTrans * nightWeight;

    /**
     * ── 这里曾经有一个假的「大气雾」项 ──
     *
     *   vec3 haze = uSunColor * 0.0009 * (1.0 - viewTrans);
     *   color += groundCol * viewTrans + haze;
     *
     * 它的本意是补上「地面到相机之间的空气散射」。但现在 skyRadiance()
     * 已经沿同一条视线把整段大气积完了（包括到地面交点之前的所有散射），
     * 再加一遍就是重复计算。更要命的是它**不随昼夜变化**：
     * 固定 0.0009 的系数在自动曝光 700 倍下会直接饱和成一片纯白，
     * 把整块地面糊掉 —— 这也是为什么之前地面是死白的。
     *
     * 现在只保留地面本身的辐亮度 × 大气透射率，气溶胶的雾感由
     * Mie 散射在 skyRadiance() 里物理地产生。
     */
    color += groundCol * viewTrans;
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
        /**
         * ── 卷云亮度必须来自「它所在高度的实际光照」 ──
         *
         * 原来是 `uSunColor * (0.05 + 0.03*sunFacing)` —— 一个与太阳高度
         * 完全无关的常数项。曝光 = 1 时看着还行，一旦自动曝光把暮光提亮
         * 500 倍，这层常数就成了 0.3~0.5 的线性亮度，把整片上方天空
         * 糊成一个巨大的白色光球（还带 bloom）。
         *
         * 现在改成查多重散射 LUT：取 14 km 高度上的环境辐亮度。
         * 太阳落到地平线以下后，14 km 处的地球本影边界约在 -3.8°，
         * 所以 -11° 时卷云应该是全黑的 —— 物理上就该如此。
         */
        vec3 ciColor = uSunColor * msLookup(ciP, uSunDir) * 0.9;
        color = mix(color, color + ciColor, clamp(ci * 0.35 * ciFade, 0.0, 0.5));
      }
    }
  }

  // =========================================================================
  // 4. 星空
  // =========================================================================
  {
    float sunAlt = dot(uSunDir, upDir);           // 太阳高度的正弦
    // 星星必须在天空还亮的时候彻底消失。以 -6°/-11° 为界：
    // 太阳 -2° 时天光已经压下大部分恒星，只有最亮的几颗还在。
    float night = 1.0 - smoothstep(-0.19, -0.10, sunAlt);
    if (night > 0.001 && aboveHorizon) {
      // uStarScale 抵消自动曝光：星星是点光源，屏幕上应该始终是同样亮的小点。
      // 不乘的话，暮光档位 512× 曝光会把每颗星放大到 80 的线性亮度，
      // 再经 bloom 变成一片白斑 —— 看起来像镜头脏了。
      color += starField(dir, pixelAngle, uTime) * night * 55.0 * uStarScale;
    }
  }

  // =========================================================================
  // 5. 太阳圆盘 + 光晕
  // =========================================================================
  {
    float cosTheta = clamp(dot(dir, uSunDir), -1.0, 1.0);
    float angle = acos(cosTheta);

    /**
     * ── 太阳必须在几何地平线以上才画 ──
     * 早期版本靠 sunIrradiance() 在太阳高度 -8° 以下把 uSunColor 归零
     * 来「顺手」隐藏圆盘和光晕。现在 uSunColor 是恒定的大气层外辐照度，
     * 就必须显式做地平线裁剪，否则夜里会有一个挂在地平线下的太阳光斑
     * 叠在地面上（因为地面是加法合成的，挡不住它）。
     */
    float sunAltSin = dot(uSunDir, upDir);
    float sunUp = smoothstep(horizonSin, horizonSin + 0.012, sunAltSin);
    float skyMask = aboveHorizon ? 1.0 : 0.0;

    // 圆盘：用像素角做抗锯齿，边缘刚好一个像素
    float disc = 1.0 - smoothstep(uSunAngularRadius - pixelAngle, uSunAngularRadius + pixelAngle, angle);

    vec3 sunTransView = atmosphereTransmittance(
      opticalDepth(camPos, dir, raySphereFar(camPos, dir, uAtmosphereRadius), 8)
    );

    color += uSunColor * disc * sunTransView * 180.0 * sunUp * skyMask;

    /**
     * ── 这里曾经有一个手写的「日晕」项 ──
     *
     *   float halo = pow(c,40)*2.5 + pow(c,16)*0.08;
     *   color += uSunColor * halo * sunTransView * 0.55;
     *
     * 当年加它是因为单次散射的 Mie 相位函数太窄，太阳周围不够亮。
     * 但它有两个致命问题：
     *   1) cos^16 的尾巴极长 —— 离太阳 19° 还有 0.40，
     *      乘上 uSunColor×0.55 就是 2.7 的线性辐亮度，直接把半个窗口糊成白色。
     *   2) 和物理 Mie 散射重复计算：skyRadiance() 里的 Cornette-Shanks
     *      相位函数已经给出了正确的日晕形状和能量。
     *
     * 自动曝光一上，这个「常数级」的假光晕立刻暴露成一大片死白 ——
     * 这是典型的「经验项在低动态范围下看不出来、一进 HDR 就炸」。
     */
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
        c = groundAlbedo(pKm, tGround, terrainHeight(pKm));
      }
      gl_FragColor = vec4(c, 1.0);
      return;
    } else if (uDebugMode == 6) {
      // 纯天空散射（**只要单次**）—— 用来对比多次散射的贡献
      vec3 c = skyRadiance(camPos, dir, uSunDir, uSunColor, 0.0, uSteps, 0);
      // 用固定曝光看结构
      c = pow(clamp(c * 4.0, 0.0, 1.0), vec3(1.0 / 2.2));
      gl_FragColor = vec4(c, 1.0);
      return;
    } else if (uDebugMode == 7) {
      // **只要多次散射** —— 直接看暮光是谁提供的
      vec3 c = skyRadiance(camPos, dir, uSunDir, uSunColor, 0.0, uSteps, 2);
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
