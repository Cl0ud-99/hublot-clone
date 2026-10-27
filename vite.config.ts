import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';

/**
 * 注意：vite-plugin-glsl 1.6.x 的默认导出是 async function，
 * 直接放进 plugins 数组会得到一个未 await 的 Promise，
 * Vite 不会自动 await，插件就变成空对象（shader 被当成文本资源导出）。
 *
 * 所以这里在 config 函数里 await 它。
 */
export default defineConfig(async () => {
  const glslPlugin = await glsl({
    include: ['**/*.glsl', '**/*.vert', '**/*.frag'],
    exclude: ['**/node_modules/**'],
    warnDuplicatedImports: false,
    defaultExtension: 'glsl',
    compress: false,
    // 必须关掉。开启后插件会在 src/shaders/ 下创建 .tmpdir 临时文件并监视它，
    // 在 Windows 上会抛 EBUSY（文件被锁）直接让 dev server 崩溃。
    // 改着色器时手动重启即可，或依赖 Vite 自身对 .glsl 的模块失效。
    watch: false,
  });

  return {
    plugins: [glslPlugin],
    server: {
      host: '127.0.0.1',
      port: 5173,
      watch: {
        /**
         * 忽略编辑器原子保存时产生的临时目录。
         *
         * 编辑器（VS Code 等）保存文件时会先写一个
         * `.<name>.<pid>.<uuid>.tmpdir/<name>.tmp` 再改名替换。
         * Vite 的 chokidar 监视器会扫到它并尝试 watch，
         * 在 Windows 上文件已被改名/删除 → 抛 EBUSY → 整个 dev server 崩掉。
         *
         * 这不是 vite-plugin-glsl 的问题（它只是受害者），
         * 忽略这个模式能从根上避免。
         */
        ignored: [
          '**/*.tmpdir/**',
          '**/.tmpdir/**',
          '**/*.tmp',
          '**/node_modules/**',
          '**/dist/**',
        ],
      },
    },
    build: {
      target: 'es2020',
      chunkSizeWarningLimit: 1200,
    },
  };
});
