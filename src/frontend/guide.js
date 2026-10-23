import { S } from "./store.js";
import { $, toast, vibrate } from "./dom.js";
import { fmt, idxToRC, zoneOf, zoneLetter } from "./coords.js";
import { mainComp, promoteConnected } from "./grid.js";
import { paint, afterChange, focusSet } from "./board.js";
import { pushUndo, setUndoHook } from "./interact.js";
import { markChange } from "./sync.js";
import { beaconShow, beaconHide } from "./beacon.js";

/* ================= 摆放引导 =================
   「引导摆放」不再一次性把识别结果全铺到棋盘（那样一进引导就已经全绿了，
   引导本身没意义）。现在改成**一步一步来**：
     · 进引导时棋盘只有本来就拼好的块；
     · 顺序两级：**整**与整之间「由整到散、由近到远」，**整内部**「先组再独立、先多再少」；
     · 每一步要么是**一个拼好组**（已经拼成组的，无需一步一步引导），
       要么是**一片独立片**：浮条报编号 + 「哪一区第几列第几行」+ 挨着哪块已拼好的，
       目标在棋盘上**持续闪**（亮的那一相就是图例里的「进行中」），直到用户点下一步；
       同时按视口比例缩放居中，让目标占住屏幕的固定份额；
     · 「✓ 放好了」→ 这一步才真正写进棋盘（没连主片区的标待定）；
     · 「跳过」→ 保持未拼，直接下一步；中途退出则没确认的都留在未拼。
   · 每一步都带一张**照片小窗**：整张输入照片 + 当前这一步每一片的位置；
     **已经放好的块在小窗里涂成背景色**（点一次「放好了」就少一块），进度一眼看得出。
   状态放 S.guideActive（共享 store），避免与 interact.js 循环依赖；
   照片位置由 scan.js 通过 setGuideProviders 注入（避免 scan↔guide 循环 import）。 */

var G={ q:[], k:0, cur:[], done:0, applied:[] };

/* 当前目标的高亮/闪烁交给 beacon.js（和「找点」用同一套：进行中绿底 + 620ms 硬闪）。
   独立片亮一块、拼好组亮整组；点「放好了 / 跳过」后 showCur 换目标。 */

var infoProv=null, drawProv=null;
/* scan.js 注入：infoFn() → {grpOf:{idx:组号}}（OCR 认出来的拼好组）；
   drawFn(canvas, ids) → 画出照片小窗 */
export function setGuideProviders(infoFn, drawFn){ infoProv=infoFn; drawProv=drawFn; }

function guideInfo(){
  try{ if(infoProv){ return infoProv()||{}; } }catch(err){}
  return {};
}

/* 队列分两级（用户澄清：「由整到散、由近到远指的是**顺序**，
   如果这个整由许多碎片组成，需要分步引导，只不过碎片的引导放在一块罢了」）：
     · **整**＝网格 4 邻连起来的目标块。整与整之间按「由整到散、由近到远」排：
       能连上已拼区的先 → 整大的先（由整到散）→ 离主片区近的先 → 编号小；
     · **整内部**按用户要的「先组再独立、先多再少」：OCR 认得出的**拼好组**整组算一步
       （「已经拼成组的，无需一步一步引导」），组大的在前；剩下的独立片才一片一步。
   步长曾整片算一步，用户：「只要是连起来的直接算作一步，图片预览也只框选范围，
   而不是告诉你具体哪一片」—— 那说的是**没组的散片也被合成一步**；
   有组的组仍然整组走，只是预览要把组里每一片都钉出来。 */
function buildQueue(targets){
  var main=mainComp();
  var mc=0, mr=0;
  if(main.length){
    main.forEach(function(i){ var p=idxToRC(i); mc+=p.col; mr+=p.row; });
    mc/=main.length; mr/=main.length;
  }
  var seen=new Set(), uniq=[];
  (targets||[]).forEach(function(i){
    if(i>=1 && i<=S.cfg.total && !seen.has(i)){ seen.add(i); uniq.push(i); }
  });
  // OCR 认出来的「拼好组」：组内整组算一步，不一片一片来
  var grpOf={};
  var gsrc=guideInfo().grpOf||{};
  for(var sk in gsrc){ if(gsrc[sk]!=null) grpOf[sk]=+gsrc[sk]; }
  // 并查集：目标块之间按网格 4 邻合并成「整」
  var par={};
  function find(a){ while(par[a]!==a){ par[a]=par[par[a]]; a=par[a]; } return a; }
  uniq.forEach(function(i){ par[i]=i; });
  var inSet=new Set(uniq);
  uniq.forEach(function(i){
    (S.adj[i]||[]).forEach(function(j){
      if(inSet.has(j)){ var a=find(i), b=find(j); if(a!==b) par[b]=a; }
    });
  });
  var comps={}, roots=[];
  uniq.forEach(function(i){
    var r=find(i);
    if(!comps[r]){ comps[r]=[]; roots.push(r); }
    comps[r].push(i);
  });
  var wholes=[];
  roots.forEach(function(r){
    var ids=comps[r], cc=0, cr=0;
    ids.forEach(function(i){
      var p=idxToRC(i); cc+=p.col; cr+=p.row;
    });
    cc/=ids.length; cr/=ids.length;
    var cd=main.length?Math.hypot(cc-mc,cr-mr):0;
    function dOf(a){                      // 一小堆块的质心到主片区的距离
      var c2=0, r2=0;
      a.forEach(function(i){ var p=idxToRC(i); c2+=p.col; r2+=p.row; });
      return main.length?Math.hypot(c2/a.length-mc, r2/a.length-mr):0;
    }
    /* 整内部：先组（大组在前）再独立片 —— 用户「先组再独立，先多再少」 */
    var byGrp={}, solo=[];
    ids.forEach(function(i){
      var g=grpOf[i];
      if(g!=null) (byGrp[g]=byGrp[g]||[]).push(i);
      else solo.push(i);
    });
    var subs=[];
    Object.keys(byGrp).forEach(function(g){
      var a=byGrp[g].slice().sort(function(x,y){ return x-y; });
      subs.push({ ids:a, isGrp:true, n:a.length, head:a[0], dist:dOf(a) });
    });
    solo.forEach(function(i){
      var p=idxToRC(i);
      subs.push({ ids:[i], isGrp:false, n:1, head:i,
                  dist: main.length?Math.hypot(p.col-mc,p.row-mr):0 });
    });
    subs.sort(function(a,b){
      if(a.isGrp!==b.isGrp) return a.isGrp?-1:1;   // 先组再独立
      if(a.n!==b.n) return b.n-a.n;                // 先多再少
      if(a.dist!==b.dist) return a.dist-b.dist;    // 由近到远
      return a.head-b.head;
    });
    wholes.push({ ids:ids.slice().sort(function(x,y){ return x-y; }), subs:subs,
                  n:ids.length, cd:cd, head:Math.min.apply(null,ids) });
  });
  return growOrder(wholes);
}

/* 整与整之间的排序（进引导时一次算定，这样撤销回退才能按序号走）＝
   「先把能连起来的先连起来，整块的优先；这个整周围没有可以再连的点，就切换下一个整块」：
     ① 紧挨着**已经拼起来的**（棋盘上原有的 + 这一遍已经排上的整）的先挑，
        里面再按 整大 → 离主片区近 → 编号小；
     ② 全都接不上 → 按 整大 → 近 → 编号小 另起一个整（由整到散、由近到远）。 */
function growOrder(wholes){
  var done=new Set();
  for(var k=1;k<=S.cfg.total;k++){
    var st=S.states[k];
    if(st===1||st===3||st===4) done.add(k);
  }
  var left=wholes.slice(), out=[];

  function touches(w,set){
    if(!set) return false;
    for(var k=0;k<w.ids.length;k++){
      var nb=S.adj[w.ids[k]]||[];
      for(var j=0;j<nb.length;j++) if(set.has(nb[j])) return true;
    }
    return false;
  }
  function wholeCmp(a,b){                     // 整大 → 近 → 编号小
    if(a.n!==b.n) return b.n-a.n;
    if(a.cd!==b.cd) return a.cd-b.cd;
    return a.head-b.head;
  }
  function pickIn(pred){
    var pick=-1;
    for(var k=0;k<left.length;k++){
      if(pred && !pred(left[k])) continue;
      if(pick<0 || wholeCmp(left[k],left[pick])<0) pick=k;
    }
    return pick;
  }

  while(left.length){
    var p=pickIn(function(w){ return touches(w,done); });   // ① 能连上已拼区的先
    if(p<0) p=pickIn(null);                                 // ② 接不上：由整到散、由近到远另起一个
    var w=left.splice(p,1)[0];
    out.push(w);
    w.ids.forEach(function(i){ done.add(i); });
  }
  // 整内部顺序在 buildQueue 里已经按「先组再独立、先多再少」排好，这里直接展开
  var q=[];
  out.forEach(function(w){ w.subs.forEach(function(s){ q.push(s); }); });
  return q;
}

/* 浮条左边的照片小窗：把目标块（组）在**刚识别的那张照片**上的位置圈出来 */
function drawPhoto(ids){
  var cv=$("gdPic"); if(!cv) return;
  var ok=false;
  try{ ok = drawProv ? !!drawProv(cv, ids) : false; }catch(err){ ok=false; }
  cv.style.display = ok ? "block" : "none";
}

function clearGcur(){
  beaconHide();
  G.cur=[];
}

function showCur(){
  clearGcur();
  var it=G.q[G.k];
  if(!it) return;
  G.cur=it.ids.slice();
  beaconShow(G.cur);                  // 亮起来并按 620ms 闪（进行中色），直到点下一步
  if(it.ids.length===1){
    /* 独立片：浮条直接说「哪一片、放哪里」——编号 + 区/列/行 + 挨着哪块已拼好的。
       引导顺序本身就是贴着已拼区长出来的，所以「挨着谁」几乎总有答案。 */
    var i0=it.ids[0], p=idxToRC(i0), nb=[];
    (S.adj[i0]||[]).forEach(function(j){
      if(nb.length>=2) return;
      if(S.states[j]===1||S.states[j]===3) nb.push(fmt(j));
    });
    $("gdNum").textContent=fmt(i0);
    $("gdInfo").textContent=zoneLetter(zoneOf(i0))+"区 第"+p.col+"列 第"+p.row+"行"
      +(nb.length?(" · 挨着 "+nb.join("、")):"");
  } else {
    /* 一个拼好组整组算一步（「已经拼成组的，无需一步一步引导」）：
       报块数 + 前几片的编号，小窗里组里每一片都钉金框。 */
    $("gdNum").textContent="整组·"+it.ids.length+"块";
    $("gdInfo").textContent="这一组一起放："
      +it.ids.slice(0,5).map(fmt).join("·")+(it.ids.length>5?"…":"");
  }
  $("gdStep").textContent=(G.k+1)+"/"+G.q.length+(G.done?" · 已放 "+G.done:"");
  drawPhoto(it.ids);
  focusSet(it.ids,{keepDone:true});    // 与「找点」同一套：按比例缩放 + 留住一块已完成的片
}

function finishGuide(){
  var n=G.q.length, d=G.done;
  guideExit();
  toast("引导完成 · "+n+" 步，已放 "+d+" 步"+(d<n?("，跳过 "+(n-d)+" 步"):""));
  vibrate([30,40,30]);
}

/* 把一条引导（单块或整组）真正写进棋盘：与「应用」同样的口径——
   先按应用前的主片区判定，连不上主片区的标「待定」（黄），其余转完成。 */
function applyItem(ids){
  var base=new Set();
  for(var k=1;k<=S.cfg.total;k++){ if(S.states[k]===1) base.add(k); }
  var orig=new Map();
  ids.forEach(function(i){ if(i!=null && S.states[i]!==1) orig.set(i,S.states[i]); });
  if(!orig.size) return { n:0, demoted:0 };
  var mainSet=new Set(mainComp(base));   // 注意：base 为空时它返回「目前棋盘上最大的那片」
  var hadMain=base.size>0;               // 这一条之前棋盘上有主片区吗
  orig.forEach(function(v,k){ S.states[k]=1; });
  /* 棋盘上一块都还没拼过：这次放的这条本身就是主片区，不能判「连不上」。
     （base 为空时 mainComp 只能看棋盘上已有的块，可能是别处的待定块 → 会把这一条全判成待定） */
  if(hadMain) orig.forEach(function(v,k){
    if(S.states[k]===1 && !mainSet.has(k)){ S.states[k]=3; }
  });
  promoteConnected().forEach(function(c){ if(!orig.has(c[0])) orig.set(c[0],c[1]); });
  /* 待定数要**在 promoteConnected 之后**数：刚判的待定如果其实连着主片区，
     上面那步会把它们转回完成（也有它自己连成一片的情况），先数就报了假警。 */
  var demoted=0;
  orig.forEach(function(v,k){ if(S.states[k]===3) demoted++; });
  orig.forEach(function(v,k){ paint(k); markChange(k); });
  var ids=Array.from(orig.keys());
  pushUndo(Array.from(orig.entries()));
  afterChange();
  return { n:orig.size, demoted:demoted, ids:ids };
}

/* 撤销联动：撤销的正好是引导放下的某一条 → 引导跳回那一条（重新高亮 + 重新聚焦）。
   记录用**栈**：中途点过「跳过」不影响判断（跳过不产生撤销记录），
   所以「放 A → 跳过 B → 撤销」应该退回 A，而不是停在 B。
   其它改动（比如引导途中随手点了别的块）只回退棋盘，不动引导指针。 */
function guideOnUndo(chunk){
  if(!S.guideActive || !G.applied.length) return false;
  var top=G.applied[G.applied.length-1];
  var got=new Set();
  for(var k=0;k<chunk.length;k++) got.add(chunk[k][0]);
  if(got.size!==top.ids.length) return false;
  for(var j=0;j<top.ids.length;j++) if(!got.has(top.ids[j])) return false;
  G.applied.pop();
  if(G.done>0) G.done--;
  G.k=top.k;
  showCur();                    // 回到那一条：闪的还是它，缩放也回到它
  return true;
}
setUndoHook(guideOnUndo);

// ok=true「放好了」：这一步写进棋盘；ok=false「跳过」：保持未拼。
function guideNext(ok){
  if(!S.guideActive) return;
  var ids=(G.cur||[]).slice();
  var at=G.k;
  /* 点「放好了」不弹任何提示（用户：「不要有任何提示出现」）——
     棋盘上那几片转绿、引导自己跳到下一步，本身就是反馈；再弹一条 toast
     每步都拦一下视线。只留一下极轻的震动确认点到。 */
  if(ok){
    var r=applyItem(ids);
    if(r.n){
      G.done++;
      if(r.ids) G.applied.push({ k:at, ids:r.ids });
      vibrate(15);
    }
  } else if(ids.length){
    toast("已跳过 "+fmt(ids[0])+"（保持未拼）");
  }
  G.k++;
  if(G.k>=G.q.length){ finishGuide(); return; }
  showCur();
}

export function startGuide(targets){
  var q=buildQueue(targets);
  if(!q.length){ toast("没有需要引导的块"); return; }
  if(S.guideActive){
    // 重入：丢掉旧队列直接重启
    clearGcur();
    G.q=[]; G.cur=[];
  }
  G.q=q; G.k=0; G.done=0;
  S.guideActive=true;
  document.body.classList.add("guideon");
  showCur();
  var nGrp=q.filter(function(it){ return it.ids.length>1; }).length;
  toast("引导摆放 · "+q.length+" 步（拼好组整组算一步 "+nGrp+" 组，其余一片一步；"
        +"由整到散、由近到远）· 放好一步才落一步");
}

export function guideExit(){
  if(!S.guideActive) return;
  var left=G.q.length-G.k-(G.k<G.q.length?1:0);   // 还没轮到的步数
  clearGcur();
  G.q=[]; G.k=0; G.cur=[]; G.done=0; G.applied=[];
  S.guideActive=false;
  document.body.classList.remove("guideon");
  var cv=$("gdPic"); if(cv) cv.style.display="none";
  return left;
}

$("gdOk").addEventListener("click",function(){ guideNext(true); });
$("gdMain").addEventListener("click",function(){ guideNext(true); });   // 大目标：点编号区=放好了
$("gdSkip").addEventListener("click",function(){ guideNext(false); });
$("gdExit").addEventListener("click",function(){
  var left=guideExit();
  toast(left>0 ? ("已退出引导 · 还有 "+left+" 步没放（保持未拼）") : "已退出引导");
});
