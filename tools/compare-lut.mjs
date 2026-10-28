import { makeLUT } from './ms-reference.mjs';
const cpu = makeLUT({ size: 32, dirsFirst: 64, dirsHigher: 32, steps: 28, orders: 5, sunSteps: 6 });
const size = 32;
const ref = (x, y) => { const i = (y*size+x)*3; return [cpu.total[i], cpu.total[i+1], cpu.total[i+2]]; };
const gpuSamples = JSON.parse(process.argv[2]);
let maxRel = 0, sumRel = 0, n = 0, worst = null;
for (const [x, y, r, g, b] of gpuSamples) {
  const c = ref(x, y);
  const gv = [r, g, b];
  for (let k = 0; k < 3; k++) {
    const denom = Math.max(Math.abs(c[k]), 1e-30);
    const rel = Math.abs(gv[k] - c[k]) / denom;
    if (!Number.isFinite(rel)) continue;
    sumRel += rel; n++;
    if (rel > maxRel) { maxRel = rel; worst = { x, y, k, gpu: gv[k], cpu: c[k] }; }
  }
}
console.log('平均相对误差', (sumRel/n*100).toFixed(2)+'%');
console.log('最大相对误差', (maxRel*100).toFixed(2)+'%', worst);
console.log('\n抽样对比 (x,y): GPU R,G,B  vs  CPU R,G,B');
for (const [x, y, r, g, b] of gpuSamples.filter(s => s[1] >= 12)) {
  const c = ref(x, y);
  console.log(` (${x},${y}) GPU ${r.toExponential(3)} ${g.toExponential(3)} ${b.toExponential(3)} | CPU ${c[0].toExponential(3)} ${c[1].toExponential(3)} ${c[2].toExponential(3)}`);
}
