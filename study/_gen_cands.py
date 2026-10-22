# -*- coding: utf-8 -*-
"""检出编号 → 导出裁剪对照大图（供目视读数）+ 字形数据 JSON"""
from PIL import Image, ImageDraw
import math, json, os

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))   # 项目根（本脚本在 study/ 下）

SRCs = ['public/85890.jpg', 'public/85891.jpg', 'public/85892.jpg']
W_T, H_T = 12, 16
MAXSIDE = 3072

def otsu_of(px, W, H):
    hist = [0]*256
    for y in range(H):
        for x in range(W): hist[px[x, y]] += 1
    tot = W*H
    sumall = sum(t*hist[t] for t in range(256))
    sumB = wB = 0; best = -1; thr = 127
    for k in range(256):
        wB += hist[k]
        if wB == 0: continue
        wF = tot-wB
        if wF == 0: break
        sumB += k*hist[k]
        mB = sumB/wB; mF = (sumall-sumB)/wF
        b = wB*wF*(mB-mF)**2
        if b > best: best = b; thr = k
    return thr

def norm_rot(bits, w, h, cosv, sinv, gray=None):
    """gray: 与 bits 同尺寸的灰度数组；提供时同时输出软位图（0-15）"""
    corners = [(0,0),(w,0),(0,h),(w,h)]
    us = [x*cosv + y*sinv for x, y in corners]
    vs = [-x*sinv + y*cosv for x, y in corners]
    u0, u1 = min(us), max(us); v0, v1 = min(vs), max(vs)
    du, dv = u1-u0, v1-v0
    out = []
    soft = []
    for ty in range(H_T):
        for tx in range(W_T):
            su0 = u0 + du*tx/W_T; su1 = u0 + du*(tx+1)/W_T
            sv0 = v0 + dv*ty/H_T; sv1 = v0 + dv*(ty+1)/H_T
            n = su = sg = 0
            y = sv0
            while y < sv1:
                x = su0
                while x < su1:
                    sx = x*cosv - y*sinv; sy = x*sinv + y*cosv
                    ix, iy = int(sx), int(sy)
                    if 0 <= ix < w and 0 <= iy < h:
                        su += bits[iy*w+ix]; n += 1
                        if gray is not None: sg += gray[iy*w+ix]
                    x += 1
                y += 1
            if n == 0:
                cxu = (su0+su1)/2; cyv = (sv0+sv1)/2
                sx = cxu*cosv - cyv*sinv; sy = cxu*sinv + cyv*cosv
                ix, iy = int(sx), int(sy)
                if 0 <= ix < w and 0 <= iy < h:
                    out.append(bits[iy*w+ix])
                    soft.append(gray[iy*w+ix] >> 4 if gray is not None else 0)
                else:
                    out.append(0); soft.append(15)
            else:
                out.append(1 if su*2 >= n else 0)
                soft.append(min(15, int(sg/n) >> 4) if gray is not None else 0)
    return out, soft

def flip(b): return b[::-1]

def bits2hex(bits):
    nb = (len(bits) + 3) // 4
    v = 0
    for b in bits: v = (v << 1) | b
    return '%0*x' % (nb, v)

cands = []    # {id, photo, cx, cy, ang, glyphs:[{h, isDash, A, B}]}  A=沿+u读
crops = []    # (id, PIL crop)
for SRC in SRCs:
    im0 = Image.open(SRC).convert('L')
    sc = min(1.0, MAXSIDE/max(im0.size))
    W, H = round(im0.width*sc), round(im0.height*sc)
    im = im0.resize((W, H), Image.BILINEAR)
    px = im.load()
    thr = otsu_of(px, W, H)
    dark = bytearray(W*H)
    gray = [0]*(W*H)
    for y in range(H):
        for x in range(W):
            gray[y*W+x] = px[x, y]
            if px[x, y] < thr*0.80: dark[y*W+x] = 1
    dlab = [0]*(W*H); comps = []
    for s in range(W*H):
        if not dark[s] or dlab[s]: continue
        stack = [s]; dlab[s] = 1; pts = []
        while stack:
            q = stack.pop(); pts.append(q)
            qx, qy = q % W, q // W
            for nx, ny in ((qx-1,qy),(qx+1,qy),(qx,qy-1),(qx,qy+1)):
                if 0 <= nx < W and 0 <= ny < H:
                    j = ny*W+nx
                    if dark[j] and not dlab[j]: dlab[j] = 1; stack.append(j)
        n = len(pts)
        if n < 16: continue
        xs = [p % W for p in pts]; ys = [p // W for p in pts]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        if (x1-x0) > 90 or (y1-y0) > 60: continue
        bits = [0]*((x1-x0+1)*(y1-y0+1))
        for p in pts:
            bits[(p//W - y0)*(x1-x0+1) + (p % W - x0)] = 1
        comps.append(dict(cx=sum(xs)/n, cy=sum(ys)/n, n=n, x0=x0, x1=x1, y0=y0, y1=y1,
                          h=y1-y0+1, bits=bits, w=x1-x0+1))
    par = list(range(len(comps)))
    def find(a):
        while par[a] != a: par[a] = par[par[a]]; a = par[a]
        return a
    dmax = 26*W/1500.0
    for i in range(len(comps)):
        for j in range(i+1, len(comps)):
            if math.hypot(comps[i]['cx']-comps[j]['cx'], comps[i]['cy']-comps[j]['cy']) < dmax:
                par[find(i)] = find(j)
    groups = {}
    for i in range(len(comps)): groups.setdefault(find(i), []).append(comps[i])
    nok = 0
    for g in groups.values():
        if not (2 <= len(g) <= 8): continue
        hs_all = [c['h'] for c in g]
        med_h = sorted(hs_all)[len(hs_all)//2]
        core = [c for c in g if c['h'] >= med_h*0.4]
        if len(core) < 2: continue
        mx = sum(c['cx'] for c in core)/len(core); my = sum(c['cy'] for c in core)/len(core)
        sxx = sum((c['cx']-mx)**2 for c in core); syy = sum((c['cy']-my)**2 for c in core)
        sxy = sum((c['cx']-mx)*(c['cy']-my) for c in core)
        ang = 0.5*math.atan2(2*sxy, sxx-syy)
        ux, uy = math.cos(ang), math.sin(ang)
        maxdev = max(abs(-(c['cx']-mx)*uy+(c['cy']-my)*ux) for c in core)
        hs = [c['h'] for c in core]
        if maxdev > 0.65*sum(hs)/len(hs): continue
        if max(hs) > min(hs)*2.4: continue
        ts = sorted((c['cx']-mx)*ux+(c['cy']-my)*uy for c in g)
        gaps = [ts[i+1]-ts[i] for i in range(len(ts)-1)]
        if min(gaps) < 1.2 or max(gaps) > 2.6*sum(hs)/len(hs): continue
        nring = 0
        for c in g:
            R = 3; b = t = 0
            for yy in range(c['y0']-R, c['y1']+R+1):
                for xx in range(c['x0']-R, c['x1']+R+1):
                    if not (0 <= xx < W and 0 <= yy < H): continue
                    if c['x0'] <= xx <= c['x1'] and c['y0'] <= yy <= c['y1']: continue
                    t += 1
                    if px[xx, yy] > thr: b += 1
            if t and b >= t*0.55: nring += 1
        if nring < len(g)*0.75: continue
        nok += 1
        # 沿 +u 排序；连接号 = 最矮组件
        items = sorted(g, key=lambda c: (c['cx']-mx)*ux + (c['cy']-my)*uy)
        min_h = min(c['h'] for c in items)
        glyphs = []
        for c in items:
            # 帧修复：x 轴 = 检测排序轴 (cos ang, sin ang)，y 轴 = (-sin ang, cos ang)
            cosv = math.cos(ang); sinv = math.sin(ang)
            # 灰度数组裁剪到该组件 bbox
            ggray = [gray[(c['y0']+iy)*W + c['x0']+ix] for iy in range(c['h']) for ix in range(c['w'])]
            a, s = norm_rot(c['bits'], c['w'], c['h'], cosv, sinv, ggray)
            glyphs.append(dict(h=c['h'], isDash=c['h'] < med_h*0.4,
                               A=''.join(map(str, a)), B=''.join(map(str, flip(a))),
                               S=''.join('%x' % v for v in s)))
        cid = len(cands)
        cands.append(dict(id=cid, photo=SRC, cx=round(mx), cy=round(my),
                          ang=round(ang, 3), glyphs=glyphs,
                          comps=[dict(x0=c['x0'], y0=c['y0'], w=c['w'], h=c['h'],
                                      m=bits2hex(c['bits'])) for c in items],
                          thr=thr, scale=sc))
        # 裁剪（原图分辨率，以检测中心为准）
        R = 42
        fx = mx/sc; fy = my/sc
        fx0 = max(0, int(fx-R/sc)); fy0 = max(0, int(fy-R/sc))
        fx1 = min(im0.width, int(fx+R/sc)); fy1 = min(im0.height, int(fy+R/sc))
        cp = im0.crop((fx0, fy0, fx1, fy1)).resize(((fx1-fx0)*4, (fy1-fy0)*4), Image.LANCZOS)
        crops.append((cid, cp))
    print('%s: numbers=%d' % (SRC, nok))

json.dump(cands, open('study/_cands.json', 'w'))
print('candidates:', len(cands))

# ---- 拼大图：每格 = 裁剪 + id ----
COLS = 8
CELL = 340
rows = math.ceil(len(crops)/COLS)
sheet = Image.new('L', (COLS*CELL, rows*(CELL+22)), 255)
dr = ImageDraw.Draw(sheet)
for k, (cid, cp) in enumerate(crops):
    gx = (k % COLS)*CELL; gy = (k // COLS)*(CELL+22)
    cp2 = cp.copy()
    cp2.thumbnail((CELL-8, CELL-8))
    sheet.paste(cp2, (gx+4, gy+20))
    dr.text((gx+6, gy+4), '#%d' % cid, fill=0)
    dr.rectangle([gx, gy, gx+CELL-1, gy+CELL+21], outline=160)
sheet.save('study/_cands_sheet.png')
print('sheet saved: _cands_sheet.png', sheet.size)
