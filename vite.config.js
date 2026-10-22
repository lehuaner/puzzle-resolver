import { defineConfig } from "vite";

export default defineConfig({
  // 根目录即项目根：index.html 为唯一入口，src/frontend 为前端源码
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020"
  },
  server: {
    port: 5173,
    host: true,
    // 单独跑 `vite` 时也把 /ocrsvc 代理到本机 OCR 服务（npm run dev 走 Express，用不到）
    proxy: {
      "/ocrsvc": {
        target: "http://127.0.0.1:8849",
        changeOrigin: true,
        rewrite: function (p) { return p.replace(/^\/ocrsvc/, ""); }
      }
    }
  }
});
