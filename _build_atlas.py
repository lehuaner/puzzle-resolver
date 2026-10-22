# -*- coding: utf-8 -*-
"""构建器 v5：_ocr_lib 表示（24x32 双线性紧bbox）+ 种子锚定 + 2假设扩展 + LOO + 输出 JS"""
import json, sys, math
sys.path.insert(0, '.')
from _ocr_lib import l1, flip, load_cands, photo_gray, extract_glyph, cand_glyphs

cands = load_cands()
labels = json.load(open('_labels.json', encoding='utf-8'))
SEED = {0: (('B', 'T'), 'B363'), 1: (('B', 'T'), 'B339'), 2: (('B', 'T'), 'B340'),
        3: (('F', 'T'), 'B337'), 4: (('B', 'T'), 'B338'), 5: (('B', 'T'), 'B313'),
        6: (('B', 'T'), 'B314'), 7: (('B', 'T'), 'B311'), 8: (('B', 'T'), 'B312'),
        11: (('F', 'T'), 'B287'), 12: (('B', 'T'), 'B288'), 13: (('B', 'T'), 'B286'),
        60: (('F', 'F'), 'C644'), 61: (('F', 'F'), 'C691'), 65: (('B', 'T'), 'C544'),
        82: (('F', 'F'), 'B423')}
info = {c['id']: c for c in cands}
LETTERS = list('ABCD')
DIGITS = [str(x) for x in range(10)]

_gcache = {}
def glyphs(cid):
    if cid not in _gcache:
        _gcache[cid] = cand_glyphs(info[cid])
    return _gcache[cid]

def reading_of(cid, order, fl):
    A = glyphs(cid)
    seq = A if order == 'F' else A[::-1]
    return [b if fl == 'F' else flip(b) for b in seq]

def extract(assign):
    by_cls = {}
    for cid, (order, fl) in assign.items():
        lab = labels.get(str(cid))
        if not lab: continue
        seq = reading_of(cid, order, fl)
        if info[cid]['n'] if False else len(seq) == 5:
            pairs = [(lab[0], seq[0]), ('-', seq[1]), (lab[1], seq[2]), (lab[2], seq[3]), (lab[3], seq[4])]
        elif len(seq) == 4:
            pairs = [(lab[0], seq[0]), (lab[1], seq[1]), (lab[2], seq[2]), (lab[3], seq[3])]
        else:
            continue
        for cls, b in pairs:
            if cls == '?': continue
            by_cls.setdefault(cls, []).append((cid, b))
    return by_cls

def score_reading(reading, n, by_cls, exclude_id=None):
    def best(bits, pool):
        m = 1e18
        for cls in pool:
            for cid, tb in by_cls.get(cls, ()):
                if cid == exclude_id: continue
                d = l1(bits, tb)
                if d < m: m = d
        return m
    pos_d = (2, 3, 4) if n == 5 else (1, 2, 3)
    sc = best(reading[0], LETTERS)
    if n == 5:
        sc += best(reading[1], ['-'])
    for p in pos_d:
        sc += best(reading[p], DIGITS)
    return sc

def assign_all(by_cls, direction, frozen, margin_min):
    chg = 0
    HYP = {'F+': ('F', 'F'), 'B+': ('B', 'T'), 'R+': ('B', 'F'), 'F-': ('F', 'T')}
    for cid in info:
        lab = labels.get(str(cid))
        if not lab or lab[0] == '?' or len(info[cid]['comps']) < 4 or cid in frozen: continue
        n = len(info[cid]['comps'])
        A = glyphs(cid)
        hyps = [('F+', list(A)), ('B+', [flip(b) for b in A[::-1]]),
                ('R+', list(reversed(A))), ('F-', [flip(b) for b in A])]
        scored = sorted((score_reading(r, n, by_cls, cid), nm) for nm, r in hyps)
        if scored[1][0] - scored[0][0] < margin_min: continue
        nd = HYP[scored[0][1]]
        if cid in direction and direction[cid] != nd: chg += 1
        direction[cid] = nd
    return chg

direction = dict(SEED)
frozen = set(SEED)
by_cls = extract(direction)
for it in range(4):
    chg = assign_all(by_cls, direction, frozen, margin_min=150)
    by_cls = extract(direction)
    n_assigned = len(direction)
    print('迭代%d: 已定向 %d, 变更 %d' % (it, n_assigned, chg))
    # 不提前 break：跑满 4 轮让门控候选间互相校正

cnt = {}
for cls, lst in by_cls.items(): cnt[cls] = len(lst)
print('样本分布:', dict(sorted(cnt.items())))

# ---- LOO 端到端 ----
ok_num = ok_letter = tot = 0
margins = []
for cid in info:
    lab = labels.get(str(cid))
    if not lab or '?' in lab or len(info[cid]['comps']) < 4: continue
    tot += 1
    n = len(info[cid]['comps'])
    rdF = reading_of(cid, 'F', 'F')
    rdB = reading_of(cid, 'B', 'T')
    sF = score_reading(rdF, n, by_cls, cid)
    sB = score_reading(rdB, n, by_cls, cid)
    margins.append(abs(sF - sB) / (5 if n == 5 else 4))
    rd, drn = (rdF, 'F') if sF <= sB else (rdB, 'B')
    pos_d = (2, 3, 4) if n == 5 else (1, 2, 3)
    def bm(bits, pool):
        bestc, bd = None, 1e18
        for cls in pool:
            for xid, tb in by_cls.get(cls, ()):
                if xid == cid: continue
                d = l1(bits, tb)
                if d < bd: bd, bestc = d, cls
        return bestc, bd
    bl, _ = bm(rd[0], LETTERS)
    dg = ''.join(bm(rd[p], DIGITS)[0] for p in pos_d)
    if bl == lab[0]: ok_letter += 1
    if bl == lab[0] and dg == lab[1:]:
        ok_num += 1
    else:
        print('  误判 #%d %s -> %s%s (%s)' % (cid, lab, bl, dg, drn))
print('字母级: %d/%d = %.1f%%' % (ok_letter, tot, ok_letter*100/tot))
print('整号级: %d/%d = %.1f%%' % (ok_num, tot, ok_num*100/tot))
margins.sort()
print('平均位置信差 min/p5/p50: %.3f %.3f %.3f' % (margins[0], margins[len(margins)//20], margins[len(margins)//2]))

# ---- 输出模板库 ----
out = {}
for cls in sorted(by_cls):
    lst = by_cls[cls]
    sel, seen = [], []
    for cid, b in lst:
        if any(l1(b, sb) < 200 for sb in seen): continue
        seen.append(b); sel.append(b)
        if len(sel) >= 8: break
    if len(sel) < 2: sel = [b for _, b in lst[:8]]
    out[cls] = sel
print('模板类:', {k: len(v) for k, v in sorted(out.items())})

js = ['// 自动生成：拼图片上印刷编号字形模板库（24x32 软位图，0-15 墨度，基线对齐正视图）',
      '// 运行时 L1 最近邻匹配；反向用 180° 翻转比较',
      'export const OCR_TEMPLATES = {']
for cls in sorted(out):
    js.append("  '%s': [" % cls)
    for b in out[cls]:
        js.append("    '%s'," % ''.join('%x' % round(v) for v in b))
    js.append('  ],')
js.append('};')
open('src/frontend/ocr-templates.js', 'w', encoding='utf-8').write('\n'.join(js) + '\n')
print('written: src/frontend/ocr-templates.js (%d bytes)' % len('\n'.join(js)))

# ---- 验证条 ----
from PIL import Image, ImageDraw
SC = 5
strips = []
for cid in sorted(info):
    lab = labels.get(str(cid))
    if not lab or cid not in direction or len(info[cid]['comps']) < 4: continue
    order, fl = direction[cid]
    reading = reading_of(cid, order, fl)
    imgs = []
    for b in reading:
        im = Image.new('L', (24, 32))
        im.putdata([int(v)*17 for v in b])
        imgs.append(im.resize((24*SC, 32*SC), Image.NEAREST))
    w = sum(i.width for i in imgs) + 6*(len(imgs)-1)
    strip = Image.new('L', (w, 32*SC), 255)
    x = 0
    for i in imgs:
        strip.paste(i, (x, 0)); x += i.width + 6
    strips.append((cid, lab, '%s%s' % (order, fl), strip))
PER = 10
import math as _m
for si in range(0, len(strips), PER):
    chunk = strips[si:si+PER]
    W = max(220 + s.width for _, _, _, s in chunk)
    sheet = Image.new('L', (W, len(chunk)*(32*SC+24)), 255)
    dr = ImageDraw.Draw(sheet)
    y = 0
    for cid, lab, drn, s in chunk:
        dr.text((4, y+6), '#%d %s %s' % (cid, lab, drn), fill=0)
        sheet.paste(s, (220, y))
        y += 32*SC + 24
    sheet.save('_verify_%d.png' % (si//PER))
print('验证条: %d 张' % _m.ceil(len(strips)/PER))
