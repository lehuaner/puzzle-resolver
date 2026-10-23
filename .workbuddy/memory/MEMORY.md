# 拼图定位台 · 长期备忘（压缩版）

## 速览
- 交付：`index.html` + `src/frontend/`（Vite）+ `server/`（Express+ws，代管 OCR 子进程）；`npm run dev` 或 `start-lan-server.bat`（8848 页面 + 8849 PP-OCR）。案例照片 `public/85889.jpg`、`85890.jpg`。
- 架构：ESM + 共享状态 `S`（store.js，活绑定不能跨模块赋值，`import {S}` 后只读写属性）；编号八组合（origin tl/tr/bl/br × order col/row）；5 态（0 灰/1 绿/2 绿闪/3 待定黄/4 孤片浅黄）；4 邻 BFS 连通域，待定→完成单向自动晋升；WS 同步 + 即时落库。
- 主界面扫描：Otsu + 连通域(>1.2%) + 两点标定 + 圆形采样前景率>0.55；支持旋转 90°（solveScan 按方形度 |log(|px|/|py|)| 选轴向，「⟳ 转向」兜底）；应用后包络盒居中（centerOnSet 只缩不放）+ 外沿金描边（flashRegion，共边不画、9s 清）。

## OCR（v11~v13.5）
- `ocr-templates.js`（15 类×≤20 样本×768 hex 软位图）+ `study/` 离线管线。字形正立化用组件墨迹 bbox 宽高比（h≥1.12w 竖直；**勿用 PCA**，半暗阴影带会拉偏）；4 假设 F+/B+/R+/F-，dash 在 index1；格式 L-ddd（n=5）/Lddd（n=4）。
- PP-OCR 服务：优先调标注台同款，失败回退内置模板；2×2 重叠分片 6%（整图 det 字符过小必漏）；svc 框角有 **90° 歧义** → 含 svc 读数的对按轴系折叠(mod90)，模板对保持 mod180；svc 读数合成 comps（沿 ang 跨 0.675×tl）。
- **rapidocr 3.9.2 大坑**：同一实例调一次 `use_det=False` 后全管线永久退化成单行垃圾 → `ocr_server.py` 双引擎隔离（get_ocr 全管线 / get_rec rec-only）；改 warmup/fallback 后**必须重启服务进程**。

## 判定几何
- **散块模式**：照片网格映射与摆放无关 → 判定全用 OCR 工作坐标：距离∈[0.7,1.5]×minSide（片宽=文本行投影长/0.27）+ 文本平行（读数 ang，mod180<20°，**无 90° 歧义**）+ 轴向性 `axial=max(|cosψ|,|sinψ|)`（对 90° 旋转不变）≥0.65；编号网格 4 邻**或对角**校验 → 并查集成组。axial≥0.8 且网格对不上→红框可疑；0.65~0.8 灰区不标。
- **整块模式**：读数与全局网格映射中位残差<0.5 格距 → blockMode（散块 10+ 格距物理不可能误判）：BFS 沿前景蔓延 + 簇级 OCR 支持检查（推算簇内 1.0 格距内有 conf 读数占比≥25%，杀光斑）。85889：318=277 读+47 推。
- **推算四道关**：①贴邻 ②接缝（连线中点窗 maskWhite≥0.35，真拼合可低至 0.39）③片心（中心窗≥0.85）④占位（预测位被其他编号读数占 <0.55×side）。
- **关键认知：旧 mask 有连通域过滤（<1.2% 面积清零）→ 孤立散片在 mask 上是空的**，bbox 全环外推在散堆里必被凸头/地板/外簇标名片骗过（85891 实测 17 推 16 错）。
- `maskWhite` 比 `mask` 多一条「小窗亮度均匀 ((max-min)/max<0.10)」滤光斑，**代价是把阴影/侧光里的真片整片滤掉**（85890 阴影片 maskWhite≈0.00 而 mask≈0.90）→ 新增 `maskCov()`（纯 Otsu）只给「延伸」用。
- 标定几何：锚点对的是**片心**不是交界点；标定对左右镜像免疫；拼接方向可能整体旋转 90°；编号质心≠片心。

## 字母分区校验位 / 同位置冲突（v29b）
- **字母 = 分区校验位**：片背印「字母+全局编号」，字母只是编号所在分区的重述 → `coords.js` 的 `letterZone/zoneRangeOf/numInZone`，区间全由 `zoneStart/zoneEnd/zoneCount`（total+zoneSize）推出，**不许写死 A-D 或 250**。字母读不出/超出分区数时返回 true 不误杀。判错时**改数字不改字母**。
- 85889 实测越段读数仅 5 条（D-277、D-476、D-602、C-109、C-878），与用户判定「推算对」的那 5 条冲突 100% 吻合。
- **同位置两个编号 → 默认采纳推算（网格位）的号**，做法是**原位换号**：`map.delete(旧); rd.idx=新; rd.digits=fmt(新); map.set(新, rd)`，位置/角度/comps/svc 全沿用 → 不留空洞。**绝不能用 `insertReading` 造新读数**（丢 comps → readingSide 错 → 拼好组散架）。反例保留读数：`numInZone(字母,读数)` 真而推算号越段。换不了（目标号别处已有读数）→ 进 `dupFix` 让人点。
- 换号后 ROI 会犯同一个误读 → `scan.zoneFixAt`(错号+位置) + `zoneFixBlocks()` 在 fillGaps/recheckWeak 里挡。**只按位置挡，不全局拉黑**（B-476/B-277/A-109 是照片另一头的真片）。
- `roiNums` 现在连字母一起抓；`insertReading(idx,ox,oy,letter)` 有可选字母参数。

## 提示 / 补点 / 删块（v29c、v28）
- **「认不准/漏读」提示**：命中抽成 `weakHit(p)`，**移动模式也做命中**（用户要「不用切增删」）。候选编号必须按**结果集**过滤（`!map.has(v) && !set.has(v)`）。**屏蔽名单两条链**：`weakCells` 看 `weakDrop`、`gaps` 看 `gapTried` —— 删漏读位「?」要两份都写。
- **补点的放大镜/坐标别复用旧 OCR 坐标**：`photoPosOf()` 按编号查 → 读数位与推算位互相顶替，弹出「之前 OCR 那个点」的原图。只有该格确有这条读数才用读数坐标，否则用点击点。
- **延伸**：`extLv`(0/1)+`extendInfer(cb)`：散块组推算放宽 bbox ±6/48 块/8 轮；整块 `fgAt` 放宽非严格档；沿 alignedIdx∪inferredIdx 4 邻 BFS 一圈（`maskCov≥0.55`，上限 80）。**准入 `extOk(j)` 必须有**：贴邻 ≥2 块已确认或 0.8 格距内有 ocr.results 检出（否则 85889 反光区会被误加 21 块）。
- **删掉的块**：`ocr.drop`/`inferDrop` 里的号走 `openPick({restore})`「补回来」；`photoPosOf` 加 `src:"keep"`（用 `ocr.keep` 原位置+原角度，角度丢了拼好组会散架）；散块空白落点用 `dropNear()`（0.85 片宽）。

## 引导 / 聚焦 / 高亮（v24~v29g）
- **高亮唯一实现 `beacon.js`**：`beaconShow(ids)` 挂 `.gcur`（常驻绿描边）+620ms 切 `.gblink`；找点 9s 自动收。`.cell.gcur` 必须 `overflow:visible`。
- **聚焦唯一实现 `board.focusSet(list,opt)`**：基准 `min(W,visH)*0.42/max(bw,bh)` 夹 0.55~2.6；再算「最近一块已完成(1) 整格可见」`need=(半视口-10)/(|d|+半格)`，`s=max(0.3,min(s,need))`；0.3 装不下就**让位平移**（量按屏幕像素封顶 `(W/2-70)/s`）；`visH` 扣 `#guideBar`/`#locCard` 遮挡。找点 `locate()` 必须**先 showLocCard 再 focusSet**。
- **v29g 缩放下限**：可见比例按面积 `W*visH/(contentW*contentH*s²) ≥ minView`（默认 30%，`S.cfg.guideMinView`，设置项 10~100），反解 `cap=sqrt(...)` 作 s 上限。
  **坑：兜底守卫别压在默认值线上**。原来写 `if(cap>0.35 && cap<s)`，而本盘 1000 片时 `cap(30%)≈0.359` —— 正好压线，默认看着生效；一调到 40% 以上 cap 跌破 0.35 被**整个跳过**，悄悄回到放大状态（实测 60% 时可见只剩 4%）。绝对下限要留足余量（现为 0.15，仅防成一枚邮票）。**用户可调参数的默认值往往就贴在兜底线上，必须实测默认值两侧**。
  - 实测（85889，视口 500×410、浮条压底 131px、content 2357×1472）：15%→s=0.508、30%→s=0.3595、60%→s=0.254、100%→s=0.1969，四档可见比例精确命中。「找点」共用 focusSet 同样受约束。
- **引导队列（两级，v29h）**：`buildQueue` → `growOrder`（一次算定）。
  - **整**＝目标块按网格 4 邻的连通分量。整与整之间「由整到散、由近到远」：①紧挨着**已拼起来的**（棋盘原有 + 这一遍已排上的整）先挑，内部按 整大→离主片区近→编号小；②全都接不上 → 按同样规则另起一个整。
  - **整内部**「先组再独立、先多再少」：OCR 认得出的**拼好组**（`scanGuideInfo().grpOf`）**整组算一步**（用户：「已经拼成组的，无需一步一步引导」），组大的在前（组内 `dist` 取组质心）；剩下的独立片**一片一步，贴着已拼的贪心往外长**（`growSolo`）——每次挑「离已拼的最近」（**切比雪夫**距离，平手编号小）。`done` 既有棋盘原有的（＝主区）也有这一遍刚排上的组/片 → 「先放靠主区近的」和「先放贴连片的」是同一条规则：连片每长一块，周围的片就更近一步。
  - **排序用的「已拼集」必须排除本轮目标**：目标里可能有上一轮被标「待定(3)/孤片(4)」的块，它们虽在棋盘上但这轮还要引导；若算进 done，growSolo 的剩余候选过滤会把它们**静默丢掉**、整级「能连上」判断也会被自己骗到（`growOrder` 开头 `tgt` 集合排除）。
  - 演进史（都是用户原话，别反复）：先是「整片一条」→ 用户「只要是连起来的直接算作一步，图片预览也只框选范围，而不是告诉你具体哪一片」→ 改一片一步 → 用户澄清「由整到散、由近到远指的是**顺序**，整内部先组再独立、先多再少，拼好组无需一步一步」→ 即现在的两级。**教训：「由整到散」是整层的次序，不是步长；步长是「组整组、散片一片」。**
  - `spreadSplit`/`MAXC`/`bboxCells` 已删（一步一片后没有「摊开」问题）。
- **引导小窗 `#gdPic`**：地图式——整图 contain 铺入（200×150 画布，CSS 108×81）、其余压暗 `rgba(6,10,8,.46)`、当前这一步每一片按**片子朝向画旋转方框**（金）+ 外圈 + 中心点。**只高亮，不写序号**（用户：「引导时原图上不要显示序号，只有高亮」；编号由浮条报）。**已放到棋盘上的块（`S.states!==0`）涂成「压暗后的照片背景色」** —— 点一次「放好了」预览上就少一块，进度一眼看得出。背景色取照片最外圈像素的中位色（`photoBg()`，缓存），再按压暗系数预混，涂上去才溶得进桌面、不像补丁。
- **点「放好了」不弹任何提示**（用户原话）：`guideNext(true)` 里那条 `toast("已放 N 块…")` 已删——棋盘转绿 + 引导自己跳下一步就是反馈，再弹 toast 每步都拦视线。只留 `vibrate(15)` 确认点到。「跳过 / 退出 / 引导完成」的 toast 保留（不是点放好了弹出的）。
- **浮条文案**：独立片 → `gdNum`=编号、`gdInfo`="C区 第15列 第1行 · 挨着 625、650"（`S.adj` 里找 state 1/3 的邻居，最多 2 个）；整组 → `gdNum`="整组·N块"、`gdInfo`="这一组一起放：701·702·703…"（前 5 片）。
- **撤销联动**：`interact.js` `setUndoHook(fn)`；`guideOnUndo(chunk)` 与 `G.applied` **栈顶** `{k,ids}` 比对。**必须用栈不能 k--**（跳过不产生撤销记录）。「放好了」不再弹撤销提示。
- v24 坑：引导只排 `S.states!=1` 的块；待定数必须在 `promoteConnected()` 后数；棋盘全空不能判待定，判据 `hadMain=base.size>0`；改号浮层黑图＝坐标系没换算（photoPosOf 给 OCR 工作坐标，pickZoom 吃 scan 坐标，补 `k=scan.W/scan.ocr.w`）；微调网格拖不动＝pointermove 每帧 recalc → 改「拖动只 drawScan、松手 recalc」+`scan.gridAdj` 锁 blockMode；标签循环必须遍历 **ocr.map**（遍历 results 会「光秃秃」）。

## 审核 / 补漏 / 自动收尾（v18~v21）
- 可疑块渲染成 `编号 [✓][✕]` chip：点编号→`scanFocusOn(x,y,3.4)`；✓→`scan.suspAck`、recalc 剔除；✕→从 ocr.map+result 删。
- v19 逐块审查 `startReview()`/`#scanRv`。**收敛性坑**：①suspAck 剔除必须在 `scan.suspIdx=` 赋值前**再剔一次**且 `!scan._adopting` 防打断 adopt 递归 ②rvReplace/rvReocr 必须 `add(旧号)`**和**`add(新号)`。
- v20：删了还有编号＝标签遍历 `ocr.results` 而删除只动 `ocr.map` → 加 `scan.ocr.drop` 黑名单，原读数 `{x,y,ang}` 存 `scan.ocr.keep`（不存则拼好组散架）。组框歪 40°＝det 框角 90° 歧义，2θ 平均把两垂直族抵消 → 改 **4θ 圆均值（周期 90°）**。散块模式孤片误报降级为 `scan.loosePairs` 软提示。漏识别片 `scanGaps`：片心圆窗 maskWhite 落在读数位自身分布（15%~92% 分位）之间、且离任何读数/推算位>0.72 片宽→灰虚线「?」。
- v21：`autoVerify(tag)` 串「复核漏读 → 补漏」，自动识别完/可疑审完后跑（autoChain 静默）。**v29f 起去掉 fillGaps 级**（补漏不自动跑，85890 收敛 80s+→13s），工具条 `#bExtend` 常驻。
- v28b 可疑点查重：recalcScan 末尾遍历 suspIdx，编号已在 set → 自动确认、移出人工队列，记 `scan.suspAuto`。**只删可疑标记，绝不动 set/map/inferredPos**。连带：查重吃光可疑走不到 `rvDone()` → 自动识别链也带 `{extend:true}`；`extendInfer` 的「没多推就退回」必须在 `was===0` 时才退。

## 布局 / 窄屏
- v22：≤900 `.scan-stage{flex:0 0 auto;height:clamp(160px,44vh,460px)}` + `.scan-side{flex:1 1 auto;min-height:0;overflow-y:auto}`。数据栏底 padding 归零（sticky;bottom:0 对齐内容盒底）；贴底栏必须 `flex:0 0 100%;width:100%`+`background:var(--panel)`。≤520：三动作键 12.5px、`.scan-bar` nowrap+overflow-x:auto。
- 引导浮条 ≤600 改 `grid`，`areas:"pic main" "btns btns"`，`#gdInfo` 一律 `order:3;flex:1 1 100%`（浮条最宽 560，塞一行必被挤成「…」）。
- DOM 坑：`classList.add()` 不接受含空格字符串（抛 SyntaxError）。

## 服务托管（v23）
- 页面不写死 `127.0.0.1:8849`；`server/ocr.js` 代管：探测 8849，没起就 spawn `label/ocr_server.py`（解释器必须实测 `-c "import rapidocr"`：`py -3`→`%LOCALAPPDATA%\Programs\Python\Python3xx\python.exe`→`python`；PATH 首个 python 是 managed 3.13.12 没装 rapidocr）；已在跑就复用、挂了 health 自愈（6s 防抖）。路由 `GET /ocrsvc/health`、`POST /ocrsvc/ocr`（express.raw 80mb）。前端 `OSVC.host`=location.origin+"/ocrsvc"，仅 file:// 直连。`start-lan-server.bat` 杀端口后**必须等真空闲**；**别一边跑 bat 一边编辑它**（cmd 按字节偏移续读会重复执行）；bat 改完转回 **CRLF**。

## 通用坑清单
- **dist 换 hash 但页面还跑旧 bundle**：build 后必须 `navigate_page(reload, ignoreCache:true)`，并用 `document.querySelectorAll('script[src]')` 验新 hash。验版本看 `dist/assets/*.js` 大小/时间戳。
- `canvas.width` 赋相同值也会清空内容 → layout 类函数须 `if(cv.width!==W)` 守卫。
- 杀服务用 PID（`netstat -ano | grep :8848`），勿 `taskkill //IM node.exe`（会连 chrome-devtools MCP 一起杀）。
- E2E：**必须先点 `#bScan` 开扫描页再载图**（否则 osvcProbe 未跑→静默回退内置模板，读数骤减误判回归）；照片同源 fetch → `new DataTransfer()` 给 `#fImg` 设 files 再 dispatch change；PointerEvent 派到 scanStage（pointerId 勿残留）；`window.__autoBusy()` **是函数**。切 emulate 视口会**整页重置**（`__scan.img/ocr/result` 全清），必须重扫。
- 调试钩子：`__scan` / `__addPiece(i,sx,sy)` / `__focus` / `__gaps` / `__drop` / `__recalc` / `__autoBusy` / `__guide(ids)`。
- canvas 取证：toDataURL 超限落 `.workbuddy/projects/**/tool-results/*.txt` → venv python 解码落盘 → Read 看图。
- 标注台：双击 `label/index.html` 即用（file://）；数据 localStorage `plabel:<照片名>`；导出 bbox 为原图像素坐标。模板库/OCR 核心由 `ocr-templates.js`、`ocr.js` sed 转换生成，**源文件更新后须重转**。
