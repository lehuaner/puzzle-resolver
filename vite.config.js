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
    host: true
  }
});
