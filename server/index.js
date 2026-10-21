/* 拼图定位台 · 统一服务端（Express + ws + Vite）
 *
 *   npm run dev     开发模式：Vite 中间件 + HMR，WS 同端口
 *   npm run build   构建前端到 dist/
 *   npm start       生产模式：托管 dist/，WS 同端口（默认 8848）
 *
 * 局域网其它设备访问 http://<本机IP>:8848/ 即可，多设备实时同步。
 */
import express from "express";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";
import { attachWS } from "./ws.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const argPort = process.argv.find(function (a) { return /^\d{2,5}$/.test(a); });
const PORT = parseInt(process.env.PORT || argPort || "8848", 10);
const isProd = process.argv.includes("--prod") || process.env.NODE_ENV === "production";
const DIST = path.join(ROOT, "dist");

const app = express();
app.disable("x-powered-by");

const server = createServer(app);
const store = createStore(path.join(ROOT, "puzzle-data.json"));
attachWS(server, store);          // WebSocket：/ws，与 HTTP 同端口

if (isProd) {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.error("还没有构建产物 dist/，请先执行： npm run build");
    process.exit(1);
  }
  // 数据文件不对外暴露
  app.use("/puzzle-data.json", function (req, res) { res.status(404).end("not found"); });
  app.use(express.static(DIST, { maxAge: "1h", index: "index.html" }));
  app.get("*", function (req, res) {
    res.sendFile(path.join(DIST, "index.html"));
  });
} else {
  // 开发模式：Vite 以中间件方式挂在同一个 HTTP 服务上（HMR 走自己的 WS 路径，互不干扰）
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    root: ROOT,
    server: { middlewareMode: true, hmr: { port: PORT } },
    appType: "custom"
  });
  app.use(vite.middlewares);
}

server.listen(PORT, "0.0.0.0", function () {
  const ips = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (k) {
    (nets[k] || []).forEach(function (n) { if (n.family === "IPv4" && !n.internal) ips.push(n.address); });
  });
  console.log("拼图定位台已启动（" + (isProd ? "生产模式 · dist/" : "开发模式 · Vite") + "）");
  console.log("  本机访问：  http://127.0.0.1:" + PORT + "/");
  ips.forEach(function (ip) { console.log("  局域网访问：http://" + ip + ":" + PORT + "/"); });
  console.log("  数据文件：  " + store.dataFile + "（共 " + store.size + " 张图）");
});
