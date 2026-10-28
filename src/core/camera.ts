/**
 * 相机装置（Camera Rig）
 *
 * 复刻原站的观测方式：人坐在舷窗旁，相机不能自由飞行，只能：
 *   - 微小平移（cm 级）
 *   - 微小旋转（度级）
 *   - 手抖（多正弦叠加）
 *   - 鼠标视差
 *
 * 关键设计：所有运动都是「指数阻尼逼近目标值」，不用线性插值。
 * 这样无论帧率多少，收敛手感都一致 —— 原站全站都是这个套路。
 *
 * 坐标系约定：
 *   世界坐标：球心为原点，单位 km（与 shader 一致）。
 *   站点切空间：east / north / up 三个正交单位向量。
 *   局部偏移量用「米」表达（因为 UI 上 cm 更直观），进世界前统一 /1000。
 */

import * as THREE from 'three';
import * as C from '../config';

/** 平滑逼近（帧率无关） */
function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/** 三正弦叠加，模拟手抖 —— 原站同名函数 */
function shake(t: number, freq: number): number {
  return (
    0.55 * Math.sin(t * 0.31 * freq + 1.3) +
    0.3 * Math.sin(t * 0.77 * freq + 4.1) +
    0.15 * Math.sin(t * 1.93 * freq + 0.7)
  );
}

const DEG2RAD = Math.PI / 180;

export type RigParams = {
  row: number;
  hublot: boolean;
  px: number;
  py: number;
  pd: number;
  yaw: number;
  pitch: number;
  turbulence: number;
};

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  /** 鼠标位置（-1..1） */
  private pointer = { x: 0, y: 0 };
  /** 阻尼后的鼠标位置 */
  private pointerSmooth = { x: 0, y: 0 };

  /** 当前相机世界位置（km，球心原点） */
  readonly worldPos = new THREE.Vector3();

  /** 站点处的东/北/上基向量 */
  private siteEast = new THREE.Vector3();
  private siteNorth = new THREE.Vector3();
  private siteUp = new THREE.Vector3();

  /**
   * 舷窗参考坐标系（yaw = 0 / pitch = 0）。
   *
   * forward = 视线方向（水平），right = 屏幕右方，up = 天顶。
   * 太阳方向用它映射到世界：这样「太阳相对画面在哪」只由 yaw/azimuth 决定，
   * 不受地理位置影响 —— 原站就是这么做的。
   */
  private refForward = new THREE.Vector3();
  private refRight = new THREE.Vector3();

  /** 阻尼后的局部偏移（米） */
  private localOffset = new THREE.Vector3();
  /** 阻尼后的基准角度（弧度） */
  private yawRad = 0;
  private pitchRad = 0;

  /** 地平线下俯角（弧度）。10 km 高空约 3.27°。 */
  private readonly horizonDrop: number;

  // 复用对象，避免每帧分配
  private readonly _tmpDir = new THREE.Vector3();
  private readonly _tmpRight = new THREE.Vector3();
  private readonly _tmpUp = new THREE.Vector3();
  private readonly _tmpBack = new THREE.Vector3();
  private readonly _tmpMat = new THREE.Matrix4();
  private readonly _tmpQuat = new THREE.Quaternion();
  /** 参考姿态（yaw=0, pitch=0）：机舱就按这个姿态摆放 */
  private readonly _refQuat = new THREE.Quaternion();
  /** 机舱偏移计算的临时向量（与 _tmpDir 分开，避免互相踩） */
  private readonly _cabinOffset = new THREE.Vector3();

  constructor() {
    // 近/远裁面按「机舱尺度」设定，而不是天空尺度。
    //
    // 为什么不用原站那种 near 0.02 / far 2e5：
    // 深度比达到 1e7 时，WebGL 的深度缓冲精度会在机舱这种
    // 「几厘米到几米」的尺度上完全崩掉，窗框和机翼会疯狂 z-fighting。
    //
    // 这里的做法是把职责分开：
    //   - 天空：全屏三角形，不写深度，压根不参与深度比较
    //   - 机舱：只需要 0.02 ~ 500 m 的范围，深度精度绰绰有余
    this.camera = new THREE.PerspectiveCamera(
      C.CAMERA_FOV_CABIN,
      1,
      C.CAMERA_NEAR,
      C.CAMERA_FAR_CABIN,
    );

    // --- 站点基向量 ---
    const lat = C.SITE_LAT * DEG2RAD;
    const lon = C.SITE_LON * DEG2RAD;
    this.siteUp
      .set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon))
      .normalize();
    this.siteNorth
      .set(-Math.sin(lat) * Math.cos(lon), Math.cos(lat), -Math.sin(lat) * Math.sin(lon))
      .normalize();
    // east = up × north
    //
    // ── 这里曾经写反了 ──
    // 原来是 north × up，得到的是**西**不是东（在赤道本初子午线上算一下：
    // north=(0,1,0), up=(1,0,0)，north×up=(0,0,-1)，而东应该是 +z）。
    // 后果是整个地理坐标系变成左手的：太阳方位东西颠倒、px 平移方向也反了。
    // 因为机舱和相机都建在同一套错坐标里，画面自洽，所以一直没暴露；
    // 一旦把太阳和真实方位对齐就会立刻出错。
    this.siteEast.crossVectors(this.siteUp, this.siteNorth).normalize();

    // 舷窗参考系：yaw = 0 时看向正北（水平），屏幕右方 = forward × up
    this.refForward.copy(this.siteNorth);
    this.refRight.crossVectors(this.refForward, this.siteUp).normalize();

    // --- 地平线下俯角 ---
    const R = C.EARTH_RADIUS_KM;
    const h = C.CRUISE_ALTITUDE_KM;
    this.horizonDrop = Math.acos(R / (R + h));
  }

  getSiteUp(): THREE.Vector3 {
    return this.siteUp;
  }
  getSiteNorth(): THREE.Vector3 {
    return this.siteNorth;
  }
  getSiteEast(): THREE.Vector3 {
    return this.siteEast;
  }

  /** 舷窗参考系（yaw=0/pitch=0）：forward 水平朝前，right 屏幕右方，up 天顶 */
  getReferenceForward(): THREE.Vector3 {
    return this.refForward;
  }
  getReferenceRight(): THREE.Vector3 {
    return this.refRight;
  }

  /**
   * 相机相对机舱坐标原点的偏移（米）。
   * 机舱本地轴约定：
   *   x = 沿机身（座位排方向）
   *   y = 上下
   *   z = 朝窗外（three 相机看 -Z，所以窗在 -z）
   */
  getLocalOffset(): THREE.Vector3 {
    return this.localOffset;
  }

  /**
   * 摆放机舱。
   *
   * ── 为什么机舱不能挂在相机下 ──
   * 如果机舱是相机的子节点，那么转动头部时窗框会跟着一起转，
   * 永远停在屏幕的同一位置 —— 那是「贴在脸上的贴纸」，不是窗。
   * 窗必须固定在意向坐标系里，转头时它才会在视野里移动。
   *
   * ── 正确做法：用「参考姿态」定义意向坐标系 ──
   * 定义：yaw = 0 且 pitch = 0 时相机看向的方向，就是「正对窗外的方向」。
   * 于是把机舱按这个参考姿态摆放，窗洞（本地 -Z）就正好在参考视线上。
   * 之后相机的 yaw/pitch 就是「相对窗的偏转」，转头时窗自然滑动。
   *
   * 这比手写 siteEast/North/Up 基向量矩阵更不容易出错：
   * 参考姿态直接复用了相机自己的朝向构造逻辑，两者永远一致。
   */
  applyCabinTransform(cabinRoot: THREE.Object3D, seatOffset: THREE.Vector3) {
    // 1) 参考姿态 = yaw 0 / pitch 0 时的相机朝向
    this.computeOrientation(0, 0, this._refQuat);

    // 2) 机舱的世界朝向 = 参考姿态
    cabinRoot.quaternion.copy(this._refQuat);

    // 3) 机舱反向平移：把「座位在机舱里的位置」从原点挪开。
    //    注意 computeOrientation 会占用 _tmpDir，所以这里用一个独立向量。
    const p = this._cabinOffset
      .copy(seatOffset)
      .multiplyScalar(-1)
      .applyQuaternion(this._refQuat);
    cabinRoot.position.copy(p);
  }

  /** 计算给定 yaw/pitch 下的相机朝向（不含平滑） */
  private computeOrientation(yaw: number, pitch: number, out: THREE.Quaternion) {
    const dir = this._tmpDir
      .copy(this.siteNorth)
      .applyAxisAngle(this.siteUp, -yaw)
      .applyAxisAngle(this.siteEast, pitch - this.horizonDrop)
      .normalize();

    const right = this._tmpRight.crossVectors(dir, this.siteUp);
    if (right.lengthSq() < 1e-10) right.crossVectors(dir, this.siteEast);
    right.normalize();
    const up = this._tmpUp.crossVectors(right, dir).normalize();

    this._tmpMat.makeBasis(right, up, this._tmpBack.copy(dir).negate());
    out.setFromRotationMatrix(this._tmpMat);
    return out;
  }

  get altitudeKm(): number {
    return C.CRUISE_ALTITUDE_KM;
  }

  /** 视野中心相对地平线的俯角（度），调试用 */
  get horizonDropDeg(): number {
    return this.horizonDrop / DEG2RAD;
  }

  onPointerMove(nx: number, ny: number) {
    this.pointer.x = nx;
    this.pointer.y = ny;
  }

  onPointerLeave() {
    this.pointer.x = 0;
    this.pointer.y = 0;
  }

  /** 立即到位（初始化 / 重置时用） */
  reset(p: RigParams) {
    const target = this.computeTarget(p);
    this.localOffset.copy(target.offset);
    this.yawRad = target.yaw;
    this.pitchRad = target.pitch;
    this.pointerSmooth.x = this.pointer.x;
    this.pointerSmooth.y = this.pointer.y;
    this.apply(0, 1, p);
    // 一次性对齐，不要 slerp 残留
    this.camera.quaternion.copy(this._tmpQuat);
  }

  /**
   * 由座位排数与用户微调，算出舷窗坐标系下的偏移与朝向。
   * 偏移单位：米。角度单位：弧度。
   */
  private computeTarget(p: RigParams) {
    // 座位排数 → 沿机身偏移（每排约 0.8 m）
    const rowOffsetM = (p.row - C.ROW_DEFAULT) * 0.8;
    const x = rowOffsetM + p.px * 0.01;
    const y = p.py * 0.01;
    const z = p.pd * 0.01;

    // 「框景」模式贴近窗玻璃、视线居中。REV: pane 模式 lookAt 为 3°/3°
    const yawDeg = p.hublot ? p.yaw : 3;
    const pitchDeg = p.hublot ? p.pitch : 3;

    return {
      offset: new THREE.Vector3(x, y, z),
      yaw: yawDeg * DEG2RAD,
      pitch: pitchDeg * DEG2RAD,
    };
  }

  /**
   * 每帧更新。
   * @param t   累计时间（秒）
   * @param dt  帧间隔（秒）
   */
  update(t: number, dt: number, p: RigParams) {
    const target = this.computeTarget(p);
    const lambda = 3.0;

    this.localOffset.x = damp(this.localOffset.x, target.offset.x, lambda, dt);
    this.localOffset.y = damp(this.localOffset.y, target.offset.y, lambda, dt);
    this.localOffset.z = damp(this.localOffset.z, target.offset.z, lambda, dt);

    this.yawRad = damp(this.yawRad, target.yaw, lambda, dt);
    this.pitchRad = damp(this.pitchRad, target.pitch, lambda, dt);

    // 鼠标阻尼稍慢，产生惯性
    const pLambda = 2.2;
    this.pointerSmooth.x = damp(this.pointerSmooth.x, this.pointer.x, pLambda, dt);
    this.pointerSmooth.y = damp(this.pointerSmooth.y, this.pointer.y, pLambda, dt);

    this.apply(t, dt, p);
  }

  private apply(t: number, dt: number, p: RigParams) {
    // 世界坐标（km）：球面基点 + 切空间偏移（米 → km）
    const radiusKm = C.EARTH_RADIUS_KM + C.CRUISE_ALTITUDE_KM;
    const pos = this.worldPos;
    pos
      .copy(this.siteUp)
      .multiplyScalar(radiusKm)
      .addScaledVector(this.siteEast, this.localOffset.x * 0.001)
      .addScaledVector(this.siteNorth, this.localOffset.y * 0.001)
      .addScaledVector(this.siteUp, this.localOffset.z * 0.001);

    // --- 手抖（km 量级，很小）---
    const amp = 0.0012 * p.turbulence;
    pos.addScaledVector(this.siteEast, shake(t, 1.0) * amp);
    pos.addScaledVector(this.siteNorth, shake(t + 20, 0.6) * amp * 0.7);
    pos.addScaledVector(this.siteUp, shake(t + 40, 1.3) * amp);

    // --- 视线方向 ---
    // 起点正北；先绕 up 轴转 yaw（负角 = 向东），再绕 east 轴俯仰。
    // 最终还要减去地平线下俯角，这样「pitch = 0」时视线正好落在几何地平线上。
    // 鼠标视差直接叠加到角度上。
    const yawTotal = this.yawRad - this.pointerSmooth.x * 0.14;
    const pitchTotal = this.pitchRad - this.pointerSmooth.y * 0.09;

    // 复用参考姿态用的同一套朝向构造，保证机舱对齐与相机朝向永远一致
    this.computeOrientation(yawTotal, pitchTotal, this._tmpQuat);

    // 平滑。用 slerp 避免鼠标抖动生硬；dt 大时也稳定。
    const k = 1 - Math.exp(-9 * Math.min(dt, 0.1));
    this.camera.quaternion.slerp(this._tmpQuat, k);
    this.camera.position.set(0, 0, 0);
    this.camera.updateMatrixWorld();
  }
}
