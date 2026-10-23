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

var G={ q:[], k:0, cur:[], done:0, applied:[] };

/* 当前目标的高亮/闪烁交给 beacon.js（和「找点」用同一套：进行中绿底 + 620ms 硬闪）。
   单块亮一块、整片亮整片；点「放好了 / 跳过」后 showCur 换目标。 */

var infoProv=null, drawProv=null;
/* scan.js 注入：infoFn() → {grpOf:{idx:组号}}；drawFn(canvas, ids) → 画出照片小窗 */
export function setGuideProviders(infoFn, drawFn){ infoProv=infoFn; drawProv=drawFn; }

function guideInfo(){
  try{ if(infoProv){ return infoProv()||{}; } }catch(err){}
  return {};
}
function grpOfMap(){ return guideInfo().grpOf||{}; }

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
  var info=guideInfo();
  var grpOf={};
  var src=info.grpOf||{};
  for(var sk in src){ if(src[sk]!=null) grpOf[sk]=src[sk]; }
  /* 整块模式（网格映射可信，残差 <0.5 格距）：4 邻相邻就是真的拼在一起。
     OCR 并查集只把「读到的编号」并成组，推算出来的块没组号 → 排队时全散成单块
     （用户：『除了最大的组，剩下都是单个单个的，但它们其实也在组内、是连在一起的』）。
     这里把没组的块**顺着 4 邻并进相邻的组**（多轮扩散），一条引导就是一整片。 */
  if(info.block){
    var gsz={};
    uniq.forEach(function(i){ if(grpOf[i]!=null) gsz[grpOf[i]]=(gsz[grpOf[i]]||0)+1; });
    for(var pass=0; pass<4; pass++){
      var moved=0;
      uniq.forEach(function(i){
        if(grpOf[i]!=null) return;
        var vote={}, best=null, bv=0;
        (S.adj[i]||[]).forEach(function(j){
          if(grpOf[j]==null) return;
          vote[grpOf[j]]=(vote[grpOf[j]]||0)+1;
        });
        for(var g in vote){
          var sc=vote[g]*1000+(gsz[g]||0);          // 邻居里出现最多的组优先，平手取大组
          if(sc>bv){ bv=sc; best=+g; }
        }
        if(best!=null){ grpOf[i]=best; gsz[best]=(gsz[best]||0)+1; moved++; }
      });
      if(!moved) break;
    }
  }

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
  if(info.block){
    /* 整块模式：网格可信，网格上连成一片的就是**一整片** → 一条引导走完，
       不再按 OCR 组拆、也不受 MAXC 限制（否则又变成「1 大组 + 一堆零碎」）。
       标签沿用分量里占多数的那个 OCR 组号，没有就写「连片」。 */
    Object.keys(cl).forEach(function(r){
      var ids=cl[r].sort(function(a,b){ return a-b; });
      var vote={}, best=null, bv=0;
      ids.forEach(function(i){ if(grpOf[i]!=null) vote[grpOf[i]]=(vote[grpOf[i]]||0)+1; });
      for(var g in vote){ if(vote[g]>bv){ bv=vote[g]; best=+g; } }
      items.push({ ids:ids, grp:(bv*2>=ids.length?best:null),
                   group:(bv*2>=ids.length && ids.length>=2), merged:!(bv*2>=ids.length) });
    });
  }
  else Object.keys(cl).forEach(function(r){
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
      /* 太大：按「拼好组」拆；**剩下的没组块不再碎成单块**——
         以前每块各自一条，整张大图就变成「1 大组 + 几十条单块」（用户：「其实只需要
         引导一组就行」）。现在把没组的块在网格上再聚成连通的次级连片，一条一条走。 */
      var byGrp={}, rest=[];
      ids.forEach(function(i){
        var g=grpOf[i];
        if(g!=null) (byGrp[g]=byGrp[g]||[]).push(i);
        else rest.push(i);
      });
      Object.keys(byGrp).forEach(function(g){
        var a=byGrp[g].sort(function(x,y){ return x-y; });
        items.push({ ids:a, grp:+g, group:a.length>=2 });
      });
      var rset=new Set(rest), seen2=new Set();
      rest.forEach(function(i){
        if(seen2.has(i)) return;
        var comp=[], st=[i]; seen2.add(i);
        while(st.length){
          var c0=st.pop(); comp.push(c0);
          (S.adj[c0]||[]).forEach(function(j){
            if(rset.has(j) && !seen2.has(j)){ seen2.add(j); st.push(j); }
          });
        }
        comp.sort(function(x,y){ return x-y; });
        items.push({ ids:comp, grp:null, group:false, merged:comp.length>=2 });
      });
    }
  });

  function centroidDist(ids){
    if(!main.length) return 0;
    var c=0, r=0;
    ids.forEach(function(i){ var p=idxToRC(i); c+=p.col; r+=p.row; });
    return Math.hypot(c/ids.length-mc, r/ids.length-mr);
  }
  items=spreadSplit(items);
  items.forEach(function(it){
    it.n=it.ids.length;
    it.dist=centroidDist(it.ids);
    it.head=it.ids[0];        // 编号最小的一块：平手时当「从上往下、从左往右」的次序
  });
  return growOrder(items);
}

/* 一条里的块如果**摊得很开**（占的格子远多于块数），预览为了装下它会把视野拉得很远，
   高亮又零零散散撒在各处 → 用户：「预览框内显示的范围过大，不好找图」。
   按网格 BFS 把它切成「连得上、又不摊太开」的小片。
   判据用**填充率**而不是绝对块数：一整片实心区域（拼好的主体）本来就该一条走完
   （用户早先要的正是「只引导一组就行」），只有散开的才拆。 */
var SPREAD_FILL=0.34, SPREAD_MIN=4, SPREAD_SPAN=10;
function bboxCells(ids){
  var r0=1e9, r1=-1e9, c0=1e9, c1=-1e9;
  ids.forEach(function(i){
    var p=idxToRC(i);
    if(p.row<r0) r0=p.row; if(p.row>r1) r1=p.row;
    if(p.col<c0) c0=p.col; if(p.col>c1) c1=p.col;
  });
  return { r0:r0, r1:r1, c0:c0, c1:c1, h:r1-r0+1, w:c1-c0+1 };
}
function spreadSplit(items){
  var out=[];
  (items||[]).forEach(function(it){
    var ids=it.ids||[];
    if(ids.length<SPREAD_MIN){ out.push(it); return; }
    var bb=bboxCells(ids);
    if(ids.length/(bb.w*bb.h) >= SPREAD_FILL){ out.push(it); return; }   // 实心一大片：不拆
    var left=new Set(ids);
    while(left.size){
      var seed=Math.min.apply(null,Array.from(left));
      var comp=[], st=[seed]; left.delete(seed);
      while(st.length){
        var c0=st.shift(); comp.push(c0);
        if(comp.length>=MAXC) break;
        var nb=(S.adj[c0]||[]).slice().sort(function(a,b){ return a-b; });
        for(var q=0;q<nb.length;q++){
          var j=nb[q]; if(!left.has(j)) continue;
          if(comp.length>=MAXC) break;
          var tb=bboxCells(comp.concat([j]));
          if(tb.h>SPREAD_SPAN || tb.w>SPREAD_SPAN) continue;   // 加上它就摊太开了：留给下一片
          left.delete(j); st.push(j);
        }
      }
      comp.sort(function(a,b){ return a-b; });
      out.push({ ids:comp, grp:it.grp, group:false, merged:comp.length>=2, split:true });
    }
  });
  return out;
}

/* 按「连得起来」排序（顺序在进引导时一次算定，这样撤销回退才能按序号走）：
   拿棋盘上已有的块（1/3/4）当起点，反复挑——
     ① 紧挨着**上一条**的（继续沿着这一片长下去）；
     ② 否则紧挨着**已铺开的整片**的；
     ③ 都没有 → 说明这一片周围再没有能接上的了，换下一个整块重新起头；
   每一档里都**整块的优先**（块大先放），块一样大再按离主片区近、编号小。
   这样不会出现「整块一股脑先放完、最后满地捡单块」，而是贴着已拼区一块块连下去。 */
function growOrder(items){
  var placed=new Set();
  for(var k=1;k<=S.cfg.total;k++){
    var st=S.states[k];
    if(st===1||st===3||st===4) placed.add(k);
  }
  var left=items.slice(), out=[], last=null;

  function touches(it,set){
    if(!set) return false;
    for(var k=0;k<it.ids.length;k++){
      var nb=S.adj[it.ids[k]]||[];
      for(var j=0;j<nb.length;j++) if(set.has(nb[j])) return true;
    }
    return false;
  }
  function better(a,b){                      // 大块 → 近 → 编号小
    if(a.n!==b.n) return a.n>b.n;
    if(a.dist!==b.dist) return a.dist<b.dist;
    return a.head<b.head;
  }
  function takeBest(pred){
    var pick=-1;
    for(var k=0;k<left.length;k++){
      if(pred && !pred(left[k])) continue;
      if(pick<0 || better(left[k],left[pick])) pick=k;
    }
    return pick;
  }

  while(left.length){
    var lastSet=last?new Set(last.ids):null;
    var pick=takeBest(function(it){ return touches(it,lastSet); });
    if(pick<0) pick=takeBest(function(it){ return touches(it,placed); });
    if(pick<0) pick=takeBest(null);          // 全都接不上：挑最大的另起一片
    var it=left.splice(pick,1)[0];
    out.push(it);
    for(var q=0;q<it.ids.length;q++) placed.add(it.ids[q]);
    last=it;
  }
  return out;
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
  focusSet(it.ids,{keepDone:true});    // 与「找点」同一套：按比例缩放 + 留住一块已完成的片
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

// ok=true「放好了」：这一条（单块 / 整组）写进棋盘；ok=false「跳过」：保持未拼。
function guideNext(ok){
  if(!S.guideActive) return;
  var ids=(G.cur||[]).slice();
  var at=G.k;
  if(ok){
    var r=applyItem(ids);
    if(r.n){
      G.done++;
      if(r.ids) G.applied.push({ k:at, ids:r.ids });
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
  toast(left>0 ? ("已退出引导 · 还有 "+left+" 条没放（保持未拼）") : "已退出引导");
});
