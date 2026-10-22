import { S } from "./store.js";
import { $, toast, vibrate } from "./dom.js";
import { fmt, idxToRC, zoneOf, zoneLetter } from "./coords.js";
import { mainComp, promoteConnected } from "./grid.js";
import { paint, afterChange, centerOnSet } from "./board.js";
import { pushUndo } from "./interact.js";
import { markChange } from "./sync.js";

/* ================= 摆放引导 =================
   扫描应用后，把本次新增的块排成一条队列，底部浮条逐条提示：
     · 先「离整图近的」——贴着已拼/待定区的那几块，顺着整体往外长；
     · 再「成块组」——OCR 认出来的拼好组，**一组算一次引导**（不是一块一次），
       一次把连着的那几块一起放，省得来回找。
   · 每条都会在浮条左边给一张**照片小窗**，把目标块在刚识别的那张照片上的
     位置圈出来——不然只报编号，人还得在照片里满地找"是哪一块"。
   高亮当前块（金色脉冲描边），块跑出视口时自动平移找回。
   状态放 S.guideActive（共享 store），避免与 interact.js 循环依赖；
   照片位置由 scan.js 通过 setGuideProviders 注入（避免 scan↔guide 循环 import）。 */

var G={ q:[], k:0, cur:[] };

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
  (G.cur||[]).forEach(function(i){ if(S.cells[i]) S.cells[i].classList.remove("gcur"); });
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
  $("gdStep").textContent=(G.k+1)+"/"+G.q.length;
  drawPhoto(it.ids);
  ensureVisible(it.ids);
}

function finishGuide(){
  var n=G.q.length;
  guideExit();
  toast("引导完成 · 共 "+n+" 条");
  vibrate([30,40,30]);
}

// ok=true「放好了」：当前条目（单块 / 整组）标完成（含相连待定自动转完成）后推进；
// ok=false「跳过」：保持原状态只推进。
function guideNext(ok){
  if(!S.guideActive) return;
  var ids=G.cur||[];
  if(ok){
    var orig=new Map();
    ids.forEach(function(i){ if(i!=null && S.states[i]!==1) orig.set(i,S.states[i]); });
    if(orig.size){
      orig.forEach(function(v,k){ S.states[k]=1; });
      promoteConnected().forEach(function(c){ if(!orig.has(c[0])) orig.set(c[0],c[1]); });
      orig.forEach(function(v,k){ paint(k); markChange(k); });
      pushUndo(Array.from(orig.entries()));
      afterChange();
      vibrate(15);
    }
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
  G.q=q; G.k=0;
  S.guideActive=true;
  document.body.classList.add("guideon");
  showCur();
  var nG=q.filter(function(it){ return it.group; }).length;
  toast("引导摆放 · "+q.length+" 条（先放离整图近的 "
    +(q.length-nG)+" 块"+(nG?("，再 "+nG+" 个成块组"):"")+"）");
}

export function guideExit(){
  if(!S.guideActive) return;
  clearGcur();
  G.q=[]; G.k=0; G.cur=[];
  S.guideActive=false;
  document.body.classList.remove("guideon");
  var cv=$("gdPic"); if(cv) cv.style.display="none";
}

$("gdOk").addEventListener("click",function(){ guideNext(true); });
$("gdMain").addEventListener("click",function(){ guideNext(true); });   // 大目标：点编号区=放好了
$("gdSkip").addEventListener("click",function(){ guideNext(false); });
$("gdExit").addEventListener("click",guideExit);
