# -*- coding: utf-8 -*-
"""OCR 共享库：字形提取（紧bbox + 双线性亚像素采样 + 色阶归一）与匹配"""
import math, json
from PIL import Image

MAXSIDE = 3072
GW, GH = 24, 32

_photo_cache = {}
def photo_gray(path):
    if path in _photo_cache: return _photo_cache[path]
    im0 = Image.open(path).convert('L')
    sc = min(1.0, MAXSIDE/max(im0.size))
    W, H = round(im0.width*sc), round(im0.height*sc)
    im = im0.resize((W, H), Image.BILINEAR)
    px = im.load()
    gray = [px[x, y] for y in range(H) for x in range(W)]
    _photo_cache[path] = (gray, W, H)
    return gray, W, H

def otsu(vals):
    hist = [0]*256
    for v in vals: hist[int(v)] += 1
    tot = len(vals); sumall = sum(t*hist[t] for t in range(256))
    sumB = wB = 0; best = -1; thr = 127
    for k in range(256):
        wB += hist[k]
        if wB == 0: continue
        wF = tot-wB
        if wF == 0: break
        sumB += k*hist[k]
        b = wB*wF*((sumB/wB)-((sumall-sumB)/wF))**2
        if b > best: best = b; thr = k
    return thr

def bil(v, x, y, w, h):
    x = max(0.0, min(w-1.0, x)); y = max(0.0, min(h-1.0, y))
    x0, y0 = int(x), int(y)
    x1 = min(w-1, x0+1); y1 = min(h-1, y0+1)
    dx, dy = x-x0, y-y0
    return (v[y0*w+x0]*(1-dx)*(1-dy) + v[y0*w+x1]*dx*(1-dy) +
            v[y1*w+x0]*(1-dx)*dy + v[y1*w+x1]*dx*dy)

def hex2set(hx, w, h):
    """掩膜 hex -> 绝对坐标偏移集合（相对组件 bbox 左上角）"""
    v = int(hx, 16) if hx else 0
    s = set()
    for i in range(w*h):
        if v & (1 << (w*h-1-i)):
            s.add((i % w, i // w))
    return s

def extract_glyph(gray, W, comp, ang, own=None, others=None, bgv=None, gw=GW, gh=GH):
    """comp: {x0,y0,w,h,m?}; own: 本组件掩膜 set（局部坐标）；others: 其余组件 [(x0,y0,w,h,set)]。
    返回 (gw*gh) 软位图 0-15，字形正立化视图。
    核心策略：组件墨迹 PCA 长轴 = 字身竖直轴（数字字形高>宽），
    彻底兼容横排/竖排/斜排/字符正立竖排；剩余 180° 二义由 4 假设匹配兜底。"""
    x0, y0, w, h = comp['x0'], comp['y0'], comp['w'], comp['h']
    # 组件内灰度：屏蔽其他组件的像素（视为背景）
    bb = []
    for iy in range(h):
        for ix in range(w):
            v = gray[(y0+iy)*W + x0+ix]
            if others and bgv is not None:
                for ox0, oy0, ow, oh, oset in others:
                    if ox0 <= x0+ix < ox0+ow and oy0 <= y0+iy < oy0+oh:
                        if (x0+ix-ox0, y0+iy-oy0) in oset:
                            v = bgv
                            break
            bb.append(v)
    t = otsu(bb)
    th = t*0.75
    # 字身轴判据：墨迹（局部阈值）bbox 宽高比。印刷字形高>宽（~1.4），
    # h 明显大于 w → 字身竖直；反之水平；方形字（0/8）代价低默认竖直。
    pts = [(ix, iy) for iy in range(h) for ix in range(w) if bb[iy*w+ix] < th]
    if len(pts) >= 5:
        xs_ = [p[0] for p in pts]; ys_ = [p[1] for p in pts]
        gw_ = max(xs_)-min(xs_)+1; gh_ = max(ys_)-min(ys_)+1
        if gw_ >= 1.12*gh_:
            d = (1.0, 0.0)     # 字身水平（横躺字形）
        else:
            d = (0.0, 1.0)     # 字身竖直（正立字形）
    else:
        d = (0.0, 1.0)
    dx, dy = d
    # 采样帧：v 轴(gh) = 长轴 d，u 轴(gw) = (dy,-dx)，右手系
    # 即令 cosv=dy, sinv=-dx，沿用 sx=su*cosv-sv*sinv 公式
    cosv, sinv = dy, -dx
    corners = [(0,0),(w,0),(0,h),(w,h)]
    us = [x*cosv + y*sinv for x, y in corners]
    vs = [-x*sinv + y*cosv for x, y in corners]
    U0, U1 = min(us), max(us); V0, V1 = min(vs), max(vs)
    DU, DV = U1-U0, V1-V0
    # 旋转域粗网格 → 投影紧 bbox（含 1 格边距）
    N = 56
    NU = max(8, round(N*DU/max(DU, DV)))
    NV = max(8, round(N*DV/max(DU, DV)))
    coarse = []
    for jy in range(NV):
        for jx in range(NU):
            su = U0 + DU*(jx+0.5)/NU
            sv = V0 + DV*(jy+0.5)/NV
            sx = su*cosv - sv*sinv
            sy = su*sinv + sv*cosv
            coarse.append(bil(bb, sx, sy, w, h))
    cu = [min(coarse[jy*NU+jx] for jy in range(NV)) for jx in range(NU)]
    cv = [min(coarse[jy*NU+jx] for jx in range(NU)) for jy in range(NV)]
    xu = [jx for jx in range(NU) if cu[jx] < th]
    yv = [jy for jy in range(NV) if cv[jy] < th]
    if not xu or not yv:
        u0, u1, v0, v1 = U0, U1, V0, V1
    else:
        pad_u = DU/NU*1.0; pad_v = DV/NV*1.0
        u0 = U0 + DU*xu[0]/NU - pad_u
        u1 = U0 + DU*(xu[-1]+1)/NU + pad_u
        v0 = V0 + DV*yv[0]/NV - pad_v
        v1 = V0 + DV*(yv[-1]+1)/NV + pad_v
    du, dv = u1-u0, v1-v0
    out = []
    for ty in range(gh):
        for tx in range(gw):
            su = u0 + du*(tx+0.5)/gw
            sv = v0 + dv*(ty+0.5)/gh
            sx = su*cosv - sv*sinv
            sy = su*sinv + sv*cosv
            out.append(bil(bb, sx, sy, w, h))
    # 色阶归一化
    s = sorted(out)
    lo = s[int(len(s)*0.05)]; hi = s[int(len(s)*0.80)]
    if hi - lo >= 8:
        out = [max(0.0, min(15.0, (x-lo)*15/(hi-lo))) for x in out]
    else:
        out = [max(0.0, min(15.0, x)) for x in out]
    return out

def l1(a, b): return sum(abs(x-y) for x, y in zip(a, b))
def flip(b): return b[::-1]
def conf(d, n): return 1 - d/(n*15)

def load_cands(path='study/_cands.json'):
    return json.load(open(path, encoding='utf-8'))

def cand_glyphs(cand, bgv=235):
    """候选全部字形的统一提取入口（PCA 自适应正立化 + 邻字屏蔽）"""
    gray, W, H = photo_gray(cand['photo'])
    own_list, others_list, _ = cand_masks(cand, bgv)
    out = []
    for i, cc in enumerate(cand['comps']):
        out.append(extract_glyph(gray, W, cc, cand['ang'], own_list[i], others_list[i], bgv))
    return out

def cand_masks(cand, bgv=None):
    """返回 (own_list, others_list, bgv)：每组件的自身掩膜与其余组件掩膜列表。
    无掩膜数据时对应项为 None。"""
    comps = cand['comps']
    has_m = all('m' in c for c in comps)
    sets = [hex2set(c['m'], c['w'], c['h']) if has_m else None for c in comps]
    own_list = list(sets)
    others_list = []
    for i in range(len(comps)):
        if not has_m:
            others_list.append(None); continue
        others_list.append([(comps[j]['x0'], comps[j]['y0'], comps[j]['w'], comps[j]['h'], sets[j])
                            for j in range(len(comps)) if j != i])
    return own_list, others_list, bgv
