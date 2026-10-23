// 离线复刻 guide.js 的两级排序，验证：①不丢块 ②独立片贴着已拼区/连片往外长
var R = 25, C = 40, TOTAL = 1000;
function idxToRC(i) { var n = i - 1, a = Math.floor(n / R), b = n % R; return { row: b + 1, col: a + 1 }; } // order=col, origin=tl 简化
function adj(i) { var p = idxToRC(i), o = [];   // order=col：行邻接=±1，列邻接=±R（别写成 ±C！）
  if (p.row > 1) o.push(i - 1); if (p.row < R) o.push(i + 1);
  if (p.col > 1) o.push(i - R); if (p.col < C) o.push(i + R); return o; }
var adjMap = {};                                  // 真实应用里 S.adj 是邻接表对象：S.adj[i] = 邻居数组
for (var ai = 1; ai <= TOTAL; ai++) adjMap[ai] = adj(ai);
var S = { adj: adjMap, states: new Uint8Array(TOTAL + 1), cfg: { total: TOTAL } };

function buildOrder(targets, grpOf) {
  var seen = new Set(), uniq = [];
  targets.forEach(function (i) { if (i >= 1 && i <= TOTAL && !seen.has(i)) { seen.add(i); uniq.push(i); } });
  var par = {};
  function find(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
  uniq.forEach(function (i) { par[i] = i; });
  var inSet = new Set(uniq);
  uniq.forEach(function (i) { (S.adj[i] || []).forEach(function (j) { if (inSet.has(j)) { var a = find(i), b = find(j); if (a !== b) par[b] = a; } }); });
  var comps = {}, roots = [];
  uniq.forEach(function (i) { var r = find(i); if (!comps[r]) { comps[r] = []; roots.push(r); } comps[r].push(i); });
  var wholes = [];
  roots.forEach(function (r) {
    var ids = comps[r], cc = 0, cr = 0;
    ids.forEach(function (i) { var p = idxToRC(i); cc += p.col; cr += p.row; });
    cc /= ids.length; cr /= ids.length;
    function dOf(a) { var c2 = 0, r2 = 0; a.forEach(function (i) { var p = idxToRC(i); c2 += p.col; r2 += p.row; }); return Math.hypot(c2 / a.length - cc, r2 / a.length - cr); }
    var byGrp = {}, solo = [];
    ids.forEach(function (i) { var g = grpOf[i]; if (g != null) (byGrp[g] = byGrp[g] || []).push(i); else solo.push(i); });
    var grpSubs = [];
    Object.keys(byGrp).forEach(function (g) { var a = byGrp[g].slice().sort(function (x, y) { return x - y; });
      grpSubs.push({ ids: a, isGrp: true, n: a.length, head: a[0], dist: dOf(a) }); });
    grpSubs.sort(function (a, b) { if (a.n !== b.n) return b.n - a.n; if (a.dist !== b.dist) return a.dist - b.dist; return a.head - b.head; });
    if (globalThis.__DBG) console.log("DBG 整 n=" + ids.length, "grpSubs:", JSON.stringify(grpSubs.map(function(g){return g.ids;})), "solo.len:", solo.length);
    solo.sort(function (a, b) { return a - b; });
    wholes.push({ ids: ids.slice().sort(function (x, y) { return x - y; }), grpSubs: grpSubs, solo: solo,
                  n: ids.length, cd: 0, head: Math.min.apply(null, ids) });
  });
  // ---- growOrder + growSolo（与 guide.js 相同）----
  var tgt = new Set(); wholes.forEach(function (w) { w.ids.forEach(function (i) { tgt.add(i); }); });
  var done = new Set(), doneRC = [], rcC = {};
  function rcOf(i) { var v = rcC[i]; if (!v) { v = idxToRC(i); rcC[i] = v; } return v; }
  for (var k = 1; k <= TOTAL; k++) { var st = S.states[k]; if ((st === 1 || st === 3 || st === 4) && !tgt.has(k)) { done.add(k); doneRC.push(rcOf(k)); } }
  var left = wholes.slice(), out = [];
  function touches(w, set) { for (var k = 0; k < w.ids.length; k++) { var nb = S.adj[w.ids[k]] || [];
    for (var j = 0; j < nb.length; j++) if (set.has(nb[j])) return true; } return false; }
  function wholeCmp(a, b) { if (a.n !== b.n) return b.n - a.n; if (a.cd !== b.cd) return a.cd - b.cd; return a.head - b.head; }
  function pickIn(pred) { var pick = -1; for (var k = 0; k < left.length; k++) { if (pred && !pred(left[k])) continue;
    if (pick < 0 || wholeCmp(left[k], left[pick]) < 0) pick = k; } return pick; }
  while (left.length) {
    var p = pickIn(function (w) { return touches(w, done); }); if (p < 0) p = pickIn(null);
    var w = left.splice(p, 1)[0];
    w.grpSubs.forEach(function (s) { out.push(s); s.ids.forEach(function (i) { done.add(i); doneRC.push(rcOf(i)); }); });
    // growSolo
    var solo = w.solo;
    if (solo.length) {
      var best = {}, soloRC = [];
      solo.forEach(function (i, k) { soloRC[k] = rcOf(i); best[i] = Infinity; });
      function upd(qr, qc) { for (var k2 = 0; k2 < solo.length; k2++) { var i = solo[k2]; if (done.has(i)) continue;
        var pp = soloRC[k2]; var d = Math.max(Math.abs(pp.row - qr), Math.abs(pp.col - qc)); if (d < best[i]) best[i] = d; } }
      doneRC.forEach(function (q) { upd(q.row, q.col); });
      var leftSolo = solo.slice();
      while (leftSolo.length) {
        var pick2 = 0;
        for (var k3 = 1; k3 < leftSolo.length; k3++) { var a = leftSolo[k3], b = leftSolo[pick2];
          if (best[a] < best[b] || (best[a] === best[b] && a < b)) pick2 = k3; }
        var q = leftSolo.splice(pick2, 1)[0];
        out.push({ ids: [q], isGrp: false, n: 1, head: q, dist: best[q] });
        done.add(q); var qp = rcOf(q); doneRC.push(qp); upd(qp.row, qp.col);
      }
    }
  }
  return out;
}

function flat(o) { var r = []; o.forEach(function (s) { s.ids.forEach(function (i) { r.push(i); }); }); return r; }
function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } }

// ===== 用例 1：空棋盘 + 一整片 20 块 + 一个 4 块的组 =====
S.states.fill(0);
var t1 = []; for (var r = 1; r <= 4; r++) for (var c = 1; c <= 5; c++) t1.push((c - 1) * R + r);       // 20 块实心片
var g1 = {}; t1.slice(0, 4).forEach(function (i) { g1[i] = 0; });                                      // 前 4 块是一个拼好组
var o1 = buildOrder(t1, g1), f1 = flat(o1);
assert(f1.length === t1.length, "用例1 块数 " + f1.length + "!=" + t1.length);
assert(new Set(f1).size === t1.length, "用例1 有重复块");
assert(o1[0].isGrp === true && o1[0].ids.length === 4, "用例1 组应整组第一步，实际 " + JSON.stringify(o1[0].ids));
// 组之后第一片应贴着组
var near = adj(o1[1].ids[0]).some(function (j) { return g1[j] != null; });
assert(near, "用例1 组后第一片应贴着组，实际 " + o1[1].ids[0] + " @" + JSON.stringify(idxToRC(o1[1].ids[0])));
// 每一步都应贴着已拼块（切比雪夫距离 ≤ 2，连续生长不乱跳）
var placedG = new Set(o1[0].ids); var maxJump = 0;
for (var s2 = 1; s2 < o1.length; s2++) {
  var q = o1[s2].ids[0], best = 99;
  placedG.forEach(function (pp) { var a = idxToRC(pp), b = idxToRC(q);
    var d = Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col)); if (d < best) best = d; });
  if (best > maxJump) maxJump = best;
  placedG.add(q);
}
assert(maxJump <= 2, "用例1 最大跳跃 " + maxJump + "（应≤2，贴着往外长）");
console.log("用例1 通过：组整组走，独立片贴着长，最大跳跃 =", maxJump);

// ===== 用例 2：主区在左下 + 散在右上的 8 个独立块 → 应先放靠主区近的 =====
S.states.fill(0);
for (var rr = 23; rr <= 25; rr++) for (var cc2 = 1; cc2 <= 3; cc2++) S.states[(cc2 - 1) * R + rr] = 1;   // 主区 3x3 @左下
var t2 = []; for (var c3 = 30; c3 <= 37; c3++) t2.push((c3 - 1) * R + 3);                                // 右上一排 8 块
var o2 = buildOrder(t2, {}), f2 = flat(o2);
assert(f2.length === 8, "用例2 块数 " + f2.length);
assert(idxToRC(o2[0].ids[0]).col === 30, "用例2 第一片应最靠主区(列30)，实际列" + idxToRC(o2[0].ids[0]).col);
var prev = 0, mono = true;
o2.forEach(function (s) { var c4 = idxToRC(s.ids[0]).col; if (c4 < prev) mono = false; prev = c4; });
assert(mono, "用例2 列号应单调不减（先近后远）");
console.log("用例2 通过：先放靠主区的块，列顺序 =", f2.map(function (i) { return idxToRC(i).col; }).join(","));

// ===== 用例 3：目标里有「待定(3)」块 → 不能被静默丢掉 =====
S.states.fill(0);
var t3 = [(5 - 1) * R + 5, (6 - 1) * R + 5, (7 - 1) * R + 5];        // 3 块竖排
S.states[t3[1]] = 3;                                                  // 中间那块上一轮被标了待定
var o3 = buildOrder(t3, {}), f3 = flat(o3);
assert(f3.length === 3, "用例3 应 3 块全在队列，实际 " + f3.length + ": " + f3);
assert(f3.indexOf(t3[1]) >= 0, "用例3 待定块不能被丢掉");
console.log("用例3 通过：待定块保留在队列里");

// ===== 用例 4：两个分离的整 → 先走大的（由整到散）。队列是"步"，所以看前 9 步是否都属于大整 =====
S.states.fill(0);
var t4 = [];
for (var c5 = 1; c5 <= 3; c5++) for (var r5 = 1; r5 <= 3; r5++) t4.push((c5 - 1) * R + r5);   // 9 块 @左上
t4.push((20 - 1) * R + 10, (21 - 1) * R + 10);                                                // 2 块 @右下（竖排相邻）
var o4 = buildOrder(t4, {});
var big9 = new Set([1, 2, 3, 26, 27, 28, 51, 52, 53]);
var firstNineAllBig = o4.slice(0, 9).every(function (s) { return s.ids.every(function (i) { return big9.has(i); }); });
assert(firstNineAllBig, "用例4 前 9 步应全属大整（9 块），实际前 9 步 " + JSON.stringify(o4.slice(0, 9).map(function (s) { return s.ids; })));
assert(o4[9].ids[0] === (20 - 1) * R + 10 || o4[9].ids[0] === (21 - 1) * R + 10, "用例4 第 10 步应进入小整，实际 " + o4[9].ids[0]);
console.log("用例4 通过：先走大整（9 块走完），再走小整（2 块）");

// ===== 用例 5：组成连片 —— L 形拐角处应先补拐角块（贴连片），再放远的 =====
S.states.fill(0);
var t5 = [(1-1)*R+1, (2-1)*R+1, (3-1)*R+1,    // 竖条 1,26,51 @列1
          (1-1)*R+2];                          // 2 @列2（贴着 1）
var g5 = {}; t5.forEach(function(i){ g5[i]=0; });   // 4 块是一个组 → 整组一步
// 目标再加两块独立片：一块贴组（(2-1)*R+2=27），一块离得远（(3-1)*R+3=53）
t5.push((2-1)*R+2, (3-1)*R+3);
var o5 = buildOrder(t5, g5);
assert(o5[0].isGrp === true, "用例5 组应第一步");
assert(o5[1].ids[0] === (2-1)*R+2, "用例5 贴组的独立片(27)应先放，实际 " + o5[1].ids[0]);
console.log("用例5 通过：独立片先贴连片（27 先于 53）");

console.log(process.exitCode ? "\n有失败项" : "\n全部用例通过");
