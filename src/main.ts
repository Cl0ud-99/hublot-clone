/**
 * 入口
 *
 * 架构非常扁平，因为没有场景图：
 *   一个全屏三角形（天空/地面/大气）+ 相机装置 + 参数面板 + 音频
 *
 * WebGL2 不可用时给出可读提示，而不是白屏。
 */

import * as THREE from 'three';
import * as C from './config';
import { SkyRenderer } from './core/sky';
import { CameraRig } from './core/camera';
import { PerformanceAdaptor } from './core/perf';
import { CabinAudio } from './core/audio';
import { createCabin, seatOffsetForRow } from './core/cabin';
import { PostPipeline } from './core/post';
import { computeSun, sunIrradiance, sunDirectionInWindowFrame, autoExposureEV, formatHour } from './core/sun';
import { createPane } from './core/pane';

const app = document.getElementById('app');

/**
 * 能力检测。之所以要检测而不是直接 try/catch，是因为某些环境
 * 会返回一个「能创建但一用就崩」的上下文。
 */
function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    // 释放上下文，避免占用
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

if (!app) {
  throw new Error('#app not found');
} else if (!hasWebGL2()) {
  app.innerHTML =
    '<div id="fallback">This demo needs WebGL2.<br/>请使用新版 Chrome / Edge / Safari / Firefox。</div>';
} else {
  main(app);
}

function main(root: HTMLElement) {
  // -------------------------------------------------------------------------
  // 渲染器
  // -------------------------------------------------------------------------

  const renderer = new THREE.WebGLRenderer({
    // 机舱有真实几何（内壁开孔 + 机翼），需要深度测试来正确遮挡。
    // 但全屏的天空三角形本身不参与深度（shader 里设了 depthWrite:false），
    // 所以不会出现 z-fighting。
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
    preserveDrawingBuffer: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // ── 色调映射交给后期管线统一做 ──
  // 这里必须保持 NoToneMapping。原因：
  //   机舱用 MeshStandardMaterial，three 会按 renderer.toneMapping
  //   自动给它的 shader 注入 tonemapping_fragment。
  //   但现在场景是先渲染到 HDR 缓冲，再由 composite.frag 统一做
  //   ACES + sRGB。如果这里开着 ACES，机舱会被压缩两次，
  //   而天空（原生 ShaderMaterial，three 不注入）只被压缩一次 ——
  //   结果就是「天空亮、机舱暗」的撕裂。
  //
  //   正确做法：渲染进 HDR 时全部关闭，post.render() 内部会临时
  //   覆盖这两个设置，出屏由 composite.frag 统一处理。
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x000000, 1);
  root.appendChild(renderer.domElement);

  // -------------------------------------------------------------------------
  // 内容
  // -------------------------------------------------------------------------

  const scene = new THREE.Scene();
  // 天空渲染器需要在构造时生成多重散射 LUT（几个 32×32 的 GPU pass）
  const sky = new SkyRenderer(renderer);
  // 天空先渲染，且不写深度（材质里设了 depthWrite:false），
  // 机舱随后正常绘制并遮挡它，窗洞自然透出天空。
  sky.mesh.renderOrder = -1000;
  scene.add(sky.mesh);

  // 把硬件支持的最大各向异性过滤传给机舱：
  // 机翼面板纹理在掠射角下完全依赖它才能保持清晰
  const cabin = createCabin(renderer.capabilities.getMaxAnisotropy());
  const { keyLight, fillLight, rimLight, windowLight, skyLight } = cabin;

  const rig = new CameraRig();

  // 机舱固定在场景里（**不能**挂到相机下，否则转头时窗框会跟着转）。
  // 相机恒定在原点，所以「相机在舱内的位置」通过反向平移机舱来实现，
  // 具体由 rig.applyCabinTransform() 每帧计算。
  scene.add(cabin.root);

  const audio = new CabinAudio();
  const perf = new PerformanceAdaptor(2); // medium 起步

  // 开发期调试钩子：在控制台里可以直接访问场景对象，
  // 排查「几何在哪、有没有被裁掉、包围盒多大」这类问题非常有用。
  // 生产构建时 import.meta.env.DEV 为 false，会被 tree-shake 掉。
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__hublot = { renderer, scene, cabin, rig, sky };
  }

  // HDR + bloom 后期管线
  const post = new PostPipeline(renderer);
  // 调试：?debugBloom=1 直接看 bloom 缓冲
  post.debugBloom = new URLSearchParams(location.search).get('debugBloom') === '1';

  let params: C.Params = C.readParamsFromUrl();

  // 让相机第一帧就在正确位置，避免开场有一次明显的位移
  rig.reset(params);

  // -------------------------------------------------------------------------
  // 尺寸与分辨率自适应
  // -------------------------------------------------------------------------

  const canvas = renderer.domElement;

  function resize() {
    const w = root.clientWidth || window.innerWidth;
    const h = root.clientHeight || window.innerHeight;

    // tier 的 dprScale 已经是「相对 CSS 像素的倍率」
    const requested = perf.tier.dprScale;
    // 但不超过设备真实 DPR 的 2 倍，避免 3x 屏上过度渲染
    const deviceMax = Math.min(window.devicePixelRatio || 1, 2);
    const ratio = Math.max(0.5, Math.min(requested, deviceMax));

    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, true);

    // ── 相机宽高比 ──
    // 这一步绝对不能省。PerspectiveCamera 的 aspect 默认是 1，
    // 如果不更新，投影矩阵就按 1:1 算，机舱几何会被横向拉伸
    // （1400×900 的视口会拉宽 1.56 倍，舷窗从竖长变成横宽）。
    //
    // 注意天空不受影响：它走的是全屏着色器里的 uResolution，
    // 自己算 aspect。所以漏掉这一行会出现「天空正确、机舱拉伸」的
    // 割裂现象 —— 正是这个 bug 的典型症状。
    rig.camera.aspect = w / h;
    rig.camera.updateProjectionMatrix();

    // shader 里需要「实际像素」尺寸来算 pixelAngle
    sky.setResolution(w * ratio, h * ratio);

    // 后期管线按实际像素尺寸重建所有 RT
    post.setSize(w * ratio, h * ratio);
  }

  perf.onChange = () => {
    resize();
    sky.setQuality(perf.tier.skySteps);
  };

  resize();
  window.addEventListener('resize', resize);
  // 移动端旋转屏幕时 resize 可能滞后
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));

  // -------------------------------------------------------------------------
  // 交互
  // -------------------------------------------------------------------------

  canvas.addEventListener('pointermove', (e) => {
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = (e.clientY / window.innerHeight) * 2 - 1;
    rig.onPointerMove(nx, ny);
  });
  canvas.addEventListener('pointerleave', () => rig.onPointerLeave());
  canvas.addEventListener('pointercancel', () => rig.onPointerLeave());

  // --- 音频解锁：必须在用户手势里 ---
  let audioStarted = false;
  const unlockAudio = async () => {
    if (audioStarted || !params.sound) return;
    audioStarted = true;
    const ok = await audio.start(params.volume);
    if (!ok) audioStarted = false;
  };
  (['pointerdown', 'keydown', 'touchstart'] as const).forEach((ev) => {
    window.addEventListener(ev, unlockAudio, { passive: true });
  });

  // -------------------------------------------------------------------------
  // 参数面板
  // -------------------------------------------------------------------------

  const pane = createPane(params, perf.tierIndex, {
    onChange: (patch) => {
      // 注意：必须就地修改，不能重新赋值。
      // tweakpane 持有的是 params 这个对象的引用，一旦换成新对象，
      // 面板后续的编辑就全写到旧对象上，界面看起来「没反应」。
      Object.assign(params, patch);

      if (patch.sound !== undefined) {
        if (patch.sound) {
          void audio.start(params.volume).then((ok) => {
            audioStarted = ok;
          });
        } else {
          void audio.dispose();
          audioStarted = false;
        }
      }
      if (patch.volume !== undefined) audio.setVolume(patch.volume);
      if (patch.lowClouds !== undefined || patch.cirrus !== undefined) {
        sky.setWeather(params.lowClouds, params.cirrus);
      }
      if (patch.cities !== undefined) {
        sky.setCities(params.cities);
      }
      if (patch.debugMode !== undefined) {
        sky.setDebugMode(params.debugMode);
      }
    },
    onQuality: (index) => {
      perf.lockTo(index);
      resize();
      sky.setQuality(perf.tier.skySteps);
    },
    onReset: () => {
      // 清掉 URL 参数后重载，回到默认状态
      history.replaceState(null, '', location.pathname);
      location.reload();
    },
  });

  sky.setWeather(params.lowClouds, params.cirrus);
  sky.setCities(params.cities);
  sky.setDebugMode(params.debugMode);
  sky.setQuality(perf.tier.skySteps);

  // 按 H 隐藏面板
  window.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H') {
      const el = pane.element;
      el.style.display = el.style.display === 'none' ? '' : 'none';
    }
  });

  // -------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------

  const chipFps = document.getElementById('chip-fps');
  const chipScale = document.getElementById('chip-scale');
  const chipTime = document.getElementById('chip-time');
  let hudTimer = 0;

  function updateHud(dt: number) {
    hudTimer += dt;
    if (hudTimer < 0.2) return;
    hudTimer = 0;
    if (chipFps) chipFps.innerHTML = `<b>${perf.fps.toFixed(0)}</b> fps`;
    if (chipScale) chipScale.textContent = `${perf.tier.name} · ${perf.tier.dprScale.toFixed(2)}x`;
    if (chipTime) chipTime.textContent = formatHour(params.hour);
  }

  // -------------------------------------------------------------------------
  // 主循环
  // -------------------------------------------------------------------------

  const clock = new THREE.Clock();
  let elapsed = 0;
  let currentHour = params.hour;

  const worldSun = new THREE.Vector3();
  /** 太阳方向在舷窗坐标系里的分量（未归一化） */
  const sunLocal = new THREE.Vector3();
  const sunColor: [number, number, number] = [1, 1, 1];
  /** 飞行位移累积量（km），驱动地表/云/灯光图案流过画面 */
  const flightOffset = new THREE.Vector2(0, 0);

  /**
   * 舷窗参考系：太阳方向以它为基准映射到世界。
   *
   * 原站的做法（逆向自 bundle）：
   *   sunDir = (cos(az-π)cos(el), sin(el), sin(az-π)cos(el))
   * 直接写在着色器的相机坐标系里，-Z 就是 yaw=0 的视线方向。
   * 所以太阳永远在舷窗正前方附近巡游，默认 yaw=-18° 把它推到画面右侧。
   */
  const refForward = rig.getReferenceForward();
  const refRight = rig.getReferenceRight();
  const up = rig.getSiteUp();

  function frame() {
    requestAnimationFrame(frame);

    const dt = Math.min(clock.getDelta(), 0.1);
    elapsed += dt;

    // --- 时间推进 ---
    if (params.play) {
      currentHour += (dt * params.speed) / 60;
      if (currentHour > C.HOUR_MAX) currentHour = C.HOUR_MIN;
      params.hour = Math.round(currentHour * 100) / 100;
    } else {
      currentHour = params.hour;
    }

    // --- 太阳方向 ---
    // 原站用固定的第 298 天（10 月 25 日）+ 时区/经度/均时差修正，
    // 得到 (el, az)；azimuth 是相对舷窗坐标系的（az-180° 映射到 -Z）。
    const sun = computeSun(currentHour);
    const [sx, sy, sz] = sunDirectionInWindowFrame(sun);
    sunLocal.set(sx, sy, sz);
    worldSun
      .copy(up)
      .multiplyScalar(sunLocal.y)
      .addScaledVector(refForward, -sunLocal.z)
      .addScaledVector(refRight, sunLocal.x)
      .normalize();

    const irr = sunIrradiance(sun.elevationDeg);
    sunColor[0] = irr[0];
    sunColor[1] = irr[1];
    sunColor[2] = irr[2];

    // --- 相机自动曝光 ---
    // 从正午到暮光，天空辐亮度跨 5 个数量级，固定曝光不可能两头都好看。
    // autoExposureEV 按太阳高度给出 EV，params.ev 是用户的手动偏移。
    const autoEV = autoExposureEV(sun.elevationDeg);
    const exposureScale = Math.pow(2, autoEV + params.ev);

    // --- 相机 ---
    rig.update(elapsed, dt, params);

    // --- 飞行位移 ---
    // 真实巡航约 900 km/h = 0.25 km/s。REV 原站用 0.21 km/s（约 756 km/h）。
    //
    // ── 方向必须是「横向」而不是「纵向」 ──
    // 舷窗在机身侧面，视线垂直于机身轴线。所以飞机前进时，
    // 地面是**从窗口一侧横向流过**的，而不是朝观者冲过来。
    //
    // 之前沿 y（屏幕纵向）累积位移，效果是地面纵向涌向镜头 ——
    // 那更像是「垂直下坠」或「镜头在往前走」，完全不是侧窗视角。
    //
    // 映射关系：飞行方向 → 屏幕横向（x）。
    flightOffset.x += dt * C.FLIGHT_SPEED_KM_S;
    // 留一点纵向漂移，模拟轻微偏航/风（很小，不影响主方向）
    flightOffset.y += dt * C.FLIGHT_SPEED_KM_S * 0.04;
    // 避免长时间运行后浮点精度退化（超过 1e5 km 就取模重置）
    if (flightOffset.x > 1e5) flightOffset.x -= 1e5;
    if (flightOffset.y > 1e5) flightOffset.y -= 1e5;
    sky.setFlightOffset(flightOffset.x, flightOffset.y);

    // --- 材质 ---
    sky.update(
      rig.camera,
      rig.worldPos,
      worldSun,
      sunColor,
      exposureScale,
      elapsed,
    );

    audio.update(params.turbulence, elapsed);

    // --- 摆放机舱 ---
    // 座位排数决定看哪一扇窗；机舱按座位位置的相反数平移。
    rig.applyCabinTransform(cabin.root, seatOffsetForRow(params.row));
    // hublot = false 时隐藏舷窗，用于「框景」模式对比
    cabin.root.visible = params.hublot;

    // --- 同步机舱光照与时间 ---
    // 窗外的亮度决定了舱内的明暗：日出前舱内很暗，白天被照亮。
    const sunAltSin = Math.sin((sun.elevationDeg * Math.PI) / 180);
    const dayness = Math.max(0, Math.min(1, (sunAltSin + 0.1) / 0.35));

    // ── 舱内照明 ──
    // 关键：即使日落后，舱内也不该是「纯黑」。
    // 真实机舱里，窗外的天光和城市灯光会照亮内壁，
    // 让墙呈现出很暗但可辨的层次（这也是「不像 CG」的细节之一）。
    //
    // 注意末尾除以 exposureScale：
    // 自动曝光把暮光整体提亮了几百倍，如果舱内灯不跟着降，
    // 内壁会直接爆成白色。除以曝光倍数后，舱内在屏幕上保持稳定亮度
    // —— 这其实也符合人眼：暗环境下瞳孔放大，舱内灯看起来差不多亮。
    const cabinScale = 1 / Math.pow(exposureScale, 1.15);
    keyLight.intensity = (0.55 + 3.0 * dayness) * cabinScale;
    keyLight.color.setRGB(1.0, 0.90 + 0.06 * dayness, 0.78 + 0.20 * dayness);
    fillLight.intensity = (0.55 + 0.45 * dayness + 0.25 * params.cabin) * cabinScale;
    // 补光偏冷蓝：模拟窗外夜空/暮光的反射
    fillLight.color.setRGB(0.42, 0.52, 0.78);
    rimLight.intensity = (0.12 + 0.3 * dayness) * cabinScale;

    // 窗口光：让内壁从窗边到远处有明暗梯度（而不是一块均匀的深灰）。
    // 强度跟着窗外亮度走 —— 白天窗外很亮，内壁被照亮得更多。
    windowLight.intensity = (0.5 + 1.6 * dayness) * cabinScale;
    /**
     * 半球光（天空/地面环境光）。
     *
     * 两个要点：
     * 1) **必须进曝光补偿**。漏掉它的话，暮光档位（exposure≈466）
     *    会把它放大 466 倍，整个画面直接爆白 —— 这个坑踩第二次了。
     * 2) 强度要跟 dayness 走，不能恒定。它模拟的是天空辐照度，
     *    暮光时天空本身暗了几百倍，机翼当然也该暗；只靠 cabinScale
     *    会让机翼在全天保持同一个亮度，那才是「假」的根源。
     */
    skyLight.intensity = (0.12 + 0.70 * dayness) * cabinScale;
    // 白天偏暖（阳光），夜间偏冷（月光/城市灯光）
    windowLight.color.setRGB(
      0.62 + 0.38 * dayness,
      0.75 + 0.18 * dayness,
      0.95 - 0.15 * dayness,
    );

    // 城市灯光也按曝光反向缩放：否则暮光曝光一提，地面会变成一片熔金。
    // 指数取 1.35（而不是 1）：城市灯是点光源，动态范围远大于天空，
    // 线性反比缩放在高曝光下仍会让「都市圈宏观辉光」铺满整个地面。
    sky.setCities(params.cities / Math.pow(exposureScale, 1.55));
    // 星星同样要抵消自动曝光（指数略小于 1，保留一点「越暗星越多」的感觉）
    sky.setStarScale(1 / Math.pow(exposureScale, 0.95));

    // --- 渲染 ---
    // 相机放在原点：世界位置由 shader 的 uCamPos 决定，
    // 这里只需要朝向矩阵正确。
    rig.camera.position.set(0, 0, 0);
    rig.camera.updateMatrixWorld();

    // ── bloom 阈值 ──
    // 注意 bloom-bright.frag 里是**先乘 uExposure 再比阈值**，
    // 所以这里的数值是「显示亮度」单位，不需要再除以 exposureScale。
    // 早期版本不知道这一点，把阈值也按曝光反比缩了 —— 结果暮光时
    // 整片天幕（显示亮度 0.1 左右）全部越过阈值，被 bloom 糊成一团白光。
    //
    // 0.55 略高于天空的目标显示亮度（0.15），只让太阳圆盘、城市灯光
    // 这类真正的高光起辉；白天再把阈值抬一点，避免整片天空泛光。
    const autoThreshold = 0.55 + 0.5 * dayness;

    // 走 HDR 后期管线：场景 → 亮部提取 → 金字塔模糊 → 合成（ACES + 颗粒 + 暗角）
    // 曝光在这里统一应用，所以 sky shader 只输出纯线性辐亮度。
    post.render(scene, rig.camera, {
      exposure: exposureScale,
      time: elapsed,
      bloom: {
        strength: params.bloomStrength,
        // 面板上把 threshold 拖到 0 时走自动阈值；否则用用户指定的
        threshold: params.bloomThreshold > 0 ? params.bloomThreshold : autoThreshold,
        softKnee: 0.6,
        scatter: 0.85,
      },
      grain: params.grain,
      vignette: 0.22,
    });

    perf.tick(performance.now());
    updateHud(dt);
  }

  requestAnimationFrame(frame);
}
