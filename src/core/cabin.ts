/**
 * 机舱几何
 *
 * ── 架构决定 ──
 * 天空是一个 depthTest:false 的全屏三角形，机舱是正常的 3D 几何。
 * 两者共用同一个相机：
 *   1. 先画天空（renderOrder 很小，不写深度）
 *   2. 再画机舱（正常深度测试）
 * 窗洞是内壁上的真实开孔，所以天空会从洞里透出来。
 *
 * ── 为什么不用双 Pass / 双相机 ──
 * 常见做法是「天空渲染到 RT → 清深度 → 渲染机舱 → 合成」。
 * 但这里不需要：天空不写深度，机舱的 near/far 只要覆盖机舱尺度即可
 * （0.02 ~ 500 m），完全不涉及原站那种 2e5 的远裁面。
 * 少一次 RT 和一次全屏合成，移动端省一大笔带宽。
 *
 * ── 几何全部程序化生成，没有任何模型文件 ──
 *   - 舷窗内壁：Shape + 圆角矩形开孔 → ExtrudeGeometry（带倒角）
 *   - 机翼：NACA 四位翼型公式 → 挤出成翼型，再加翼梢小翼
 *   - 发动机短舱：LatheGeometry 车削
 */

import * as THREE from 'three';
import * as C from '../config';

/** 圆角矩形路径（用于窗洞和面板轮廓） */
function roundedRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): THREE.Path {
  const p = new THREE.Path();
  const x0 = x - w / 2;
  const x1 = x + w / 2;
  const y0 = y - h / 2;
  const y1 = y + h / 2;
  // 从底边左端起，逆时针（Path 用于 holes 时方向需与外轮廓相反，
  // 但 three 的 ExtrudeGeometry 会自动处理环绕方向）
  p.moveTo(x0 + r, y0);
  p.lineTo(x1 - r, y0);
  p.quadraticCurveTo(x1, y0, x1, y0 + r);
  p.lineTo(x1, y1 - r);
  p.quadraticCurveTo(x1, y1, x1 - r, y1);
  p.lineTo(x0 + r, y1);
  p.quadraticCurveTo(x0, y1, x0, y1 - r);
  p.lineTo(x0, y0 + r);
  p.quadraticCurveTo(x0, y0, x0 + r, y0);
  return p;
}

/**
 * NACA 四位翼型厚度分布。
 *
 * 这个公式是翼型设计的经典结果：
 *   yt = 5t(0.2969√x − 0.1260x − 0.3516x² + 0.2843x³ − 0.1036x⁴)
 * 其中 t 是最大厚度比。最后一项用 −0.1036 而不是 −0.1015，
 * 是为了得到闭合的后缘（避免挤出后缘出现缝）。
 */
function nacaThickness(x: number, t: number): number {
  return (
    5 *
    t *
    (0.2969 * Math.sqrt(x) -
      0.126 * x -
      0.3516 * x * x +
      0.2843 * x * x * x -
      0.1036 * x * x * x * x)
  );
}

export type CabinObjects = {
  /** 需要加入场景的根节点 */
  root: THREE.Group;
  /** 舷窗内壁（含窗洞） */
  wall: THREE.Mesh;
  /** 机翼 */
  wing: THREE.Group;
  /** 窗外主光（模拟太阳） */
  keyLight: THREE.DirectionalLight;
  /** 舱内环境光 */
  fillLight: THREE.AmbientLight;
  /** 轮廓补光 */
  rimLight: THREE.DirectionalLight;
  /** 窗口光：让内壁从窗边到远处有明暗梯度 */
  windowLight: THREE.PointLight;
  dispose(): void;
};

/** 内壁到眼睛的距离（米）。REV: 原站舷窗 z = -1.86，但那是不同的尺度体系 */
const EYE_TO_WALL = 0.42;
/** 座位间距（米） */
const ROW_PITCH = 0.8;
/** 可见窗数量。奇数保证正前方有一扇窗。 */
const ROW_COUNT = 5;

/**
 * 座位排数 → 机舱本地坐标。
 *
 * 每 ROW_PITCH 米一扇窗，排数映射到窗位；同时人眼相对窗心
 * 会有一点横向偏移，这样不同排数看到的窗外构图不同（和原站一致）。
 */
export function seatOffsetForRow(row: number): THREE.Vector3 {
  // 排数 → 窗索引。用取模让它循环，任意排数都有窗可看。
  const idx = ((row - 1) % ROW_COUNT) - (ROW_COUNT - 1) / 2;
  // 人坐在窗边，不是正对窗心，所以加一点横向偏移
  const lateral = 0.08;
  return new THREE.Vector3(idx * ROW_PITCH + lateral, 0, EYE_TO_WALL);
}

/**
 * 构建机舱。
 *
 * 坐标约定（与 rig 一致）：
 *   x = 沿机身（座位排数方向）
 *   y = 上下
 *   z = 向外（窗在 -z 方向，因为 three 相机看向 -Z）
 */
export function createCabin(): CabinObjects {
  const root = new THREE.Group();
  root.name = 'cabin';

  const disposables: Array<{ dispose(): void }> = [];

  // =========================================================================
  // 1. 舷窗内壁
  // =========================================================================

  const W = C.WINDOW;
  /**
   * 内壁平面在机舱本地坐标里的 z。
   *
   * 约定：机舱本地 -Z 就是「窗外方向」，与参考姿态下相机的视线一致。
   * 把内壁放在 z = 0，眼睛放在 +z 侧（见 seatOffsetForRow），
   * 于是「从座位朝 -Z 看出去」正好穿过窗洞 —— 不需要任何额外旋转。
   */
  const WALL_Z = 0;
  /** 座位间距（米） */
  const ROW_PITCH_M = ROW_PITCH;
  /**
   * 可见窗数量。奇数保证正前方（x=0）有一扇窗；
   * 偶数会让视线落在两窗之间的壁面上，画面里只有内壁没有天空。
   */
  /**
   * 面板高度。
   *
   * 必须足够高，否则超宽屏下上下边缘会露出天空。
   * 计算方式：眼到墙 EYE_TO_WALL、垂直 fov 54°，
   * 半高 = EYE_TO_WALL * tan(27°) ≈ 0.214 m。
   * 1.9 m 远大于这个值，所以垂直方向始终有余量。
   */
  const WALL_H = 1.9;
  /**
   * 面板宽度（动态扩展）。
   *
   * 这是超宽屏（21:9、32:9）必须处理的问题：
   * 水平半张角 = atan(tan(fov/2) * aspect)，在 32:9 下可达 ~72°，
   * 单侧需要覆盖 EYE_TO_WALL * tan(72°) ≈ 1.3 m。
   * 再叠加座位横向偏移（最多 ±1.6 m），固定 4.8 m 宽完全不够，
   * 左侧会直接露出天空。
   *
   * 所以这里按「最坏情况」留足余量：窗位偏移 + 视野半宽 + 安全边距。
   */
  const maxSeatShiftM = ((ROW_COUNT - 1) / 2) * ROW_PITCH_M;
  // 32:9 时水平半张角约 72°，tan ≈ 3.1；取 4.0 留安全边距
  const maxHalfWidthM = EYE_TO_WALL * 4.0;
  const WALL_W_TOTAL = (maxSeatShiftM + maxHalfWidthM + 1.0) * 2;

  // 外轮廓
  const outline = new THREE.Shape();
  const hw = WALL_W_TOTAL / 2;
  const hh = WALL_H / 2;
  const cr = 0.35; // 面板四角圆角
  outline.moveTo(-hw + cr, -hh);
  outline.lineTo(hw - cr, -hh);
  outline.quadraticCurveTo(hw, -hh, hw, -hh + cr);
  outline.lineTo(hw, hh - cr);
  outline.quadraticCurveTo(hw, hh, hw - cr, hh);
  outline.lineTo(-hw + cr, hh);
  outline.quadraticCurveTo(-hw, hh, -hw, hh - cr);
  outline.lineTo(-hw, -hh + cr);
  outline.quadraticCurveTo(-hw, -hh, -hw + cr, -hh);

  /**
   * 实际生成的窗洞数量。
   *
   * 面板被加宽以覆盖超宽屏，但窗洞不能只按 ROW_COUNT 生成 ——
   * 否则加宽出来的两侧会变成一整片没有窗的实心壁面，
   * 超宽屏上看起来像「左边糊了一块」。
   *
   * 所以窗洞数量跟着面板宽度走，保持与座位间距一致的真实排布。
   */
  const HOLE_COUNT = Math.max(ROW_COUNT, Math.ceil(WALL_W_TOTAL / ROW_PITCH_M) + 1);
  // 保证是奇数，使正前方（x=0）一定有一扇窗
  const HOLE_COUNT_ODD = HOLE_COUNT % 2 === 0 ? HOLE_COUNT + 1 : HOLE_COUNT;

  // 打窗洞。注意 holes 的方向要与外轮廓相反（three 会处理，但保持一致更稳）
  for (let i = 0; i < HOLE_COUNT_ODD; i++) {
    const cx = (i - (HOLE_COUNT_ODD - 1) / 2) * ROW_PITCH_M;
    outline.holes.push(roundedRect(cx, 0, W.width, W.height, W.radius));
  }

  const wallGeo = new THREE.ExtrudeGeometry(outline, {
    depth: W.depth,
    bevelEnabled: true,
    bevelThickness: 0.008,
    bevelSize: 0.006,
    bevelSegments: 4,
    curveSegments: 16,
  });
  // 挤出方向是 +z（朝眼），这里推到 z = -depth，让内壁朝眼的一面正好落在 z = 0
  wallGeo.translate(0, 0, WALL_Z - W.depth);

  // 内壁材质：哑光塑料 + 窗边被外部光照亮的边缘
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2e,
    roughness: 0.85,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });
  disposables.push(wallGeo, wallMat);

  const wall = new THREE.Mesh(wallGeo, wallMat);
  wall.name = 'windowWall';
  root.add(wall);

  // --- 窗玻璃边框装饰：每个窗洞加一圈更亮的边 ---
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x4a4a50,
    roughness: 0.55,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });
  disposables.push(trimMat);

  for (let i = 0; i < HOLE_COUNT_ODD; i++) {
    const cx = (i - (HOLE_COUNT_ODD - 1) / 2) * ROW_PITCH_M;
    const trimShape = new THREE.Shape();
    const outer = roundedRect(cx, 0, W.width + 0.022, W.height + 0.022, W.radius + 0.011);
    trimShape.curves = outer.curves;
    const inner = roundedRect(cx, 0, W.width - 0.004, W.height - 0.004, W.radius - 0.002);
    trimShape.holes.push(inner);
    const trimGeo = new THREE.ExtrudeGeometry(trimShape, {
      depth: 0.012,
      bevelEnabled: false,
      curveSegments: 16,
    });
    trimGeo.translate(0, 0, WALL_Z + 0.002);
    disposables.push(trimGeo);
    const trim = new THREE.Mesh(trimGeo, trimMat);
    root.add(trim);
  }

  // =========================================================================
  // 2. 机翼（放样生成的真实翼型）
  //
  // ── 为什么不用 ExtrudeGeometry ──
  // 挤出只能得到「等截面直筒」，也就是一根翼型截面的柱子。
  // 真实机翼有四个关键特征，缺任何一个都会一眼假：
  //   1) 收缩（taper）：翼尖弦长只有翼根的 1/4~1/3
  //   2) 后掠（sweep）：翼尖比翼根靠后 20~30°
  //   3) 上反（dihedral）：翼尖比翼根高 3~6°
  //   4) 扭转（washout）：翼尖安装角比翼根小 2~4°
  //
  // 所以这里改成**逐截面放样**：沿翼展取 N 个站位，每个站位按
  // 上述参数算出该处的翼型，再把相邻截面的顶点连成三角形。
  // =========================================================================

  const wing = new THREE.Group();
  wing.name = 'wing';

  /** 可见翼展（米）。按视锥反推：5.5 m 外、垂直 fov 54° 时约 3 m */
  const WING_SPAN = 3.0;
  /** 翼根弦长 */
  const WING_CHORD_ROOT = 1.2;
  /** 翼尖弦长 / 翼根弦长 —— 真实客机约 0.28~0.35 */
  const TAPER_RATIO = 0.3;
  /** 后掠角（弧度）。真实 737 约 25° */
  const SWEEP = (25 * Math.PI) / 180;
  /** 上反角（弧度）。真实客机约 5~6° */
  const DIHEDRAL = (5.5 * Math.PI) / 180;
  /** 翼尖扭转（弧度）。洗出角，让翼尖安装角变小 */
  const WASHOUT = (-3 * Math.PI) / 180;
  /** 翼根最大厚度比 */
  const THICK_ROOT = 0.14;
  /** 翼尖最大厚度比 */
  const THICK_TIP = 0.09;

  /**
   * 生成放样机翼几何。
   *
   * 坐标：x = 沿翼展（向翼尖），y = 上下，z = 弦向（前缘在 -z）。
   */
  function buildLoftedWing(spanStations = 24, chordStations = 28): THREE.BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];

    // 每个站位生成一圈翼型点（上表面从后到前，下表面从前到后）
    const rings: Array<Array<[number, number, number]>> = [];

    for (let s = 0; s <= spanStations; s++) {
      const t = s / spanStations; // 0 = 翼根, 1 = 翼尖

      /**
       * ── 翼根要「延伸进机身」 ──
       * 真实机翼不是从窗框边缘凭空开始的，它的根部一直延伸到机身内部
       * （翼根整流罩把机身和机翼包在一起）。
       *
       * 如果放样只从 t=0 开始，翼根会在空中被截断成一个平面，
       * 从舷窗看过去就是「机翼断开了」——正是用户截图里指出的问题。
       *
       * 做法：把 t 映射成从 -ROOT_EXTENSION 开始的区间，
       * 让几何往机身方向多伸出 1.6 m。这段会被窗框/机身挡住，
       * 视觉上机翼就是「从机身里长出来的」。
       */
      const ROOT_EXTENSION = 1.6;
      const tGeom = t * (1 + ROOT_EXTENSION / WING_SPAN) - ROOT_EXTENSION / WING_SPAN;

      // 沿翼展的几何参数（线性插值）。
      // 负 t 段保持翼根弦长不变（机身内是等截面的翼根整流罩）。
      const tClamped = Math.max(0, tGeom);
      const chord = WING_CHORD_ROOT * (1 - (1 - TAPER_RATIO) * tClamped);
      const thick = THICK_ROOT * (1 - tClamped) + THICK_TIP * tClamped;
      const twist = WASHOUT * tClamped;

      // 站位在三维空间中的位置：
      //   x = 翼展方向
      //   y = 上反角抬升
      //   z = 后掠 + 扭转造成的弦向偏移
      const x = tGeom * WING_SPAN;
      const y = Math.tan(DIHEDRAL) * x;
      const zSweep = Math.tan(SWEEP) * x;

      const ring: Array<[number, number, number]> = [];
      // 用余弦分布：前后缘加密，符合 CFD 网格惯例
      for (let c = 0; c <= chordStations; c++) {
        const u = (1 - Math.cos((c / chordStations) * Math.PI)) * 0.5; // 0..1 从前缘到后缘
        const yt = nacaThickness(u, thick);
        // 简单弯度线
        const camber = 0.02;
        const yc = camber * 4 * u * (1 - u);

        // 上表面
        const upperY = (yc + yt) * chord;
        // 弦向位置：前缘在 u=0 处，向后为正
        let cz = u * chord;

        // 施加扭转（绕翼展轴旋转）
        const cosT = Math.cos(twist);
        const sinT = Math.sin(twist);
        const ry = upperY * cosT - cz * sinT;
        const rz = upperY * sinT + cz * cosT;

        ring.push([x, y + ry, zSweep + rz]);
      }
      // 下表面（从后缘回到前缘，跳过两端避免重复）
      for (let c = chordStations - 1; c > 0; c--) {
        const u = (1 - Math.cos((c / chordStations) * Math.PI)) * 0.5;
        const yt = nacaThickness(u, thick);
        const camber = 0.02;
        const yc = camber * 4 * u * (1 - u);

        const lowerY = (yc - yt) * chord;
        let cz = u * chord;

        const cosT = Math.cos(twist);
        const sinT = Math.sin(twist);
        const ry = lowerY * cosT - cz * sinT;
        const rz = lowerY * sinT + cz * cosT;

        ring.push([x, y + ry, zSweep + rz]);
      }
      rings.push(ring);
    }

    // 把相邻两个站位的环连成四边形（拆成两个三角形）
    const ringLen = rings[0].length;
    for (let s = 0; s < spanStations; s++) {
      for (let c = 0; c < ringLen; c++) {
        const c2 = (c + 1) % ringLen;
        const a = s * ringLen + c;
        const b = s * ringLen + c2;
        const d = (s + 1) * ringLen + c;
        const e = (s + 1) * ringLen + c2;
        indices.push(a, d, b);
        indices.push(b, d, e);
      }
    }

    /**
     * ── 两端封口（关键）──
     * 放样只生成侧面，翼根和翼尖都是**敞开的环**。
     * 从舷窗看过去，翼根那个敞开的截面就像一个斜切的灰色平面，
     * 非常显眼（用户截图里那块「断开的三角」就是它）。
     *
     * 这里用三角扇把两端封住：取该环所有顶点的平均位置作为扇心，
     * 然后与环上相邻两点连成三角形。
     * 因为翼型是「上表面 + 下表面」围成的闭合轮廓，扇心落在内部，
     * 封出来的端面正好贴合翼型轮廓。
     */
    const capRing = (ringIndex: number, flip: boolean) => {
      const ring = rings[ringIndex];
      // 扇心：环上所有顶点的平均
      let cx = 0, cy = 0, cz = 0;
      for (const [px, py, pz] of ring) { cx += px; cy += py; cz += pz; }
      cx /= ring.length; cy /= ring.length; cz /= ring.length;

      const centerIdx = positions.length / 3;
      positions.push(cx, cy, cz);

      const base = ringIndex * ringLen;
      for (let c = 0; c < ringLen; c++) {
        const c2 = (c + 1) % ringLen;
        if (flip) {
          indices.push(centerIdx, base + c2, base + c);
        } else {
          indices.push(centerIdx, base + c, base + c2);
        }
      }
    };

    // 先把所有环的顶点写进 positions（封口需要基于已写入的索引）
    for (const ring of rings) for (const [px, py, pz] of ring) positions.push(px, py, pz);
    // 翼根封口（朝 -x，所以翻转）与翼尖封口（朝 +x）
    capRing(0, true);
    capRing(spanStations, false);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    // 法线由几何自动计算（放样面不是平面，必须用 computeVertexNormals）
    geo.computeVertexNormals();
    void normals;

    return geo;
  }

  const wingGeo = buildLoftedWing();
  disposables.push(wingGeo);

  /**
   * 机翼材质。
   *
   * ── 为什么会过曝成纯白 ──
   * 机翼在窗外，直接吃太阳直射（辐亮度可达 5~20），
   * 而舱内内壁只有 0.0x。两者差两个数量级，用同一套曝光必然一边死白。
   *
   * 处理办法（按优先级）：
   *   1) 降低 albedo。真实机翼涂装是浅灰（0.6~0.7 反射率），
   *      不是纯白（1.0）。之前用 0xd8dade 太亮了。
   *   2) roughness 提高。涂装是哑光的，高光应该散开而不是镜面反射。
   *   3) metalness 保持接近 0。涂装是绝缘层，金属度高的材质
   *      在没有环境贴图时会变成死黑（这也是之前机翼发暗的原因）。
   */
  const wingMat = new THREE.MeshStandardMaterial({
    color: 0x9aa0a8,
    roughness: 0.72,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  disposables.push(wingMat);

  const wingMesh = new THREE.Mesh(wingGeo, wingMat);
  wing.add(wingMesh);

  // --- 翼梢小翼（翼尖向上翘起的延伸段）---
  //
  // ── 形状为什么会变成「竖立的三角刀片」──
  // 之前直接把主翼的放样结果缩放到 40%×55% 当小翼，问题有两个：
  //   1) 主翼有 25° 后掠 + 3° 扭转，缩放到小翼尺度后这些角度被放大成
  //      一个尖锐的三角轮廓；
  //   2) 45° 上翘叠加后，从舷窗看过去正好是「侧对」的姿态，
  //      整个小翼摊开成一个平面三角形。
  //
  // 真实翼梢小翼（比如 737 NG 的融合式小翼）看起来是：
  //   - 短而钝，弦长只有翼尖的 40~50%
  //   - 上翘角约 60~75°，但因为本身有厚度，视觉上是有体积的
  //   - 前缘圆润，不会形成尖角
  //
  // 所以这里改用**专门的放样参数**重新生成小翼，而不是缩放主翼：
  // 去掉后掠、去掉扭转，用更小的厚度比。
  const wingletGeo = (() => {
    const spanStations = 8;
    const chordStations = 18;
    const ringLen = chordStations * 2;
    const positions: number[] = [];
    const indices: number[] = [];
    const rings: Array<Array<[number, number, number]>> = [];

    const wlSpan = 0.62; // 小翼展长
    const wlChordRoot = WING_CHORD_ROOT * TAPER_RATIO * 1.15; // 接翼尖处的弦长
    const wlTaper = 0.72; // 小翼自身收缩（比主翼平缓，显得钝）
    const wlThick = 0.075; // 厚度比，比主翼薄

    for (let s = 0; s <= spanStations; s++) {
      const t = s / spanStations;
      const chord = wlChordRoot * (1 - (1 - wlTaper) * t);
      const ring: Array<[number, number, number]> = [];

      for (let c = 0; c <= chordStations; c++) {
        const u = (1 - Math.cos((c / chordStations) * Math.PI)) * 0.5;
        const yt = nacaThickness(u, wlThick);
        ring.push([t * wlSpan, yt * chord, u * chord]);
      }
      for (let c = chordStations - 1; c > 0; c--) {
        const u = (1 - Math.cos((c / chordStations) * Math.PI)) * 0.5;
        const yt = nacaThickness(u, wlThick);
        ring.push([t * wlSpan, -yt * chord, u * chord]);
      }
      rings.push(ring);
    }

    for (let s = 0; s < spanStations; s++) {
      for (let c = 0; c < ringLen; c++) {
        const c2 = (c + 1) % ringLen;
        const a = s * ringLen + c;
        const b = s * ringLen + c2;
        const d = (s + 1) * ringLen + c;
        const e = (s + 1) * ringLen + c2;
        indices.push(a, d, b, b, d, e);
      }
    }
    for (const ring of rings) for (const [px, py, pz] of ring) positions.push(px, py, pz);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    return g;
  })();
  disposables.push(wingletGeo);

  const winglet = new THREE.Mesh(wingletGeo, wingMat);
  const tipX = WING_SPAN;
  const tipY = Math.tan(DIHEDRAL) * tipX;
  // 小翼的本地 +X 是展向（向上翘之前），所以放在翼尖后绕 Z 轴上翘
  winglet.position.set(tipX, tipY, Math.tan(SWEEP) * tipX);
  // 60° 上翘，接近 737 NG 的融合式小翼
  winglet.rotation.z = (60 * Math.PI) / 180;
  wing.add(winglet);

  // =========================================================================
  // 2b. 发动机短舱
  //
  // 从舷窗看机翼，发动机是最有辨识度的部件。
  // 用 LatheGeometry 车削一个「进气道 + 涵道 + 尾锥」的轮廓，
  // 比用圆柱体自然得多。
  // =========================================================================

  const nacelleProfile: THREE.Vector2[] = [];
  {
    /**
     * 短舱轮廓（半径, 轴向位置）。
     * 顺序从进气口前缘开始，沿外表面到尾部。
     * 真实涡扇短舱的特征：
     *   - 进气口唇缘略微内收（半径最小）
     *   - 中段最粗（风扇罩）
     *   - 尾部收敛成喷口
     *
     * ── 尺寸要跟翼展成比例 ──
     * 真实 737：短舱直径约 2.2 m、单侧翼展约 17 m → 直径/翼展 ≈ 0.13。
     * 本项目翼展 3.0 m，所以短舱直径应该在 0.4 m 左右（半径 0.2）。
     * 之前用 0.68 的半径（直径 1.36 m），相对翼展 3 m 显得像一根粗筒，
     * 完全不像发动机。
     */
    /**
     * ── 轮廓必须闭合，否则能看到空腔 ──
     * LatheGeometry 只是把一条折线绕轴旋转，生成的是**开放曲面**。
     * 之前只给了外表面（从进气口到尾锥），结果从侧面看过去
     * 短舱像一个「空心圆环」，能直接看到内壁 —— 非常出戏。
     *
     * 修正：把轮廓做成闭合的截面 —— 从中心轴出发绕一圈再回来。
     * 这样旋转后得到的是实心回转体，两端自动封闭。
     *
     * 路径：轴心 → 外表面（进气口到尾锥）→ 回到轴心。
     * 注意首尾两点半径都是 0（落在轴上），Lathe 会把它们收成尖点。
     */
    const pts: Array<[number, number]> = [
      [0.000, 0.00], // 轴心（进气口中心，封口）
      [0.235, 0.00], // 进气口唇缘
      [0.272, 0.14],
      [0.300, 0.32],
      [0.310, 0.56], // 最粗处（风扇罩）
      [0.300, 0.82],
      [0.272, 1.08],
      [0.236, 1.30],
      [0.200, 1.48],
      [0.172, 1.62], // 尾锥末端
      [0.000, 1.62], // 回到轴心（尾端封口）
    ];
    for (const [r, z] of pts) nacelleProfile.push(new THREE.Vector2(r, z));
  }

  const nacelleGeo = new THREE.LatheGeometry(nacelleProfile, 24);
  // Lathe 默认绕 Y 轴，转成沿 Z 轴（与机翼弦向一致）
  nacelleGeo.rotateX(Math.PI / 2);
  disposables.push(nacelleGeo);

  const nacelleMat = new THREE.MeshStandardMaterial({
    // 短舱和机翼同一套涂装，但金属件更多，roughness 略低一点
    color: 0x9298a0,
    roughness: 0.62,
    metalness: 0.06,
    side: THREE.DoubleSide,
  });
  disposables.push(nacelleMat);

  const nacelle = new THREE.Mesh(nacelleGeo, nacelleMat);
  // 挂在机翼下方约 1/4 翼展处（真实布局：内侧发动机）
  const nacelleT = 0.24;
  const nacelleX = nacelleT * WING_SPAN;
  /**
   * 短舱相对机翼的下沉量。
   *
   * 约束：短舱是半径 0.31 的圆柱，要挂在机翼**下方**而不是嵌进去。
   * 所以下沉量必须 ≥ 短舱半径 + 机翼半厚度，否则短舱上半部分
   * 会穿进翼面里，从上方看就像一个嵌在翼面上的圆环。
   *
   *   机翼半厚度 ≈ 0.14 × 1.2 / 2 ≈ 0.084
   *   短舱半径   ≈ 0.31
   *   → 下沉量至少 0.39
   *
   * 取 0.42，留一点吊挂的间隙，视觉上才像「挂在下面」。
   */
  const nacelleDrop = 0.42;
  nacelle.position.set(
    nacelleX,
    Math.tan(DIHEDRAL) * nacelleX - nacelleDrop,
    /**
     * ── 弦向位置必须落在机翼前缘之后 ──
     * 之前这里写了 `- 0.45`，把短舱整个推到机翼前缘之外，
     * 结果短舱悬在空中、和机翼之间出现明显缺口 ——
     * 看起来就是「机翼断开了」（用户截图里圈出的那块）。
     *
     * 真实布局：短舱进气口略微伸出机翼前缘，但主体在机翼下方，
     * 由吊挂与机翼相连。机翼前缘在本地 z≈0（弦向从 0 到 chord），
     * 所以短舱起点应该接近 0，最多往前伸一点点。
     */
    Math.tan(SWEEP) * nacelleX - 0.05,
  );
  wing.add(nacelle);

  // --- 吊挂（pylon）：连接机翼与短舱的整流罩 ---
  //
  // 吊挂的作用是「把短舱和机翼连起来」。所以它的 z 必须和短舱一致，
  // 高度则要跨越「机翼下表面 → 短舱上表面」这一段。
  //
  // ── 为什么不用 BoxGeometry ──
  // 方盒子在机翼下方会显得非常生硬，像粘了一块砖。
  // 真实吊挂是流线型整流罩：前缘圆润、向后收细。
  // 这里用一个「上宽下窄、前后收尖」的梯形棱柱来近似 ——
  // 用 BufferGeometry 手动构建，8 个顶点足够。
  const pylonGeo = (() => {
    // 吊挂尺寸：宽（弦向）× 高（竖直）× 厚（展向）
    const pChord = 0.46; // 弦向长度
    const pHeight = nacelleDrop * 1.05;
    const pThick = 0.075;
    // 上端（贴机翼）比下端（贴短舱）宽，形成流线过渡
    const topChord = pChord;
    const botChord = pChord * 0.72;

    // 8 个顶点：上下各 4 个（前/后 × 左/右）
    const hw = pThick / 2;
    const yTop = 0;
    const yBot = -pHeight;
    const v = [
      // 上端（y = 0）
      [0, yTop, -topChord * 0.5], // 上前
      [hw, yTop, -topChord * 0.18],
      [hw, yTop, topChord * 0.42],
      [0, yTop, topChord * 0.5], // 上后
      // 下端（y = -height）
      [0, yBot, -botChord * 0.5], // 下前
      [hw, yBot, -botChord * 0.18],
      [hw, yBot, botChord * 0.42],
      [0, yBot, botChord * 0.5], // 下后
    ];
    // 镜像出另一侧（x 取负）
    const verts: number[] = [];
    for (const [x, y, z] of v) verts.push(x, y, z);
    for (const [x, y, z] of v) verts.push(-x, y, z);

    const idx = [
      // 上端封盖
      0, 1, 2, 0, 2, 3,
      8, 10, 9, 8, 11, 10,
      // 下端封盖
      4, 6, 5, 4, 7, 6,
      12, 13, 14, 12, 14, 15,
      // 四个侧面
      0, 4, 5, 0, 5, 1, // 左侧前
      1, 5, 6, 1, 6, 2, // 右侧
      2, 6, 7, 2, 7, 3, // 左侧后
      3, 7, 4, 3, 4, 0, // 前面
      8, 9, 13, 8, 13, 12,
      9, 10, 14, 9, 14, 13,
      10, 11, 15, 10, 15, 14,
      11, 8, 12, 11, 12, 15,
    ];

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  })();
  disposables.push(pylonGeo);

  const pylon = new THREE.Mesh(pylonGeo, nacelleMat);
  pylon.position.set(
    nacelleX,
    // 位于机翼下表面与短舱上表面之间
    Math.tan(DIHEDRAL) * nacelleX - nacelleDrop * 0.52,
    // 与短舱同一弦向位置
    Math.tan(SWEEP) * nacelleX - 0.05,
  );
  wing.add(pylon);

  // ── 机翼的摆放（舷窗视角的关键）──
  //
  // ── 之前错在哪 ──
  // 放样出来的机翼：翼展沿 +X（3.0 m）、弦向沿 Z（1.76 m）。
  // 而舷窗的视线沿 -Z。也就是说翼展方向与视线垂直、
  // 弦向朝着观者 —— 看到的是机翼的**侧剖面**（一条横刀），
  // 发动机短舱也正对着镜头。
  //
  // 真实舷窗视角完全不同：
  //   - 你坐在机身侧面，视线垂直于机身轴线
  //   - 机翼从你脚下的机身伸出，**朝远离你的方向（-Z）延伸**
  //   - 所以你看到的是机翼的**上表面**，且带很强的透视收缩
  //   - 发动机在机翼下方，你只能看到它的侧面/顶面
  //
  // ── 修正 ──
  // 把整个机翼组绕 Y 轴转 -90°，让翼展轴从 +X 转到 -Z：
  //   rotateY(-90°) 把 +X 映射到 +Z，所以用 +90° 把 +X 映射到 -Z。
  // 转完之后：
  //   - 翼展 → -Z（伸向远方，符合舷窗视角）
  //   - 弦向 → +X（沿机身，即飞行方向）
  // 再叠一点俯角，让你能俯视到翼面。
  wing.rotation.set(
    // 绕 X 轴：让机翼整体向下俯一点，露出上表面
    -0.10,
    // 绕 Y 轴：把翼展从 +X 转到 -Z（这是最关键的一步）
    Math.PI / 2,
    // 绕 Z 轴：上反角在旋转后会变成「翼尖向上翘」
    0,
  );

  // ── 位置按投影反推（NDC 实测校准）──
  //
  // 迭代记录：
  //   第 1 轮 → NDC x=0.46~1.29（全在窗框外）
  //   第 2 轮 → NDC x=0.12~0.68（仍偏右）
  //   第 3 轮 → 翼根 x=0.03、翼尖 x=0.22
  //            ← 整片机翼只占屏幕 x∈[0.03,0.22]，
  //              翼根没伸到窗洞左边界（约 -0.35）之外，
  //              所以看起来像「悬在空中被切断」。
  //   第 4 轮 → 翼根 x=-0.40（正确伸出窗外）、翼尖 x=0.04
  //            ← 翼根对了，但翼尖只到 0.04，机翼在画面里太小
  //
  // 本轮：保持翼根位置，把缩放从 0.55 提到 0.85 让机翼铺开，
  // 同时略微下移，让翼面落在窗洞下半而不是贴着地平线。
  wing.position.set(
    -3.75, // 横向：翼根伸出窗洞左边界（由 NDC 校准）
    -0.75, // 垂直：下移，翼面在窗洞下半
    -3.2, // 纵深
  );
  /**
   * 整体缩放。
   *
   * 真实舷窗视角里，机翼横跨窗口下半部，从窗框左侧一直延伸到右侧外。
   * 0.55 时翼尖只到 NDC x=0.04（机翼缩在左边一小块），
   * 提到 0.85 才能铺开到窗洞右缘。
   */
  wing.scale.setScalar(0.85);
  root.add(wing);

  // =========================================================================
  // 3. 光照
  //
  // 关键：窗外极亮（太阳直射 + 大气散射），舱内极暗。
  // 所以主光从窗外打进来，另加一个很弱的填充光模拟舱内漫反射。
  // =========================================================================

  // 主光：从窗外（-z）射入，稍微偏上偏左，模拟太阳
  const keyLight = new THREE.DirectionalLight(0xfff0dd, 2.4);
  keyLight.position.set(-0.4, 0.9, -3.0);
  keyLight.target.position.set(0, 0, 0);
  root.add(keyLight);
  root.add(keyLight.target);

  // 补光：舱内漫反射（很弱，偏冷）
  const fillLight = new THREE.AmbientLight(0x2a3550, 0.35);
  root.add(fillLight);

  // 轮廓光：让内壁边缘有一点分离感
  const rimLight = new THREE.DirectionalLight(0xaabbdd, 0.25);
  rimLight.position.set(1.5, -1.0, 1.0);
  root.add(rimLight);

  /**
   * 窗口光（关键）。
   *
   * 为什么还需要它：AmbientLight 是各向同性的，它只把内壁整体提亮，
   * 不产生任何明暗过渡 —— 结果就是「一块均匀的深灰」，看起来像塑料板。
   *
   * 真实机舱里，内壁靠近窗洞的部分会被窗外光强烈照亮，
   * 越远离窗口越暗（光衰减 + 遮挡）。用一个放在窗外的
   * 点光源就能得到这个梯度，成本极低但效果差别很大。
   *
   * 放在 z = -0.25（窗外一点），并给一个较大的衰减距离，
   * 这样整个内壁都会有一点方向性，而不是只有窗边。
   */
  const windowLight = new THREE.PointLight(0x9fc0e8, 0.9, 6.0, 1.4);
  windowLight.position.set(0, 0, -0.35);
  root.add(windowLight);

  return {
    root,
    wall,
    wing,
    keyLight,
    fillLight,
    rimLight,
    windowLight,
    dispose() {
      wallGeo.dispose();
      wallMat.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
