/* 拼图定位台 · 服务端
 * 零依赖：只用 Node 内置模块
 *   · 静态托管当前目录（原 python -m http.server 的活儿）
 *   · WebSocket（自己实现 RFC6455 握手与帧编解码，不用 npm 装 ws）
 *   · 图谱数据落盘到 puzzle-data.json，任何改动立刻写文件
 *   · 同一张图 = 一个房间，改动广播给房间里的所有客户端
 *
 * 启动： node server.js [端口]      默认 8848
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const PORT = parseInt(process.argv[2], 10) || 8848;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "puzzle-data.json");

/* ---------------- 存储 ---------------- */
let db = { boards: {}, order: [] };

function loadDB() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    if (j && j.boards) { db = j; if (!Array.isArray(db.order)) db.order = Object.keys(db.boards); }
  } catch (e) { /* 第一次运行，没有数据文件 */ }
}
let saveTimer = null;
function saveDB(now) {
  if (now) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db), "utf8"); } catch (e) { console.error("写盘失败:", e.message); }
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(function () { saveTimer = null; saveDB(true); }, 120);
}

function newId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
function emptyStates(total) { return new Array(total + 1).join("0"); }

function countDone(b) {
  let n = 0;
  const s = b.states || "";
  for (let i = 0; i < s.length; i++) if (s[i] === "1") n++;
  return n;
}
function publicBoard(b) {
  return {
    id: b.id, name: b.name, updatedAt: b.updatedAt, createdAt: b.createdAt,
    total: b.cfg && b.cfg.total || 0, done: countDone(b)
  };
}
function boardList() {
  const out = [];
  db.order.forEach(function (id) { if (db.boards[id]) out.push(publicBoard(db.boards[id])); });
  return out;
}
function uniqueName(name){
  var names={};
  db.order.forEach(function(id){ if(db.boards[id]) names[db.boards[id].name]=true; });
  if(!names[name]) return name;
  for(var k=2;;k++){ var n=name+" "+k; if(!names[n]) return n; }
}
function createBoard(name, cfg) {
  const id = newId();
  const total = (cfg && cfg.total) || 1000;
  const c = Object.assign({ total: total, cols: 40, zoneSize: 250, order: "col", origin: "tl", showIndex: true, cellSize: 56, gap: 3 }, cfg || {});
  const b = { id: id, name: uniqueName(name || "未命名拼图"), cfg: c, states: emptyStates(c.total), createdAt: Date.now(), updatedAt: Date.now() };
  db.boards[id] = b; db.order.unshift(id);
  saveDB(true);
  return b;
}

loadDB();
if (!db.order.length) {            // 首次运行给一张默认图
  createBoard("我的拼图 1000 片", { total: 1000, cols: 40, zoneSize: 250, order: "col", origin: "tl", showIndex: true, cellSize: 56, gap: 3 });
}

/* ---------------- WebSocket ---------------- */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsAccept(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

// 解析一个完整帧；不够就返回 null（等更多数据）
function readFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f, off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); off = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.slice(off, off + 4); off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.slice(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { fin: fin, opcode: opcode, payload: payload, size: off + len };
}

function frameText(str) {
  const data = Buffer.from(str, "utf8");
  const len = data.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  head[0] = 0x81;                 // FIN + text
  return Buffer.concat([head, data]);
}
function framePong(data) {
  const d = data || Buffer.alloc(0);
  const len = d.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  head[0] = 0x8a;
  return Buffer.concat([head, d]);
}
function frameClose() { return Buffer.from([0x88, 0x00]); }

/* 每个连接：{ socket, id, boardId } */
const clients = new Set();

function send(client, obj) {
  try { client.socket.write(frameText(JSON.stringify(obj))); } catch (e) { /* 断了就算了 */ }
}
function broadcast(obj, except, boardId) {
  clients.forEach(function (c) {
    if (c === except) return;
    if (boardId && c.boardId !== boardId) return;
    send(c, obj);
  });
}

function applyPatch(board, cells) {
  const arr = (board.states || "").split("");
  let changed = 0;
  Object.keys(cells || {}).forEach(function (k) {
    const i = parseInt(k, 10), v = parseInt(cells[k], 10);
    if (!(i >= 1 && i <= board.cfg.total)) return;
    if (v < 0 || v > 4) return;
    while (arr.length < i) arr.push("0");
    if (arr[i - 1] !== String(v)) { arr[i - 1] = String(v); changed++; }
  });
  board.states = arr.join("");
  return changed;
}

function handle(client, msg) {
  const t = msg && msg.t;
  if (t === "list") { send(client, { t: "list", boards: boardList() }); return; }

  if (t === "create") {
    const b = createBoard(msg.name, msg.cfg);
    broadcast({ t: "list", boards: boardList() }, null, null);
    send(client, { t: "created", board: b });
    return;
  }
  if (t === "rename") {
    const b = db.boards[msg.id];
    if (!b) { send(client, { t: "error", msg: "这张图不存在" }); return; }
    b.name = String(msg.name || "").slice(0, 60) || b.name;
    b.updatedAt = Date.now();
    saveDB(true);
    broadcast({ t: "list", boards: boardList() }, null, null);
    broadcast({ t: "renamed", id: b.id, name: b.name }, null, b.id);
    return;
  }
  if (t === "delete") {
    if (!db.boards[msg.id]) return;
    delete db.boards[msg.id];
    db.order = db.order.filter(function (x) { return x !== msg.id; });
    saveDB(true);
    broadcast({ t: "list", boards: boardList() }, null, null);
    broadcast({ t: "deleted", id: msg.id }, null, msg.id);
    return;
  }
  if (t === "join") {
    const b = db.boards[msg.id];
    if (!b) {
      // 图被删了：给一张新的，避免客户端卡住
      const nb = createBoard("我的拼图", null);
      client.boardId = nb.id;
      send(client, { t: "snapshot", board: nb });
      send(client, { t: "list", boards: boardList() });
      return;
    }
    client.boardId = b.id;
    const others = [];
    clients.forEach(function (c) { if (c !== client && c.boardId === b.id) others.push(c.id); });
    send(client, { t: "snapshot", board: b, peers: others.length + 1 });
    broadcast({ t: "peers", id: b.id, n: others.length + 1 }, client, b.id);
    return;
  }
  if (t === "patch" || t === "replace") {
    const b = db.boards[msg.id];
    if (!b) { send(client, { t: "error", msg: "这张图不存在" }); return; }
    if (t === "replace") {
      if (msg.cfg) b.cfg = Object.assign({}, b.cfg, msg.cfg);
      const total = b.cfg.total || 1000;
      let s = typeof msg.states === "string" ? msg.states : emptyStates(total);
      b.states = s.length >= total ? s.slice(0, total) : s + emptyStates(total - s.length);
    } else {
      if (!applyPatch(b, msg.cells)) return;      // 没实际变化就不广播、不写盘
    }
    b.updatedAt = Date.now();
    saveDB(true);
    broadcast({ t: t, id: b.id, cells: msg.cells, cfg: t === "replace" ? b.cfg : undefined, states: t === "replace" ? b.states : undefined, by: client.id }, client, b.id);
    return;
  }
}

function onConnect(socket, req) {
  const client = { socket: socket, id: newId(), boardId: null, buf: Buffer.alloc(0), frag: null };
  clients.add(client);

  socket.on("data", function (chunk) {
    client.buf = Buffer.concat([client.buf, chunk]);
    for (;;) {
      const f = readFrame(client.buf);
      if (!f) break;
      client.buf = client.buf.slice(f.size);
      if (f.opcode === 0x8) { try { socket.write(frameClose()); } catch (e) {} clients.delete(client); socket.end(); return; }
      if (f.opcode === 0x9) { try { socket.write(framePong(f.payload)); } catch (e) {} continue; }
      if (f.opcode === 0xa) continue;
      if (f.opcode === 0x0 || f.opcode === 0x1) {
        client.frag = (f.opcode === 0x1) ? f.payload : Buffer.concat([client.frag || Buffer.alloc(0), f.payload]);
        if (!f.fin) continue;
        let msg = null;
        try { msg = JSON.parse(client.frag.toString("utf8")); } catch (e) { msg = null; }
        client.frag = null;
        if (msg) { try { handle(client, msg); } catch (e) { console.error("处理消息出错:", e); } }
      }
    }
  });
  socket.on("close", function () { clients.delete(client); });
  socket.on("error", function () { clients.delete(client); });
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".map": "application/json"
};

const server = http.createServer(function (req, res) {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/" || p === "") p = "/puzzle-map.html";
  const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ""));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("404"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
});

server.on("upgrade", function (req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n"
  );
  onConnect(socket, req);
  if (head && head.length) socket.emit("data", head);
});

server.listen(PORT, "0.0.0.0", function () {
  const ips = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (k) {
    (nets[k] || []).forEach(function (n) { if (n.family === "IPv4" && !n.internal) ips.push(n.address); });
  });
  console.log("拼图定位台服务已启动");
  console.log("  本机访问： http://127.0.0.1:" + PORT + "/puzzle-map.html");
  ips.forEach(function (ip) { console.log("  局域网访问： http://" + ip + ":" + PORT + "/puzzle-map.html"); });
  console.log("  数据文件： " + DATA_FILE);
  console.log("  图谱数量： " + db.order.length);
});
