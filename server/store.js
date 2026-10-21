/* 数据层：puzzle-data.json 落库
 * 与 v8 手写服务端同一套结构：{ boards:{id:board}, order:[id...] }
 * 任何改动立即写盘（用户要求“新增即落库”）。
 */
import fs from "node:fs";

export function createStore(dataFile) {
  let db = { boards: {}, order: [] };

  function loadDB() {
    try {
      const j = JSON.parse(fs.readFileSync(dataFile, "utf8"));
      if (j && j.boards) {
        db = j;
        if (!Array.isArray(db.order)) db.order = Object.keys(db.boards);
      }
    } catch (e) { /* 第一次运行，没有数据文件 */ }
  }

  function saveDB() {
    try {
      fs.writeFileSync(dataFile, JSON.stringify(db), "utf8");
    } catch (e) {
      console.error("写盘失败:", e.message);
    }
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
      total: (b.cfg && b.cfg.total) || 0, done: countDone(b)
    };
  }
  function boardList() {
    const out = [];
    db.order.forEach(function (id) { if (db.boards[id]) out.push(publicBoard(db.boards[id])); });
    return out;
  }
  function uniqueName(name) {
    const names = {};
    db.order.forEach(function (id) { if (db.boards[id]) names[db.boards[id].name] = true; });
    if (!names[name]) return name;
    for (let k = 2; ; k++) { const n = name + " " + k; if (!names[n]) return n; }
  }
  function createBoard(name, cfg) {
    const id = newId();
    const total = (cfg && cfg.total) || 1000;
    const c = Object.assign({ total: total, cols: 40, zoneSize: 250, order: "col", origin: "tl", showIndex: true, cellSize: 56, gap: 3 }, cfg || {});
    const b = { id: id, name: uniqueName(name || "未命名拼图"), cfg: c, states: emptyStates(c.total), createdAt: Date.now(), updatedAt: Date.now() };
    db.boards[id] = b;
    db.order.unshift(id);
    saveDB();
    return b;
  }
  function getBoard(id) { return db.boards[id] || null; }
  function renameBoard(id, name) {
    const b = db.boards[id];
    if (!b) return null;
    b.name = String(name || "").slice(0, 60) || b.name;
    b.updatedAt = Date.now();
    saveDB();
    return b;
  }
  function deleteBoard(id) {
    if (!db.boards[id]) return false;
    delete db.boards[id];
    db.order = db.order.filter(function (x) { return x !== id; });
    saveDB();
    return true;
  }
  // 返回实际变化的格子数（0 = 没有变化，不广播不写盘）
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
  function replaceBoard(board, cfg, states) {
    if (cfg) board.cfg = Object.assign({}, board.cfg, cfg);
    const total = board.cfg.total || 1000;
    const s = typeof states === "string" ? states : emptyStates(total);
    board.states = s.length >= total ? s.slice(0, total) : s + emptyStates(total - s.length);
    board.updatedAt = Date.now();
    saveDB();
  }
  function touch(board) { board.updatedAt = Date.now(); saveDB(); }

  loadDB();
  if (!db.order.length) {          // 首次运行给一张默认图
    createBoard("我的拼图 1000 片", { total: 1000, cols: 40, zoneSize: 250, order: "col", origin: "tl", showIndex: true, cellSize: 56, gap: 3 });
  }

  return {
    boardList, createBoard, getBoard, renameBoard, deleteBoard,
    applyPatch, replaceBoard, touch,
    get size() { return db.order.length; },
    get dataFile() { return dataFile; }
  };
}
