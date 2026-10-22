import { S } from "./store.js";
import { $, toast, vibrate } from "./dom.js";
import { fmt, idxToRC, zoneOf, zoneLetter } from "./coords.js";
import { mainComp, promoteConnected } from "./grid.js";
import { paint, afterChange, centerOnSet } from "./board.js";
import { pushUndo } from "./interact.js";
import { markChange } from "./sync.js";

/* ================= 摆放引导 =================
   「引导摆放」不再一次性把识别结果全铺到棋盘（那样一进引导就已经全绿了，
   引导本身没意义）。现在改成**逐条应用**：
     · 进引导时棋盘只有本来就拼好的块；
     · 浮条逐条提示目标（单块，或 OCR 认出来的**整组算一条**），
       目标块在棋盘上**持续闪烁**（整组就整组一起闪），直到用户点下一步；
     · 「✓ 放好了」→ 这一条（单块/整组）才真正写进棋盘（没连主片区的标待定）；
     · 「跳过」→ 保持未拼，直接下一条；中途退出则没确认的都留在未拼。
   · 每条都带一张**照片小窗**，圈出目标块在刚识别的那张照片上的位置。
   状态放 S.guideActive（共享 store），避免与 interact.js 循环依赖；
   照片位置由 scan.js 通过 setGuideProviders 注入（避免 scan↔guide 循环 import）。 */

var G={ q:[], k:0, cur:[], done:0, blinkT:null, off:false };

/* 当前目标持续闪烁：每 520ms 在 .gcur 上切一次 .blinkOff（CSS 里把描边藏起来）。
   单块闪一块、整组闪整组；点「放好了 / 跳过」后 showCur 会给新目标重新挂上。 */
function startBlink(){
  stopBlink();
  G.off=false;
  G.blinkT=setInterval(function(){
    if(!S.guideActive){ stopBlink(); return; }
    G.off=!G.off;
    (G.cur||[]).forEach(function(i){
      var el=S.cells[i]; if(!el) return;
      if(G.off) el.classList.add("blinkOff"); else el.classList.remove("blinkOff");
    });
  }, 520);
}
function stopBlink(){
  if(G.blinkT){ clearInterval(G.blinkT); G.blinkT=null; }
  (G.cur||[]).forEach(function(i){
    var el=S.cells[i]; if(el) el.classList.remove("blinkOff");
  });
}

var infoProv=null, drawProv=null;
/* scan.js 注入：infoFn() → {grpOf:{idx:组号}}；drawFn(canvas, ids) → 画出照片小窗 */
export function setGuideProviders(infoFn, drawFn){ infoProv=infoFn; drawProv=drawFn; }

function grpOfMap(){
  try{ if(infoProv){ var inf=infoProv(); return (inf&&inf.grpOf)||{}; } }catch(err){}
  return {};
}

// 队列排序：单片「贴已拼区优先 + 到主片区质心由近到远」；
// 成块组按组质心同样由近到远，整体排在单片之后（先把整图边缘接上再端整块）。
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
  var grpOf=grpOfMap();
  var byGrp={}, singles=[];
  uniq.forEach(function(i){
    var g=grpOf[i];
    if(g!=null) (byGrp[g]=byGrp[g]||[]).push(i);
    else singles.push(i);
  });
  var items=[];
  Object.keys(byGrp).forEach(function(g){
    var ids=byGrp[g].slice().sort(function(a,b){ return a-b; });
    if(ids.length>=2) items.push({ ids:ids, grp:+g, group:true });
    else singles.push(ids[0]);
  });
  function attached(i){
    var nb=S.adj[i]||[];
    for(var k=0;k<nb.length;k++){
      var st=S.states[nb[k]];
      if(st===1||st===3||st===4) return true;
    }
    return false;
  }
  function centroidDist(ids){
    if(!main.length) return 0;
    var c=0, r=0;
    ids.forEach(function(i){ var p=idxToRC(i); c+=p.col; r+=p.row; });
    return Math.hypot(c/ids.length-mc, r/ids.length-mr);
  }
  var singleItems=singles.map(function(i){
    return { ids:[i], grp:null, group:false,
             score:(attached(i)?0:1000)+centroidDist([i]) };
  });
  items.forEach(function(it){ it.score=centroidDist(it.ids); });
  singleItems.sort(function(a,b){ return a.score-b.score; });
  items.sort(function(a,b){ return a.score-b.score; });
  return singleItems.concat(items);          // 先离整图近的，再成块组
}

// 当前块不在视口内（留 90px 边距）才平移，避免每步都大幅跳动
function ensureVisible(ids){
  var c=0, r=0;
  ids.forEach(function(i){ var p=idxToRC(i); c+=p.col; r+=p.row; });
  c/=ids.length; r/=ids.length;
  var x=((c-1)*S.step+S.cellSize/2)*S.scale+S.tx;
  var y=((r-1)*S.step+S.cellSize/2)*S.scale+S.ty;
  var W=S.wrap.clientWidth, H=S.wrap.clientHeight, m=90;
  if(x<m||y<m||x>W-m||y>H-m) centerOnSet(ids,true);
}

/* 浮条左边的照片小窗：把目标块（组）在**刚识别的那张照片**上的位置圈出来 */
function drawPhoto(ids){
  var cv=$("gdPic"); if(!cv) return;
  var ok=false;
  try{ ok = drawProv ? !!drawProv(cv, ids) : false; }catch(err){ ok=false; }
  cv.style.display = ok ? "block" : "none";
}

function clearGcur(){
  stopBlink();
  (G.cur||[]).forEach(function(i){
    var el=S.cells[i]; if(!el) return;
    el.classList.remove("gcur"); el.classList.remove("blinkOff");
  });
}

function showCur(){
  clearGcur();
  var it=G.q[G.k];
  if(!it) return;
  G.cur=it.ids.slice();
  it.ids.forEach(function(i){ if(S.cells[i]) S.cells[i].classList.add("gcur"); });
  if(it.ids.length===1){
    var i0=it.ids[0], p=idxToRC(i0);
    $("gdNum").textContent=fmt(i0);
    $("gdInfo").textContent=zoneLetter(zoneOf(i0))+"区 第"+p.col+"列 第"+p.row+"行";
  } else {
    $("gdNum").textContent="组"+(it.grp!=null?(it.grp+1):"")+"·"+it.ids.length+"块";
    $("gdInfo").textContent="整组一起放："+it.ids.slice(0,4).map(fmt).join("·")
      +(it.ids.length>4?"…":"");
  }
  $("gdStep").textContent=(G.k+1)+"/"+G.q.length+(G.done?" · 已放 "+G.done:"");
  drawPhoto(it.ids);
  ensureVisible(it.ids);
  startBlink();                       // 闪到用户点下一步为止
}

function finishGuide(){
  var n=G.q.length, d=G.done;
  guideExit();
  toast("引导完成 · "+n+" 条，已放 "+d+" 条"+(d<n?("，跳过 "+(n-d)+" 条"):""));
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
  pushUndo(Array.from(orig.entries()));
  afterChange();
  return { n:orig.size, demoted:demoted };
}

// ok=true「放好了」：这一条（单块 / 整组）写进棋盘；ok=false「跳过」：保持未拼。
function guideNext(ok){
  if(!S.guideActive) return;
  var ids=(G.cur||[]).slice();
  if(ok){
    var r=applyItem(ids);
    if(r.n){
      G.done++;
      toast("已放 "+r.n+" 块"+(r.demoted?("，其中 "+r.demoted+" 块待定（还没连上主片区）"):""));
      vibrate(15);
    }
  } else if(ids.length){
    toast("已跳过 "+ids.length+" 块（保持未拼）");
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
  var nG=q.filter(function(it){ return it.group; }).length;
  toast("引导摆放 · "+q.length+" 条（先放离整图近的 "
    +(q.length-nG)+" 块"+(nG?("，再 "+nG+" 个成块组"):"")+"）· 放好一条才落一条");
}

export function guideExit(){
  if(!S.guideActive) return;
  var left=G.q.length-G.k-(G.k<G.q.length?1:0);   // 还没轮到的条数
  clearGcur();
  G.q=[]; G.k=0; G.cur=[]; G.done=0;
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
  toast(left>0 ? ("已退出引导 · 还有 "+left+" 条没放（保持未拼）") : "已退出引导");
});
