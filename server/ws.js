/* WebSocket 房间层：同一张图 = 一个房间
 * 协议与 v8 完全一致（前端零改动）：
 *   C→S：list / create{name,cfg} / rename{id,name} / delete{id} / join{id} / patch{id,cells} / replace{id,cfg,states}
 *   S→C：list / snapshot{board,peers} / created / renamed / deleted / patch|replace(广播) / peers{n} / error
 */
import { WebSocketServer } from "ws";

export function attachWS(server, store) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set();   // { ws, id, boardId }

  function newId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
  function send(client, obj) {
    if (client.ws.readyState !== 1) return;
    try { client.ws.send(JSON.stringify(obj)); } catch (e) { /* 断了就算了 */ }
  }
  function broadcast(obj, except, boardId) {
    clients.forEach(function (c) {
      if (c === except) return;
      if (boardId && c.boardId !== boardId) return;
      send(c, obj);
    });
  }

  function handle(client, msg) {
    const t = msg && msg.t;
    if (t === "list") { send(client, { t: "list", boards: store.boardList() }); return; }

    if (t === "create") {
      const b = store.createBoard(msg.name, msg.cfg);
      broadcast({ t: "list", boards: store.boardList() }, null, null);
      send(client, { t: "created", board: b });
      return;
    }
    if (t === "rename") {
      const b = store.renameBoard(msg.id, msg.name);
      if (!b) { send(client, { t: "error", msg: "这张图不存在" }); return; }
      broadcast({ t: "list", boards: store.boardList() }, null, null);
      broadcast({ t: "renamed", id: b.id, name: b.name }, null, b.id);
      return;
    }
    if (t === "delete") {
      if (!store.deleteBoard(msg.id)) return;
      broadcast({ t: "list", boards: store.boardList() }, null, null);
      broadcast({ t: "deleted", id: msg.id }, null, msg.id);
      return;
    }
    if (t === "join") {
      let b = store.getBoard(msg.id);
      if (!b) {
        // 图被删了：给一张新的，避免客户端卡住
        b = store.createBoard("我的拼图", null);
        client.boardId = b.id;
        send(client, { t: "snapshot", board: b });
        send(client, { t: "list", boards: store.boardList() });
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
      const b = store.getBoard(msg.id);
      if (!b) { send(client, { t: "error", msg: "这张图不存在" }); return; }
      if (t === "replace") {
        store.replaceBoard(b, msg.cfg, msg.states);
      } else {
        if (!store.applyPatch(b, msg.cells)) return;   // 没实际变化就不广播、不写盘
        store.touch(b);
      }
      broadcast({
        t: t, id: b.id,
        cells: msg.cells,
        cfg: t === "replace" ? b.cfg : undefined,
        states: t === "replace" ? b.states : undefined,
        by: client.id
      }, client, b.id);
      return;
    }
  }

  wss.on("connection", function (ws) {
    const client = { ws: ws, id: newId(), boardId: null };
    clients.add(client);
    ws.on("message", function (raw) {
      let msg = null;
      try { msg = JSON.parse(String(raw)); } catch (e) { return; }
      try { handle(client, msg); } catch (e) { console.error("处理消息出错:", e); }
    });
    ws.on("close", function () {
      clients.delete(client);
      if (client.boardId) {
        const n = [...clients].filter(function (c) { return c.boardId === client.boardId; }).length;
        broadcast({ t: "peers", id: client.boardId, n: n }, null, client.boardId);
      }
    });
    ws.on("error", function () { clients.delete(client); });
  });

  return wss;
}
