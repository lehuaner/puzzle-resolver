import { S, SCALE_MIN, SCALE_MAX, saveJSON, viewKey } from "./store.js";
import { $, toast, vibrate } from "./dom.js";
import { calcRows, fmt, idxToRC, zoneOf, zoneLetter, zoneStart, zoneEnd, zoneCount } from "./coords.js";
import { metrics, buildAdj } from "./grid.js";
import { renderLocCard, syncSearchZone } from "./search.js";
import { scheduleSave } from "./sync.js";

export function buildBoard(){
  S.rows=calcRows(); metrics(); buildAdj();
  S.board.style.width=S.contentW+"px";
  S.board.style.height=S.contentH+"px";
  S.board.style.gridTemplateColumns="repeat("+S.cfg.cols+","+S.cellSize+"px)";
  S.board.style.gridTemplateRows="repeat("+S.rows+","+S.cellSize+"px)";
  S.board.style.gap=S.gap+"px";
  S.board.style.setProperty("--cr",Math.max(3,Math.round(S.cellSize*0.13))+"px");
  var fs=Math.max(8,Math.min(Math.round(S.cellSize*0.32),26));

  var frag=document.createDocumentFragment();
  S.cells=new Array(S.cfg.total+1).fill(null);
  for(var i=1;i<=S.cfg.total;i++){
    var p=idxToRC(i);
    var d=document.createElement("div");
    d.className="cell";
    d.dataset.i=i;
    d.style.gridRow=p.row;
    d.style.gridColumn=p.col;
    d.style.fontSize=fs+"px";
    if(S.cfg.showIndex) d.textContent=fmt(i);
    S.cells[i]=d;
    frag.appendChild(d);
  }
  S.board.innerHTML="";
  S.board.appendChild(frag);

  // 大区分隔线：列优先时切在两列之间（竖线），行优先时切在两行之间（横线）
  var zc=zoneCount();
  for(var k=1;k<zc;k++){
    var fidx=zoneStart(k);
    if(fidx>S.cfg.total) break;
    var a=idxToRC(fidx-1), b=idxToRC(fidx);
    var line=document.createElement("div");
    line.className="zsep";
    if(S.cfg.order==="col"){
      var cc=Math.min(a.col,b.col);
      if(cc<1) continue;
      line.style.left=((cc-1)*S.step+S.cellSize+S.gap/2-1)+"px";
      line.style.top="0"; line.style.width="2px"; line.style.height=S.contentH+"px";
    }else{
      var rr=Math.min(a.row,b.row);
      if(rr<1) continue;
      line.style.top=((rr-1)*S.step+S.cellSize+S.gap/2-1)+"px";
      line.style.left="0"; line.style.width=S.contentW+"px"; line.style.height="2px";
    }
    S.board.appendChild(line);
  }

  for(var j=1;j<=S.cfg.total;j++) paint(j);
  applyZoneDim();
  initMinimap();
  resetView(false);
}

export function paint(i){
  var el=S.cells[i]; if(!el) return;
  var st=S.states[i];
  if(st===0) el.removeAttribute("data-s"); else el.setAttribute("data-s",st);
}

/* ---- 平移 ---- */
function clampPan(){
  // 无限画布：不做边界限制，随便拖。丢了内容用 ⤢ 适应屏幕 或点小地图找回
}

export function applyPan(anim){
  if(anim){ S.board.classList.add("anim"); clearTimeout(applyPan._t);
    applyPan._t=setTimeout(function(){ S.board.classList.remove("anim"); },320); }
  else S.board.classList.remove("anim");
  S.board.style.transform="translate3d("+Math.round(S.tx)+"px,"+Math.round(S.ty)+"px,0) scale("+S.scale+")";
  if(S.zVal) S.zVal.textContent=Math.round(S.scale*100)+"%";
  drawMinimapView();
  placeMinimap();          // 缩放/平移后重新避让闪烁点
  scheduleViewSave();      // 记住看到哪儿了
}

// 视口状态随内容一起持久化：下次打开接着看
var viewSaveTimer=null;
export function scheduleViewSave(){
  clearTimeout(viewSaveTimer);
  viewSaveTimer=setTimeout(function(){
    saveJSON(viewKey(),{z:S.viewZone, s:Math.round(S.scale*1000)/1000,
      x:Math.round(S.tx), y:Math.round(S.ty)});
  },300);
}

export function centerOnIdx(i,anim){
  var p=idxToRC(i);
  var cx=((p.col-1)*S.step+S.cellSize/2)*S.scale;
  var cy=((p.row-1)*S.step+S.cellSize/2)*S.scale;
  S.tx=S.wrap.clientWidth/2-cx; S.ty=S.wrap.clientHeight/2-cy;
  applyPan(anim!==false);
}

export function centerOnZone(z,anim){
  var s=zoneStart(z), e=zoneEnd(z);
  var minC=1e9,maxC=0,minR=1e9,maxR=0;
  for(var i=s;i<=e;i++){
    var p=idxToRC(i);
    if(p.col<minC)minC=p.col; if(p.col>maxC)maxC=p.col;
    if(p.row<minR)minR=p.row; if(p.row>maxR)maxR=p.row;
  }
  var cx=((minC-1)*S.step+(maxC-minC+1)*S.step/2)*S.scale;
  var cy=((minR-1)*S.step+(maxR-minR+1)*S.step/2)*S.scale;
  S.tx=S.wrap.clientWidth/2-cx; S.ty=S.wrap.clientHeight/2-cy;
  applyPan(anim!==false);
}

// 任意块集合：包络盒居中到视口；当前缩放装不下时只往外缩到刚好装下（不放大）
export function centerOnSet(list,anim){
  if(!list||!list.length) return;
  var minC=1e9,maxC=0,minR=1e9,maxR=0;
  for(var k=0;k<list.length;k++){
    var p=idxToRC(list[k]);
    if(p.col<minC)minC=p.col; if(p.col>maxC)maxC=p.col;
    if(p.row<minR)minR=p.row; if(p.row>maxR)maxR=p.row;
  }
  var w=(maxC-minC)*S.step+S.cellSize, h=(maxR-minR)*S.step+S.cellSize;
  var W=S.wrap.clientWidth-48, H=S.wrap.clientHeight-48;
  if(W<60) W=S.wrap.clientWidth||60;
  if(H<60) H=S.wrap.clientHeight||60;
  S.scale=Math.min(S.scale, W/w, H/h);
  var cx=((minC-1)*S.step+w/2)*S.scale;
  var cy=((minR-1)*S.step+h/2)*S.scale;
  S.tx=S.wrap.clientWidth/2-cx; S.ty=S.wrap.clientHeight/2-cy;
  applyPan(anim!==false);
}

// 回到初始：1:1 尺寸，装得下就居中，装不下就从左上角开始
export function resetView(anim){
  S.scale=1;
  var W=S.wrap.clientWidth, H=S.wrap.clientHeight;
  S.tx = S.contentW*S.scale<=W ? (W-S.contentW*S.scale)/2 : 0;
  S.ty = S.contentH*S.scale<=H ? (H-S.contentH*S.scale)/2 : 0;
  applyPan(anim!==false);
}

// 整幅缩放到刚好铺满视口
export function fitToScreen(anim){
  var W=S.wrap.clientWidth-24, H=S.wrap.clientHeight-24;
  var s=Math.min(W/S.contentW, H/S.contentH);
  S.scale=Math.max(SCALE_MIN, Math.min(SCALE_MAX, s));
  S.tx=(S.wrap.clientWidth-S.contentW*S.scale)/2;
  S.ty=(S.wrap.clientHeight-S.contentH*S.scale)/2;
  applyPan(anim!==false);
}

// 以视口内某点为锚点缩放
export function setScaleAt(px,py,ns){
  ns=Math.max(SCALE_MIN,Math.min(SCALE_MAX,ns));
  if(Math.abs(ns-S.scale)<0.0005) return;
  var k=ns/S.scale;
  S.tx=px-(px-S.tx)*k;
  S.ty=py-(py-S.ty)*k;
  S.scale=ns;
  applyPan(false);
}
export function zoomCenter(factor){
  setScaleAt(S.wrap.clientWidth/2, S.wrap.clientHeight/2, S.scale*factor);
}

/* ================= 小地图 ================= */
var mmCtx=null, mmBase=null, mmW=0, mmH=0, mmK=1, mmDPR=1;

export function initMinimap(){
  mmDPR=Math.min(window.devicePixelRatio||1,2);
  var cssW=Math.min(220,Math.max(120,Math.round(S.wrap.clientWidth*0.2)));
  mmK=cssW/S.contentW;
  mmW=cssW; mmH=Math.round(S.contentH*mmK);
  S.mm.style.width=mmW+"px";
  S.mm.style.height=mmH+"px";
  S.mm.width=Math.round(mmW*mmDPR);
  S.mm.height=Math.round(mmH*mmDPR);
  mmCtx=S.mm.getContext("2d");
  mmCtx.setTransform(mmDPR,0,0,mmDPR,0,0);
  mmBase=document.createElement("canvas");
  mmBase.width=S.mm.width; mmBase.height=S.mm.height;
  var bx=mmBase.getContext("2d");
  bx.setTransform(mmDPR,0,0,mmDPR,0,0);
  bx.fillStyle="#0e151d"; bx.fillRect(0,0,mmW,mmH);
  var w=Math.max(1.2,S.cellSize*mmK-0.6), h=w;
  for(var i=1;i<=S.cfg.total;i++){
    var p=idxToRC(i);
    var x=(p.col-1)*S.step*mmK, y=(p.row-1)*S.step*mmK;
    var st=S.states[i];
    bx.fillStyle = st===1?"#25c56b" : st===2?"#8dffbe" : st===3?"#e09b13" : st===4?"#f2d582" : "#39445a";
    bx.fillRect(x,y,w,h);
  }
  drawMinimapView();
}

export function drawMinimapView(){
  if(!mmCtx) return;
  mmCtx.clearRect(0,0,mmW,mmH);
  mmCtx.drawImage(mmBase,0,0,mmW,mmH);
  var W=S.wrap.clientWidth, H=S.wrap.clientHeight;
  var x=(-S.tx/S.scale)*mmK, y=(-S.ty/S.scale)*mmK;
  var w=(W/S.scale)*mmK, h=(H/S.scale)*mmK;
  var x0=Math.max(0.8,x), y0=Math.max(0.8,y);
  var x1=Math.min(mmW-0.8,x+w), y1=Math.min(mmH-0.8,y+h);
  if(x1-x0>2 && y1-y0>2){
    mmCtx.strokeStyle="rgba(120,190,255,.95)"; mmCtx.lineWidth=1.6;
    mmCtx.strokeRect(x0,y0,x1-x0,y1-y0);
    mmCtx.fillStyle="rgba(120,190,255,.08)";
    mmCtx.fillRect(x0,y0,x1-x0,y1-y0);
  }
}

/* 小地图位置：避开闪烁的目标点 */
function mmRects(){
  var g={top:12,bottom:12,left:12,right:12};
  var W=S.wrap.clientWidth, H=S.wrap.clientHeight;
  return {
    br:{x:W-g.right-mmW,y:H-g.bottom-mmH,w:mmW,h:mmH},
    bl:{x:g.left,y:H-g.bottom-mmH,w:mmW,h:mmH},
    tr:{x:W-g.right-mmW,y:g.top,w:mmW,h:mmH},
    tl:{x:g.left,y:g.top,w:mmW,h:mmH}
  };
}
function overlap(a,b){
  return !(a.x+a.w<b.x || b.x+b.w<a.x || a.y+a.h<b.y || b.y+b.h<a.y);
}
export function placeMinimap(){
  var founds=document.querySelectorAll(".cell.found");
  var order=["br","bl","tl"];   // 右上角被缩放工具条占用
  if(founds.length===0){ setMmCorner("br",false); return; }
  var wr=S.wrap.getBoundingClientRect();
  var targets=[];
  for(var k=0;k<founds.length;k++){
    var r=founds[k].getBoundingClientRect();
    targets.push({x:r.left-wr.left,y:r.top-wr.top,w:r.width,h:r.height});
  }
  var rects=mmRects(), pick="br";
  for(var c=0;c<order.length;c++){
    var rect=rects[order[c]], hit=false;
    for(var t=0;t<targets.length;t++){ if(overlap(rect,targets[t])){ hit=true; break; } }
    if(!hit){ pick=order[c]; break; }
  }
  setMmCorner(pick,true);
}
function setMmCorner(c,animate){
  if(S.mm.classList.contains("mm-"+c) && !animate) return;
  S.mm.classList.remove("mm-br","mm-bl","mm-tr","mm-tl");
  S.mm.classList.add("mm-"+c);
}

/* 小地图交互 */
var mmDrag=false;
function mmJump(clientX,clientY){
  var r=S.mm.getBoundingClientRect();
  var mx=(clientX-r.left)/mmK, my=(clientY-r.top)/mmK;
  var W=S.wrap.clientWidth,H=S.wrap.clientHeight;
  S.tx=W/2-mx*S.scale; S.ty=H/2-my*S.scale;
  applyPan(false);
}
S.mm.addEventListener("pointerdown",function(e){
  e.preventDefault(); mmDrag=true;
  try{ S.mm.setPointerCapture(e.pointerId); }catch(err){}
  mmJump(e.clientX,e.clientY);
});
S.mm.addEventListener("pointermove",function(e){
  if(mmDrag){ e.preventDefault(); mmJump(e.clientX,e.clientY); }
});
S.mm.addEventListener("pointerup",function(){ mmDrag=false; });
S.mm.addEventListener("pointercancel",function(){ mmDrag=false; });

/* ================= 统计 ================= */
var allDoneFlag=false;
export function updateStats(){
  var done=0, pend=0, zc=zoneCount(), zd=new Array(zc).fill(0);
  for(var i=1;i<=S.cfg.total;i++){
    var s=S.states[i];
    if(s===1){ done++; zd[zoneOf(i)]++; }
    else if(s===3||s===4) pend++;
  }
  var pct=S.cfg.total?done/S.cfg.total*100:0;
  $("tDone").textContent=done; $("tTotal").textContent=S.cfg.total;
  $("tPct").textContent=pct.toFixed(1)+"%";
  $("progFill").style.width=pct+"%";
  $("tPendWrap").style.display = pend>0 ? "inline" : "none";
  $("tPending").textContent=pend;
  for(var z=0;z<zc;z++){
    var el=$("zs"+z);
    if(el) el.textContent=zd[z]+"/"+(zoneEnd(z)-zoneStart(z)+1);
  }
  if(done===S.cfg.total && S.cfg.total>0 && !allDoneFlag){
    allDoneFlag=true; toast("🎉 全部 "+S.cfg.total+" 块拼完了！"); vibrate([60,60,60]);
  }
  if(done<S.cfg.total) allDoneFlag=false;
}

export function renderZones(){
  var zc=zoneCount();
  var html='<button class="zbtn'+(S.viewZone==="all"?" on":"")+'" data-z="all">'
    +'<span class="zt">全部</span><span class="zsub">'+S.cfg.total+' 片</span></button>';
  for(var z=0;z<zc;z++){
    html+='<button class="zbtn'+(S.viewZone===String(z)?" on":"")+'" data-z="'+z+'">'
      +'<span class="zt">'+zoneLetter(z)+'区</span>'
      +'<span class="zsub" id="zs'+z+'">0/'+(zoneEnd(z)-zoneStart(z)+1)+'</span></button>';
  }
  S.zonesEl.innerHTML=html;
}

export function setView(v,opts){
  var changed = (S.viewZone!==v);
  S.viewZone=v;   // 位置/缩放由 applyPan 里的 scheduleViewSave 统一写入
  renderZones(); updateStats(); applyZoneDim();
  if(v==="all"){ resetView(true); }
  else { centerOnZone(parseInt(v,10),true); }
  syncSearchZone();   // 搜索面板开着时，范围跟随当前视图
}

// 非当前大区淡化，突出正在拼的区域
function applyZoneDim(){
  var z = (S.viewZone==="all") ? -1 : parseInt(S.viewZone,10);
  for(var i=1;i<=S.cfg.total;i++){
    var el=S.cells[i]; if(!el) continue;
    if(z>=0 && zoneOf(i)!==z) el.classList.add("dim");
    else el.classList.remove("dim");
  }
}
export function afterChange(){ updateStats(); scheduleSave(); refreshMM(); renderLocCard(); }
export function refreshMM(){
  if(!mmBase) return;
  var bx=mmBase.getContext("2d");
  bx.fillStyle="#0e151d"; bx.fillRect(0,0,mmW,mmH);
  var w=Math.max(1.2,S.cellSize*mmK-0.6);
  for(var i=1;i<=S.cfg.total;i++){
    var p=idxToRC(i), st=S.states[i];
    bx.fillStyle = st===1?"#25c56b" : st===2?"#8dffbe" : st===3?"#e09b13" : st===4?"#f2d582" : "#39445a";
    bx.fillRect((p.col-1)*S.step*mmK,(p.row-1)*S.step*mmK,w,w);
  }
  drawMinimapView();
}