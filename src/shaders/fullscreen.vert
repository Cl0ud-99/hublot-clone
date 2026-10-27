/**
 * 全屏三角形顶点着色器
 *
 * 用 3 个顶点覆盖整个 NDC：
 *   (-1,-1) (3,-1) (-1,3)
 * 比 quad 少一次顶点处理，且避免对角线接缝。
 *
 * 注意：不要手动声明 `attribute vec3 position`。
 * three.js 会自动为 ShaderMaterial 注入内置属性（position / normal / uv 等），
 * 手动声明会触发 'position : redefinition' 编译错误。
 */

varying vec2 vUv;

void main() {
  // 从 [-1,3] 映射到 [0,1]；三角形覆盖屏幕时正好插值出 0..1
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
