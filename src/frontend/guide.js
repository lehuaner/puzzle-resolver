import { S } from "./store.js";
import { $, toast, vibrate } from "./dom.js";
import { fmt, idxToRC, zoneOf, zoneLetter } from "./coords.js";
import { mainComp, promoteConnected } from "./grid.js";
import { paint, afterChange, centerOnIdx } from "./board.js";
import { pushUndo } from "./interact.js";
import { markChange } from "./sync.js";

/* ================= 摆放引导 =================
   扫描应用后，把本次新增的块排成一条「由整到散、由近到远」的队列，
   底部浮条逐块提示位置：✓ 放好了（标完成并推进）/ 跳过 / 退出。
   高亮当前块（金色脉冲描边），块跑出视口时自动平移找回。
   状态放 S.guideActive（共享 store），避免与 interact.js 循环依赖。 */

var G={ q:[], k:0, cur:null };

// 队列排序：贴着已拼/待定区域的块先拼（顺着整体往外长），孤片后拼；
// 同级按到主片区质心的距离由近到远，少走动。
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
  function score(i){
    var nb=S.adj[i]||[], attached=false;
    for(var k=0;k<nb.length;k++){
      var st=S.states[nb[k]];
      if(st===1||st===3||st===4){ attached=true; break; }
    }
    var p=idxToRC(i);
    var d=main.length?Math.hypot(p.col-mc,p.row-mr):0;
    return (attached?0:1000)+d;
  }
  uniq.sort(function(a,b){ return score(a)-score(b); });
  return uniq;
}

// 当前块不在视口内（留 90px 边距）才平移，避免每步都大幅跳动
function ensureVisible(i){
  var p=idxToRC(i);
  var x=((p.col-1)*S.step+S.cellSize/2)*S.scale+S.tx;
  var y=((p.row-1)*S.step+S.cellSize/2)*S.scale+S.ty;
  var W=S.wrap.clientWidth, H=S.wrap.clientHeight, m=90;
  if(x<m||y<m||x>W-m||y>H-m) centerOnIdx(i,true);
}

function showCur(){
  if(G.cur!=null && S.cells[G.cur]) S.cells[G.cur].classList.remove("gcur");
  var i=G.q[G.k];
  G.cur=i;
  var el=S.cells[i];
  if(el) el.classList.add("gcur");
  $("gdNum").textContent=fmt(i);
  var p=idxToRC(i);
  $("gdInfo").textContent=zoneLetter(zoneOf(i))+"区 第"+p.col+"列 第"+p.row+"行";
  $("gdStep").textContent=(G.k+1)+"/"+G.q.length;
  ensureVisible(i);
}

function finishGuide(){
  var n=G.q.length;
  guideExit();
  toast("引导完成 · 共 "+n+" 块");
  vibrate([30,40,30]);
}

// ok=true「放好了」：当前块标完成（含相连待定自动转完成）后推进；
// ok=false「跳过」：保持原状态只推进。
function guideNext(ok){
  if(!S.guideActive) return;
  var i=G.cur;
  if(ok && i!=null && S.states[i]!==1){
    var orig=new Map();
    orig.set(i,S.states[i]);
    S.states[i]=1;
    promoteConnected().forEach(function(c){ if(!orig.has(c[0])) orig.set(c[0],c[1]); });
    orig.forEach(function(v,k){ paint(k); markChange(k); });
    pushUndo(Array.from(orig.entries()));
    afterChange();
    vibrate(15);
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
    if(G.cur!=null && S.cells[G.cur]) S.cells[G.cur].classList.remove("gcur");
    G.q=[]; G.cur=null;
  }
  G.q=q; G.k=0;
  S.guideActive=true;
  document.body.classList.add("guideon");
  showCur();
  toast("引导摆放 · 共 "+q.length+" 块，从大区域边缘开始");
}

export function guideExit(){
  if(!S.guideActive) return;
  if(G.cur!=null && S.cells[G.cur]) S.cells[G.cur].classList.remove("gcur");
  G.q=[]; G.k=0; G.cur=null;
  S.guideActive=false;
  document.body.classList.remove("guideon");
}

$("gdOk").addEventListener("click",function(){ guideNext(true); });
$("gdMain").addEventListener("click",function(){ guideNext(true); });   // 大目标：点编号区=放好了
$("gdSkip").addEventListener("click",function(){ guideNext(false); });
$("gdExit").addEventListener("click",guideExit);
