/* PP-OCR 高精度服务托管（子进程） + 同源反向代理
 *
 * 为什么要有这一层：
 *   ocr_server.py 只监听 127.0.0.1:8849，浏览器里写死 http://127.0.0.1:8849 的话，
 *   局域网其它设备（手机/平板/另一台电脑）访问的是**它自己**的 127.0.0.1 —— 必然
 *   「未连接」。这里让 8848 服务端代管：浏览器只访问页面自己的源 /ocrsvc/*，
 *   由服务端转发到本机 8849，局域网设备与手机一致可用，也不用把 8849 开到外网。
 *
 *   顺带把「要开两个服务」解决了：服务端启动时自己把 ocr_server.py 拉起来
 *   （双击一个 start-lan-server.bat 即可），已手动开着的则直接复用、不重复拉起。
 *
 * 环境变量：
 *   OCR_PORT=8849           OCR 服务端口
 *   PUZZLE_PYTHON=...       指定跑 ocr_server.py 的解释器（需已装 rapidocr）
 *   PUZZLE_NO_OCR=1         不自动拉起（只想用内置模板 OCR）
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

export const OCR_HOST = "127.0.0.1";
export const OCR_PORT = parseInt(process.env.OCR_PORT || "8849", 10);

const S = {
  ok: false,          // 服务已就绪（health 的 ok=true）
  busy: false,        // health 正在探测
  starting: false,    // 已拉起子进程、等 warmup
  child: null,        // 我们拉起的子进程（外部的则为 null，退出时不动它）
  cmd: null,          // 已确认能 import rapidocr 的解释器
  err: "",            // 最近一次失败原因（给页面显示/排查）
  lastSpawn: 0
};

/* ---------- 探测 ---------- */
function ping(timeout) {
  return new Promise(function (resolve) {
    var done = false;
    var r = http.request(
      { host: OCR_HOST, port: OCR_PORT, path: "/health", method: "GET", timeout: timeout || 900 },
      function (res) {
        var buf = "";
        res.setEncoding("utf8");
        res.on("data", function (c) { buf += c; });
        res.on("end", function () {
          if (done) return;
          done = true;
          var j = null;
          try { j = JSON.parse(buf); } catch { /* 非 JSON */ }
          resolve({ reachable: true, json: j });
        });
      }
    );
    r.on("timeout", function () { r.destroy(); });
    r.on("error", function () {
      if (done) return;
      done = true;
      resolve({ reachable: false, json: null });
    });
    r.end();
  });
}

/* ---------- 找解释器：必须真的能 import rapidocr ----------
 * PATH 上的 python 往往是后装的空环境（本机就是：managed 3.13.12 在前、没装 rapidocr），
 * 所以逐个候选实测，第一个 import 通过的才算数。 */
function candidates() {
  var out = [];
  if (process.env.PUZZLE_PYTHON) out.push({ cmd: process.env.PUZZLE_PYTHON, args: [] });
  if (process.platform === "win32") {
    out.push({ cmd: "py", args: ["-3"] });                 // C:\Windows\py.exe → 拾取最新 3.x
    var la = process.env.LOCALAPPDATA;
    if (la) {
      for (var v = 314; v >= 310; v--) {
        out.push({ cmd: path.join(la, "Programs", "Python", "Python" + v, "python.exe"), args: [] });
      }
    }
    out.push({ cmd: "python", args: [] });
  } else {
    out.push({ cmd: "python3", args: [] }, { cmd: "python", args: [] });
  }
  return out;
}

function testPython(c) {
  return new Promise(function (resolve) {
    var p;
    try {
      p = spawn(c.cmd, c.args.concat(["-c", "import rapidocr"]), { windowsHide: true, stdio: "ignore" });
    } catch { return resolve(false); }
    var t = setTimeout(function () { try { p.kill(); } catch { /* ignore */ } resolve(false); }, 20000);
    p.on("error", function () { clearTimeout(t); resolve(false); });
    p.on("exit", function (code) { clearTimeout(t); resolve(code === 0); });
  });
}

async function pickPython() {
  if (S.cmd) return S.cmd;
  var list = candidates();
  for (var i = 0; i < list.length; i++) {
    var ok = await testPython(list[i]);
    if (ok) { S.cmd = list[i]; return S.cmd; }
  }
  return null;
}

/* ---------- 拉起子进程 ---------- */
async function spawnOcr(root) {
  if (S.starting || S.child) return;
  if (Date.now() - S.lastSpawn < 6000) return;      // 防抖：别被轮询打成 spawn 风暴
  S.lastSpawn = Date.now();
  S.starting = true;
  S.err = "";

  var script = path.join(root, "label", "ocr_server.py");
  var py = await pickPython();
  if (!py) {
    S.starting = false;
    S.err = "没找到装了 rapidocr 的 Python（可设 PUZZLE_PYTHON 指定解释器）";
    console.error("[ocr] " + S.err);
    return;
  }

  var child;
  try {
    child = spawn(py.cmd, py.args.concat([script, String(OCR_PORT)]), {
      cwd: path.join(root, "label"),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (e) {
    S.starting = false;
    S.err = "启动失败：" + (e && e.message);
    console.error("[ocr] " + S.err);
    return;
  }
  S.child = child;
  console.log("[ocr] 拉起 PP-OCR 服务：" + [py.cmd].concat(py.args, [script, OCR_PORT]).join(" "));

  child.stdout.on("data", function (b) { process.stdout.write(String(b)); });
  child.stderr.on("data", function (b) { process.stderr.write(String(b)); });
  child.on("error", function (e) {
    S.starting = false;
    S.err = "子进程失败：" + (e && e.message);
    console.error("[ocr] " + S.err);
  });
  child.on("exit", function (code, sig) {
    S.starting = false;
    S.ok = false;
    S.child = null;
    if (code) S.err = "OCR 服务退出（code " + code + "）";
    console.log("[ocr] 服务进程结束 code=" + code + (sig ? " sig=" + sig : ""));
  });

  // warmup 完成（health ok=true）即视为就绪；最多等 3 分钟（首次加载模型慢）
  var t0 = Date.now();
  (function waitReady() {
    if (!S.child || !S.starting) return;
    ping(900).then(function (r) {
      if (r.reachable && r.json && r.json.ok) {
        S.ok = true;
        S.starting = false;
        console.log("[ocr] PP-OCR 已就绪（" + ((Date.now() - t0) / 1000).toFixed(1) + "s）");
        return;
      }
      if (Date.now() - t0 > 180000) {
        S.starting = false;
        S.err = "OCR 服务 3 分钟内没就绪";
        return;
      }
      setTimeout(waitReady, 600);
    });
  })();
}

/* ---------- 对外：启动时调用一次 ---------- */
export function initOcr(root) {
  if (process.env.PUZZLE_NO_OCR === "1") {
    console.log("[ocr] PUZZLE_NO_OCR=1，不自动拉起（页面走内置模板 OCR）");
    return;
  }
  ping(1000).then(function (r) {
    if (r.reachable) {
      S.ok = !!(r.json && r.json.ok);
      if (!S.ok) console.log("[ocr] 8849 上已有服务在 warmup，等它就绪");
      else console.log("[ocr] 复用已在运行的 PP-OCR 服务（127.0.0.1:" + OCR_PORT + "）");
      if (!S.ok) {
        var t0 = Date.now();
        (function poll() {
          if (Date.now() - t0 > 180000) return;
          ping(900).then(function (rr) {
            if (rr.reachable && rr.json && rr.json.ok) { S.ok = true; console.log("[ocr] PP-OCR 已就绪（复用）"); return; }
            setTimeout(poll, 600);
          });
        })();
      }
      return;
    }
    spawnOcr(root);
  });
}

/* ---------- 对外：GET /ocrsvc/health ---------- */
export function ocrHealth(root) {
  return function (req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (S.ok) return res.json({ ok: true, engine: "rapidocr", port: OCR_PORT, via: "proxy" });
    if (S.starting) return res.json({ ok: false, starting: true, engine: "rapidocr", port: OCR_PORT, via: "proxy" });
    // 还没起来：先回一句「没连上」，同时顺手再拉一次（服务被关掉后能自愈）
    res.json({ ok: false, starting: false, port: OCR_PORT, via: "proxy", error: S.err || "服务未运行" });
    ping(700).then(function (r) {
      if (r.reachable && r.json && r.json.ok) S.ok = true;
      else if (root) spawnOcr(root);
    });
  };
}

/* ---------- 对外：POST /ocrsvc/ocr（转发原始请求体） ---------- */
export function ocrProxy(req, res) {
  if (!S.ok && !S.starting) {
    return res.status(503).json({ error: "PP-OCR 服务未就绪" + (S.err ? "：" + S.err : "") });
  }
  var body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  var headers = { "Content-Type": req.headers["content-type"] || "application/json", "Content-Length": body.length };
  var r = http.request(
    { host: OCR_HOST, port: OCR_PORT, path: "/ocr", method: "POST", headers: headers },
    function (pr) {
      res.writeHead(pr.statusCode || 502, {
        "Content-Type": pr.headers["content-type"] || "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      pr.pipe(res);
    }
  );
  r.setTimeout(180000, function () { r.destroy(new Error("OCR 转发超时")); });
  r.on("error", function (e) {
    if (!res.headersSent) res.status(502).json({ error: "OCR 转发失败：" + (e && e.message) });
    else res.end();
  });
  r.end(body);
}

/* ---------- 退出时收掉我们拉起的子进程 ---------- */
export function shutdownOcr() {
  if (S.child) {
    try { S.child.kill(); } catch { /* ignore */ }
    S.child = null;
  }
}
