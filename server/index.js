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
  // 标注台（label/）：http 方式访问时照片同源加载，canvas 不被污染，
  // 自动标注（块检测需读照片像素）在 http 下完整可用
  app.use("/label", express.static(path.join(ROOT, "label"), { index: "index.html" }));
  // 标注台落库 API：http 模式（含局域网 IP 等非安全上下文，浏览器不提供
  // 目录授权）由服务端直接写 label/ 目录，页面改动即自动保存
  const LABEL_DIR = path.join(ROOT, "label");
  const SAFE_NAME = /^[A-Za-z0-9_.\-]+$/;
  const toLabelJson = (photo) => path.join(LABEL_DIR, photo.replace(/\.[^.]+$/, "") + ".labels.json");
  function rebuildLabelSnapshot() {
    try {
      const data = {};
      for (const f of fs.readdirSync(LABEL_DIR)) {
        if (!f.endsWith(".labels.json")) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(LABEL_DIR, f), "utf8"));
          if (d && d.photo && Array.isArray(d.pieces)) data[d.photo] = d;
        } catch { /* 跳过坏文件 */ }
      }
      fs.writeFileSync(path.join(LABEL_DIR, "labels-data.js"),
        "/* 自动生成：全量标注数据快照（由标注台落库时维护）。请勿手改。 */\nvar LABEL_DATA=" + JSON.stringify(data) + ";");
    } catch { /* label 目录可能不存在 */ }
  }
  app.post("/label-api/save", express.json({ limit: "20mb" }), function (req, res) {
    const photo = String(req.body.photo || "");
    const d = req.body.data;
    if (!SAFE_NAME.test(photo)) return res.status(400).json({ error: "bad name" });
    if (!d || !Array.isArray(d.pieces)) return res.status(400).json({ error: "bad data" });
    d.photo = photo;
    fs.writeFileSync(toLabelJson(photo), JSON.stringify(d, null, 1));
    rebuildLabelSnapshot();
    res.json({ ok: true });
  });
  app.post("/label-api/photo", express.raw({ type: "*/*", limit: "60mb" }), function (req, res) {
    const name = String(req.query.name || "");
    if (!SAFE_NAME.test(name)) return res.status(400).json({ error: "bad name" });
    fs.writeFileSync(path.join(LABEL_DIR, name), req.body);
    res.json({ ok: true });
  });
  app.get("/label-api/list", function (req, res) {
    const data = {};
    try {
      for (const f of fs.readdirSync(LABEL_DIR)) {
        if (!f.endsWith(".labels.json")) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(LABEL_DIR, f), "utf8"));
          if (d && d.photo && Array.isArray(d.pieces)) data[d.photo] = d;
        } catch { /* 跳过坏文件 */ }
      }
    } catch { /* 目录不存在 */ }
    res.json(data);
  });
  app.post("/label-api/delete", express.json(), function (req, res) {
    const photo = String(req.body.photo || "");
    if (!SAFE_NAME.test(photo)) return res.status(400).json({ error: "bad name" });
    try { fs.unlinkSync(toLabelJson(photo)); } catch { /* 已不存在 */ }
    rebuildLabelSnapshot();
    res.json({ ok: true });
  });
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
