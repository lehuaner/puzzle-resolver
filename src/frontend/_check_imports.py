# -*- coding: utf-8 -*-
"""静态检查 v2：
1. 剥掉字符串/注释/正则后再找“用到但未 import/未声明”的标识符
2. 反向检查：import 了但本模块没用到的名字
"""
import re, io, os

GLOBALS = set("""
document window localStorage Math JSON Object Array Set Map Uint8Array Int32Array
Number String Boolean Date navigator location history Blob FileReader Image URL
confirm prompt alert setTimeout clearTimeout setInterval clearInterval Error
isNaN isFinite parseInt parseFloat console WebSocket CustomEvent Event
""".split())

IDENT = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
REGEX_PREV = set("(,=:[!&|?{;")

def strip_noise(code):
    """把字符串/注释/正则字面量替换为等长空格，保留行号结构"""
    out = list(code)
    i, n = 0, len(code)
    prev = ""
    while i < n:
        ch = code[i]
        if ch == "/" and i+1 < n and code[i+1] == "/":
            j = code.find("\n", i); j = n if j < 0 else j
            for k in range(i, j): out[k] = " "
            i = j; continue
        if ch == "/" and i+1 < n and code[i+1] == "*":
            j = code.find("*/", i+2); j = n if j < 0 else j+2
            for k in range(i, j):
                if out[k] != "\n": out[k] = " "
            i = j; continue
        if ch in "\"'":
            q = ch; j = i+1
            while j < n:
                if code[j] == "\\": j += 2; continue
                if code[j] == q: break
                j += 1
            for k in range(i, min(j+1, n)):
                if out[k] != "\n": out[k] = " "
            i = j+1; prev = q; continue
        if ch == "/" and (prev == "" or prev in REGEX_PREV):
            j = i+1; in_class = False
            while j < n:
                c = code[j]
                if c == "\\": j += 2; continue
                if c == "\n": break
                if in_class:
                    if c == "]": in_class = False
                else:
                    if c == "[": in_class = True
                    elif c == "/": break
                j += 1
            for k in range(i, min(j+1, n)):
                if out[k] != "\n": out[k] = " "
            i = j+1; prev = "/"; continue
        m = IDENT.match(code, i)
        if m:
            prev = m.group(0)[-1]; i = m.end(); continue
        if not ch.isspace(): prev = ch
        i += 1
    return "".join(out)

DECL = re.compile(r"(?:^|\n)\s*(?:export\s+)?(?:var|function)\s+([A-Za-z_$][\w$]*)")
PARAM = re.compile(r"function\s*[\w$]*\s*\(([^)]*)\)")

ok = True
files = sorted(x for x in os.listdir(".") if x.endswith(".js"))
# ---- 可达性检查：除 main.js 外，每个模块都必须被某个模块 import（否则是孤儿，监听不会注册） ----
imported_by = {}
for f in files:
    src0 = io.open(f, encoding="utf-8").read()
    for m in re.finditer(r'import\s*(?:\{[^}]*\}|[A-Za-z_$][\w$]*)?\s*(?:from\s*)?"\./([\w$.]+)"', src0):
        imported_by.setdefault(m.group(1), []).append(f)
for f in files:
    if f == "main.js": continue
    if f not in imported_by:
        ok = False
        print("%-14s 孤儿模块：没有任何模块 import 它" % f)

for f in sorted(x for x in os.listdir(".") if x.endswith(".js")):
    src = io.open(f, encoding="utf-8").read()
    clean = strip_noise(src)
    imported = {}
    for m in re.finditer(r"import\s*\{([^}]*)\}\s*from", src):
        for name in m.group(1).split(","):
            name = name.strip()
            if name: imported[name] = True
    declared = set(DECL.findall(src))
    for m in PARAM.finditer(src):
        for p in m.group(1).split(","):
            p = p.strip()
            if p and re.fullmatch(r"[A-Za-z_$][\w$]*", p): declared.add(p)
    known = set(imported) | declared | GLOBALS
    used = set()
    for m in re.finditer(r"(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(", clean):
        used.add(m.group(1))
    missing = sorted(u for u in used if u not in known)
    unused = sorted(n for n in imported if not re.search(r"(?<![.\w$])" + re.escape(n) + r"(?![\w$])", clean))
    if missing:
        ok = False
        print("%-14s 缺失: %s" % (f, ", ".join(missing)))
    if unused:
        print("%-14s 未用: %s" % (f, ", ".join(unused)))
print("ALL OK" if ok else "有问题需要修")
