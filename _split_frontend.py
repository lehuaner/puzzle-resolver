# -*- coding: utf-8 -*-
"""把 puzzle-map.html（v8 单文件）拆成 ESM 模块。
只做机械变换：切片 + 跳过字符串/注释/正则的标识符改名 + 加 export。
"""
import re, os, io

SRC = "puzzle-map.html"
OUT = "src/frontend"
os.makedirs(OUT, exist_ok=True)

raw = io.open(SRC, encoding="utf-8").read()
lines = raw.split("\n")           # lines[N-1] == 第 N 行

def seg(a, b):                    # 1-based 含端点
    return "\n".join(lines[a-1:b])

# ---------- 需要收进共享 store 的模块级变量 ----------
RENAME = {"cfg","states","rows","adj","cellSize","gap","step","contentW","contentH",
          "tx","ty","scale","viewZone","batchMode","sel","undoStack",
          "board","wrap","zonesEl","zVal","mm","boardId","boardName"}
# cells 单独处理（flushChanges 有局部同名变量、applyRemoteCells 有同名参数）

IDENT = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
REGEX_PREV = set("(,=:[!&|?{;")   # 这些字符后面的 / 是正则开头

def transform(code):
    out = []
    i, n = 0, len(code)
    prev = ""                      # 上一个有意义字符
    while i < n:
        ch = code[i]
        if ch == "/" and i+1 < n and code[i+1] == "/":        # 行注释
            j = code.find("\n", i);  j = n if j < 0 else j
            out.append(code[i:j]); i = j; continue
        if ch == "/" and i+1 < n and code[i+1] == "*":        # 块注释
            j = code.find("*/", i+2); j = n if j < 0 else j+2
            out.append(code[i:j]); i = j; continue
        if ch in "\"'":                                         # 字符串
            q = ch; j = i+1
            while j < n:
                if code[j] == "\\": j += 2; continue
                if code[j] == q: break
                j += 1
            out.append(code[i:j+1]); i = j+1; prev = q; continue
        if ch == "/" and (prev == "" or prev in REGEX_PREV):   # 正则字面量
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
            out.append(code[i:j+1]); i = j+1; prev = "/"; continue
        m = IDENT.match(code, i)
        if m:
            w = m.group(0)
            k = m.end()
            while k < n and code[k] in " \t": k += 1
            nxt = code[k] if k < n else ""
            if w in RENAME and nxt != ":" and prev != ".":             # 对象键/标签/属性访问不改名
                out.append("S." + w)
            else:
                out.append(w)
            prev = w[-1]; i = m.end(); continue
        if not ch.isspace(): prev = ch
        out.append(ch); i += 1
    return "".join(out)

def add_exports(body, names):
    for name in names:
        body = re.sub(r"(?m)^(\s*)(function\s+%s\()" % re.escape(name), r"\1export \2", body)
        body = re.sub(r"(?m)^(\s*)((?:var|const)\s+%s\b)" % re.escape(name), r"\1export \2", body)
    return body

def write_module(fname, imports, ranges, exports, edits=None, extra_head="", extra_tail=""):
    body = "\n".join(seg(a, b) for a, b in ranges)
    if edits:
        for old, new in edits:
            assert old in body, "编辑点没找到: %r" % old[:60]
            body = body.replace(old, new)
    body = transform(body)
    body = add_exports(body, exports)
    text = imports.rstrip("\n") + "\n\n" + extra_head + body + extra_tail
    io.open(os.path.join(OUT, fname), "w", encoding="utf-8", newline="\n").write(text)
    print("written %-14s %5d bytes" % (fname, len(text.encode("utf-8"))))

# ================= 各模块 =================

# ---- dom.js：$ / vibrate / toast / esc / ago ----
write_module("dom.js", "", [
    (584, 584),      # $
    (1195, 1195),    # vibrate
    (2291, 2296),    # toastTimer + toast
    (2324, 2333),    # esc + ago
], ["$", "vibrate", "toast", "esc", "ago"])

# ---- coords.js：编号坐标 + 大区工具 ----
write_module("coords.js", 'import { S } from "./store.js";', [
    (686, 714),      # calcRows / ORIGIN_LR / ORIGIN_TB / originCfg / idxToRC / rcToIdx / ORIGIN_NAME
    (719, 720),      # zoneOf / zoneLetter（715-718 orderText 是死代码，丢弃）
    (815, 818),      # zoneCount / zoneStart / zoneEnd / fmt
], ["ORIGIN_LR", "ORIGIN_TB", "ORIGIN_NAME", "originCfg", "calcRows",
    "idxToRC", "rcToIdx", "zoneOf", "zoneLetter",
    "zoneCount", "zoneStart", "zoneEnd", "fmt"])

# ---- grid.js：states 业务规则（连通域/主片区/晋升/孤点判定）+ metrics + 存取 ----
write_module("grid.js",
    'import { S, loadJSON, LS_PRE } from "./store.js";\n'
    'import { idxToRC, rcToIdx } from "./coords.js";', [
    (621, 625),      # statesStr
    (666, 674),      # loadStates
    (722, 725),      # isPresent（726 行 var adj=[] 移入 store）
    (727, 799),      # buildAdj / components / compHasDone / mainComp / promoteConnected（800-804 hasPresentNeighbor 死代码丢弃）
    (805, 814),      # neighborKind
    (823, 828),      # metrics
], ["statesStr", "loadStates", "isPresent", "buildAdj", "components",
    "compHasDone", "mainComp", "promoteConnected", "neighborKind", "metrics"])

# ---- board.js：主界面（棋盘/上色/大区栏/平移缩放/小地图/统计）+ afterChange ----
write_module("board.js",
    'import { S, SCALE_MIN, SCALE_MAX } from "./store.js";\n'
    'import { $, toast, vibrate } from "./dom.js";\n'
    'import { calcRows, idxToRC, zoneOf, zoneLetter, zoneStart, zoneEnd, zoneCount } from "./coords.js";\n'
    'import { metrics, buildAdj } from "./grid.js";\n'
    'import { renderLocCard, syncSearchZone } from "./search.js";\n'
    'import { scheduleSave } from "./sync.js";', [
    (830, 1154),     # buildBoard / paint / 平移缩放 / 小地图 / 统计 / 大区栏 / setView / applyZoneDim
    (1196, 1208),    # afterChange / refreshMM
], ["buildBoard", "paint", "updateStats", "renderZones", "setView",
    "applyPan", "scheduleViewSave", "centerOnIdx", "centerOnZone",
    "resetView", "fitToScreen", "setScaleAt", "zoomCenter",
    "initMinimap", "drawMinimapView", "placeMinimap", "refreshMM", "afterChange"],
    edits=[("var mm=$(\"mm\"), mmCtx=null", "var mmCtx=null"),
           ("  if($(\"ovSearch\").classList.contains(\"on\")){\n    fZone = (viewZone===\"all\") ? \"all\" : String(viewZone);\n    buildChips(); runSearch();\n  }",
            "  syncSearchZone();   // 搜索面板开着时，范围跟随当前视图")])

# ---- interact.js：指针交互（双指缩放/平移/长按/批量连选）+ 撤销 + 状态动作 ----
write_module("interact.js",
    'import { S, SCALE_MIN, SCALE_MAX } from "./store.js";\n'
    'import { $, toast, vibrate } from "./dom.js";\n'
    'import { mainComp, promoteConnected, components, compHasDone } from "./grid.js";\n'
    'import { paint, applyPan, drawMinimapView } from "./board.js";\n'
    'import { hideLocCard } from "./search.js";\n'
    'import { markChange } from "./sync.js";', [
    (1156, 1193),    # 交互状态 + startPinch / doPinch
    (1210, 1284),    # pushUndo / tapCell / tapsIntoMain / enterBatch / exitBatch / addSel / updateSelCount / applyBatch / doUndo
    (1286, 1401),    # 全部指针/按钮/滚轮监听
], ["pushUndo", "tapCell", "enterBatch", "exitBatch", "applyBatch", "doUndo"])

# ---- search.js：找点 + 定位卡 ----
write_module("search.js",
    'import { S } from "./store.js";\n'
    'import { $, toast } from "./dom.js";\n'
    'import { fmt, idxToRC, zoneOf, zoneLetter, zoneCount } from "./coords.js";\n'
    'import { neighborKind } from "./grid.js";\n'
    'import { centerOnIdx, setView, placeMinimap, paint, afterChange } from "./board.js";\n'
    'import { pushUndo } from "./interact.js";\n'
    'import { markChange } from "./sync.js";', [
    (1403, 1603),
], ["buildChips", "runSearch", "flashFound", "locate", "showLocCard", "renderLocCard",
    "hideLocCard", "openSearch", "closeSearch"],
    extra_tail="""
/* setView 里“搜索范围跟随当前视图”的钩子（原 IIFE 中内联在 setView） */
export function syncSearchZone(){
  if(!$("ovSearch").classList.contains("on")) return;
  fZone = (S.viewZone==="all") ? "all" : String(S.viewZone);
  buildChips(); runSearch();
}
""")

# ---- settings.js：设置面板 ----
write_module("settings.js",
    'import { S, DEFAULT_CFG, LS_CFG, loadJSON, saveJSON, viewKey } from "./store.js";\n'
    'import { $, toast } from "./dom.js";\n'
    'import { ORIGIN_NAME, calcRows, fmt, zoneLetter } from "./coords.js";\n'
    'import { buildBoard, renderZones, updateStats } from "./board.js";\n'
    'import { exitBatch } from "./interact.js";\n'
    'import { saveNow, pushFull } from "./sync.js";', [
    (1605, 1732),
], [])

# ---- scan.js：照片识别 ----
write_module("scan.js",
    'import { S } from "./store.js";\n'
    'import { $, toast, vibrate } from "./dom.js";\n'
    'import { fmt, idxToRC, rcToIdx, zoneOf, zoneLetter } from "./coords.js";\n'
    'import { mainComp, promoteConnected } from "./grid.js";\n'
    'import { paint, afterChange } from "./board.js";\n'
    'import { pushUndo } from "./interact.js";\n'
    'import { markChange } from "./sync.js";', [
    (1734, 2288),
], [],
    extra_tail="""
/* Esc 关闭放大选点面板（main.js 键盘处理用） */
export function cancelPick(){
  scan.picking=null; $("scanPick").classList.remove("on");
}
""")

# ---- sync.js：WS 客户端 + 图谱管理 ----
write_module("sync.js",
    'import { S, DEFAULT_CFG, LS_PRE, loadJSON, saveJSON, viewKey, SCALE_MIN, SCALE_MAX } from "./store.js";\n'
    'import { $, toast, esc, ago } from "./dom.js";\n'
    'import { calcRows, zoneCount } from "./coords.js";\n'
    'import { statesStr } from "./grid.js";\n'
    'import { buildBoard, renderZones, updateStats, applyPan, resetView, setView } from "./board.js";\n'
    'import { exitBatch } from "./interact.js";\n'
    'import { renderLocCard } from "./search.js";', [
    (589, 595),      # 同步层注释 + 连接状态（boardId/boardName 移入 S）
    (597, 619),      # dirty / localMode / wsUrl / send / setStateOnline / markChange
    (626, 664),      # flushChanges / saveLocal / saveNow / scheduleSave / applyRemoteCells / applyRemoteCfg
    (2321, 2323),    # boardCache
    (2334, 2531),    # connectWS … 图谱监听（2324-2333 esc/ago 移入 dom.js）
], ["wsUrl", "send", "setStateOnline", "markChange", "flushChanges", "saveLocal",
    "saveNow", "scheduleSave", "applyRemoteCells", "applyRemoteCfg",
    "connectWS", "retryWS", "pickBoardId", "onServerMsg", "applyRemoteStates",
    "loadBoard", "bootView", "renderBoardList", "joinBoard", "pushFull"],
    edits=[("var boardId=null, boardName=\"\", peers=1;", "var peers=1;")],
    extra_tail="""
/* 没连上服务器时的降级入口（boot 用） */
export function setLocalMode(){ localMode=true; setStateOnline(false); }
""")

# ---- main.js：键盘 + 启动 ----
write_module("main.js",
    'import "./styles.css";\n'
    'import { S } from "./store.js";\n'
    'import { $, toast } from "./dom.js";\n'
    'import { calcRows } from "./coords.js";\n'
    'import { loadStates } from "./grid.js";\n'
    'import { buildBoard, renderZones, updateStats, initMinimap, applyPan, zoomCenter, fitToScreen } from "./board.js";\n'
    'import { doUndo, exitBatch } from "./interact.js";\n'
    'import { closeSearch } from "./search.js";\n'
    'import { cancelPick } from "./scan.js";\n'
    'import { wsUrl, connectWS, setLocalMode, bootView } from "./sync.js";', [
    (2298, 2319),    # 键盘
    (2533, 2560),    # boot + resize/orientation + readyState
], [])

# ---- styles.css / 页面骨架 ----
css = seg(11, 335)
io.open(os.path.join(OUT, "styles.css"), "w", encoding="utf-8", newline="\n").write(css + "\n")
print("written styles.css    %5d bytes" % len(css.encode("utf-8")))

body_markup = seg(339, 575)
page = io.open(SRC, encoding="utf-8").read().split("\n")
head = "\n".join(page[0:9])          # 1-9 行：doctype/html/head/meta/title
html = (head + "\n</head>\n<body>\n" + body_markup +
        '\n\n<script type="module" src="/src/frontend/main.js"></script>\n</body>\n</html>\n')
io.open("index.html", "w", encoding="utf-8", newline="\n").write(html)
print("written index.html    %5d bytes" % len(html.encode("utf-8")))
print("OK")
