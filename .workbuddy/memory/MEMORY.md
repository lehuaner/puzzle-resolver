# 拼图定位台 · 长期备忘

## 速览
- 交付：`index.html` + `src/frontend/`（Vite）+ `server/`（Express+ws，代管 OCR 子进程）；`npm run dev` 或双击 `start-lan-server.bat`（一个窗口起页面 8848 + PP-OCR 8849）；案例照片 `public/85889.jpg`、`85890.jpg`。
- 架构：ESM + 共享状态 `S`（store.js，活绑定不能跨模块赋值，import {S} 后读写属性）；编号八组合（origin tl/tr/bl/br × order col/row）；5 态（0 灰/1 绿/2 绿闪/3 待定黄/4 孤片浅黄）；4 邻 BFS 连通域，待定→完成单向自动晋升；WS 同步 + 图谱 + 即时落库。
- 主界面扫描：Otsu + 连通域(>1.2%) + 两点标定 + 圆形采样前景率>0.55；支持拼放方向旋转 90°（solveScan 按方形度 |log(|px|/|py|)| 选轴向，「⟳ 转向」兜底）；应用后包络盒居中（centerOnSet 只缩不放）+ 区域外沿金色描边（flashRegion，共边不画、9s 清）。

## OCR 编号识别（v11）
- `ocr-templates.js`（15 类×≤20 样本×768 hex 软位图）+ `study/` 离线管线（`_ocr_lib.py`/`_gen_cands.py`/`_build_atlas.py`；`_labels.json` 种子、`_cands.json` 中间数据；脚本已 chdir 项目根）。字形正立化用组件墨迹 bbox 宽高比（h≥1.12w 竖直；**勿用 PCA**，半暗阴影带会拉偏）；提取屏蔽同候选其他组件掩膜（bgv=235）；4 假设 F+/B+/R+/F-，dash 在 index1；格式 L-ddd（n=5）/Lddd（n=4）。
- **PP-OCR 服务（v13.5）**：优先调标注台同款服务，失败/空回退内置模板；2×2 重叠分片 6%（整图 det 字符过小必漏）；svc 框角有 **90° 歧义** → 含 svc 读数的对按轴系折叠(mod90)，模板对保持 mod180；svc 读数合成 comps（沿 ang 跨 0.675×tl）。读数带方向针（conf≥0.5）。
- **rapidocr 3.9.2 大坑**：同一实例调一次 `use_det=False` 后全管线永久退化成单行垃圾 → `ocr_server.py` 双引擎隔离（get_ocr 全管线 / get_rec rec-only）；改 warmup 或 fallback 后**必须重启服务进程**。

## 拼好组 / 推算 / 整块模式（v13~v17）
- **散块模式**：照片网格映射与摆放无关（85891 残差 10+ 格距）→ 判定全用 OCR 工作坐标：距离∈[0.7,1.5]×minSide（片宽=文本行投影长/0.27）+ 文本平行（读数 `ang`，**无 90° 歧义**，mod180<20°）+ 轴向性 `axial=max(|cosψ|,|sinψ|)`（对 90° 旋转不变）≥0.65；编号网格 4 邻**或对角**校验 → 并查集成组（8 色轮+右侧明细）。axial≥0.8 且网格对不上→红框可疑；0.65~0.8 灰区不标。
- **组内两点标定推算**：组内配对 (网格Δ,照片Δ) 最小二乘解局部网格基（退化/残差>0.35×side 检查），从正贴邻格沿前景蔓延（多轮 pass）。四道关：①贴邻 ②接缝（连线中点窗 maskWhite≥0.35，真拼合可低至 0.39）③片心（中心窗≥0.85）④占位（预测位被其他编号读数占 <0.55×side）。**关键认知：旧 mask 有连通域过滤（<1.2% 面积清零）→ 孤立散片在 mask 上是空的**，bbox 全环外推在散堆里必被凸头/地板/外簇标名片骗过（85891 实测 17 推 16 错）。
- **整块模式**：读数与全局网格映射中位残差<0.5 格距 → blockMode（散块 10+ 格距物理不可能误判）：BFS 从对齐读数沿前景蔓延 + **簇级 OCR 支持检查**（推算簇内 1.0 格距内有 conf 读数的格占比≥25%，杀光斑）；对齐读数统一画网格位 + blockAng；灰格只画手动标定模式。85889：318=277 读+47 推。
- **v16**：①`isPieceAt` 大窗下界 0.55→**0.50**（最外一列片必有一侧压地板，828=0.543；光斑靠上界 0.999+簇级 OCR 兜底）②推算 bbox ±2→±3、单组上限 12→16 ③推算块**沿用来源组色+虚线**（`inferredPos[idx].grp`）④**单轴组只在已知轴延伸**（垂直方向本质二义：237 与 187 几何等价，转 90°+前景投票会推错编号，已回退）⑤「补一块」：点没框的片→输编号→`addManualReading` 伪 comps 塞 `scan.ocr.map`→重算并推邻居。
- **v17 二义位**：单轴组垂直方向有片→相邻两号之一；孤片四向→四选一。①**排除法**：候选里已被占用的划掉，只剩 1 个就 `insertReading`+重算（`scan._adopting` 防递归；85891 的 237 靠这条补上）②**ROI 单块放大**：`roiOCR` 按 0.62 片宽裁放大 3.2× 送 `/ocr`（实测 A-237@0.94、-422@0.98）；越界**挪中心不拉伸**；4 位串取前3/后3 再用候选筛③人工点选黄虚线问号框。低置信（0.30~0.50）进 `scan.ocr.low`→「待选」。组内渲染：同组框统一**中位片宽×0.88**。

## 审核 / 补漏 / 自动收尾（v18~v21）
- **v18**：编号读取模式下「应用」曾被 `display:none` 顶掉 → 两按钮并存。可疑块渲染成 `编号 [✓][✕]` chip：点编号→`scanFocusOn(x,y,3.4)`（`ox=stageW/2 - x*fit*zoom - bx`）；✓→`scan.suspAck` 记下、recalc 剔除；✕→从 `ocr.map`+`result` 删。
- **v19 逐块审查**：有可疑时 `#bApplyScan` 变「下一步：审查可疑 N」→`startReview()` 弹 `#scanRv`（单块放大 `drawRvZoom`、诊断文案、✓/🔍重识别/✕删/✓改值、◀▶）。**两个收敛性坑**：①`suspAck` 剔除必须在 `scan.suspIdx=` 赋值前**再剔一次**（blockMode 分支随后又加），且 `!scan._adopting` 防打断 adopt 递归 ②`rvReplace/rvReocr` 必须 `add(旧号)`**和**`add(新号)`——只收旧号则新号下轮又被标红，可疑数不降、回弹同一块。
- **v20**：①**删了还有编号**——标签循环遍历 `ocr.results` 而删除只动 `ocr.map` → 加 `scan.ocr.drop` 黑名单，原读数 `{x,y,ang}` 存 `scan.ocr.keep`（不存则组内角度对不上、拼好组散架：85891 725 删→106→94，按原角度补回 106）②**组框歪 40°**——det 框角 90° 歧义，2θ 平均把两垂直族抵消 → 改 **4θ 圆均值（周期 90°）**③**孤片误报**——散块模式降级软提示 `scan.loosePairs`，红色可疑只留给整块模式（85891 5→0）④**漏识别片** `scanGaps`：片心圆窗 maskWhite 落在**读数位自身分布**（15%~92% 分位）之间、且离任何读数/推算位>0.72 片宽→灰虚线「?」；「补漏 N」逐块 ROI 识别，读不出记 `scan.gapTried`（85891 106→117，85889 的 9 处全是反光）。
- **v21**：①`autoVerify(tag)` 串「复核漏读 `recheckWeak` → 补漏 `fillGaps`」，在自动识别完、可疑点审完后跑（`autoChain` 静默、结束一条合计 toast；运行期禁用「应用」）②引导 item 级 `{ids,grp}`，浮条 `#gdPic` 用 `scanGuideDraw` 从原照片裁窗圈金框；scan↔guide 用 `setGuideProviders(infoFn,drawFn)` 防循环 import ③**点已有结果的块=改号** `applyRename(old,n)`（旧号进 drop+存角度→原位插新号→自动归组并闪整组；孤片报"第x列第y行·暂时没拼上"）；浮层多「删掉这块」。公用件 `photoPosOf(idx)`、`scanFlash(ids)`。坑：`组 10 · 2 块` 折行挤掉编号区 → `组10·2块`+`nowrap`。

## 引导 / 聚焦 / 高亮（v24~v27）
- **高亮唯一实现 `beacon.js`**：`beaconShow(ids)` 挂 `.gcur`（常驻绿描边）+620ms 切 `.gblink`（`var(--green)`+`breath`＝图例「进行中」），`beaconHide()` 收；找点 9s 自动收。金色 `.found` 已退役，小地图避让选择器改 `.cell.gcur`。**`.cell.gcur` 必须 `overflow:visible`**，否则 `.cell{overflow:hidden}` 裁掉描边。
- **聚焦唯一实现 `board.focusSet(list,opt)`**：基准 `min(W,visH)*0.42/max(bw,bh)` 夹 0.55~2.6；再算「最近一块已完成(1) 整格可见」`need=(半视口-10)/(|d|+半格)`，`s=max(0.3,min(s,need))`；0.3 装不下就**让位平移**（量按**屏幕像素**封顶 `(W/2-70)/s`）；`visH` 扣 `#guideBar`/`#locCard` 实测遮挡，目标居中到 `visH/2`。找点 `locate()` 必须**先 `showLocCard` 再 `focusSet`**。别用「中心点+固定边距」判可见——窄屏相邻一格会被切一半。
- **引导队列 `growOrder`**：以棋盘已有块为种子，①挨着上一条 ②挨着已铺开整片 ③都不行才另起一片；每档内块大优先→近→编号小。顺序进引导时一次算定。
- **撤销联动**：`interact.js` 的 `setUndoHook(fn)`，`doUndo()` 回退后调；`guideOnUndo(chunk)` 与 `G.applied` **栈顶** `{k,ids}` 比对内容，一致则 `G.k=top.k`+`showCur()`。**必须用栈不能 `k--`**：跳过不产生撤销记录（「放A→跳过B→撤销」撤销的是 A）。
- **v24**：①引导不再预铺结果，只排 `S.states!=1` 的块，`applyItem(ids)` 点「放好了」才单条落库 ②目标持续硬闪（`S.guideActive` 假自停）③**待定数必须在 `promoteConnected()` 之后数**；**棋盘全空不能判待定**，判据 `hadMain=base.size>0`（`mainComp(base)` 在 base 空时返回棋盘现有最大那片，写 `if(mainSet.size)` 等于没写）④改号浮层黑图＝坐标系没换算：`photoPosOf()` 给 OCR 工作坐标，`#pickZoom` 吃 scan 坐标，补 `k=scan.W/scan.ocr.w` ⑤微调网格拖不动图框＝`pointermove` 每帧 recalc 把残差拉大→blockMode 翻 false、弹回原位；改「拖动只 `drawScan()`、松手 recalc」+`scan.gridAdj` 锁 blockMode + `scanCellBase()`（标定解只做**判据**，微调只影响**画在哪**）⑥复核/补漏/补块/改号插进来的读数只在 `scan.ocr.map`，标签循环必须遍历 **map**（遍历 results 会「光秃秃」）。
- **v25**：先按 `S.adj` 并查集把目标块并成**连片**（≤9 块；>9 退回 OCR 组/单块），排序 `att(贴已拼区)→n 大→质心距离→head`；85891 48→34 条。
- **v26**：找点与引导共用 focusSet/beacon；找点 900→0.3 倍时 7 块已完成全可见。
- **延伸 / 删了能点回来（v28，74074d5）**：
  - `maskWhite` 比 `mask` 多一条「小窗亮度均匀 ((max-min)/max<0.10)」用来滤光斑，**代价是把阴影/侧光里的真片整片滤掉**（85890 实测阴影片 maskWhite≈0.00 而 mask≈0.90；木地板两者都≈0.00）。所以新增 `maskCov()`（纯 Otsu 阈值）只给「延伸」用。
  - `extLv`(0/1) + `extendInfer(cb)`：散块组推算放宽到 bbox **±6/48 块/8 轮**（原 ±3/16/4）；整块模式 `fgAt` 放宽到非严格档；再沿 `alignedIdx ∪ inferredIdx` 4 邻往外 BFS 一圈（片心 `maskCov≥0.55`，上限 80）。
  - **延伸准入 `extOk(j)` 必须有**：贴邻 ≥2 块已确认 **或** 0.8 格距内有任何 `ocr.results` 检出。没这条 85889 反光区（20 格零检出、只一点与主体相接）会被整块误加 21 块。
  - 自动链：`rvDone()` → `autoVerify(tag,cb,{extend:true})` → 复核 → 补漏 → **延伸**（延伸纯几何，`!OSVC.ok` 也跑，此时 nW/nG 归零）。工具条 `#bExtend` 常驻；`resetScan` 归零 `extLv`；`extendInfer` 一块没多推就退回原档位。
  - **删掉的块**：整块模式下 `scanHitIdx` 走网格兜底总能拿到编号，但该号不在 `ocr.map` 也不在 `inferredPos` → 老代码**什么都不弹**。现在 `ocr.drop`/`inferDrop` 里的号走 `openPick({restore})`「补回来」，`photoPosOf` 加 `src:"keep"`（用 `ocr.keep` 原位置+原角度；角度丢了拼好组会散架），散块空白落点用 `dropNear()`（0.85 片宽）命中。
  - **整块模式点没算进来的格子** → `openPick({cell:idx})`「该是 N，确认补上？」→ `addManualReading`。这才是「即使选了增删也点不动」的那条路。
- **可疑点查重（v28b，1b03ae7）**：recalcScan 末尾（drop 清理后、`scan.result=set` 前）遍历 `suspIdx`，编号已在 `set` 里 → 自动确认、移出人工审查队列，记 `scan.suspAuto`（明细列「已自动确认 N 个可疑（结果里已有该块）」）。**只删可疑标记，绝不动 set/map/inferredPos**（用户明确要求别把正常点删掉）。不用 `suspAck`（永久黑名单），每次重算重查 → 块不在结果里时可疑会重新出现。连带两坑：① 查重吃光可疑后走不到 `rvDone()`，"审完可疑自动延伸"落空 → 自动识别链也带 `{extend:true}`，`doExt` 不再要求 `extLv==0` ② `extendInfer` 的"没多推就退回"必须在 `was===0`（首次试探）时才退，已在延伸档时退回会把上次延伸出来的块全撤掉＝掉块。认知：blockMode 两类可疑的编号必然在 result（conf≥0.5 就进 set）→ 查重后基本清零；仍留人工审的只剩散块组推算里 `occ` 占位那条。

## 布局 / 窄屏
- **v22**：≤900 `.scan-stage{flex:0 0 auto;height:clamp(160px,44vh,460px)}` + `.scan-side{flex:1 1 auto;min-height:0;overflow-y:auto}`。①**数据栏底 padding 归零**——`position:sticky;bottom:0` 对齐内容盒底，留 10px 就从缝里露字 ②贴底栏必须 `flex:0 0 100%;width:100%`+`background:var(--panel)`，否则 `align-items:flex-start` 下只占半行。≤520：三动作键 12.5px 压单行、`.scan-bar` 改 `nowrap+overflow-x:auto`、`.scan-tip` 改 `left/right:8px+transform:none`。
- **引导浮条**：≤600 改 `grid`，`areas:"pic main" "btns btns"`，按钮独占底行（`#gdSkip` 68px / `.okb` flex:1 / `.gd-x` 44px），`#gdInfo` 一律 `order:3;flex:1 1 100%`（浮条最宽 560，塞一行必被挤成「…」）。
- DOM 坑：`classList.add()` 不接受含空格字符串（抛 SyntaxError），多 token 逐个 add。

## 服务托管（v23）
- 页面不写死 `127.0.0.1:8849`（局域网设备上那是它自己）；`server/ocr.js` 代管：探测 8849，没起就 spawn `label/ocr_server.py`（**解释器必须实测 `-c "import rapidocr"`**：`py -3`→`%LOCALAPPDATA%\Programs\Python\Python3xx\python.exe`→`python`；本机 PATH 首个 python 是 managed 3.13.12 没装 rapidocr）；已在跑就复用、挂了 health 触发自愈（6s 防抖）。路由 `GET /ocrsvc/health`（未就绪带 `starting`）、`POST /ocrsvc/ocr`（`express.raw` 80mb）。前端 `OSVC.host` = http(s) 下 `location.origin+"/ocrsvc"`，仅 file:// 直连；探测退避 20 次，徽标三态。`start-lan-server.bat` 杀端口后**必须等真空闲**。坑：**别一边跑 bat 一边编辑它**（cmd 按字节偏移续读会重复执行）；bat 改完转回 **CRLF**。

## 坑清单（通用）
- **dist 换 hash 但页面还跑旧 bundle**：build 后必须 `navigate_page(reload, ignoreCache:true)`。验版本看 `dist/assets/*.js` 大小/时间戳，别信构建日志 kB。
- `canvas.width` 赋相同值也会清空内容 → layout 类函数须 `if(cv.width!==W)` 守卫。
- 杀服务用 PID（`netstat -ano | grep :8848`），勿 `taskkill //IM node.exe`（会连 chrome-devtools MCP 一起杀）。

## 标定几何
- 锚点对的是**片心**不是交界点（交界在晶格点）。
- 标定对左右镜像免疫（负 pitch 吸收），col/row 优先顺序必须与实物一致。
- 拼接方向可能整体旋转 90°，用方形度判据自动适配；|dc|≈|dr| 且位移≈45° 本质二义，靠「⟳ 转向」兜底。
- 编号印在片背、散片朝向任意，编号文字质心≠片心；相邻已拼片编号位移=片距。

## 测试技巧
- **bat 一律纯 ASCII**：含 UTF-8 中文 + chcp 65001 会触发 cmd 解析错位闪退；中文路径用 `%USERPROFILE%`。
- E2E：**必须先点 `#bScan` 开扫描页再载图**，否则 osvcProbe 未跑→静默回退内置模板（读数骤减，误判回归）；照片同源 fetch → `new DataTransfer()` 给 `#fImg` 设 files 再 dispatch change；PointerEvent 派到 scanStage（pointerId 勿残留）；`window.__autoBusy()` **是函数**。
- 视口用 `emulate({viewport:"WxHxDPR,mobile,touch"})`（`resize_page` 常不生效）；**切 emulate 会关掉 `#ovScan`、清空 `__scan.result`**，要重点识别+重灌照片。验浮条排版不必重跑识别：`body.classList.add('guideon')`+假文本+`#gdPic` 画黑块，直接量 rect。
- 调试钩子：`__scan` / `__addPiece(i,sx,sy)`（scan 坐标）/ `__focus` / `__gaps` / `__drop` / `__recalc` / `__autoBusy`。
- canvas 取证：toDataURL 超限落 `.workbuddy/projects/**/tool-results/*.txt` → venv python 解码落盘 → Read 看图。venv：`~/.workbuddy/binaries/python/envs/default/Scripts/python.exe`。
- `label/85891.labels.json` 人工框 ×0.75 合成读数注入 `scan.ocr.map` → 触发 recalc 可复现拼好组。

## 标注台（label/）
- 双击 `label/index.html` 即用（file://）；产出人工标注供 OCR 评估/重训。
- 自动标注：亮域连通域(1500)+detectNumbers(3072)+编号落框归属；域含 ≥2 编号 → 按编号位置+均摊面积 sqrt(域像素/编号数) 拆方框；阴影堆块无域 → 编号+平均小块边长建框；垃圾编号过滤 n≥4 且 conf≥0.45。
- 数据：localStorage `plabel:<照片名>`（debounce 600ms）；导出 bbox 为原图像素坐标 `{bbox,label,conf,src}`。
- 模板库/OCR 核心由 `ocr-templates.js`、`ocr.js` sed 转换生成（去 import/export）；**源文件更新后须重转**。
