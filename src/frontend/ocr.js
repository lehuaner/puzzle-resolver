/* OCR 印刷编号识别：在照片上检出「字母-数字」编号字符串并识别其数值。
 * 管线与离线模板构建（_ocr_lib.py）严格一致：
 *   全图 Otsu → 暗像素连通域 → 编号组聚类/几何过滤 → 逐组件字形提取
 *   （邻组件像素屏蔽 + 字身正立化[bbox 宽高比判据] + 旋转域紧bbox + 24×32 双线性 + 色阶归一）
 *   → 4 假设（F+/B+/R+/F-）L1 模板匹配 → reading/置信度
 * 模板来自 src/frontend/ocr-templates.js（正立化字形，0-15 墨度）。
 * 输出: [{ x, y, letter, digits, idx, conf, dir, n, comps:[{x0,y0,w,h}] }] */

import { OCR_TEMPLATES } from "./ocr-templates.js";

var MAXSIDE = 3072;          // 与离线管线一致：编号文字需要分辨率
var GW = 24, GH = 32;        // 字形网格
var LETTERS = ["A", "B", "C", "D"];
var DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

function otsuOf(hist, total) {
  var sum = 0; for (var t = 0; t < 256; t++) sum += t * hist[t];
  var sumB = 0, wB = 0, best = 0, thr = 127;
  for (var k = 0; k < 256; k++) {
    wB += hist[k]; if (wB === 0) continue;
    var wF = total - wB; if (wF === 0) break;
    sumB += k * hist[k];
    var mB = sumB / wB, mF = (sum - sumB) / wF;
    var between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = k; }
  }
  return thr;
}

/* 灰度化 + 全图 Otsu + 暗像素连通域（4 邻接）。
 * 组件过滤：面积>=16、bbox 上限（编号字符尺寸，3072 工作分辨率）。 */
function darkComponents(gray, w, h) {
  var hist = new Array(256).fill(0);
  var i, n = gray.length;
  for (i = 0; i < n; i++) hist[gray[i]]++;
  var thr = otsuOf(hist, n);
  var darkThr = thr * 0.80;
  var dark = new Uint8Array(n);
  for (i = 0; i < n; i++) dark[i] = gray[i] < darkThr ? 1 : 0;

  var label = new Int32Array(n);      // 0=背景
  var stack = new Int32Array(n);
  var comps = [];
  var cur = 0;
  for (var s = 0; s < n; s++) {
    if (!dark[s] || label[s]) continue;
    cur++;
    var top = 0; stack[top++] = s; label[s] = cur;
    var pts = [], minX = w, maxX = 0, minY = h, maxY = 0;
    while (top > 0) {
      var q = stack[--top]; pts.push(q);
      var qx = q % w, qy = (q / w) | 0;
      if (qx < minX) minX = qx; if (qx > maxX) maxX = qx;
      if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
      if (qx > 0) { var a = q - 1; if (dark[a] && !label[a]) { label[a] = cur; stack[top++] = a; } }
      if (qx < w - 1) { var b = q + 1; if (dark[b] && !label[b]) { label[b] = cur; stack[top++] = b; } }
      if (qy > 0) { var c = q - w; if (dark[c] && !label[c]) { label[c] = cur; stack[top++] = c; } }
      if (qy < h - 1) { var e = q + w; if (dark[e] && !label[e]) { label[e] = cur; stack[top++] = e; } }
    }
    comps.push({ id: cur, x0: minX, y0: minY, w: maxX - minX + 1, h: maxY - minY + 1, pts: pts, cx: 0, cy: 0 });
  }
  var out = [];
  for (i = 0; i < comps.length; i++) {
    var cp = comps[i];
    if (cp.pts.length < 16) continue;
    if (cp.w > 90 || cp.h > 60) continue;   // 编号字符的尺寸上限
    var sx = 0, sy = 0;
    for (var p = 0; p < cp.pts.length; p++) { sx += cp.pts[p] % w; sy += (cp.pts[p] / w) | 0; }
    cp.cx = sx / cp.pts.length; cp.cy = sy / cp.pts.length;
    out.push(cp);
  }
  return { comps: out, label: label, thr: thr };
}

/* 组件周围环带的亮像素率（排除深色桌面上的大片暗区 / 阴影块） */
function ringBright(gray, w, h, c, thr) {
  var R = 3, bright = 0, tot = 0;
  for (var yy = c.y0 - R; yy <= c.y0 + c.h - 1 + R; yy++) {
    for (var xx = c.x0 - R; xx <= c.x0 + c.w - 1 + R; xx++) {
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      var inside = xx >= c.x0 && xx <= c.x0 + c.w - 1 && yy >= c.y0 && yy <= c.y0 + c.h - 1;
      if (inside) continue;
      tot++;
      if (gray[yy * w + xx] > thr) bright++;
    }
  }
  return tot ? bright / tot : 0;
}

/* 把组件按近邻聚成「编号串」候选组，并做几何过滤（与 _gen_cands.py 一致） */
function groupCandidates(comps, gray, w, h, thr) {
  var dmax = 26 * w / 1500.0;
  var par = new Int32Array(comps.length);
  for (var i = 0; i < par.length; i++) par[i] = i;
  function find(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
  for (i = 0; i < comps.length; i++) {
    for (var j = i + 1; j < comps.length; j++) {
      var dx = comps[i].cx - comps[j].cx, dy = comps[i].cy - comps[j].cy;
      if (Math.hypot(dx, dy) < dmax) { par[find(i)] = find(j); }
    }
  }
  var groups = {};
  for (i = 0; i < comps.length; i++) {
    var r = find(i);
    (groups[r] = groups[r] || []).push(comps[i]);
  }
  var cands = [];
  for (var k in groups) {
    var g = groups[k];
    if (g.length < 2 || g.length > 8) continue;
    var nring = 0;
    for (i = 0; i < g.length; i++) {
      if (ringBright(gray, w, h, g[i], thr) >= 0.55) nring++;
    }
    if (nring < g.length * 0.75) continue;
    var hs = g.map(function (c) { return c.h; }).sort(function (a, b) { return a - b; });
    var medH = hs[hs.length >> 1];
    var core = g.filter(function (c) { return c.h >= medH * 0.4; });
    if (core.length < 2) continue;
    var mx = 0, my = 0;
    core.forEach(function (c) { mx += c.cx; my += c.cy; });
    mx /= core.length; my /= core.length;
    var sxx = 0, syy = 0, sxy = 0;
    core.forEach(function (c) {
      var ddx = c.cx - mx, ddy = c.cy - my;
      sxx += ddx * ddx; syy += ddy * ddy; sxy += ddx * ddy;
    });
    var ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    var ux = Math.cos(ang), uy = Math.sin(ang);
    var maxdev = 0;
    core.forEach(function (c) {
      var dv = Math.abs(-(c.cx - mx) * uy + (c.cy - my) * ux);
      if (dv > maxdev) maxdev = dv;
    });
    var avgH = 0; core.forEach(function (c) { avgH += c.h; }); avgH /= core.length;
    if (maxdev > 0.65 * avgH) continue;
    var hmin = 1e9, hmax = 0;
    core.forEach(function (c) { if (c.h < hmin) hmin = c.h; if (c.h > hmax) hmax = c.h; });
    if (hmax > hmin * 2.4) continue;
    var ts = g.map(function (c) { return (c.cx - mx) * ux + (c.cy - my) * uy; })
      .sort(function (a, b) { return a - b; });
    var gmin = 1e9, gmax = 0;
    for (i = 0; i < ts.length - 1; i++) {
      var gp = ts[i + 1] - ts[i];
      if (gp < gmin) gmin = gp; if (gp > gmax) gmax = gp;
    }
    if (gmin < 1.2 || gmax > 2.6 * avgH) continue;
    g.sort(function (a, b) {
      return ((a.cx - mx) * ux + (a.cy - my) * uy) - ((b.cx - mx) * ux + (b.cy - my) * uy);
    });
    cands.push({ x: mx, y: my, ang: ang, comps: g });
  }
  return cands;
}

function bil(v, x, y, w, h) {
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  var x0 = x | 0, y0 = y | 0;
  var x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  var dx = x - x0, dy = y - y0;
  return v[y0 * w + x0] * (1 - dx) * (1 - dy) + v[y0 * w + x1] * dx * (1 - dy) +
    v[y1 * w + x0] * (1 - dx) * dy + v[y1 * w + x1] * dx * dy;
}

/* 逐组件字形提取（与 _ocr_lib.extract_glyph 一致）。
 * label: 全图组件标签（屏蔽同组其他组件像素）；本组件无标签数据时传 null。 */
function extractGlyph(gray, W, comp, label, bgv) {
  var x0 = comp.x0, y0 = comp.y0, w = comp.w, h = comp.h;
  var bb = new Array(w * h);
  for (var iy = 0; iy < h; iy++) {
    for (var ix = 0; ix < w; ix++) {
      var gi = (y0 + iy) * W + (x0 + ix);
      bb[iy * w + ix] = (label && label[gi] !== 0 && label[gi] !== comp.id) ? bgv : gray[gi];
    }
  }
  var hist = new Array(256).fill(0);
  for (var i = 0; i < bb.length; i++) hist[bb[i] | 0]++;
  var t = otsuOf(hist, bb.length);
  var th = t * 0.75;
  // 字身轴判据：墨迹 bbox 宽高比（印刷字形高>宽 ~1.4）
  var pts = [];
  for (iy = 0; iy < h; iy++) for (ix = 0; ix < w; ix++) {
    if (bb[iy * w + ix] < th) pts.push(ix, iy);
  }
  var dx, dy;
  if (pts.length >= 10) {
    var gx0 = 1e9, gx1 = 0, gy0 = 1e9, gy1 = 0;
    for (i = 0; i < pts.length; i += 2) {
      if (pts[i] < gx0) gx0 = pts[i]; if (pts[i] > gx1) gx1 = pts[i];
      if (pts[i + 1] < gy0) gy0 = pts[i + 1]; if (pts[i + 1] > gy1) gy1 = pts[i + 1];
    }
    var gwd = gx1 - gx0 + 1, ght = gy1 - gy0 + 1;
    if (gwd >= 1.12 * ght) { dx = 1; dy = 0; }   // 字身水平（横躺字形）
    else { dx = 0; dy = 1; }                      // 字身竖直（正立字形）
  } else { dx = 0; dy = 1; }
  // 采样帧：v 轴(gh) = 字身竖直方向，u 轴(gw) = (dy,-dx)
  var cosv = dy, sinv = -dx;
  var corners = [[0, 0], [w, 0], [0, h], [w, h]];
  var us = [], vs = [];
  for (i = 0; i < 4; i++) {
    us.push(corners[i][0] * cosv + corners[i][1] * sinv);
    vs.push(-corners[i][0] * sinv + corners[i][1] * cosv);
  }
  var U0 = Math.min.apply(null, us), U1 = Math.max.apply(null, us);
  var V0 = Math.min.apply(null, vs), V1 = Math.max.apply(null, vs);
  var DU = U1 - U0, DV = V1 - V0;
  var N = 56;
  var NU = Math.max(8, Math.round(N * DU / Math.max(DU, DV)));
  var NV = Math.max(8, Math.round(N * DV / Math.max(DU, DV)));
  var coarse = new Array(NU * NV);
  for (var jy = 0; jy < NV; jy++) {
    for (var jx = 0; jx < NU; jx++) {
      var su = U0 + DU * (jx + 0.5) / NU, sv = V0 + DV * (jy + 0.5) / NV;
      coarse[jy * NU + jx] = bil(bb, su * cosv - sv * sinv, su * sinv + sv * cosv, w, h);
    }
  }
  var cu = [], cv = [];
  for (jx = 0; jx < NU; jx++) {
    var m = 1e9;
    for (jy = 0; jy < NV; jy++) { var vv = coarse[jy * NU + jx]; if (vv < m) m = vv; }
    cu.push(m);
  }
  for (jy = 0; jy < NV; jy++) {
    m = 1e9;
    for (jx = 0; jx < NU; jx++) { vv = coarse[jy * NU + jx]; if (vv < m) m = vv; }
    cv.push(m);
  }
  var xu = [], yv = [];
  for (jx = 0; jx < NU; jx++) if (cu[jx] < th) xu.push(jx);
  for (jy = 0; jy < NV; jy++) if (cv[jy] < th) yv.push(jy);
  var u0, u1, v0, v1;
  if (!xu.length || !yv.length) { u0 = U0; u1 = U1; v0 = V0; v1 = V1; }
  else {
    var padU = DU / NU, padV = DV / NV;
    u0 = U0 + DU * xu[0] / NU - padU;
    u1 = U0 + DU * (xu[xu.length - 1] + 1) / NU + padU;
    v0 = V0 + DV * yv[0] / NV - padV;
    v1 = V0 + DV * (yv[yv.length - 1] + 1) / NV + padV;
  }
  var du = u1 - u0, dv = v1 - v0;
  var out = new Array(GW * GH);
  for (var ty = 0; ty < GH; ty++) {
    for (var tx = 0; tx < GW; tx++) {
      su = u0 + du * (tx + 0.5) / GW; sv = v0 + dv * (ty + 0.5) / GH;
      out[ty * GW + tx] = bil(bb, su * cosv - sv * sinv, su * sinv + sv * cosv, w, h);
    }
  }
  var sorted = out.slice().sort(function (a, b) { return a - b; });
  var lo = sorted[(sorted.length * 0.05) | 0], hi = sorted[(sorted.length * 0.80) | 0];
  if (hi - lo >= 8) {
    var k2 = 15 / (hi - lo);
    for (i = 0; i < out.length; i++) {
      var q = (out[i] - lo) * k2;
      out[i] = q < 0 ? 0 : (q > 15 ? 15 : q);
    }
  } else {
    for (i = 0; i < out.length; i++) { q = out[i]; out[i] = q < 0 ? 0 : (q > 15 ? 15 : q); }
  }
  return out;
}

function flipBits(b) { return b.slice().reverse(); }

function l1(a, b) {
  var s = 0;
  for (var i = 0; i < a.length; i++) { var d = a[i] - b[i]; s += d < 0 ? -d : d; }
  return s;
}

/* 模板展开：{ cls: [Float32Array...] }，一次性转换供匹配复用 */
var TPL = null;
function baseTemplates() {
  if (TPL) return TPL;
  TPL = {};
  for (var cls in OCR_TEMPLATES) {
    TPL[cls] = OCR_TEMPLATES[cls].map(function (s) {
      var a = new Float32Array(GW * GH);
      for (var i = 0; i < a.length; i++) {
        a[i] = parseInt(s[i], 16);
      }
      return a;
    });
  }
  return TPL;
}

function cloneTemplates() {
  var b = baseTemplates(), t = {};
  for (var cls in b) t[cls] = b[cls].slice();
  return t;
}

/* 4 假设枚举已内联到 recognize()（dash 判序后仅 2 假设） */

/* 每字形对每类模板的最小 L1（含其翻转）：基础池与自举池分开算 */
function glyphDistCache(glyphs, base, dyn, candIdx) {
  var map = new Map();     // key: glyphIdx*2+flipped -> { cls: minBase, dcls: minDyn(src≠self) }
  glyphs.forEach(function (g, gi) {
    [false, true].forEach(function (fl, fi) {
      var bits = fl ? flipBits(g) : g;
      var rec = {}, drec = {};
      for (var cls in base) {
        var m = 1e18;
        var arr = base[cls];
        for (var i = 0; i < arr.length; i++) {
          var d = l1(bits, arr[i]);
          if (d < m) m = d;
        }
        rec[cls] = m;
        if (dyn && dyn[cls]) {
          var md = 1e18;
          dyn[cls].forEach(function (e) {
            if (e.src === candIdx) return;      // 排除自身来源
            var d2 = l1(bits, e.bits);
            if (d2 < md) md = d2;
          });
          drec[cls] = md;
        }
      }
      map.set(gi * 2 + fi, { base: rec, dyn: drec });
    });
  });
  return map;
}

/* 识别一个候选组：返回 { letter, digits, conf, dir, glyphs } 或 null。
 * base: 基础模板池 {cls:[bits]}；dyn: 自举池 {cls:[{bits,src}]}（匹配时排除 src===candIdx 防自我强化） */
function recognize(cand, candIdx, gray, W, label, base, dyn) {
  var glyphs = cand.comps.map(function (c) { return extractGlyph(gray, W, c, label, 235); });
  var cache = glyphDistCache(glyphs, base, dyn, candIdx);
  var n = glyphs.length;
  // dash 位置硬判 order：n=5 组 dash 必在 reading[1]（正序 p=1 / 倒序 p=n-2）
  var hs = cand.comps.map(function (c) { return c.h; }).sort(function (a, b) { return a - b; });
  var med = hs[hs.length >> 1];
  var dpos = [];
  cand.comps.forEach(function (c, i) { if (c.h < med * 0.4) dpos.push(i); });
  var hypDefs;
  if (n === 5 && dpos.length === 1 && (dpos[0] === 1 || dpos[0] === n - 2)) {
    hypDefs = dpos[0] === 1
      ? [["F+", 0, false], ["F-", 0, true]]
      : [["B+", 1, true], ["R+", 1, false]];
  } else {
    hypDefs = [["F+", 0, false], ["B+", 1, true], ["R+", 1, false], ["F-", 0, true]];
  }
  var results = [];
  // 每假设：reading 位置 i 用字形 idxs[i]（rev 决定倒顺，fl 决定是否用翻转距离）
  hypDefs.forEach(function (hd) {
    var name = hd[0], rev = hd[1], fl = hd[2];
    var idxs = [];
    for (var i = 0; i < n; i++) idxs.push(rev ? n - 1 - i : i);
    var score = 0, chars = [];
    for (i = 0; i < n; i++) {
      var gi = idxs[i], rec = cache.get(gi * 2 + (fl ? 1 : 0));
      var pool, cls;
      if (n >= 5) {
        if (i === 0) { pool = LETTERS; }
        else if (i === 1) { pool = ["-"]; }
        else { pool = DIGITS; }
      } else {
        if (i === 0) { pool = LETTERS; } else { pool = DIGITS; }
      }
      // 池内最小（基础池与自举池合并）
      var m = 1e18, mc = null;
      pool.forEach(function (cls2) {
        var d1 = rec.base[cls2], d2 = rec.dyn[cls2];
        var d = Math.min(d1 === undefined ? 1e18 : d1, d2 === undefined ? 1e18 : d2);
        if (d < m) { m = d; mc = cls2; }
      });
      if (mc === null) return;
      score += m; chars.push({ cls: mc, d: m });
    }
    results.push({ name: name, score: score, chars: chars });
  });
  results.sort(function (a, b) { return a.score - b.score; });
  var bestR = results[0];
  if (!bestR || bestR.chars.length !== n) return null;
  var letter = bestR.chars[0].cls;
  var digits = "";
  var dstart = n >= 5 ? 2 : 1;
  for (var i = dstart; i < n; i++) digits += bestR.chars[i].cls;
  var idx = parseInt(digits, 10);
  if (isNaN(idx)) return null;
  // 置信度：平均每格 L1 / 15 → 0..1
  var avgPerCell = bestR.score / (n * GW * GH);
  var conf = Math.max(0, Math.min(1, 1 - avgPerCell / 15 * 4));   // 经验缩放
  return {
    x: cand.x, y: cand.y, letter: letter, digits: digits, idx: idx,
    conf: conf, dir: bestR.name, n: n, glyphs: glyphs,
    comps: cand.comps.map(function (c) { return { x0: c.x0, y0: c.y0, w: c.w, h: c.h }; })
  };
}

/* 主入口：img 为 HTMLImageElement（任意分辨率，内部缩到 3072）。
 * 含「照片内自举」：第一轮全库匹配 → 高置信字形按类别反哺模板池 → 重匹配。
 * 返回识别结果数组（按置信度降序）。 */
export function detectNumbers(img) {
  var sc = Math.min(1, MAXSIDE / Math.max(img.width, img.height));
  var w = Math.round(img.width * sc), h = Math.round(img.height * sc);
  var cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  var cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(img, 0, 0, w, h);
  var d = cx.getImageData(0, 0, w, h).data;
  var gray = new Uint8Array(w * h);
  for (var i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) | 0;
  }
  var dc = darkComponents(gray, w, h);
  var cands = groupCandidates(dc.comps, gray, w, h, dc.thr);
  var base = baseTemplates();
  var dyn = null;
  var results = [];
  for (var round = 0; round < 3; round++) {
    results = [];
    cands.forEach(function (cand, ci) {
      var r = recognize(cand, ci, gray, w, dc.label, base, dyn);
      if (r && r.conf > 0.12) results.push(r);
    });
    // 自举：收集本轮高置信字形（每类限 6 个，防止误结果主导）
    if (round === 1) break;
    var perCls = {};
    dyn = {};
    var good = results.filter(function (r) { return r.conf >= 0.62 && r.n >= 4; })
      .sort(function (a, b) { return b.conf - a.conf; });
    good.forEach(function (r) {
      var ci = cands.indexOf(cands.find(function (cd) { return cd.x === r.x && cd.y === r.y; }));
      var seq = r.n >= 5 ? [r.letter, "-", r.digits[0], r.digits[1], r.digits[2]]
                         : [r.letter, r.digits[0], r.digits[1], r.digits[2]];
      var rev = (r.dir === "B+" || r.dir === "R+");
      var fl = (r.dir === "B+" || r.dir === "F-");
      var order = r.glyphs.map(function (g, i2) { return rev ? r.glyphs.length - 1 - i2 : i2; });
      for (var k = 0; k < seq.length && k < order.length; k++) {
        var cls = seq[k];
        if (cls === "?") continue;
        perCls[cls] = perCls[cls] || 0;
        if (perCls[cls] >= 6) continue;
        var bits = r.glyphs[order[k]];
        if (fl) bits = flipBits(bits);
        var arr = dyn[cls] = dyn[cls] || [];
        var dup = arr.some(function (e) { return l1(bits, e.bits) < 60; });
        if (!dup) { arr.push({ bits: Float32Array.from(bits), src: ci }); perCls[cls]++; }
      }
    });
  }
  results.sort(function (a, b) { return b.conf - a.conf; });
  return results;
}
