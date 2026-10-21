import { S } from "./store.js";
import { $, toast, vibrate } from "./dom.js";
import { fmt, idxToRC, rcToIdx, zoneOf, zoneLetter } from "./coords.js";
import { mainComp, promoteConnected } from "./grid.js";
import { paint, afterChange } from "./board.js";
import { pushUndo } from "./interact.js";
import { markChange } from "./sync.js";
import { hideLocCard } from "./search.js";

/* ================= 照片识别 ================= */
var scan={
  img:null, W:0, H:0, mask:null, gray:null, base:null,
  anchors:[],          // [{x,y,idx}]
  result:null,         // Set of idx
  cellsChecked:0,
  calibrated:false,
  picking:null,
  zoom:1, ox:0, oy:0, fit:1,   // 照片视图：缩放倍数（1=适应窗口）与平移偏移
  mode:"move"          // move 移动照片 / grid 微调网格 / edit 增删结果
};
var scanCanvas=$("scanCanvas"), scanCtx=null;

function otsu(g){
  var hist=new Array(256).fill(0), n=g.length;
  for(var i=0;i<n;i++) hist[g[i]]++;
  var sum=0; for(var t=0;t<256;t++) sum+=t*hist[t];
  var sumB=0,wB=0,best=0,thr=127;
  for(var k=0;k<256;k++){
    wB+=hist[k]; if(wB===0) continue;
    var wF=n-wB; if(wF===0) break;
    sumB+=k*hist[k];
    var mB=sumB/wB, mF=(sum-sumB)/wF;
    var between=wB*wF*(mB-mF)*(mB-mF);
    if(between>best){ best=between; thr=k; }
  }
  return thr;
}

function analyzeImage(img, cb){
  var MAX=1500;
  var sc=Math.min(1, MAX/Math.max(img.width,img.height));
  var w=Math.round(img.width*sc), h=Math.round(img.height*sc);
  var cv=document.createElement("canvas");
  cv.width=w; cv.height=h;
  var cx=cv.getContext("2d",{willReadFrequently:true});
  cx.drawImage(img,0,0,w,h);
  var d=cx.getImageData(0,0,w,h).data;
  var gray=new Uint8Array(w*h);
  for(var i=0,p=0;i<gray.length;i++,p+=4){
    gray[i]=(d[p]*0.299+d[p+1]*0.587+d[p+2]*0.114)|0;
  }
  var thr=otsu(gray);
  var mask=new Uint8Array(w*h);
  for(var j=0;j<mask.length;j++) mask[j]=gray[j]>thr?1:0;

  // 连通域：保留较大区域
  var label=new Int32Array(w*h), stack=new Int32Array(w*h), comps=[];
  var cur=0;
  for(var s=0;s<mask.length;s++){
    if(!mask[s]||label[s]) continue;
    cur++;
    var top=0; stack[top++]=s; label[s]=cur;
    var cnt=0, minX=1e9,maxX=0,minY=1e9,maxY=0;
    while(top>0){
      var q=stack[--top]; cnt++;
      var qx=q%w, qy=(q/w)|0;
      if(qx<minX)minX=qx; if(qx>maxX)maxX=qx;
      if(qy<minY)minY=qy; if(qy>maxY)maxY=qy;
      if(qx>0){ var a=q-1; if(mask[a]&&!label[a]){label[a]=cur;stack[top++]=a;} }
      if(qx<w-1){ var b=q+1; if(mask[b]&&!label[b]){label[b]=cur;stack[top++]=b;} }
      if(qy>0){ var c2=q-w; if(mask[c2]&&!label[c2]){label[c2]=cur;stack[top++]=c2;} }
      if(qy<h-1){ var e2=q+w; if(mask[e2]&&!label[e2]){label[e2]=cur;stack[top++]=e2;} }
    }
    comps.push({id:cur,area:cnt,minX:minX,maxX:maxX,minY:minY,maxY:maxY});
  }
  var totalArea=w*h;
  var keep={};
  comps.forEach(function(c){
    if(c.area > totalArea*0.012 && (c.maxX-c.minX)>w*0.12 && (c.maxY-c.minY)>h*0.08) keep[c.id]=true;
  });
  for(var m=0;m<mask.length;m++){
    if(mask[m] && !keep[label[m]]) mask[m]=0;
  }
  scan.W=w; scan.H=h; scan.gray=gray; scan.mask=mask; scan.thr=thr;
  cb();
}

function samplePiece(x,y,rx,ry){
  var hit=0,tot=0;
  for(var dy=-ry;dy<=ry;dy++){
    var py=Math.round(y+dy);
    if(py<0||py>=scan.H) continue;
    for(var dx=-rx;dx<=rx;dx++){
      var px=Math.round(x+dx);
      if(px<0||px>=scan.W) continue;
      if((dx*dx)/(rx*rx)+(dy*dy)/(ry*ry)>1) continue;
      tot++;
      if(scan.mask[py*scan.W+px]) hit++;
    }
  }
  return tot>0 ? hit/tot : 0;
}

function buildScanBase(){
  var cv=document.createElement("canvas");
  cv.width=scan.W; cv.height=scan.H;
  var c2=cv.getContext("2d");
  c2.drawImage(scan.img,0,0,scan.W,scan.H);
  var ov=document.createElement("canvas");
  ov.width=scan.W; ov.height=scan.H;
  var oc=ov.getContext("2d");
  var id=oc.createImageData(scan.W,scan.H);
  for(var i=0;i<scan.mask.length;i++){
    if(scan.mask[i]){ id.data[i*4]=80; id.data[i*4+1]=190; id.data[i*4+2]=255; id.data[i*4+3]=34; }
  }
  oc.putImageData(id,0,0);
  c2.drawImage(ov,0,0);
  scan.base=cv;
}

// 照片适应窗口的基础缩放
function scanFitScale(){
  var stage=$("scanStage");
  var maxW=stage.clientWidth-24, maxH=stage.clientHeight-24;
  if(maxW<40||maxH<40) return scan.fit||1;
  return Math.min(maxW/scan.W, maxH/scan.H, 1.4);
}
// 把 canvas 摆到 stage 里：居中 + 用户平移 + 缩放
function layoutScanView(){
  var stage=$("scanStage");
  if(!scan.img||!scan.W||!scan.H) return;
  if(stage.clientWidth<40||stage.clientHeight<40) return;
  scan.fit=scanFitScale();
  var s=scan.fit*scan.zoom;
  var cw=Math.max(24,Math.round(scan.W*s)), ch=Math.max(24,Math.round(scan.H*s));
  scanCanvas.style.width=cw+"px";
  scanCanvas.style.height=ch+"px";
  var bx=(stage.clientWidth-cw)/2, by=(stage.clientHeight-ch)/2;
  scanCanvas.style.transform="translate("+Math.round(bx+scan.ox)+"px,"+Math.round(by+scan.oy)+"px)";
}
// 以屏幕上某点为锚缩放照片
function scanZoomAt(cx,cy,nz){
  nz=Math.max(0.3,Math.min(14,nz));
  var stage=$("scanStage"), st=stage.getBoundingClientRect();
  var old=scan.zoom, k=nz/old, fit=scan.fit||scanFitScale();
  var cw0=scan.W*fit*old, ch0=scan.H*fit*old;
  var cw1=scan.W*fit*nz,  ch1=scan.H*fit*nz;
  var bx0=(stage.clientWidth-cw0)/2, by0=(stage.clientHeight-ch0)/2;
  var bx1=(stage.clientWidth-cw1)/2, by1=(stage.clientHeight-ch1)/2;
  var px=cx-st.left-(bx0+scan.ox), py=cy-st.top-(by0+scan.oy);
  scan.ox=cx-st.left-px*k-bx1;
  scan.oy=cy-st.top-py*k-by1;
  scan.zoom=nz;
  layoutScanView();
}
function scanResetView(){
  scan.zoom=1; scan.ox=0; scan.oy=0; layoutScanView();
}

export function drawScan(){
  if(!scan.img||!scan.W||!scan.H) return;
  var stage=$("scanStage");
  var maxW=stage.clientWidth-24, maxH=stage.clientHeight-24;
  if(maxW<40||maxH<40) return;
  layoutScanView();
  if(scanCanvas.width!==scan.W || scanCanvas.height!==scan.H){
    scanCanvas.width=scan.W; scanCanvas.height=scan.H;
  }
  scanCtx=scanCanvas.getContext("2d");
  if(!scan.base) buildScanBase();
  scanCtx.clearRect(0,0,scan.W,scan.H);
  scanCtx.drawImage(scan.base,0,0);

  if(scan.calibrated) drawScanGrid();
  else scan.anchors.forEach(function(a,k){
    scanCtx.beginPath();
    scanCtx.arc(a.x,a.y,11,0,Math.PI*2);
    scanCtx.fillStyle="rgba(255,212,94,.95)"; scanCtx.fill();
    scanCtx.strokeStyle="#1a1200"; scanCtx.lineWidth=2.5; scanCtx.stroke();
    scanCtx.fillStyle="#1a1200"; scanCtx.font="bold 13px monospace";
    scanCtx.textAlign="center"; scanCtx.textBaseline="middle";
    scanCtx.fillText(String(k+1),a.x,a.y);
  });
}

function drawScanGrid(){
  var px=Math.abs(scan.pitchX), py=Math.abs(scan.pitchY);
  var W=scan.W,H=scan.H;
  var bw=px*0.66, bh=py*0.66;
  for(var i=1;i<=S.cfg.total;i++){
    var p=idxToRC(i);
    var x=scan.ax+(p.col-scan.ac)*scan.pitchX;
    var y=scan.ay+(p.row-scan.ar)*scan.pitchY;
    if(x<-px||y<-py||x>W+px||y>H+py) continue;
    var ok=scan.result && scan.result.has(i);
    var pend=ok && scan.pendingSet && scan.pendingSet.has(i);
    scanCtx.fillStyle = ok
      ? (pend ? "rgba(240,180,30,.34)" : "rgba(40,230,120,.30)")
      : "rgba(130,150,175,.16)";
    scanCtx.fillRect(x-bw/2,y-bh/2,bw,bh);
    if(ok){
      scanCtx.strokeStyle = pend ? "rgba(255,198,40,.95)" : "rgba(60,255,140,.95)";
      scanCtx.lineWidth=Math.max(1.2,px*0.055);
      scanCtx.strokeRect(x-bw/2,y-bh/2,bw,bh);
    } else {
      scanCtx.strokeStyle="rgba(150,170,195,.32)"; scanCtx.lineWidth=1;
      scanCtx.strokeRect(x-bw/2,y-bh/2,bw,bh);
    }
  }
}

function recalcScan(){
  if(!scan.calibrated) return;
  var rx=Math.abs(scan.pitchX)*0.26, ry=Math.abs(scan.pitchY)*0.26;
  var set=new Set(), checked=0, newly=0;
  for(var i=1;i<=S.cfg.total;i++){
    var p=idxToRC(i);
    var x=scan.ax+(p.col-scan.ac)*scan.pitchX;
    var y=scan.ay+(p.row-scan.ar)*scan.pitchY;
    if(x<rx||y<ry||x>scan.W-rx||y>scan.H-ry) continue;
    checked++;
    if(samplePiece(x,y,rx,ry)>0.55){
      set.add(i);
      if(S.states[i]!==1) newly++;
    }
  }
  scan.result=set; scan.cellsChecked=checked;
  $("scanCells").textContent=checked;
  updateScanStats();
  if(scan.calibrated) $("scanTip").textContent="识别 "+set.size+" 块"
    +" · "+(scan.mode==="edit"?"可增删结果":"可微调网格 / 增删结果");
}

// 预演：应用后哪些新增点会因为没连上主片而变成待定
function previewPendingSet(){
  if(!scan.result||!scan.result.size) return new Set();
  var backup=S.states.slice();
  var base=new Set();                 // 改动前就已完成的块 = 主片区基准
  for(var k=1;k<=S.cfg.total;k++){ if(S.states[k]===1) base.add(k); }
  var applied=new Set();
  scan.result.forEach(function(i){ if(S.states[i]!==1){ S.states[i]=1; applied.add(i); } });
  var mainSet=new Set(mainComp(base));
  var pend=new Set();
  applied.forEach(function(i){ if(!mainSet.has(i)) pend.add(i); });
  S.states=backup;
  return pend;
}

function computeScan(){
  scan.calibrated=false; scan.result=null;
  if(scan.anchors.length<2){ return; }
  var a=scan.anchors[0], b=scan.anchors[1];
  var pa=idxToRC(a.idx), pb=idxToRC(b.idx);
  var dc=pb.col-pa.col, dr=pb.row-pa.row;
  if(dc===0||dr===0){ toast("两块必须在不同行且不同列，请重新标定"); return; }
  var pitchX=(b.x-a.x)/dc, pitchY=(b.y-a.y)/dr;
  if(Math.abs(pitchX)<6||Math.abs(pitchY)<6){ toast("标定距离太近，请选相距更远的两块"); return; }
  scan.ax=a.x; scan.ay=a.y; scan.ac=pa.col; scan.ar=pa.row;
  scan.pitchX=pitchX; scan.pitchY=pitchY;
  scan.calibrated=true;
  $("scanNudge").style.display="flex";
  recalcScan();
}

function resetScan(keepImg){
  scan.anchors=[]; scan.result=null; scan.cellsChecked=0; scan.picking=null;
  scan.calibrated=false;
  scan.zoom=1; scan.ox=0; scan.oy=0;
  setScanMode("move");
  $("scanPick").classList.remove("on");
  $("scanNudge").style.display="none";
  $("scanFound").textContent="0"; $("scanCells").textContent="0"; $("scanNew").textContent="0";
  $("scanPend").textContent="0";
  $("bApplyScan").disabled=true;
  $("scanTip").style.display=scan.img?"block":"none";
  $("scanTip").textContent="点第 1 块拼图的中心（并输入编号）";
  if(!keepImg){ scan.img=null; scan.mask=null; scan.base=null; scanCtx=null; $("scanTip").style.display="none"; }
  drawScan();
}

/* ---- 使用说明：展屏（宽屏/横屏/全屏）默认收起，点顶栏「?」展开 ---- */
var scanHelpOpen=true;
function scanWideMode(){
  return window.innerWidth>=900 || window.innerWidth>window.innerHeight || !!document.fullscreenElement;
}
function applyScanHelp(){
  $("scanHelp").classList.toggle("off",!scanHelpOpen);
  $("bScanHelp").classList.toggle("on",scanHelpOpen);
}
function scanHelpSync(){ scanHelpOpen=!scanWideMode(); applyScanHelp(); }
$("bScanHelp").addEventListener("click",function(){
  scanHelpOpen=!scanHelpOpen; applyScanHelp();
});
document.addEventListener("fullscreenchange",scanHelpSync);
document.addEventListener("webkitfullscreenchange",scanHelpSync);
scanHelpSync();

$("bScan").addEventListener("click",function(){
  hideLocCard();
  $("ovScan").classList.add("on");
  scanHelpSync();               // 每次打开都按当前形态决定说明是否收起
  if(!scan.img){ resetScan(false); }
  else { drawScan(); }
  setTimeout(drawScan,60);
});
$("scanClose").addEventListener("click",function(){ $("ovScan").classList.remove("on"); });
$("bPickImg").addEventListener("click",function(){ $("fImg").click(); });
$("fImg").addEventListener("change",function(e){
  var f=e.target.files&&e.target.files[0]; if(!f) return;
  var url=URL.createObjectURL(f);
  var img=new Image();
  img.onload=function(){
    scan.img=img; scan.base=null; scan.mask=null; scan.W=0; scan.H=0;
    resetScan(true);
    $("scanTip").textContent="正在分析照片…";
    setTimeout(function(){
      analyzeImage(img,function(){
        $("scanTip").textContent="点第 1 块拼图的中心（并输入编号）";
        drawScan();
        toast("已识别拼图区域");
      });
    },40);
    URL.revokeObjectURL(url);
  };
  img.onerror=function(){ toast("图片加载失败"); };
  img.src=url;
  e.target.value="";
});

function parsePickNum(v){
  var raw=String(v||"").replace(/[^0-9]/g,"");
  if(!raw) return null;
  var n=parseInt(raw,10);
  return isNaN(n)?null:n;
}
function updatePickRes(){
  var n=parsePickNum($("pickNum").value);
  if(n===null||n<1||n>S.cfg.total){
    $("pickRes").innerHTML="对应全局第 <b>-</b> 块";
    return null;
  }
  var p=idxToRC(n);
  $("pickRes").innerHTML="对应全局第 <b>"+fmt(n)+"</b> 块 · "
    +zoneLetter(zoneOf(n))+"区 第"+p.col+"列 第"+p.row+"行";
  return n;
}
$("pickNum").addEventListener("input",updatePickRes);

/* ---- 照片上的交互：点选锚点 / 平移缩放 / 微调网格 / 增删结果 ---- */
var scanPtr=new Map(), scanDrag=null, scanPinch=null, pickR=45;

function scanImgXY(clientX,clientY){
  var r=scanCanvas.getBoundingClientRect();
  return { x:(clientX-r.left)*(scan.W/r.width), y:(clientY-r.top)*(scan.H/r.height) };
}
// 图像坐标 → 最近的格子编号
function scanHitIdx(x,y){
  if(!scan.calibrated) return null;
  var col=Math.round((x-scan.ax)/scan.pitchX)+scan.ac;
  var row=Math.round((y-scan.ay)/scan.pitchY)+scan.ar;
  if(row<1||col<1||row>S.rows||col>S.cfg.cols) return null;
  var i=rcToIdx(row,col);
  return (i>=1&&i<=S.cfg.total)?i:null;
}
function scanToggleCell(i,del){
  if(!scan.result||i==null) return;
  if(del) scan.result.delete(i); else scan.result.add(i);
  updateScanStats(); drawScan();
}
function updateScanStats(){
  var set=scan.result||new Set(), newly=0;
  set.forEach(function(i){ if(S.states[i]!==1) newly++; });
  scan.newCount=newly;
  scan.pendingSet=previewPendingSet();
  $("scanFound").textContent=set.size;
  $("scanNew").textContent=newly;
  $("scanPend").textContent=scan.pendingSet.size;
  $("bApplyScan").disabled = set.size===0;
}

// 放大镜：把选中点附近的原始像素放大显示，方便读印在块上的数字
function drawPickZoom(){
  if(!scan.picking||!scan.img) return;
  var cv=$("pickZoom"), c=cv.getContext("2d");
  var R=Math.max(10,Math.min(320,pickR));
  var k=scan.img.width/scan.W;          // 工作图 → 原图 的倍率
  c.fillStyle="#060a10"; c.fillRect(0,0,cv.width,cv.height);
  try{
    c.drawImage(scan.img,(scan.picking.x-R)*k,(scan.picking.y-R)*k,2*R*k,2*R*k,
                0,0,cv.width,cv.height);
  }catch(err){}
  c.strokeStyle="rgba(255,212,94,.95)"; c.lineWidth=1.5;
  c.beginPath();
  c.moveTo(cv.width/2,0); c.lineTo(cv.width/2,cv.height);
  c.moveTo(0,cv.height/2); c.lineTo(cv.width,cv.height/2);
  c.stroke();
  $("pkZoomVal").textContent="×"+(cv.width/(2*R)).toFixed(1).replace(/\.0$/,"");
}
$("pickZoom").parentNode.addEventListener("click",function(e){
  var b=e.target.closest?e.target.closest("button[data-z]"):null; if(!b) return;
  if(b.dataset.z==="in") pickR=Math.max(10,pickR/1.5);
  else pickR=Math.min(320,pickR*1.5);
  drawPickZoom();
});

function openPick(p,clientX,clientY){
  scan.picking={x:p.x,y:p.y};
  var pr=$("scanPick");
  pr.classList.add("on");
  var stage=$("scanStage").getBoundingClientRect();
  var left=clientX-stage.left+14, top=clientY-stage.top+14;
  if(left+290>stage.width) left=clientX-stage.left-300;
  if(top+420>stage.height) top=Math.max(8,clientY-stage.top-420);
  pr.style.left=Math.max(8,left)+"px";
  pr.style.top=Math.max(8,top)+"px";
  $("pickNum").value=""; updatePickRes();
  drawPickZoom();
  setTimeout(function(){ try{ $("pickNum").focus(); }catch(err){} },60);
}

function startScanPinch(){
  var pts=[]; scanPtr.forEach(function(v){ pts.push(v); });
  if(pts.length<2){ scanPinch=null; return; }
  scanPinch={ d:Math.max(1,Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y)), z:scan.zoom };
  scanDrag=null;
}
function doScanPinch(){
  var pts=[]; scanPtr.forEach(function(v){ pts.push(v); });
  if(pts.length<2||!scanPinch) return;
  var d=Math.max(1,Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y));
  scanZoomAt((pts[0].x+pts[1].x)/2,(pts[0].y+pts[1].y)/2, scanPinch.z*(d/scanPinch.d));
}

/* 手势监听放在 stage 上而不是 canvas 上：一根手指点在照片以外的空白处也要能平移；
   两根手指一根在画布内、一根在画布外，也要能识别为双指缩放 */
var scanStage=$("scanStage");
scanStage.addEventListener("pointerdown",function(e){
  if(!scan.img||!scan.mask) return;
  // 顶部工具条 / 选点浮层是 UI，不当画布手势
  if(e.target.closest && (e.target.closest(".scan-bar")||e.target.closest(".scan-pick"))) return;
  e.preventDefault();
  scanPtr.set(e.pointerId,{x:e.clientX,y:e.clientY});
  try{ scanStage.setPointerCapture(e.pointerId); }catch(err){}
  if(scanPtr.size>=2){ startScanPinch(); scanDrag=null; return; }
  var p=scanImgXY(e.clientX,e.clientY);
  var inside=p.x>=0&&p.y>=0&&p.x<=scan.W&&p.y<=scan.H;
  scanDrag={ id:e.pointerId, sx:e.clientX, sy:e.clientY, ox:scan.ox, oy:scan.oy,
             ax:scan.ax, ay:scan.ay, moved:false, pt:p, last:null, del:false, inside:inside };
  // 增删模式：按下即切换这一格（只认照片范围内的格子）
  if(scan.calibrated && scan.mode==="edit" && inside){
    var i=scanHitIdx(p.x,p.y);
    if(i!==null){ scanDrag.del=scan.result.has(i); scanDrag.last=i; scanToggleCell(i,scanDrag.del); }
  }
});

scanStage.addEventListener("pointermove",function(e){
  if(scanPtr.has(e.pointerId)) scanPtr.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(scanPinch){ doScanPinch(); return; }
  if(!scanDrag||scanDrag.id!==e.pointerId) return;
  var dx=e.clientX-scanDrag.sx, dy=e.clientY-scanDrag.sy;
  if(!scanDrag.moved && (Math.abs(dx)>6||Math.abs(dy)>6)) scanDrag.moved=true;
  if(!scanDrag.moved) return;
  if(scan.calibrated && scan.mode==="grid"){
    var r=scanCanvas.getBoundingClientRect(), k2=scan.W/r.width;
    scan.ax=scanDrag.ax+dx*k2; scan.ay=scanDrag.ay+dy*k2;
    recalcScan(); drawScan();
  } else if(scan.calibrated && scan.mode==="edit"){
    var p=scanImgXY(e.clientX,e.clientY);
    if(p.x<0||p.y<0||p.x>scan.W||p.y>scan.H) return;
    var i=scanHitIdx(p.x,p.y);
    if(i!==null && i!==scanDrag.last){ scanDrag.last=i; scanToggleCell(i,scanDrag.del); }
  } else {
    scan.ox=scanDrag.ox+dx; scan.oy=scanDrag.oy+dy; layoutScanView();
  }
});

function endScanPointer(e){
  scanPtr.delete(e.pointerId);
  if(scanPinch){ if(scanPtr.size<2) scanPinch=null; scanDrag=null; return; }
  if(!scanDrag||scanDrag.id!==e.pointerId) return;
  var d=scanDrag; scanDrag=null;
  if(d.moved) return;                       // 拖过 = 平移照片，不当作选点
  if(!scan.calibrated){
    if(scan.anchors.length>=2){ toast("已标定两块，点「重新标定」可重来"); return; }
    if(d.inside) openPick(d.pt,e.clientX,e.clientY);   // 只有点在照片范围内才选锚点
  }
}
scanStage.addEventListener("pointerup",endScanPointer);
scanStage.addEventListener("pointercancel",function(e){
  scanPtr.delete(e.pointerId); scanDrag=null; scanPinch=null;
});
$("scanStage").addEventListener("wheel",function(e){
  if(!scan.img) return;
  e.preventDefault();
  scanZoomAt(e.clientX,e.clientY, scan.zoom*Math.exp(-e.deltaY*0.0016));
},{passive:false});

function setScanMode(m){
  scan.mode=m;
  var bs=document.querySelectorAll(".scan-bar button[data-m]");
  for(var i=0;i<bs.length;i++) bs[i].classList.toggle("on", bs[i].dataset.m===m);
  scanStage.style.cursor = m==="move" ? "grab" : "crosshair";
  if(m==="edit"){
    if(!scan.calibrated){ toast("先标定两块，再手动增删"); setScanMode("move"); return; }
    $("scanTip").textContent="增删模式：点格子加入 / 移除识别结果，按住拖动可连续刷";
  } else if(m==="grid"){
    $("scanTip").textContent="微调模式：拖动照片来平移网格，或用下方方向键";
  } else {
    $("scanTip").textContent="移动模式：拖动平移、滚轮缩放照片；点块可选为标定锚点";
  }
}
document.querySelector(".scan-bar").addEventListener("click",function(e){
  var b=e.target.closest?e.target.closest("button"):null; if(!b) return;
  if(b.dataset.m){ setScanMode(b.dataset.m); return; }
  if(!scan.img) return;
  var st=$("scanStage").getBoundingClientRect();
  var cx=st.left+st.width/2, cy=st.top+st.height/2;
  if(b.id==="szIn") scanZoomAt(cx,cy,scan.zoom*1.3);
  else if(b.id==="szOut") scanZoomAt(cx,cy,scan.zoom/1.3);
  else if(b.id==="szFit") scanResetView();
});

$("scanNudge").addEventListener("click",function(e){
  var b=e.target.closest?e.target.closest("button"):null; if(!b||!scan.calibrated) return;
  var n=b.dataset.n;
  var sx=Math.abs(scan.pitchX)*0.05, sy=Math.abs(scan.pitchY)*0.05;
  if(n==="left") scan.ax-=sx;
  if(n==="right") scan.ax+=sx;
  if(n==="up") scan.ay-=sy;
  if(n==="down") scan.ay+=sy;
  if(n==="plus"){ scan.pitchX*=1.012; scan.pitchY*=1.012; }
  if(n==="minus"){ scan.pitchX*=0.988; scan.pitchY*=0.988; }
  recalcScan(); drawScan();
});

$("pickCancel").addEventListener("click",function(){
  scan.picking=null; $("scanPick").classList.remove("on");
});
$("pickOk").addEventListener("click",function(){
  if(!scan.picking) return;
  var idx=updatePickRes();
  if(!idx){ toast("请输入拼图块上印的数字（1 ~ "+S.cfg.total+"）"); return; }
  scan.anchors.push({x:scan.picking.x,y:scan.picking.y,idx:idx});
  scan.picking=null; $("scanPick").classList.remove("on");
  if(scan.anchors.length===1){
    $("scanTip").textContent="再点第 2 块拼图（对角线方向，越远越准）";
    drawScan();
  } else {
    computeScan();
    drawScan();
    if(scan.calibrated){
      $("scanTip").textContent="格距 "+Math.abs(scan.pitchX).toFixed(1)+"×"+Math.abs(scan.pitchY).toFixed(1)
        +" · 识别 "+scan.result.size+" 块 · 可微调 / 增删";
      $("scanStep").innerHTML="已标定 <b>"+fmt(scan.anchors[0].idx)+"</b> 与 <b>"+fmt(scan.anchors[1].idx)+"</b><br>"
        +"<b>绿框</b>＝识别为已拼 · 灰框＝空位<br>"
        +"顶部工具条：<b>移动照片</b>拖动/缩放看细节 · <b>微调网格</b>整体挪动 · <b>增删结果</b>逐格修正<br>"
        +"<span class=\"sn\">只把识别到的块标为已拼，不会动其它块。</span>";
    }
  }
});
$("bRescan").addEventListener("click",function(){ resetScan(true); });

$("bApplyScan").addEventListener("click",function(){
  if(!scan.result||!scan.result.size){ toast("还没有识别结果"); return; }
  var orig=new Map();
  var base=new Set();                 // 应用前已完成的块 = 主片区基准
  for(var k=1;k<=S.cfg.total;k++){ if(S.states[k]===1) base.add(k); }
  var applied=0;
  scan.result.forEach(function(i){
    if(S.states[i]!==1){ if(!orig.has(i)) orig.set(i,S.states[i]); S.states[i]=1; applied++; }
  });
  // 与主片区不相连的新增区域 → 待定（黄）
  var demoted=0;
  if(applied){
    var mainSet=new Set(mainComp(base));
    orig.forEach(function(v,i){
      if(S.states[i]===1 && !mainSet.has(i)){ S.states[i]=3; demoted++; }
    });
    // 已有的待定块如果这次连上了主片，转完成
    promoteConnected().forEach(function(c){ if(!orig.has(c[0])) orig.set(c[0],c[1]); });
  }
  orig.forEach(function(v,k){ paint(k); markChange(k); });
  pushUndo(Array.from(orig.entries()));
  afterChange();
  $("ovScan").classList.remove("on");
  var msg="已应用 · "+applied+" 块";
  if(demoted) msg+="，其中 "+demoted+" 块待定";
  toast(msg);
  vibrate(30);
});
/* Esc 关闭放大选点面板（main.js 键盘处理用） */
export function cancelPick(){
  scan.picking=null; $("scanPick").classList.remove("on");
}
