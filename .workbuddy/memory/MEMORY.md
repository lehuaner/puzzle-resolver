# 拼图定位台 · 长期备忘

## 项目速览（v9 起）
- 交付物：`index.html` + `src/frontend/`（Vite 构建）+ `server/`（Express+ws）；启动 `npm run dev`（开发）或 `start-lan-server.bat`（先 build 再生产模式，0.0.0.0:8848）；识别案例照片 `85889.jpg`、`85890.jpg` 在 `public/`。
- 架构：ESM 模块 + 共享状态 `S`（store.js，活绑定不能跨模块赋值，import {S} 后读写属性）；编号八组合（origin tl/tr/bl/br × order col/row）；5 态（0 灰/1 绿/2 绿闪/3 待定黄/4 孤片浅黄）；4 邻接 BFS 连通域，待定→完成单向自动晋升；WS 实时同步 + 图谱管理 + 即时落库。
- 图片识别：Otsu + 连通域(>1.2%) + 两点标定 + 圆形采样前景率>0.55；**支持拼放方向旋转 90°**（solveScan 按方形度 |log(|px|/|py|)| 自动选轴向，微调条「⟳ 转向」手动兜底）；应用结果后主界面自动包络盒居中（centerOnSet，只缩不放）+ 区域外沿金色描边（flashRegion，共边不画、9s 清除）。
- **OCR 编号识别（v11）**：`ocr-templates.js`（15 类×≤20 样本×768 hex 软位图）+ `study/` 离线管线（`_ocr_lib.py` 字形库 / `_gen_cands.py` 候选生成 / `_build_atlas.py` 构建器，`_labels.json` 人工种子标注、`_cands.json` 中间数据同在 study/，脚本已 chdir 项目根，从任意位置可跑）；字形正立化=组件墨迹 bbox 宽高比（h≥1.12w 竖直/反之水平，勿用 PCA——半暗阴影带会拉偏）；提取时屏蔽同候选其他组件掩膜像素（bgv=235）；4 假设 F+/B+/R+/F- 匹配，dash 在 index1；全库自洽 100%（LOO 低是单样本类稀疏非算法缺陷）；编号格式 L-ddd（n=5 带 dash）或 Lddd（n=4）。
- **扫描引导（v12）**：照片载入自动 OCR→`autoCalibrate`（conf 前 8 挑最远对）；散块模式（ocr.map≥2）下 OCR 编号即「已拼」证据（conf≥0.5），网格框淡化+编号标注（conf 着色）；「应用并引导摆放」→ guide.js 队列（贴已拼区先、按主片质心距离近到远），底部浮条 gdOk（标1+promote）/gdSkip/Esc，gcur 金色脉冲高亮，与批量互斥（S.guideActive 存 store 防循环依赖）。
- DOM 坑：`classList.add()` 不接受含空格字符串（抛 SyntaxError），多 token 必须逐个 add。

## 标定几何要点
- 锚点对的是**片心**不是交界点（交界在晶格点，片心偏移半片）。
- 标定对左右镜像免疫（负 pitch 吸收），但 col/row 优先顺序必须与实物一致。
- 拼放方向可能整体旋转 90°（照片里列轴竖直、行轴水平），两点标定用方形度判据自动适配；|dc|≈|dr| 且位移≈45° 时本质二义，靠「⟳ 转向」人工兜底。
- 编号印在片背、散片放置朝向任意，编号文字质心≠片心；相邻已拼片的编号位移=片距。

## 测试技巧
- **bat 双击闪退坑（已修 960dd2c）**：bat 含 UTF-8 中文（echo/路径）+ chcp 65001 会触发 cmd 解析错位（行被截断如 `'xe' 不是命令`、路径找不到）→ 闪退。规则：**bat 一律纯 ASCII**，中文路径用 `%USERPROFILE%` 等环境变量引用（运行时展开不经过文件字节解析）。
- **file:// 单页工具**：经典 `<script src>` 相对路径在 file:// 下可加载（ESM module/fetch 才被 CORS 拦）；照片经 input file → URL.createObjectURL → canvas 不污染，可直接 getImageData。
- **canvas 坑**：`cv.width=...` 赋相同值也会清空内容——layout 类函数须 `if(cv.width!==W)` 守卫，否则缩放后黑屏。
- 识别流程 E2E：页面须同源 fetch 照片，`new DataTransfer()` 给 `#fImg` 设 files 再 dispatch change；锚点用 PointerEvent 派发到 scanStage（pointerId 勿残留，否则误进 pinch 分支，调试先 reload）。
- canvas 取证：toDataURL 超限自动落 `.workbuddy/projects/**/tool-results/*.txt` → venv python 正则解码落盘 → Read 看图。
- venv：`~/.workbuddy/binaries/python/envs/default/Scripts/python.exe`（Windows 是 Scripts/ 不是 bin/），Pillow 已装。
- 杀服务用 PID（netstat -ano | grep :8848），勿 taskkill //IM node.exe（会连 chrome-devtools MCP 一起杀）。

## 标注台（label/，91b3940）
- 双击 `label/index.html` 即用（file://）。用途：人工产出准确标注（编号+整块框），供 OCR 评估/重训。
- 自动标注：亮域连通域(1500) + detectNumbers(3072) + 编号落框归属；**域含 ≥2 编号 → 按编号位置+均摊面积(sqrt(域像素/编号数))拆方框**（拼放粘连/乱堆堆叠都靠这条）；阴影堆块无域 → 编号+平均小块边长建框；垃圾编号过滤 n≥4 且 conf≥0.45。
- 数据：localStorage `plabel:<照片名>` 自动保存（debounce 600ms）；导出合并 JSON，bbox 为**原图像素坐标**，`{bbox,label,conf,src:auto|manual}`。
- 模板库/OCR 核心由 `src/frontend/ocr-templates.js`、`ocr.js` sed 转换生成（去 import/export）；**源文件更新后须重新转换**。
