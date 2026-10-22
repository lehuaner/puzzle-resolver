# -*- coding: utf-8 -*-
"""
拼图标注台 · 高精度 OCR 服务（RapidOCR / PaddleOCR ONNX 模型）

供 label/index.html（file:// 或 http）通过 HTTP 调用本机离线识别：
  GET  /health  -> {"ok":true,"engine":"rapidocr"}
  POST /ocr     -> body 三选一：
     {"img": "<dataURL 或裸 base64>"}                 页面已解码的图像
     {"file": "85892.jpg"}                            服务端直接读脚本同目录照片
     {"file": "...", "roi":{cx,cy,w,h,ang,z,pad}}     框内旋转裁剪（原图像素坐标）
                -> {"lines":[{"text","score","box":[[x,y]x4]}]}（坐标=送识别的图像像素）

file:// 页面用 <img> 直读照片时 canvas 被污染无法导出，{file} 模式让服务端
代读磁盘文件，双击打开也能享受高精度 OCR。

启动：双击 start-ocr-server.bat，或
  python ocr_server.py [端口]     （默认 8849）
依赖：pip install rapidocr opencv-python（系统 Python 已装）
"""
import base64
import json
import math
import os
import re
import sys
import threading

import numpy as np
import cv2

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8849
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_SAFE_NAME = re.compile(r"^[A-Za-z0-9_.\-]+$")   # 只允许纯文件名，防路径穿越

_ocr = None
_ocr_lock = threading.Lock()
_ready = False


def get_ocr():
    global _ocr
    if _ocr is None:
        from rapidocr import RapidOCR
        # 编号散块朝向不定：保留 cls（方向分类）；det 不限边（照片 3072px 直接推）
        _ocr = RapidOCR()
    return _ocr


def warmup():
    """启动即跑一张小图，把 det/cls/rec 模型全部加载到位。"""
    global _ready
    try:
        blank = np.full((320, 320, 3), 245, dtype=np.uint8)
        cv2.putText(blank, "B-123", (40, 200), cv2.FONT_HERSHEY_SIMPLEX,
                    3.0, (30, 30, 30), 8, cv2.LINE_AA)
        get_ocr()(blank)
        # rec-only 路径（fallback_rec 用）也预热一次
        get_ocr()(blank, use_det=False, use_cls=False)
        _ready = True
        print("[ocr_server] warmup OK, listening on http://127.0.0.1:%d" % PORT)
    except Exception as e:  # noqa: BLE001
        print("[ocr_server] warmup FAILED: %r" % e)


_NUM_HINT = re.compile(r"[A-Za-z]?\s*[-–—]?\s*\d{2,4}")


def fallback_rec(img):
    """det 兜底：白块上的淡印刷小字 PP-OCR det 常漏检（det 把白块本体误检成
    文本行，真编号反而漏掉，实测 85891 的 D-773）。改走：亮域定位块本体 →
    块内滑动横条带 → rec-only 紧凑识别（rec 对紧凑条带一喂即中，实测 0.96）。
    返回 [(text, score), ...]。"""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, bm = cv2.threshold(g, 160, 255, cv2.THRESH_BINARY)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(bm)
    if n <= 1:
        return []
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x, y, w, h = [int(v) for v in stats[big, :4]]
    if w < 40 or h < 40:
        return []
    bh = int(min(max(h * 0.26, 30), 130))
    bw = int(w * 0.92)
    x0 = x + max(0, (w - bw) // 2)
    eng = get_ocr()
    H, W = img.shape[:2]
    out = []
    steps = 5
    for i in range(steps):
        cy0 = y + int((h - bh) * i / (steps - 1)) if steps > 1 else y
        cy0 = max(0, min(cy0, H - bh))
        snip = img[cy0:cy0 + bh, x0:x0 + bw]
        if snip.shape[0] < 24 or snip.shape[1] < 48:
            continue
        z = max(1.0, 48.0 / snip.shape[0])
        if z > 1.0:
            snip = cv2.resize(snip, None, fx=z, fy=z, interpolation=cv2.INTER_CUBIC)
        for im in (snip, cv2.rotate(snip, cv2.ROTATE_180)):
            try:
                r = eng(im, use_det=False, use_cls=False)
            except Exception:  # noqa: BLE001
                continue
            if r.txts:
                for t, s in zip(r.txts, r.scores):
                    t = str(t).strip()
                    if t:
                        out.append((t, float(s)))
    return out


def load_photo(name):
    """读脚本同目录下的照片文件（白名单文件名）。"""
    if not _SAFE_NAME.match(name or ""):
        raise ValueError("bad file name")
    path = os.path.join(BASE_DIR, name)
    if not os.path.isfile(path):
        raise FileNotFoundError(name)
    arr = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if arr is None:
        raise ValueError("image decode failed: %s" % name)
    return arr


def crop_roi(arr, roi):
    """框内旋转裁剪：转正+放大+补白+框外涂白。

    roi 坐标为原图像素；pad=框外余量倍率（默认 1.3）。
    z 自适应：把块区域缩放到约 560px（字符高 ≈60-90px，det/rec 舒适区）；
    画布过大（如 2600px）会被 det 内部缩放导致字符过小而漏检。
    """
    h_img, w_img = arr.shape[:2]
    cx = float(roi.get("cx", w_img / 2))
    cy = float(roi.get("cy", h_img / 2))
    w = max(2.0, float(roi.get("w", 100)))
    h = max(2.0, float(roi.get("h", w)))
    ang = float(roi.get("ang", 0.0))
    pad = float(roi.get("pad", 1.3))
    z = min(2.2, max(0.9, 560.0 / max(w, h)))
    side = int(math.ceil(max(w, h) * z * 1.45))
    # 页面 c2.rotate(-ang)：canvas 正角=顺时针 → -ang=逆时针 ang；
    # cv2.getRotationMatrix2D 正角=逆时针（同 y 向下坐标系），故传 +degrees(ang)
    M = cv2.getRotationMatrix2D((cx, cy), math.degrees(ang), z)
    M[0, 2] += side / 2 - cx
    M[1, 2] += side / 2 - cy
    warped = cv2.warpAffine(arr, M, (side, side),
                            flags=cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_CONSTANT,
                            borderValue=(245, 242, 234))
    # 框外涂白：全白底层 + 旋转矩形内区域从 warped 拷回
    inW, inH = w * z * pad, h * z * pad
    rect = cv2.boxPoints(((side / 2, side / 2), (inW, inH), math.degrees(ang)))
    mask = np.zeros((side, side), np.uint8)
    cv2.fillPoly(mask, [np.round(rect).astype(np.int32)], 255)
    out = np.full_like(warped, (245, 242, 234))
    out[mask > 0] = warped[mask > 0]
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": _ready, "engine": "rapidocr", "port": PORT})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/ocr":
            self._json(404, {"error": "not found"})
            return
        try:
            ln = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(ln)
            req = json.loads(raw.decode("utf-8")) if raw[:1] == b"{" else {"img": raw.decode("utf-8", "ignore")}
            if req.get("file"):
                arr = load_photo(req["file"])
                if req.get("tile"):
                    sx, sy, ex, ey = [int(v) for v in req["tile"]]
                    arr = arr[max(0, sy):ey, max(0, sx):ex]
                if req.get("roi"):
                    arr = crop_roi(arr, req["roi"])
            else:
                dataurl = req.get("img") or ""
                img_bytes = base64.b64decode(dataurl.split(",", 1)[-1])
                arr = cv2.imdecode(np.frombuffer(img_bytes, np.uint8),
                                   cv2.IMREAD_COLOR)
                if req.get("roi"):
                    arr = crop_roi(arr, req["roi"])
            if arr is None:
                self._json(400, {"error": "image decode failed"})
                return
            with _ocr_lock:
                res = get_ocr()(arr)
            txts = getattr(res, "txts", None) or []
            scores = getattr(res, "scores", None) or []
            boxes = getattr(res, "boxes", None)
            lines = []
            for i, t in enumerate(txts):
                box = None
                if boxes is not None and i < len(boxes):
                    box = np.asarray(boxes[i]).tolist()
                lines.append({
                    "text": str(t),
                    "score": float(scores[i]) if i < len(scores) else 0.0,
                    "box": box,
                })
            # 兜底：主推理（det 路线）没有可信的编号形态行时，条带盲扫 rec-only
            # （低 conf 编号行不算数——如白块误检行 rec 出 '07713'@0.545 这类错串，
            #   得让兜底有机会补上真正可读的候选，页面端按解析+分数择优）
            if not any(_NUM_HINT.search(l["text"]) and l["score"] >= 0.72
                       for l in lines):
                with _ocr_lock:
                    fb = fallback_rec(arr)
                for t, s in fb:
                    lines.append({"text": t, "score": s, "box": None, "fb": True})
                if fb:
                    print("[ocr_server] fallback_rec +%d candidates" % len(fb))
            self._json(200, {"lines": lines})
            print("[ocr_server] /ocr %dx%d -> %d lines"
                  % (arr.shape[1], arr.shape[0], len(lines)))
        except FileNotFoundError as e:
            self._json(404, {"error": "photo not found: %s" % e})
        except Exception as e:  # noqa: BLE001
            try:
                self._json(500, {"error": repr(e)})
            except Exception:  # noqa: BLE001
                pass
            print("[ocr_server] /ocr ERROR: %r" % e)

    def log_message(self, fmt, *args):  # 探测请求不刷屏
        if self.path != "/health":
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    warmup()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

