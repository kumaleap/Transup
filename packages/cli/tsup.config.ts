/**
 * 构建产物：packages/cli/dist/index.js（ESM，带 shebang，npx 可直接跑）
 *
 * @transup/core 以【源码内联】方式打进 bundle —— core 尚未独立发包
 * （等迁独立仓库时再拆），所以 cli 的 dependencies 里要带上 core 的
 * 运行时依赖（SDK/zod/MCP），它们保持 external 由 npm 安装。
 */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node26",
  banner: { js: "#!/usr/bin/env node" },
  noExternal: [/^@transup\/core/],
  clean: true,
  sourcemap: false,
  minify: false, // 产物可读性优先：用户排查问题时能看懂栈
});
