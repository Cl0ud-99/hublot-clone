import { makeLUT, skyRadiance } from './ms-reference.mjs';
const E = [16*1.7/2.03, 16*1.85/2.03, 16];
const lut = makeLUT({ size: 32, dirsFirst: 64, dirsHigher: 32, steps: 28, orders: 5, sunSteps: 6 });
const R = 6360, h = 10.4;
const cam = [0, R + h, 0];
// 太阳高度 19.6°，方位 = 视线方位（最亮情况）
const alt = 19.6 * Math.PI/180;
const sunDir = [Math.sin(alt), Math.cos(alt), 0];
console.log('俯角   tGround   skyRadiance(单次)        skyRadiance(含MS)       地面辐亮度估计');
for (const dep of [7.8, 6, 5, 4, 3.5, 3.37]) {
  const a = -dep * Math.PI/180;
  const dir = [Math.cos(a), Math.sin(a), 0];   // 朝 +x 略微向下
  const s1 = skyRadiance(lut, cam, dir, sunDir, E, 24, 0);
  const sm = skyRadiance(lut, cam, dir, sunDir, E, 24, 1);
  // 地面交点距离（球面）
  const b = cam[0]*dir[0] + cam[1]*dir[1];
  const c = cam[0]*cam[0] + cam[1]*cam[1] - R*R;
  const disc = Math.sqrt(Math.max(0, b*b - c));
  const t = -b - disc;
  // 地面辐亮度：albedo 0.12, cosSun≈sin(alt)
  const T = 0.5;
  const ground = 0.12 * (E[1] * 0.75 * Math.sin(alt) / Math.PI) * T;
  console.log(`${dep.toFixed(2).padStart(5)}  ${t.toFixed(0).padStart(6)}   ${s1.map(v=>v.toExponential(2)).join(',')}   ${sm.map(v=>v.toExponential(2)).join(',')}   ${ground.toExponential(2)}`);
}
