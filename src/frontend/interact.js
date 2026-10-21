import { S, SCALE_MIN, SCALE_MAX } from "./store.js";
import { $, toast, vibrate } from "./dom.js";
import { fmt } from "./coords.js";
import { mainComp, promoteConnected, components, compHasDone } from "./grid.js";
import { paint, applyPan, drawMinimapView, afterChange, setView, setScaleAt, zoomCenter, fitToScreen } from "./board.js";
import { hideLocCard } from "./search.js";
import { markChange } from "./sync.js";

/* ================= 交互 ================= */
var pressTimer=null,pressCell=null,pressMoved=false,longFired=false;
var pressX=0,pressY=0,pressing=false,isPan=false,startTx=0,startTy=0,downX=0,downY=0;
var dragging=false,dragAdd=true;
var pointers=new Map(), pinching=false, pinchStart=null;

function startPinch(){
  clearTimeout(pressTimer); pressTimer=null;
  pressing=false; isPan=false; pressCell=null; longFired=false; dragging=false;
  if(S.batchMode) exitBatch();
  var pts=[]; pointers.forEach(function(v){ pts.push(v); });
  if(pts.length<2){ pinching=false; pinchStart=null; return; }
  pinching=true;
  pinchStart={
    dist:Math.max(1,Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y)),
    midX:(pts[0].x+pts[1].x)/2, midY:(pts[0].y+pts[1].y)/2,
    tx:S.tx, ty:S.ty, scale:S.scale
  };
  S.board.classList.remove("anim");
}

function doPinch(){
  if(!pinchStart) return;
  var pts=[]; pointers.forEach(function(v){ pts.push(v); });
  if(pts.length<2) return;
  var dist=Math.max(1,Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y));
  var midX=(pts[0].x+pts[1].x)/2, midY=(pts[0].y+pts[1].y)/2;
  var wr=S.wrap.getBoundingClientRect();
  var k=dist/pinchStart.dist;
  var ns=Math.max(SCALE_MIN,Math.min(SCALE_MAX,pinchStart.scale*k));
  var ratio=ns/pinchStart.scale;
  var mx0=pinchStart.midX-wr.left, my0=pinchStart.midY-wr.top;
  var mx1=midX-wr.left, my1=midY-wr.top;
  S.tx=mx1-(mx0-pinchStart.tx)*ratio;
  S.ty=my1-(my0-pinchStart.ty)*ratio;
  S.scale=ns;
  applyPan(false);
}
export function pushUndo(ch){ if(!ch.length) return; S.undoStack.push(ch); if(S.undoStack.length>50) S.undoStack.shift(); }

export function tapCell(i){
  var prev=S.states[i], next=0, note="";
  if(prev===1||prev===3||prev===4){
    next=0;                                   // 已有块 → 取消
  } else {
    // 主片区已经存在时，随手点到的孤点先记成“待定”，别直接算完成
    if(mainComp().length && !tapsIntoMain(i)){
      next=3; note=fmt(i)+" 离已拼区域还远 · 先记为待定";
    }
    else next=1;
  }
  var orig=new Map();
  orig.set(i,prev); S.states[i]=next;
  if(next===1){
    promoteConnected().forEach(function(c){ if(!orig.has(c[0])) orig.set(c[0],c[1]); });
  }
  orig.forEach(function(v,k){ paint(k); markChange(k); });
  pushUndo(Array.from(orig.entries()));
  vibrate(12);
  afterChange();            // 里面会同步定位卡的状态显示
  if(note) toast(note);
}
// 该点是否接得上“主进度”：只要某个邻居落在含有已完成块的连通区域里，就算接得上
function tapsIntoMain(i){
  var nb=S.adj[i]||[], comps=components(), c, k;
  for(c=0;c<comps.length;c++){
    if(!compHasDone(comps[c],null)) continue;
    var s=new Set(comps[c]);
    for(k=0;k<nb.length;k++){ if(s.has(nb[k])) return true; }
  }
  return false;
}
export function enterBatch(i){
  if(S.batchMode) return;
  hideLocCard();            // 用批量模式就收起定位卡，避免两条工具打架
  S.batchMode=true; document.body.classList.add("batch");
  if(i) addSel(i,true);
  updateSelCount(); toast("批量模式 · 拖动可连选");
}
export function exitBatch(){
  if(!S.batchMode) return;
  S.batchMode=false; document.body.classList.remove("batch");
  S.sel.forEach(function(k){ if(S.cells[k]) S.cells[k].classList.remove("sel"); });
  S.sel.clear(); updateSelCount();
}
function addSel(i,on){
  var el=S.cells[i]; if(!el) return;
  if(on){ if(!S.sel.has(i)){ S.sel.add(i); el.classList.add("sel"); } }
  else { if(S.sel.has(i)){ S.sel.delete(i); el.classList.remove("sel"); } }
}
function updateSelCount(){ $("selN").textContent=S.sel.size; }

export function applyBatch(target){
  if(S.sel.size===0){ toast("还没有选中任何块"); return; }
  var orig=new Map();
  S.sel.forEach(function(i){
    if(S.states[i]!==target){ if(!orig.has(i)) orig.set(i,S.states[i]); S.states[i]=target; }
  });
  if(target===1){
    promoteConnected().forEach(function(c){ if(!orig.has(c[0])) orig.set(c[0],c[1]); });
  }
  orig.forEach(function(v,k){ paint(k); markChange(k); });
  pushUndo(Array.from(orig.entries()));
  afterChange();
  toast("已更新 "+orig.size+" 块"+(target===1?"（含相连待定转完成）":""));
  vibrate(25); exitBatch();
}
export function doUndo(){
  var c=S.undoStack.pop();
  if(!c){ toast("没有可撤销的操作"); return; }
  for(var i=0;i<c.length;i++){ S.states[c[i][0]]=c[i][1]; paint(c[i][0]); markChange(c[i][0]); }
  afterChange(); toast("已撤销 "+c.length+" 处改动"); vibrate(18);
}
// 手势监听挂到 wrap 而不是 board：手指点在格子以外的空白处也要能平移，
// 两根手指一根在画布内、一根在画布外也要能识别为双指缩放
S.wrap.addEventListener("contextmenu",function(e){ e.preventDefault(); });

S.wrap.addEventListener("pointerdown",function(e){
  // 小地图 / 缩放工具条有自己的手势，不参与画布平移缩放
  if(e.target.closest && e.target.closest(".zoombar,#mm,.mm-lb")) return;
  e.preventDefault();
  pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pointers.size>=2){ startPinch(); return; }

  var el=e.target.closest?e.target.closest(".cell"):null;
  var i=el?parseInt(el.dataset.i,10):0;

  if(S.batchMode && el){
    dragging=true; dragAdd=!S.sel.has(i);
    addSel(i,dragAdd); updateSelCount(); vibrate(8);
    return;
  }

  pressing=true; isPan=false; longFired=false; pressMoved=false;
  pressCell=el; pressX=e.clientX; pressY=e.clientY;
  downX=e.clientX; downY=e.clientY;
  startTx=S.tx; startTy=S.ty;

  clearTimeout(pressTimer);
  if(el){
    pressTimer=setTimeout(function(){
      pressTimer=null; longFired=true;
      vibrate(35); enterBatch(i);
      // 长按后手指不抬起继续滑 = 连选（别忘了置位，否则只会选中第一块）
      dragging=true; dragAdd=true;
    },620);
  }
},{passive:false});

window.addEventListener("pointermove",function(e){
  if(pointers.has(e.pointerId)) pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pinching){ doPinch(); return; }

  if(S.batchMode && dragging){
    if(e.pointerType!=="touch" && e.buttons===0){ dragging=false; return; }
    var t=document.elementFromPoint(e.clientX,e.clientY);
    var c=t&&t.closest?t.closest(".cell"):null;
    if(c){ addSel(parseInt(c.dataset.i,10),dragAdd); updateSelCount(); }
    return;
  }
  if(!pressing || longFired) return;
  var dx=e.clientX-downX, dy=e.clientY-downY;
  if(!isPan){
    if(Math.abs(dx)>7||Math.abs(dy)>7){
      isPan=true; clearTimeout(pressTimer); pressTimer=null;
      S.board.classList.remove("anim");
    }
  }
  if(isPan){
    S.tx=startTx+dx; S.ty=startTy+dy;      // 无限画布：不做边界限制
    S.board.style.transform="translate3d("+Math.round(S.tx)+"px,"+Math.round(S.ty)+"px,0) scale("+S.scale+")";
    drawMinimapView();
  }
},{passive:true});

function endPress(e){
  dragging=false;
  if(pressTimer){
    clearTimeout(pressTimer); pressTimer=null;
    if(!isPan && !longFired && pressCell && !S.batchMode){
      tapCell(parseInt(pressCell.dataset.i,10));
    }
  }
  if(isPan){ applyPan(false); }
  pressing=false; isPan=false; pressCell=null; longFired=false; pressMoved=false;
}
window.addEventListener("pointerup",function(e){
  if(pointers.has(e.pointerId)) pointers.delete(e.pointerId);
  if(pinching){
    if(pointers.size>=2) startPinch();
    else { pinching=false; pinchStart=null; }
    return;
  }
  endPress(e);
});
window.addEventListener("pointercancel",function(e){
  pointers.delete(e.pointerId);
  clearTimeout(pressTimer); pressTimer=null;
  pressing=false; isPan=false; dragging=false; pressCell=null; longFired=false;
  if(pointers.size<2){ pinching=false; pinchStart=null; }
});

S.zonesEl.addEventListener("click",function(e){
  var b=e.target.closest?e.target.closest(".zbtn"):null;
  if(!b) return;
  vibrate(10); setView(b.dataset.z,{recenter:true});
});

$("bUndo").addEventListener("click",doUndo);
/* 进/出全屏后把 #app 高度对齐 body 实际撑开的高度：
   个别浏览器全屏后视口单位（vh/dvh）不重算，底部会露出黑边 */
function fsResync(){
  var fsEl=document.fullscreenElement||document.webkitFullscreenElement;
  var app=document.getElementById("app");
  if(fsEl){
    var h=Math.round(document.body.getBoundingClientRect().height);
    if(h>0) app.style.height=h+"px";
  }else{
    app.style.height="";
  }
}
document.addEventListener("fullscreenchange",fsResync);
document.addEventListener("webkitfullscreenchange",fsResync);
window.addEventListener("orientationchange",function(){
  if(document.fullscreenElement||document.webkitFullscreenElement) setTimeout(fsResync,60);
});

$("bFull").addEventListener("click",function(){
  try{
    var fsEl=document.fullscreenElement||document.webkitFullscreenElement;
    if(!fsEl){
      // 全屏挂到 body：root(html) 全屏时 UA 样式不会把它撑满，手机会露出黑边
      (document.body.requestFullscreen||document.body.webkitRequestFullscreen||function(){}).call(document.body);
    }
    else {
      (document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document);
    }
  }catch(err){ toast("当前浏览器不支持全屏"); }
});
$("batchbar").addEventListener("click",function(e){
  var b=e.target.closest?e.target.closest("button"):null;
  if(!b) return;
  if(b.dataset.act==="exit") exitBatch(); else applyBatch(parseInt(b.dataset.act,10));
});

/* 缩放：滚轮 / 触控板 */
S.wrap.addEventListener("wheel",function(e){
  e.preventDefault();
  var r=S.wrap.getBoundingClientRect();
  var k=Math.exp(-e.deltaY*0.0018);
  setScaleAt(e.clientX-r.left, e.clientY-r.top, S.scale*k);
},{passive:false});

/* 缩放：按钮 */
$("zIn").addEventListener("click",function(){ zoomCenter(1.3); vibrate(8); });
$("zOut").addEventListener("click",function(){ zoomCenter(1/1.3); vibrate(8); });
$("zFit").addEventListener("click",function(){ fitToScreen(true); vibrate(12); });