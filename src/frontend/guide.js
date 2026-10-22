import { S } from "./store.js";
import { $, toast, vibrate } from "./dom.js";
import { fmt, idxToRC, zoneOf, zoneLetter } from "./coords.js";
import { mainComp, promoteConnected } from "./grid.js";
import { paint, afterChange, applyPan } from "./board.js";
import { pushUndo } from "./interact.js";
import { markChange } from "./sync.js";

/* ================= 摆放引导 =================
   「引导摆放」不再一次性把识别结果全铺到棋盘（那样一进引导就已经全绿了，
   引导本身没意义）。现在改成**逐条应用**：
     · 进引导时棋盘只有本来就拼好的块；
     · 浮条逐条提示目标：OCR 认出来的整组、或**编号上相邻能拼成一片的几块**算一条，
       目标在棋盘上**持续闪**（亮的那一相就是图例里的「进行中」），直到用户点下一步；
       同时按视口比例缩放居中，让目标占住屏幕的固定份额；
     · 「✓ 放好了」→ 这一条才真正写进棋盘（没连主片区的标待定）；
     · 「跳过」→ 保持未拼，直接下一条；中途退出则没确认的都留在未拼。
   · 每条都带一张**照片小窗**，圈出目标块在刚识别的那张照片上的位置。
   状态放 S.guideActive（共享 store），避免与 interact.js 循环依赖；
   照片位置由 scan.js 通过 setGuideProviders 注入（避免 scan↔guide 循环 import）。 */

var G={ q:[], k:0, cur:[], done:0, blinkT:null, on:false };

/* 当前目标持续闪烁：亮的那一相**就是图例里的「进行中」**（绿底呼吸闪 breath），
   灭的那一相退回块本来的颜色，位置靠一直挂着的一圈绿色描边（.gcur::after）钉住。
   单块闪一块、整片闪整片；点「放好了 / 跳过」后 showCur 会给新目标重新挂上。 */
function startBlink(){
  stopBlink();
  G.on=true;
  (G.cur||[]).forEach(function(i){ if(S.cells[i]) S.cells[i].classList.add("gblink"); });
  G.blinkT=setInterval(function(){
    if(!S.guideActive){ stopBlink(); return; }
    G.on=!G.on;
    (G.cur||[]).forEach(function(i){
      var el=S.cells[i]; if(!el) return;
      if(G.on) el.classList.add("gblink"); else el.classList.remove("gblink");
    });
  }, 620);
}
function stopBlink(){
  if(G.blinkT){ clearInterval(G.blinkT); G.blinkT=null; }
  (G.cur||[]).forEach(function(i){
    var el=S.cells[i]; if(el) el.classList.remove("gblink");
  });
}

var infoProv=null, drawProv=null;
/* scan.js 注入：infoFn() → {grpOf:{idx:组号}}；drawFn(canvas, ids) → 画出照片小窗 */
export function setGuideProviders(infoFn, drawFn){ infoProv=infoFn; drawProv=drawFn; }

function grpOfMap(){
  try{ if(infoProv){ var inf=infoProv(); return (inf&&inf.grpOf)||{}; } }catch(err){}
  return {};
}

/* 队列：
   ①先把目标块按**网格 4 邻**并成「连片」——OCR 没认成一组、但编号上挨着的几块，
     本来就是能拼成一整块的，一次引导整片，别东一块西一块地闪；
   ②连片太大（>MAXC）就退回 OCR 组 / 单块，免得一次闪半个屏幕；
   ③排序：贴已拼区的先 → 连片大的先 → 离已拼区质心近的先。 */
var MAXC=9;
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

  // 并查集：目标块之间按网格 4 邻合并
  var par={};
  function find(a){ while(par[a]!==a){ par[a]=par[par[a]]; a=par[a]; } return a; }
  uniq.forEach(function(i){ par[i]=i; });
  var inSet=new Set(uniq);
  uniq.forEach(function(i){
    (S.adj[i]||[]).forEach(function(j){ if(inSet.has(j)){ var a=find(i), b=find(j); if(a!==b) par[b]=a; } });
  });
  var cl={};
  uniq.forEach(function(i){ var r=find(i); (cl[r]=cl[r]||[]).push(i); });

  var items=[];
  Object.keys(cl).forEach(function(r){
    var ids=cl[r].sort(function(a,b){ return a-b; });
    if(ids.length<=MAXC){
      var gs={};
      ids.forEach(function(i){ if(grpOf[i]!=null) gs[grpOf[i]]=1; });
      var ks=Object.keys(gs);
      items.push({ ids:ids,
                   grp:(ks.length===1?+ks[0]:null),
                   group:(ids.length>=2 && ks.length===1),   // 就是一个 OCR 拼好组
                   merged:(ids.length>=2 && ks.length!==1) }); // 相邻块拼出来的连片
    } else {
      // 太大：按 OCR 组拆开，没组的单块各自一条
      var byGrp={};
      ids.forEach(function(i){
        var g=grpOf[i];
        if(g!=null) (byGrp[g]=byGrp[g]||[]).push(i);
        else items.push({ ids:[i], grp:null, group:false });
      });
      Object.keys(byGrp).forEach(function(g){
        var a=byGrp[g].sort(function(x,y){ return x-y; });
        items.push({ ids:a, grp:+g, group:a.length>=2 });
      });
    }
  });

  function attached(ids){
    for(var k=0;k<ids.length;k++){
      var nb=S.adj[ids[k]]||[];
      for(var j=0;j<nb.length;j++){
        var st=S.states[nb[j]];
        if(st===1||st===3||st===4) return true;
      }
    }
    return false;
  }
  function centroidDist(ids){
    if(!main.length) return 0;
    var c=0, r=0;
    ids.forEach(function(i){ var p=idxToRC(i); c+=p.col; r+=p.row; });
    return Math.hypot(c/ids.length-mc, r/ids.length-mr);
  }
  items.forEach(function(it){
    it.att=attached(it.ids);
    it.n=it.ids.length;
    it.dist=centroidDist(it.ids);
    it.head=it.ids[0];        // 编号最小的一块：棋盘还空时拿它当「从上往下、从左往右」的次序
  });
  items.sort(function(a,b){
    if(a.att!==b.att) return a.att?-1:1;      // 先把已经能接上的放完
    if(a.n!==b.n) return b.n-a.n;              // 能整片放的优先（别东一块西一块）
    if(a.dist!==b.dist) return a.dist-b.dist;
    return a.head-b.head;
  });
  return items;
}

/* 目标缩放：让这一片在屏幕上**按比例**占住一个稳定的位置——
   长短边都塞进「可视区短边的 42%」，单块再放大一点（1.0~2.6 之间夹住），
   然后居中到**没被浮条盖住的那块可视区**。这样单块不会只剩一个小点、
   整片也不会撑出屏幕外；目标也不会被底部浮条压到。 */
function focusItem(ids){
  var W=S.wrap.clientWidth, H=S.wrap.clientHeight;
  if(!W||!H) return;
  var p=idxToRC(ids[0]);
  var minC=p.col, maxC=p.col, minR=p.row, maxR=p.row;
  ids.forEach(function(i){
    var q=idxToRC(i);
    if(q.col<minC) minC=q.col; if(q.col>maxC) maxC=q.col;
    if(q.row<minR) minR=q.row; if(q.row>maxR) maxR=q.row;
  });
  // 浮条压在画面底部：把「可视高度」扣掉被盖住的那截，目标居中到剩下的区域
  var visH=H, gb=$("guideBar");
  try{
    if(gb && gb.getBoundingClientRect){
      var wr=S.wrap.getBoundingClientRect(), br=gb.getBoundingClientRect();
      var cover=wr.bottom-br.top;
      if(cover>0) visH=Math.max(H*0.45, H-Math.min(cover,H*0.55));
    }
  }catch(err){}
  var bw=(maxC-minC)*S.step+S.cellSize, bh=(maxR-minR)*S.step+S.cellSize;
  var box=Math.min(W, visH)*0.42;
  var s=Math.min(box/bw, box/bh);
  s=Math.max(0.55, Math.min(2.6, s));   // 单块放大到 2.6 封顶，整片最多缩到 0.55（再小字就看不清）
  S.scale=s;
  var cx=((minC-1)*S.step+bw/2)*s, cy=((minR-1)*S.step+bh/2)*s;
  S.tx=W/2-cx; S.ty=visH/2-cy;
  applyPan(true);
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
    el.classList.remove("gcur"); el.classList.remove("gblink");
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
    var tag = it.group ? ("组"+(it.grp+1)) : "连片";
    $("gdNum").textContent=tag+"·"+it.ids.length+"块";
    $("gdInfo").textContent=(it.group?"整组一起放：":"这些挨着放：")
      +it.ids.slice(0,4).map(fmt).join("·")+(it.ids.length>4?"…":"");
  }
  $("gdStep").textContent=(G.k+1)+"/"+G.q.length+(G.done?" · 已放 "+G.done:"");
  drawPhoto(it.ids);
  focusItem(it.ids);                  // 按视口比例缩放 + 居中，突出目标
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
  var nMulti=q.filter(function(it){ return it.ids.length>1; }).length;
  toast("引导摆放 · "+q.length+" 条（接上已拼区的先放，能挨成一片的 "
    +(nMulti||0)+" 条整片放）· 放好一条才落一条");
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
