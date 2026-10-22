import { S } from "./store.js";
import { $, toast, vibrate } from "./dom.js";
import { fmt, idxToRC, rcToIdx, zoneOf, zoneLetter } from "./coords.js";
import { mainComp, promoteConnected } from "./grid.js";
import { paint, afterChange, centerOnSet, setView } from "./board.js";
import { pushUndo, exitBatch } from "./interact.js";
import { markChange } from "./sync.js";
import { hideLocCard, flashRegion } from "./search.js";
import { detectNumbers } from "./ocr.js";
import { startGuide } from "./guide.js";

/* ================= 照片识别 ================= */
var scan={
  img:null, W:0, H:0, mask:null, gray:null, base:null,
  anchors:[],          // [{x,y,idx}]
  result:null,         // Set of idx
  cellsChecked:0,
  calibrated:false,
  rot:false,           // 拼放方向相对编号框架旋转了 90°：照片 x 由行驱动、y 由列驱动
  picking:null,
  zoom:1, ox:0, oy:0, fit:1,   // 照片视图：缩放倍数（1=适应窗口）与平移偏移
  mode:"move",         // move 移动照片 / grid 微调网格 / edit 增删结果
  ocr:null             // {results, map:Map(idx->rec), w, h} 散块编号识别（OCR 工作分辨率）
};
window.__scan=scan;    // 调试/E2E 钩子（与 window.__ocr 同模式）
window.__addPiece=function(i,x,y){ return addManualReading(i,x,y); };  // 同上
var GRP_TXT=["#6ec8ff","#ffb050","#d878ff","#78ffd0","#ff78b8","#d0ff5a","#8ca0ff","#ffdc5a"]; // 拼好组文字色
var scanCanvas=$("scanCanvas"), scanCtx=null;

/* ---- PP-OCR 高精度服务（可选，与标注台同一服务，127.0.0.1:8849）----
   服务端已带 CORS；未启动时自动回退内置模板 OCR。 */
var OSVC={ host:(function(){ try{ return localStorage.getItem("scanOsvcHost")||"http://127.0.0.1:8849"; }catch(err){ return "http://127.0.0.1:8849"; } })(),
           ok:false, checking:false };
function osvcBadge(){
  var d=$("osvcDot"), st=$("osvcState");
  if(!d) return;
  d.style.background=OSVC.ok?"#3ddc84":"#3a4656";
  st.textContent=OSVC.ok?"已连接":"未连接";
  st.style.color=OSVC.ok?"var(--ok, #3ddc84)":"";
}
function osvcProbe(){
  if(OSVC.checking) return;
  OSVC.checking=true;
  var ctl=new AbortController(), t=setTimeout(function(){ ctl.abort(); },1500);
  fetch(OSVC.host+"/health",{signal:ctl.signal})
    .then(function(r){ return r.json(); })
    .then(function(j){ OSVC.ok=!!j.ok; })
    .catch(function(){ OSVC.ok=false; })
    .then(function(){ OSVC.checking=false; clearTimeout(t); osvcBadge(); });
}
// "B-241"/"B241"/"B—241"/"7-793"（首字符非 A-D）→ {letter,digits}；纯数字不认（防噪声）
function parseNumText(t){
  if(!t) return null;
  var s0=String(t).replace(/\s+/g,"");
  var m=s0.match(/([A-Da-d])[-–—]?(\d{2,4})(?!\d)/);
  if(m) return { letter:m[1].toUpperCase(), digits:m[2] };
  var m2=s0.match(/^.\s*[-–—]\s*(\d{2,4})(?!\d)/);
  if(m2) return { letter:"", digits:m2[1] };
  return null;
}
/* 整图 → 服务读数（2×2 重叠分片：整图推理字符相对太小 det 会漏检）。
   返回与 detectNumbers 同构的读数（3072 尺度，ang=行框长边方向）。 */
function svcReadings(img){
  var W=img.width, H=img.height;
  var s=Math.round(W*Math.min(1,3072/Math.max(W,H)))/W;   // 原图 → OCR 尺度
  var ov=Math.round(Math.max(W,H)*0.06);                   // 6% 重叠防切在编号上
  var hw=Math.floor(W/2), hh=Math.floor(H/2);
  var tiles=[[0,0,hw+ov,hh+ov],[hw-ov,0,W,hh+ov],[0,hh-ov,hw+ov,H],[hw-ov,hh-ov,W,H]];
  var out=[], seenC=[], chain=Promise.resolve();
  tiles.forEach(function(t){
    chain=chain.then(function(){
      var sx=Math.max(0,t[0]), sy=Math.max(0,t[1]);
      var ex=Math.min(W,t[2]), ey=Math.min(H,t[3]);
      if(ex-sx<40||ey-sy<40) return;
      var c=document.createElement("canvas"); c.width=ex-sx; c.height=ey-sy;
      c.getContext("2d").drawImage(img, sx,sy,ex-sx,ey-sy, 0,0,ex-sx,ey-sy);
      return fetch(OSVC.host+"/ocr",{ method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({img:c.toDataURL("image/jpeg",0.92)}) })
        .then(function(r){ return r.json(); })
        .then(function(j){
          if(j.error) throw new Error(j.error);
          (j.lines||[]).forEach(function(l){
            var num=parseNumText(l.text);
            if(!num||!l.box||l.box.length<3) return;
            var xs=l.box.map(function(p){ return p[0]+sx; }),
                ys=l.box.map(function(p){ return p[1]+sy; });
            var cx=(Math.min.apply(0,xs)+Math.max.apply(0,xs))/2;
            var cy=(Math.min.apply(0,ys)+Math.max.apply(0,ys))/2;
            for(var si=0;si<seenC.length;si++){
              var dx=seenC[si][0]-cx, dy=seenC[si][1]-cy;
              if(dx*dx+dy*dy<6400) return;              // 重叠区同一行去重（<80px）
            }
            seenC.push([cx,cy]);
            var digits=num.digits, idx=parseInt(digits,10);
            if(isNaN(idx)||digits.length<3||idx<1||idx>S.cfg.total) return;
            var d1=Math.hypot(l.box[1][0]-l.box[0][0], l.box[1][1]-l.box[0][1]);
            var d2=Math.hypot(l.box[2][0]-l.box[1][0], l.box[2][1]-l.box[1][1]);
            var ang=d1>=d2
              ? Math.atan2(l.box[1][1]-l.box[0][1], l.box[1][0]-l.box[0][0])
              : Math.atan2(l.box[2][1]-l.box[1][1], l.box[2][0]-l.box[1][0]);
            var tl=(d1>=d2?d1:d2)*s;
            // 合成 comps：沿 ang 跨 0.675×tl → readingSide 的 0.27 比例折出 ≈2.5×文本宽的片宽
            var T=tl*0.675, cs=Math.cos(ang), sn=Math.sin(ang), comps=[];
            for(var i=0;i<5;i++){
              var ccx=cx*s+(i-2)*T/4*cs, ccy=cy*s+(i-2)*T/4*sn;
              comps.push({x0:ccx-3, y0:ccy-6, w:6, h:12});
            }
            out.push({ letter:(num.letter||zoneLetter(zoneOf(idx))), digits:digits,
                       idx:idx, conf:l.score, x:cx*s, y:cy*s, ang:ang, n:5, svc:true, comps:comps });
          });
        });
    });
  });
  return chain.then(function(){ return out; });
}

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
  var maskWhite=new Uint8Array(w*h);
  for(var j=0,p=0;j<mask.length;j++,p+=4){
    mask[j]=gray[j]>thr?1:0;
    // 白色度：拼图背面是低饱和白纸；木地板反光光斑中圈饱和度明显偏高
    // （彩色木纹透出），用 max-min/max < 0.10 把它从前景里剥掉——过曝核心
    // 虽无法区分，但被中圈隔断后前景不再连通，逐格蔓延到不了那里。
    var R=d[p],G=d[p+1],B=d[p+2];
    var mx=R>G?R:G; if(B>mx)mx=B;
    var mn=R>G?(G>B?B:G):(R>B?B:R);
    maskWhite[j]=(gray[j]>thr && mx>0 && (mx-mn)/mx<0.10)?1:0;
  }

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
  scan.W=w; scan.H=h; scan.gray=gray; scan.mask=mask; scan.maskWhite=maskWhite; scan.thr=thr;
  cb();
}

/* 拼图块前景判定（带反光光斑过滤）。
   木地板反光光斑在灰度 Otsu 下会误判为前景：过曝核心接近纯白、中圈发灰白，
   饱和度/亮度/色差/缝结构都与拼图白纸重叠，逐像素无法区分。实测（85889）：
   白纸格大窗（>缝距）maskWhite 命中率稳定在 0.91~0.99（缝贡献少量暗像素），
   光斑核心 ≈1.0（完全无缝纯亮）、光斑中圈/骑缝格 ≤0.85（渐变暗像素多）。
   strict=true 用于整块图蔓延/前景采样；散块组内推算用 whiteHit 的
   片心+接缝双窗判据（更严，防散堆邻片/凸头骗过）。 */
function isPieceAt(x,y,rx,ry,strict){
  var hit=0,tot=0;
  for(var dy=-ry;dy<=ry;dy++){
    var py=Math.round(y+dy);
    if(py<0||py>=scan.H) continue;
    for(var dx=-rx;dx<=rx;dx++){
      var px=Math.round(x+dx);
      if(px<0||px>=scan.W) continue;
      if((dx*dx)/(rx*rx)+(dy*dy)/(ry*ry)>1) continue;
      tot++;
      if(scan.maskWhite[py*scan.W+px]) hit++;
    }
  }
  if(!tot||hit/tot<=0.55) return false;
  if(!strict) return true;
  var RX=Math.round(Math.abs(scan.pitchX)*0.55), RY=Math.round(Math.abs(scan.pitchY)*0.55);
  if(RX<10||RY<10) return true;
  var hitB=0, totB=0;
  for(var dy2=-RY;dy2<=RY;dy2++){
    var py2=Math.round(y+dy2);
    if(py2<0||py2>=scan.H) continue;
    for(var dx2=-RX;dx2<=RX;dx2++){
      var px2=Math.round(x+dx2);
      if(px2<0||px2>=scan.W) continue;
      totB++;
      if(scan.maskWhite[py2*scan.W+px2]) hitB++;
    }
  }
  if(!totB) return true;
  var fgwB=hitB/totB;
  // 大窗白纸命中率：光斑核心 ≈1.0（纯亮无缝）、光斑中圈/骑缝 ≤0.85、
  // 阴影白纸 0.55~0.88（与光斑中圈重叠，交给簇级「OCR 支持检查」区分——
  // 真片区域至少会有一个检出哪怕被丢，光斑区什么字都没有）。
  // 下界取 0.50：画面最外一列的片，大窗有一侧压在木地板上（828 实测矩形
  // 0.543、椭圆 0.605），用 0.55 会把整列边缘片全判掉，簇级检查已经兜住误判。
  return fgwB>0.50 && fgwB<0.999;
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

// 行列 → 照片坐标。rot 时拼放方向旋转了 90°：照片 x 由行驱动、y 由列驱动
function scanCellXY(p){
  if(scan.rot) return { x:scan.ax+(p.row-scan.ar)*scan.pitchX,
                        y:scan.ay+(p.col-scan.ac)*scan.pitchY };
  return { x:scan.ax+(p.col-scan.ac)*scan.pitchX,
           y:scan.ay+(p.row-scan.ar)*scan.pitchY };
}
// 照片坐标 → 最近行列（增删模式点选格子用）
function scanXYCell(x,y){
  if(scan.rot) return { row:Math.round((x-scan.ax)/scan.pitchX)+scan.ar,
                        col:Math.round((y-scan.ay)/scan.pitchY)+scan.ac };
  return { col:Math.round((x-scan.ax)/scan.pitchX)+scan.ac,
           row:Math.round((y-scan.ay)/scan.pitchY)+scan.ar };
}

function drawScanGrid(){
  var px=Math.abs(scan.pitchX), py=Math.abs(scan.pitchY);
  var W=scan.W,H=scan.H;
  var bw=px*0.66, bh=py*0.66;
  var ocrMode=scan.ocr && scan.ocr.map.size>=2;
  // 编号读取模式一律不画灰格底框：散块照片上网格映射是 garbage（画了干扰拼好组），
  // 整块照片上格子被结果框/推算框铺满，灰格只是噪点。手动标定（非 OCR）才画。
  var showGrid = !ocrMode;
  var GRP_COLORS=["rgba(80,200,255,.30)","rgba(255,170,80,.30)","rgba(200,120,255,.30)",
                  "rgba(120,255,200,.30)","rgba(255,120,180,.30)","rgba(200,255,90,.30)",
                  "rgba(140,160,255,.30)","rgba(255,220,90,.30)"];
  // 散块模式下网格框更淡（编号标注才是主角）
  if(showGrid) for(var i=1;i<=S.cfg.total;i++){
    var p=idxToRC(i);
    var q=scanCellXY(p);
    var x=q.x, y=q.y;
    if(x<-px||y<-py||x>W+px||y>H+py) continue;
    var ok=scan.result && scan.result.has(i);
    var pend=ok && scan.pendingSet && scan.pendingSet.has(i);
    var susp=scan.suspIdx && scan.suspIdx.has(i);                // 拼合可疑块
    // 散块模式：结果框改画在片子实际位置（读数处），网格映射位只留淡格
    if(ocrMode && ok) continue;
    scanCtx.fillStyle = ok
      ? (pend ? "rgba(240,180,30,.34)" : "rgba(40,230,120,.30)")
      : (ocrMode ? "rgba(130,150,175,.07)" : "rgba(130,150,175,.16)");
    scanCtx.fillRect(x-bw/2,y-bh/2,bw,bh);
    if(ok){
      scanCtx.strokeStyle = susp ? "rgba(255,80,80,.95)" : pend ? "rgba(255,198,40,.95)" : "rgba(60,255,140,.95)";
      scanCtx.lineWidth=Math.max(1.2,px*0.055);
      scanCtx.strokeRect(x-bw/2,y-bh/2,bw,bh);
    } else {
      scanCtx.strokeStyle= ocrMode ? "rgba(150,170,195,.14)" : "rgba(150,170,195,.32)";
      scanCtx.lineWidth=1;
      scanCtx.strokeRect(x-bw/2,y-bh/2,bw,bh);
    }
  }
  // 散块模式：已拼结果框画在片子的实际照片位置（读数处），按文字方向旋转，拼好组按组着色。
  // 整块模式：对齐读数统一画在网格位（同尺寸同角度）——读数框边长随文字长短而异、
  // 且文字中心≠片心，混在推算框里会显得歪歪扭扭；网格对齐后直接用网格位最整齐。
  if(ocrMode && scan.reads && scan.result){
    var k2=scan.W/scan.ocr.w;
    var blk=!!scan.blockMode;
    var bw2=Math.abs(scan.pitchX)*0.92, bh2=Math.abs(scan.pitchY)*0.92;
    scan.reads.forEach(function(rd){
      if(!scan.result.has(rd.idx)) return;
      var x=rd.x*k2, y=rd.y*k2, side=readingSide(rd)*k2, ang=rd.ang||0, rect=false;
      if(blk && scan.alignedIdx && scan.alignedIdx.has(rd.idx)){
        var gp=scanCellXY(idxToRC(rd.idx));
        x=gp.x; y=gp.y; ang=scan.blockAng||0; rect=true;   // 网格位 + 统一尺寸
      }
      if(x<-60||y<-60||x>W+60||y>H+60) return;
      var susp=scan.suspIdx && scan.suspIdx.has(rd.idx);
      var gi=scan.grpMap ? scan.grpMap[rd.idx] : null;
      scanCtx.save();
      scanCtx.translate(x,y); scanCtx.rotate(ang);   // 框随文字方向摆放
      var fw = rect?bw2:side, fh = rect?bh2:side;
      scanCtx.fillStyle = susp ? "rgba(255,90,90,.30)"
        : gi!=null ? GRP_COLORS[gi%GRP_COLORS.length] : "rgba(40,230,120,.30)";
      scanCtx.fillRect(-fw/2,-fh/2,fw,fh);
      scanCtx.strokeStyle = susp ? "rgba(255,80,80,.95)"
        : gi!=null ? GRP_COLORS[gi%GRP_COLORS.length].replace(".30",".95") : "rgba(60,255,140,.95)";
      scanCtx.lineWidth=Math.max(1.2,fw*0.05);
      scanCtx.strokeRect(-fw/2,-fh/2,fw,fh);
      scanCtx.restore();
    });
  }
  // 手动增删的格子（无读数、非推算）：网格位橙色框，否则点了看不见
  if(ocrMode && scan.result && scan.blockMode){
    for(var mi=1;mi<=S.cfg.total;mi++){
      if(!scan.result.has(mi) || scan.ocr.map.has(mi) || (scan.inferredIdx&&scan.inferredIdx.has(mi))) continue;
      var gp=scanCellXY(idxToRC(mi));
      if(gp.x<-40||gp.y<-40||gp.x>W+40||gp.y>H+40) continue;
      var sw=Math.abs(scan.pitchX)*0.92, sh=Math.abs(scan.pitchY)*0.92;
      scanCtx.save();
      scanCtx.translate(gp.x,gp.y); scanCtx.rotate(scan.blockAng||0);
      scanCtx.fillStyle="rgba(255,170,40,.30)";
      scanCtx.fillRect(-sw/2,-sh/2,sw,sh);
      scanCtx.strokeStyle="rgba(255,170,40,.95)";
      scanCtx.lineWidth=Math.max(1.2,sw*0.05);
      scanCtx.strokeRect(-sw/2,-sh/2,sw,sh);
      scanCtx.restore();
    }
  }
  // 拼好推算块：组内两点标定外推 + 前景证实 → 蓝框 + 蓝色编号
  if(ocrMode && scan.inferredIdx && scan.inferredIdx.size){
    var k3=scan.W/scan.ocr.w;
    scan.inferredIdx.forEach(function(idx){
      if(scan.result && !scan.result.has(idx)) return;   // 被手动删除的不画
      var ip=scan.inferredPos[idx]; if(!ip) return;
      var x=ip.x*k3, y=ip.y*k3;
      if(x<-60||y<-60||x>W+60||y>H+60) return;
      var side=ip.side*k3;
      // 推算块沿用「来源拼好组」的颜色（同组同色，视觉上才是一整块），
      // 用虚线边框区分「推算」与「读数」——颜色=组归属，线型=证据强度。
      // weak（单轴组转 90° 补出来的那根轴）：黄虚线 + 编号带「?」，方向需要人核。
      var gcol = (ip.grp!=null) ? GRP_COLORS[ip.grp%GRP_COLORS.length] : null;
      var strokeCol = ip.weak ? "rgba(255,214,80,.95)"
        : (gcol ? gcol.replace(".30",".95") : "rgba(110,190,255,.95)");
      scanCtx.save();
      scanCtx.translate(x,y); scanCtx.rotate(ip.ang||0);
      scanCtx.fillStyle = ip.weak ? "rgba(255,200,40,.26)" : (gcol || "rgba(80,170,255,.30)");
      scanCtx.fillRect(-side/2,-side/2,side,side);
      scanCtx.strokeStyle = strokeCol;
      scanCtx.lineWidth=Math.max(1.2,side*0.05);
      scanCtx.setLineDash([Math.max(4,side*0.18), Math.max(3,side*0.12)]);
      scanCtx.strokeRect(-side/2,-side/2,side,side);
      scanCtx.restore();
      var label=zoneLetter(zoneOf(idx))+"-"+fmt(idx)+(ip.weak?"?":"");
      scanCtx.font="bold 15px monospace";
      var tw2=scanCtx.measureText(label).width;
      scanCtx.fillStyle="rgba(8,12,18,.72)";
      scanCtx.fillRect(x-tw2/2-4, y-31, tw2+8, 18);
      scanCtx.fillStyle=strokeCol;
      scanCtx.textAlign="center"; scanCtx.textBaseline="middle";
      scanCtx.fillText(label, x, y-22);
    });
  }
  // 散块模式：把读到的编号标在照片上（conf 着色）。整块模式下对齐读数的标签
  // 跟着框一起放到网格位，与推算块混排时整列整齐。
  if(ocrMode && scan.ocr.results){
    var k=scan.W/scan.ocr.w;
    scan.ocr.results.forEach(function(r){
      var x=r.x*k, y=r.y*k;
      if(scan.blockMode && scan.alignedIdx && scan.alignedIdx.has(r.idx)){
        var gp=scanCellXY(idxToRC(r.idx));
        x=gp.x; y=gp.y;
      }
      if(x<-40||y<-40||x>W+40||y>H+40) return;
      var good=r.conf>=0.65, mid=r.conf>=0.5;
      var col=good?"rgba(60,255,140,.95)":(mid?"rgba(255,198,40,.95)":"rgba(160,175,195,.6)");
      // 片位置小十字
      scanCtx.strokeStyle=col; scanCtx.lineWidth=1.4;
      scanCtx.beginPath();
      scanCtx.moveTo(x-6,y); scanCtx.lineTo(x+6,y);
      scanCtx.moveTo(x,y-6); scanCtx.lineTo(x,y+6);
      scanCtx.stroke();
      // 编号文字底衬（最后画，压住针线）
      var label=r.letter+"-"+r.digits;
      scanCtx.font="bold 15px monospace";
      var tw=scanCtx.measureText(label).width;
      scanCtx.fillStyle="rgba(8,12,18,.72)";
      scanCtx.fillRect(x-tw/2-4, y-31, tw+8, 18);
      scanCtx.fillStyle=col;
      scanCtx.textAlign="center"; scanCtx.textBaseline="middle";
      scanCtx.fillText(label, x, y-22);
    });
  }
}

/* 读数文本行长度：comps 中心沿 ang 方向的投影跨度；片宽经验折算 tl/0.27 */
function readingTl(r){
  var th=r.ang||0, cs=Math.cos(th), sn=Math.sin(th), mn=1e9, mx=-1e9;
  (r.comps||[]).forEach(function(c){
    var a=(c.x0+c.w/2)*cs+(c.y0+c.h/2)*sn;
    if(a<mn)mn=a; if(a>mx)mx=a;
  });
  return mx>mn ? mx-mn : 0;
}
function readingSide(r){
  var tl = (typeof r.tl==="number" && r.tl>0) ? r.tl : readingTl(r);   // reads 数组已存 tl
  return tl>0 ? Math.max(40,Math.min(240,tl/0.27)) : 0;
}

function recalcScan(){
  if(!scan.calibrated) return;
  var set=new Set(), checked=0, newly=0;
  if(scan.ocr && scan.ocr.map.size>=2){
    // 散块模式：OCR 读到的编号本身就是「该块已拼」的证据
    scan.ocr.map.forEach(function(r){
      checked++;
      if(r.conf>=0.5 && r.idx>=1 && r.idx<=S.cfg.total) set.add(r.idx);
    });
    // —— 拼好组识别（编号 + 照片位置 + 文本方向）——
    // 散块照片上网格映射与片子实际摆放位置无关（残差可达十几个格距），
    // 拼合判定全部用 OCR 工作坐标 + 读数文本方向：
    //   距离≈一片宽(0.7~1.5×minSide) + 文本轴平行(svc 框角按轴系折叠, <20°)
    //   + 相对向量沿文本轴(≥0.65)。
    // 拼合相邻的两块，编号须为网格 4 邻/对角（主 app 网格绝对坐标）：
    //   是 → 并查集合并成组，并记「网格Δ×照片Δ」样本供组内两点标定；
    //   否 → 先挂起，二筛定夺。
    var reads=[];
    scan.ocr.map.forEach(function(r,idx){
      if(r.conf<0.5||r.idx<1||r.idx>S.cfg.total) return;
      var tl=readingTl(r);
      if(tl>0) reads.push({idx:idx,x:r.x,y:r.y,ang:r.ang||0,tl:tl,svc:!!r.svc});
    });
    var parent={};
    function find(x){ while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; }
    reads.forEach(function(r){ parent[r.idx]=r.idx; });
    var vpairs=[], defSusp=[];
    for(var a=0;a<reads.length;a++)for(var b=a+1;b<reads.length;b++){
      var ra=reads[a], rb=reads[b];
      var d=Math.hypot(ra.x-rb.x, ra.y-rb.y);
      var side=Math.min(readingSide(ra), readingSide(rb));
      if(d<side*0.7||d>side*1.5) continue;             // 不是一片宽的近邻（1.41≈对角贴片）
      var dth=Math.abs(ra.ang-rb.ang)*180/Math.PI%180; if(dth>90) dth=180-dth;
      if(ra.svc||rb.svc){ if(dth>45) dth=90-dth; }     // PP-OCR 框角带 90° 歧义（det 点序），按轴系折叠
      if(dth>20) continue;                             // 文本轴不平行 → 不是同一簇
      var psi=Math.atan2(rb.y-ra.y, rb.x-ra.x)-ra.ang;
      var axv=Math.max(Math.abs(Math.cos(psi)), Math.abs(Math.sin(psi)));
      if(axv<0.65) continue;                           // 相对向量明显偏离横/竖轴
      var pa=idxToRC(ra.idx), pb=idxToRC(rb.idx);
      var dr=pb.row-pa.row, dc=pb.col-pa.col;
      if((Math.abs(dr)===1&&Math.abs(dc)===1)||(dr===0&&Math.abs(dc)===1)||(dc===0&&Math.abs(dr)===1)){
        var ra2=find(ra.idx), rb2=find(rb.idx);        // 4 邻或对角（角贴）都算拼合
        if(ra2!==rb2) parent[rb2]=ra2;
        vpairs.push({a:ra.idx,b:rb.idx,dr:dr,dc:dc,dx:rb.x-ra.x,dy:rb.y-ra.y});
      } else if(axv>=0.8 && d<=side*1.35){
        defSusp.push([ra.idx,rb.idx]);                 // 疑似拼合但编号对不上
      }
    }
    var byRoot={}, groups=[], grpMap={};
    reads.forEach(function(r){
      var rt=find(r.idx);
      (byRoot[rt]=byRoot[rt]||[]).push(r.idx);
    });
    Object.keys(byRoot).forEach(function(k){
      var m=byRoot[k];
      if(m.length>=2){ m.sort(function(x,y){ return x-y; }); groups.push(m); }
    });
    groups.forEach(function(m,gi){ m.forEach(function(i){ grpMap[i]=gi; }); });
    // 二筛：两块各自都已在多片组里 = 两个拼好簇挨着放而已，不算可疑
    var suspIdx=new Set(), suspPairs=[];
    function grpSizeOf(i){ var gi=grpMap[i]; return gi==null?1:groups[gi].length; }
    defSusp.forEach(function(p){
      var ga=grpSizeOf(p[0])>=2, gb=grpSizeOf(p[1])>=2;
      if(ga&&gb) return;                               // 两簇相邻摆放，不算可疑（不展示）
      if(ga) { suspIdx.add(p[1]); if(suspPairs.length<4) suspPairs.push(p[0]+"+"+p[1]); }
      else if(gb) { suspIdx.add(p[0]); if(suspPairs.length<4) suspPairs.push(p[0]+"+"+p[1]); }
      else { suspIdx.add(p[0]); suspIdx.add(p[1]);
        if(suspPairs.length<4) suspPairs.push(p[0]+"+"+p[1]); }
    });
    // —— 组内两点标定 → 大片范围推算 + OCR 复核 ——
    // 每组用组内拼合对最小二乘解出局部网格基 (Vr,Vc)（两点定标的一般化），
    // 从成员正贴邻格沿前景蔓延推算：该格编号由网格唯一确定，直接入结果（蓝框）；
    // 有读数但离预测位很远 → 误读，标红。
    // 散堆里 bbox±2 的远环与组并无拼合关系（跳格会猜错号），且邻簇的片靠着
    // 堆放时前景无法区分——所以推算必须同时过四道几何关：
    //   ① 贴邻：预测格 4 邻须是同组成员读数或本组已推算格（沿片蔓延，不跳格）
    //   ② 接缝：与锚点连线中点的窗也是实前景（真拼合片边贴边；邻片只留凸头）
    //   ③ 片心：预测位中心窗命中 ≥0.85（凸头/地板缝不够）
    //   ④ 占位：预测位已被其他编号的读数占据 → 那是外簇的片，不推算
    var inferred=0, inferredIdx=new Set(), inferredPos={}, misread=0, weakN=0;
    function whiteHit(x,y,rx){                         // scan 坐标椭圆小窗 maskWhite 命中率
      var hit=0,tot=0;
      for(var dy=-rx;dy<=rx;dy++){
        var py2=Math.round(y+dy); if(py2<0||py2>=scan.H) continue;
        for(var dx=-rx;dx<=rx;dx++){
          var px2=Math.round(x+dx); if(px2<0||px2>=scan.W) continue;
          if((dx*dx)/(rx*rx)+(dy*dy)/(rx*rx)>1) continue;
          tot++; if(scan.maskWhite[py2*scan.W+px2]) hit++;
        }
      }
      return tot>0?hit/tot:0;
    }
    groups.forEach(function(members){
      var gi=grpMap[members[0]];
      var gp=vpairs.filter(function(p){ return grpMap[p.a]===gi; });
      if(!gp.length) return;
      var Sa=0,Sc=0,Sb=0,Bx=0,Cx=0,By=0,Cy=0;
      gp.forEach(function(p){
        Sa+=p.dr*p.dr; Sc+=p.dc*p.dc; Sb+=p.dr*p.dc;
        Bx+=p.dr*p.dx; Cx+=p.dc*p.dx; By+=p.dr*p.dy; Cy+=p.dc*p.dy;
      });
      var sides=members.map(function(i){ return readingSide(scan.ocr.map.get(i))||0; })
        .filter(function(s){ return s>0; }).sort(function(x,y){ return x-y; });
      var side=sides.length?sides[sides.length>>1]:0;
      if(!side) return;
      var det=Sa*Sc-Sb*Sb;
      var Vrx,Vcx,Vry,Vcy, oneAxis=null;
      if(Math.abs(det)>=0.5*(Sa+Sc)){
        Vrx=(Bx*Sc-Sb*Cx)/det; Vcx=(Sa*Cx-Sb*Bx)/det;
        Vry=(By*Sc-Sb*Cy)/det; Vcy=(Sa*Cy-Sb*By)/det;
      } else {
        // 单方向拼合（组只沿一条线拼着）：两点只定得出一根轴，垂直那根轴的方向
        // 本质二义 —— 两侧都可能接着有片，「有片的一侧」既可能是 +col 也可能是
        // -col，选错编号就整体错位（85891 的 237 与 187 在几何上完全等价）。
        // 所以只在「已知轴」上延伸，垂直方向不扩展：宁可少推，绝不推错。
        var knownR=Sa>0;
        var kx=knownR?(Bx/Sa):(Cx/Sc), ky=knownR?(By/Sa):(Cy/Sc);
        if(!(Math.hypot(kx,ky)>0)) return;
        if(knownR){ Vrx=kx; Vry=ky; Vcx=0; Vcy=0; oneAxis="row"; }
        else { Vcx=kx; Vcy=ky; Vrx=0; Vry=0; oneAxis="col"; }
      }
      var maxRes=0;
      gp.forEach(function(p){
        maxRes=Math.max(maxRes, Math.hypot(p.dr*Vrx+p.dc*Vcx-p.dx, p.dr*Vry+p.dc*Vcy-p.dy));
      });
      if(maxRes>side*0.35) return;                       // 残差过大 → 组内疑有误读，不外推
      var seed=scan.ocr.map.get(members[0]);
      var p0=idxToRC(members[0]);
      var rmin=99,rmax=0,cmin=99,cmax=0;
      members.forEach(function(i){
        var rc=idxToRC(i);
        rmin=Math.min(rmin,rc.row); rmax=Math.max(rmax,rc.row);
        cmin=Math.min(cmin,rc.col); cmax=Math.max(cmax,rc.col);
      });
      var r0min=rmin,r0max=rmax,c0min=cmin,c0max=cmax;
      rmin=Math.max(1,rmin-3); rmax=Math.min(S.rows,rmax+3);   // ±3：蔓延能多长两圈，
      cmin=Math.max(1,cmin-3); cmax=Math.min(S.cfg.cols,cmax+3); // 四道关 + 上限兜底防扩散
      if(oneAxis==="row"){ cmin=c0min; cmax=c0max; }           // 垂直轴方向二义 → 不扩展
      else if(oneAxis==="col"){ rmin=r0min; rmax=r0max; }
      var k=scan.W/scan.ocr.w, added=0;
      var rx=side*k*0.28;
      var groupSet={}, chain={};                     // 蔓延锚点：本组成员读数 / 本组已推算格
      members.forEach(function(i){ groupSet[i]=true; });
      for(var pass=0; pass<4; pass++){               // 多轮蔓延：链式锚点逐轮生长
        var fresh=0;
        for(var r=rmin;r<=rmax;r++)for(var c=cmin;c<=cmax;c++){
          var idx=rcToIdx(r,c);                          // r/c 已夹在合法域内
          if(idx<1||idx>S.cfg.total||inferredIdx.has(idx)) continue;
          var px=seed.x+(r-p0.row)*Vrx+(c-p0.col)*Vcx;
          var py=seed.y+(r-p0.row)*Vry+(c-p0.col)*Vcy;
          if(px<side*0.35||py<side*0.35||px>scan.ocr.w-side*0.35||py>scan.ocr.h-side*0.35) continue;
          // ① 贴邻 + ② 接缝：预测格须与本组成员/已推算格正贴，且连线中点也是实前景
          var seam=0;
          var nb=[[r+1,c],[r-1,c],[r,c+1],[r,c-1]];
          for(var n=0;n<4;n++){
            var rr=nb[n][0], cc=nb[n][1];
            if(rr<1||cc<1||rr>S.rows||cc>S.cfg.cols) continue;
            var j=rcToIdx(rr,cc), ax=null, ay=0;
            if(groupSet[j]){ var r2=scan.ocr.map.get(j); if(r2){ ax=r2.x; ay=r2.y; } }
            else if(chain[j]){ ax=chain[j].x; ay=chain[j].y; }
            if(ax==null) continue;
            var v=whiteHit((px+ax)/2*k,(py+ay)/2*k,rx);
            if(v>seam) seam=v;
          }
          if(seam<0.35) continue;                        // 无贴邻或中间是地板/凸头 → 不外推
          // ③ 片心窗要实
          var cellV=whiteHit(px*k,py*k,rx);
          if(cellV<0.85) continue;
          // ④ 占位：预测位被其他编号的读数占据 → 那是外簇/单片的片
          var occ=null;
          scan.ocr.map.forEach(function(r3,i3){
            if(occ!=null) return;
            if(Math.hypot(r3.x-px,r3.y-py)<side*0.55) occ=i3;
          });
          var rd=occ!=null?scan.ocr.map.get(occ):scan.ocr.map.get(idx);
          if(rd){
            // occ 是别的编号 → 预测位被外簇/单片的读数占着（贴着堆放），
            // rd 贴近预测位，自然跳过（不标不推）；occ 为空而同号读数在远处 → 误读
            if(Math.hypot(rd.x-px,rd.y-py)>side*0.55){   // 有读数但不在网格位 → 误读
              suspIdx.add(idx); misread++;
              if(suspPairs.length<4) suspPairs.push(idx+"≠网格位");
            }
          } else {
            set.add(idx); inferredIdx.add(idx); inferred++;
            inferredPos[idx]={x:px,y:py,ang:seed.ang,side:side,grp:gi,weak:false};
            chain[idx]={x:px,y:py};
            fresh++; added++;
            if(added>16){ pass=99; break; }              // 单组外推上限，防映射意外扩散
          }
        }
        if(!fresh) break;
      }
    });
    // —— 整块照片检测：读数与全局网格映射吻合（中位残差 < 0.5 格距）——
    // 整块拼图按网格摆放，自动标定可信；散块照片映射是 garbage（残差 10+ 格距），
    // 物理上不可能误判。整块图不必逐格 OCR：前景在的格子编号由网格唯一确定。
    // 推算用 BFS 从「对齐读数」的格子沿前景蔓延——孤立的散片小群（物理位置与
    // 编号网格无关）与主体之间隔木地板，蔓延不到，不会被错误推算成别的编号。
    var k=scan.W/scan.ocr.w;
    var mp=(Math.abs(scan.pitchX)+Math.abs(scan.pitchY))/2;
    var alignedIdx=new Set();
    var resid=[];
    scan.ocr.map.forEach(function(r,idx){
      if(r.conf<0.5||idx<1||idx>S.cfg.total) return;
      var q=scanCellXY(idxToRC(idx));
      var d=Math.hypot(q.x-r.x*k, q.y-r.y*k);
      resid.push(d);
      if(d<mp*0.55) alignedIdx.add(idx);
    });
    resid.sort(function(a,b){ return a-b; });
    var medD=resid.length?resid[resid.length>>1]:1e9;
    scan.blockMode = resid.length>=3 && medD < mp*0.5;
    scan.alignedIdx=alignedIdx;
    if(scan.blockMode){
      // 整块统一文字方向：ang 周期 π，用 2θ 向量均值避免平均抵消
      var sx=0, sy=0, na=0;
      scan.ocr.map.forEach(function(r){
        if(r.conf>=0.5 && isFinite(r.ang)){ sx+=Math.cos(2*r.ang); sy+=Math.sin(2*r.ang); na++; }
      });
      var blkAng = na ? 0.5*Math.atan2(sy,sx) : 0;
      scan.blockAng=blkAng;
      var bw=Math.abs(scan.pitchX), bh=Math.abs(scan.pitchY);
      var rx=bw*0.26, ry=bh*0.26;
      function fgAt(idx){
        var p=idxToRC(idx), q=scanCellXY(p);
        if(q.x<rx||q.y<ry||q.x>scan.W-rx||q.y>scan.H-ry) return false;
        return isPieceAt(q.x,q.y,rx,ry,true);
      }
      function pushInfer(idx){
        if(inferredIdx.has(idx)) return;
        var p=idxToRC(idx), q=scanCellXY(p);
        set.add(idx);                                  // 推算块入结果
        inferredIdx.add(idx); inferred++;
        inferredPos[idx]={ x:q.x/k, y:q.y/k, ang:blkAng, side:Math.min(bw,bh)/k };
      }
      var visited=new Set(alignedIdx);
      var queue=Array.from(alignedIdx);
      for(var front=0; front<queue.length; front++){
        var p0=idxToRC(queue[front]);
        var nei=[[p0.row+1,p0.col],[p0.row-1,p0.col],[p0.row,p0.col+1],[p0.row,p0.col-1]];
        for(var ni=0;ni<4;ni++){
          var rr=nei[ni][0], cc=nei[ni][1];
          if(rr<1||cc<1||rr>S.rows||cc>S.cfg.cols) continue;
          var j=rcToIdx(rr,cc);
          if(j<1||j>S.cfg.total||visited.has(j)) continue;
          visited.add(j);
          if(!fgAt(j)) continue;                       // 前景不在：不蔓延（隔离散片群止步于此）
          var rd=scan.ocr.map.get(j);
          if(rd && alignedIdx.has(j)){ queue.push(j); } // 对齐读数格：继续蔓延
          else if(rd){                                  // 非对齐读数占了此号：矛盾，蓝框+核对
            pushInfer(j); queue.push(j);
            if(!grpMap[rd.idx] && !suspIdx.has(rd.idx)){ // 组内读数豁免（整群位置偏移，自洽）
              suspIdx.add(rd.idx); misread++;
              if(suspPairs.length<4) suspPairs.push(rd.idx+"≠网格位");
            }
          }
          else { pushInfer(j); queue.push(j); }         // 前景在、无读数 → 推算
        }
      }
      // —— 簇级 OCR 支持检查 ——
      // 光斑/杂色前景可能骗过逐格判定（灰尘暗点、渐变白），但真片区域至少会有
      // 一个 OCR 检出（哪怕因 conf/字数不足被丢弃）。按 4 邻把推算格分簇：
      // 簇内「1.0 格距内有任何置信度读数」的格子占比 ≥25% 才保留，否则整簇剔除。
      var infArr=Array.from(inferredIdx);
      var infSet=new Set(infArr);
      var seen2=new Set();
      var arr=scan.ocr.results||[];
      infArr.forEach(function(seed){
        if(seen2.has(seed)) return;
        var cluster=[], stk=[seed]; seen2.add(seed);
        while(stk.length){
          var ci=stk.pop(); cluster.push(ci);
          var pc=idxToRC(ci);
          var nei2=[[pc.row+1,pc.col],[pc.row-1,pc.col],[pc.row,pc.col+1],[pc.row,pc.col-1]];
          for(var q4=0;q4<4;q4++){
            if(nei2[q4][0]<1||nei2[q4][1]<1||nei2[q4][0]>S.rows||nei2[q4][1]>S.cfg.cols) continue;
            var nj=rcToIdx(nei2[q4][0],nei2[q4][1]);
            if(infSet.has(nj)&&!seen2.has(nj)){ seen2.add(nj); stk.push(nj); }
          }
        }
        var supN=0;
        for(var z2=0;z2<cluster.length;z2++){
          var pc2=idxToRC(cluster[z2]), q2=scanCellXY(pc2);
          // 紧贴「已对齐读数格」的推算格 = 与已确认主体直接相邻，必是真片：
          // 光斑是隔着地板的大孤立区，不会整簇贴在主体边上（大簇靠 25% 占比照样剔除）
          var nb4=[[pc2.row+1,pc2.col],[pc2.row-1,pc2.col],[pc2.row,pc2.col+1],[pc2.row,pc2.col-1]];
          var nearAligned=false;
          for(var n4=0;n4<4;n4++){
            if(nb4[n4][0]<1||nb4[n4][1]<1||nb4[n4][0]>S.rows||nb4[n4][1]>S.cfg.cols) continue;
            if(alignedIdx.has(rcToIdx(nb4[n4][0],nb4[n4][1]))){ nearAligned=true; break; }
          }
          if(nearAligned){ supN++; continue; }
          for(var w2=0;w2<arr.length;w2++){
            if(Math.hypot(arr[w2].x*k-q2.x, arr[w2].y*k-q2.y)<mp){ supN++; break; }
          }
        }
        if(supN*4<cluster.length) cluster.forEach(function(ci){
          set.delete(ci); inferredIdx.delete(ci); delete inferredPos[ci]; inferred--;
        });
      });
    }
    scan.reads=reads; scan.groups=groups; scan.grpMap=grpMap;
    scan.suspIdx=suspIdx.size?suspIdx:null;
    scan.suspPairs=suspPairs;
    scan.inferred=inferred; scan.inferredIdx=inferredIdx; scan.inferredPos=inferredPos;
    scan.inferredWeak=weakN;
  } else {
    scan.reads=null; scan.groups=null; scan.grpMap=null;
    scan.suspIdx=null; scan.suspPairs=null;
    scan.inferred=0; scan.inferredIdx=null; scan.inferredPos=null; scan.inferredWeak=0;
    scan.blockMode=false; scan.alignedIdx=null; scan.blockAng=0;
    var rx=Math.abs(scan.pitchX)*0.26, ry=Math.abs(scan.pitchY)*0.26;
    for(var i=1;i<=S.cfg.total;i++){
      var p=idxToRC(i);
      var q=scanCellXY(p);
      var x=q.x, y=q.y;
      if(x<rx||y<ry||x>scan.W-rx||y>scan.H-ry) continue;
      checked++;
      if(isPieceAt(x,y,rx,ry,true)){
        set.add(i);
        if(S.states[i]!==1) newly++;
      }
    }
  }
  scan.result=set; scan.cellsChecked=checked;
  $("scanCells").textContent=checked;
  updateScanStats();
  if(scan.calibrated) $("scanTip").textContent=scanTipText()
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

// 标定求解。两锚点只有一组位移，但拼放方向可能相对编号框架旋转了 90°，
// 对角标定因此有两种解释：普通（列→x、行→y）与旋转（行→x、列→y）。
// 拼图块近似正方形，正确解释下横竖格距应接近——取明显更接近正方形的一种；
// 分不出时按普通处理，用户可点微调条「⟳ 转向」手动切换。
function solveScan(forceRot){
  if(scan.anchors.length<2){ return false; }
  var a=scan.anchors[0], b=scan.anchors[1];
  var pa=idxToRC(a.idx), pb=idxToRC(b.idx);
  var dc=pb.col-pa.col, dr=pb.row-pa.row;
  if(dc===0||dr===0){ toast("两块必须在不同行且不同列，请重新标定"); return false; }
  function skew(px,py){
    var m=Math.abs(px), n=Math.abs(py);
    if(m<8||n<8) return 1e9;
    return Math.abs(Math.log(m/n));
  }
  var s0=skew((b.x-a.x)/dc,(b.y-a.y)/dr);   // 普通朝向
  var s1=skew((b.x-a.x)/dr,(b.y-a.y)/dc);   // 旋转 90°
  var rot=(forceRot===undefined)?(s1<s0*0.6):forceRot;
  var pitchX=rot?(b.x-a.x)/dr:(b.x-a.x)/dc;
  var pitchY=rot?(b.y-a.y)/dc:(b.y-a.y)/dr;
  if(Math.abs(pitchX)<6||Math.abs(pitchY)<6){ toast("标定距离太近，请选相距更远的两块"); return false; }
  scan.rot=rot;
  scan.ax=a.x; scan.ay=a.y; scan.ac=pa.col; scan.ar=pa.row;
  scan.pitchX=pitchX; scan.pitchY=pitchY;
  scan.calibrated=true;
  $("scanNudge").style.display="flex";
  recalcScan();
  return true;
}
function computeScan(){
  scan.calibrated=false; scan.result=null;
  solveScan();
}
function scanTipText(){
  return "识别 "+(scan.result?scan.result.size:0)+" 块"
    +(scan.ocr&&scan.ocr.map.size>=2?" · 编号读取模式":"")
    +(scan.blockMode?" · 整块拼图":"")
    +(scan.groups&&scan.groups.length?" · 拼好组 "+scan.groups.length:"")
    +(scan.inferred?" · 拼好推算 "+scan.inferred:"")
    +(scan.inferredWeak?(" · 待核 "+scan.inferredWeak):"")
    +(scan.suspIdx?(" · ⚠可疑 "+scan.suspIdx.size):"");
}
function scanCalTip(){
  $("scanTip").textContent="格距 "+Math.abs(scan.pitchX).toFixed(1)+"×"+Math.abs(scan.pitchY).toFixed(1)
    +(scan.rot?" · 横向拼放":"")
    +" · "+scanTipText()
    +" · 可微调 / 增删";
}

function resetScan(keepImg,keepOcr){
  scan.anchors=[]; scan.result=null; scan.cellsChecked=0; scan.picking=null;
  scan.calibrated=false;
  scan.rot=false;
  // keepOcr：重新标定沿用已读的编号（光斑过滤的簇级 OCR 支持检查、拼好组、推算
  // 全都依赖 OCR 证据；清掉就等于退回纯前景扫描，光斑区会被误判成片）
  if(!keepOcr){ scan.ocr=null; scan.ocrAuto=false; }
  scan.blockMode=false;
  scan.alignedIdx=null; scan.blockAng=0;
  scan.reads=null; scan.groups=null; scan.grpMap=null;
  scan.suspIdx=null; scan.suspPairs=null;
  scan.inferred=0; scan.inferredIdx=null; scan.inferredPos=null; scan.inferredWeak=0;
  scan.zoom=1; scan.ox=0; scan.oy=0;
  setScanMode("move");
  $("scanPick").classList.remove("on");
  $("scanNudge").style.display="none";
  $("scanFound").textContent="0"; $("scanCells").textContent="0"; $("scanNew").textContent="0";
  $("scanPend").textContent="0";
  $("bApplyScan").disabled=true;
  $("bApplyGuide").disabled=true;
  $("bApplyGuide").style.display="none";
  $("bApplyScan").style.display="block";
  $("scanTip").style.display=scan.img?"block":"none";
  $("scanTip").textContent="点第 1 块拼图的中心（并输入编号）";
  if(!keepImg){ scan.img=null; scan.mask=null; scan.base=null; scanCtx=null; $("scanTip").style.display="none"; }
  drawScan();
}

/* ---- 使用说明：默认收起（桌面/移动端都不占地方），点顶栏「?」展开 ---- */
var scanHelpOpen=false;
function applyScanHelp(){
  $("scanHelp").classList.toggle("off",!scanHelpOpen);
  $("bScanHelp").classList.toggle("on",scanHelpOpen);
}
function scanHelpSync(){ scanHelpOpen=false; applyScanHelp(); }
$("bScanHelp").addEventListener("click",function(){
  scanHelpOpen=!scanHelpOpen; applyScanHelp();
});
document.addEventListener("fullscreenchange",scanHelpSync);
document.addEventListener("webkitfullscreenchange",scanHelpSync);
scanHelpSync();
osvcProbe();                    // 模块加载即探测一次（照片加载早于打开扫描页时也有状态）

$("bScan").addEventListener("click",function(){
  hideLocCard();
  $("ovScan").classList.add("on");
  scanHelpSync();               // 每次打开都回到「说明默认收起」
  osvcProbe();                  // 探测 PP-OCR 服务状态
  if(!scan.img){ resetScan(false); }
  else { drawScan(); }
  setTimeout(drawScan,60);
});
$("scanClose").addEventListener("click",function(){ $("ovScan").classList.remove("on"); });
$("osvcBadge").addEventListener("click",function(){
  osvcProbe();
  toast(OSVC.ok?"OCR：PP-OCR 高精度（服务已连接）":"正在检测 PP-OCR 服务（127.0.0.1:8849）…");
});
$("bPickImg").addEventListener("click",function(){ $("fImg").click(); });
$("fImg").addEventListener("change",function(e){
  var f=e.target.files&&e.target.files[0]; if(!f) return;
  var url=URL.createObjectURL(f);
  var img=new Image();
  img.onload=function(){
    scan.img=img; scan.base=null; scan.mask=null; scan.W=0; scan.H=0; scan.ocr=null;
    resetScan(true);
    $("scanTip").textContent="正在分析照片…";
    setTimeout(function(){
      analyzeImage(img,function(){
        $("scanTip").textContent="正在读取片上编号…";
        drawScan();
        // 自动 OCR：编号识别 → 散块模式 + 自动标定（失败回退手点）
        // PP-OCR 服务在线时优先用它（召回远高于内置模板），失败/空结果回退模板
        setTimeout(function(){
          function done(res){
            try{
              var ok=res.filter(function(r){ return r.conf>=0.5 && r.n>=4 && r.idx>=1 && r.idx<=S.cfg.total; });
              scan.ocr={ results:res, map:new Map(), w:Math.round(img.width*Math.min(1,3072/Math.max(img.width,img.height))),
                         h:Math.round(img.height*Math.min(1,3072/Math.max(img.width,img.height))) };
              ok.forEach(function(r){ if(!scan.ocr.map.has(r.idx)) scan.ocr.map.set(r.idx,r); });
              if(ok.length>=2 && autoCalibrate(ok)) {
                toast("已自动识别 "+ok.length+" 个编号"+(ok.some(function(r){return r.svc;})?"（PP-OCR）":""));
              } else {
                scan.ocrAuto=false;
                $("scanTip").textContent=ok.length
                  ? "读到 "+ok.length+" 个编号但不足以自动标定，请手动点两块拼图中心"
                  : "未读到编号，请点两块拼图的中心（并输入编号）";
              }
              drawScan();
            }catch(err){
              $("scanTip").textContent="自动识别失败，请点两块拼图的中心（并输入编号）";
            }
          }
          function tmpl(){
            try{ return detectNumbers(img)||[]; }catch(err){ return []; }
          }
          if(OSVC.ok){
            $("scanTip").textContent="PP-OCR 高精度识别中…（2×2 分片）";
            svcReadings(img).then(function(res){
              if(res.length) done(res);
              else { toast("PP-OCR 未读到编号，改用内置模板"); done(tmpl()); }
            }).catch(function(err){
              OSVC.ok=false; osvcBadge();
              toast("PP-OCR 服务调用失败，回退内置模板");
              done(tmpl());
            });
          } else done(tmpl());
        },40);
      });
    },40);
    URL.revokeObjectURL(url);
  };
  img.onerror=function(){ toast("图片加载失败"); };
  img.src=url;
  e.target.value="";
});

/* 自动标定：= 手动两点标定的自动版。
   候选取 conf 前 12 个读数两两组合（两种朝向都试），用该对解出的网格去解释
   **全量读数**，取「中位残差最小」的一对——等价于人眼挑两块最可信、最分开的片
   并把整张图对齐。比"挑距离最远"稳得多（远对可能几乎同列 → 格距退化），
   且与照片无关，可直接沿用到别的图。中位数抗少量误读离群。 */
function autoCalibrate(okList){
  var cands=okList.slice().sort(function(a,b){ return b.conf-a.conf; }).slice(0,12);
  var k=scan.W/scan.ocr.w;              // OCR 工作坐标 → scan 工作坐标
  var best=null;
  for(var i=0;i<cands.length;i++){
    for(var j=i+1;j<cands.length;j++){
      var a=cands[i], b=cands[j];
      if(a.idx===b.idx) continue;
      var pa=idxToRC(a.idx), pb=idxToRC(b.idx);
      var dc=pb.col-pa.col, dr=pb.row-pa.row;
      if(dc===0||dr===0) continue;               // 必须不同行且不同列，否则解不出两轴
      for(var r2=0;r2<2;r2++){
        var rot=!!r2;
        var pitchX=rot?(b.x-a.x)/dr:(b.x-a.x)/dc;
        var pitchY=rot?(b.y-a.y)/dc:(b.y-a.y)/dr;
        if(Math.abs(pitchX)<6||Math.abs(pitchY)<6) continue;
        var ax=a.x*k, ay=a.y*k, px=pitchX*k, py=pitchY*k;
        var res=[];
        for(var m=0;m<okList.length;m++){
          var rd=okList[m], p=idxToRC(rd.idx);
          var cx=rot?ax+(p.row-pa.row)*px:ax+(p.col-pa.col)*px;
          var cy=rot?ay+(p.col-pa.col)*py:ay+(p.row-pa.row)*py;
          res.push(Math.hypot(cx-rd.x*k, cy-rd.y*k));
        }
        res.sort(function(x,y){ return x-y; });
        var med=res.length?res[res.length>>1]:1e9;
        if(!best||med<best.med) best={ a:a, b:b, rot:rot, med:med };
      }
    }
  }
  if(!best) return false;
  scan.anchors=[
    { x:best.a.x*k, y:best.a.y*k, idx:best.a.idx },
    { x:best.b.x*k, y:best.b.y*k, idx:best.b.idx }
  ];
  scan.ocrAuto=true;
  scan.calibrated=false; scan.result=null;
  solveScan(best.rot);                          // 朝向按全局一致性选出，不再靠方形度猜
  if(!scan.calibrated){ scan.anchors=[]; scan.ocrAuto=false; return false; }
  scanCalTip();
  $("scanStep").innerHTML="已自动识别并标定（读取到 <b>"+okList.length+"</b> 个编号）<br>"
    +"<b>绿框</b>＝识别为已拼（随文字方向摆放） · 同色框＝<b>拼好组</b> · <b>蓝框</b>＝组内推算 · <b>红框</b>＝疑似拼错/误读<br>"
    +"顶部工具条：<b>移动照片</b>查看细节 · <b>微调网格</b>整体挪动 · <b>增删结果</b>逐格修正<br>"
    +"<b>增删结果</b>模式下点<b>没有框的片</b>可以输入编号把它补进结果（OCR 漏读的边角块），补完自动重新分组并推算邻居<br>"
    +"<span class=\"sn\">「重新标定」= 自动重标（Shift/Alt + 点 = 手动点两块）；网格在全部编号读数里自动找最自洽的一对片对齐，换照片同样适用。相邻且编号方向一致的块自动归为拼好组；组内编号在网格上对不上时会标红提示。识别有误的编号可以直接在照片上核对；应用后可点「应用并引导摆放」逐块引导。</span>";
  return true;
}

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
// 图像坐标 → 最近的格子编号。
// 编号读取模式下先命中最近的读数框/推算框（散块照片网格映射与实际摆放无关，
// 按格子命中会点空），空白处仅整块模式（网格对齐）才按格子增删。
function scanHitIdx(x,y){
  if(!scan.calibrated) return null;
  var ocrMode=scan.ocr && scan.ocr.map.size>=2;
  if(ocrMode){
    var k=scan.W/scan.ocr.w, best=null, bd=1e9;
    (scan.reads||[]).forEach(function(r){
      var d=Math.hypot(r.x*k-x, r.y*k-y);
      var lim=readingSide(r)*k*0.75;
      if(d<lim && d<bd){ bd=d; best=r.idx; }
    });
    if(scan.inferredPos) Object.keys(scan.inferredPos).forEach(function(key){
      var ip=scan.inferredPos[key];
      var d=Math.hypot(ip.x*k-x, ip.y*k-y);
      if(d<ip.side*k*0.75 && d<bd){ bd=d; best=+key; }
    });
    if(best!=null) return best;
    if(!scan.blockMode) return null;               // 散块：空白处不增格
  }
  var c=scanXYCell(x,y), col=c.col, row=c.row;
  if(row<1||col<1||row>S.rows||col>S.cfg.cols) return null;
  var i=rcToIdx(row,col);
  return (i>=1&&i<=S.cfg.total)?i:null;
}
function scanToggleCell(i,del){
  if(!scan.result||i==null) return;
  if(del) scan.result.delete(i); else scan.result.add(i);
  updateScanStats(); drawScan();
}
/* 手动补一块：OCR 漏读的片（尤其拼在簇边、垂直方向又解不出轴向的那块），
   由人点位置 + 输编号补成「伪读数」，之后并查集/局部网格会自动把它并进簇，
   组内双轴由此可解，周围漏读片跟着一起推出来。 */
function addManualReading(idx,sx,sy){
  if(!scan.ocr||!scan.ocr.map) { toast("先载入照片完成识别"); return false; }
  if(scan.ocr.map.has(idx)){ toast("第 "+idx+" 块已经读到了"); return false; }
  var k=scan.W/scan.ocr.w, ox=sx/k, oy=sy/k;
  var near=null, bd=1e9;
  scan.ocr.map.forEach(function(r){ var d=Math.hypot(r.x-ox,r.y-oy); if(d<bd){ bd=d; near=r; } });
  var ang=near?(near.ang||0):0;
  var side=near?readingSide(near):0;
  if(!side) side=Math.min(scan.ocr.w,scan.ocr.h)/18;   // 无参照读数时按照片短边粗估片宽
  var tl=side*0.27, comps=[];
  for(var t=-1;t<=1;t+=2){
    comps.push({ x0:ox+Math.cos(ang)*tl*0.5*t-1, y0:oy+Math.sin(ang)*tl*0.5*t-1, w:2, h:2 });
  }
  scan.ocr.map.set(idx, { idx:idx, x:ox, y:oy, ang:ang, conf:1, svc:false, manual:true,
    comps:comps, letter:zoneLetter(zoneOf(idx)), digits:fmt(idx) });
  recalcScan();
  toast("已补第 "+idx+" 块，重新分组完成");
  return true;
}
function updateScanStats(){
  var set=scan.result||new Set(), newly=0;
  set.forEach(function(i){ if(S.states[i]!==1) newly++; });
  scan.newCount=newly;
  scan.pendingSet=previewPendingSet();
  $("scanFound").textContent=set.size;
  $("scanNew").textContent=newly;
  $("scanPend").textContent=scan.pendingSet.size;
  // 拼好组 / 可疑对明细（散块模式）
  var nG=scan.groups?scan.groups.length:0;
  $("scanGrpRow").style.display=nG?"flex":"none";
  $("scanGrp").textContent=nG;
  var nS=scan.suspIdx?scan.suspIdx.size:0;
  $("scanSuspRow").style.display=nS?"flex":"none";
  $("scanSusp").textContent=nS;
  var det=$("scanGrpDetail");
  var parts=[];
  if(nG) scan.groups.forEach(function(m,gi){
    parts.push("<span style=\"color:"+(GRP_TXT[gi%GRP_TXT.length])+"\">组"+(gi+1)+": "+m.join(",")+"</span>");
  });
  if(nS){
    var sp=scan.suspPairs||[];
    parts.push("<span style=\"color:#ff8080\">⚠可疑对: "+(sp.length?sp.join("、")+"…":"见红框")+"</span>");
  }
  det.style.display=parts.length?"block":"none";
  det.innerHTML=parts.join("<br>");
  $("bApplyScan").disabled = set.size===0;
  // 引导按钮：散块模式（编号读取）下才出现
  var guideMode = set.size>0 && scan.ocr && scan.ocr.map.size>=2;
  $("bApplyGuide").style.display = guideMode ? "block" : "none";
  $("bApplyGuide").disabled = set.size===0;
  if(guideMode) $("bApplyScan").style.display="none";
  else $("bApplyScan").style.display="block";
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

function openPick(p,clientX,clientY,add){
  scan.picking={x:p.x,y:p.y,add:!!add};
  var pr=$("scanPick");
  pr.classList.add("on");
  var h4=pr.querySelector("h4");
  if(h4) h4.textContent = add ? "这块拼图上印的数字（补进结果）" : "这一块上印的数字";
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
    else if(scan.ocr && scan.ocr.map.size>=2) scanDrag.addPt=p;   // 点空白片 → 补一块
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
  } else if(d.addPt && scan.mode==="edit"){
    openPick(d.addPt,e.clientX,e.clientY,true);        // 增删模式下点空白片 → 补编号
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
  if(n==="rot"){
    // 切换拼放方向解释：按锚点重新求解（网格参数重算，微调失效）
    if(solveScan(!scan.rot)) scanCalTip();
    drawScan();
    return;
  }
  recalcScan(); drawScan();
});

$("pickCancel").addEventListener("click",function(){
  scan.picking=null; $("scanPick").classList.remove("on");
});
$("pickOk").addEventListener("click",function(){
  if(!scan.picking) return;
  var idx=updatePickRes();
  if(!idx){ toast("请输入拼图块上印的数字（1 ~ "+S.cfg.total+"）"); return; }
  if(scan.picking.add){                            // 「补一块」：伪读数 + 立即重算
    var pt={x:scan.picking.x,y:scan.picking.y};
    scan.picking=null; $("scanPick").classList.remove("on");
    if(addManualReading(idx,pt.x,pt.y)){ drawScan(); if(scan.calibrated) scanCalTip(); }
    return;
  }
  scan.anchors.push({x:scan.picking.x,y:scan.picking.y,idx:idx});
  scan.picking=null; $("scanPick").classList.remove("on");
  if(scan.anchors.length===1){
    $("scanTip").textContent="再点第 2 块拼图（对角线方向，越远越准）";
    drawScan();
  } else {
    computeScan();
    drawScan();
    if(scan.calibrated){
      scanCalTip();
      $("scanStep").innerHTML="已标定 <b>"+fmt(scan.anchors[0].idx)+"</b> 与 <b>"+fmt(scan.anchors[1].idx)+"</b><br>"
        +"<b>绿框</b>＝识别为已拼 · 灰框＝空位<br>"
        +"顶部工具条：<b>移动照片</b>拖动/缩放看细节 · <b>微调网格</b>整体挪动 · <b>增删结果</b>逐格修正<br>"
        +(scan.rot?"照片拼放方向与编号相差 90°，已自动适配；网格不对点「⟳ 转向」<br>":"")
        +"<span class=\"sn\">只把识别到的块标为已拼，不会动其它块。</span>";
    }
  }
});
$("bRescan").addEventListener("click",function(e){
  resetScan(true,true);                 // 保留 OCR：编号证据（光斑过滤/拼好组/推算）不丢
  if(e.shiftKey||e.altKey){             // 手动兜底：Shift/Alt + 点 = 自己点两块
    $("scanStep").innerHTML="手动标定：请点两块拼图的中心（并输入编号）";
    return;
  }
  var okList=[];
  if(scan.ocr) scan.ocr.map.forEach(function(r){ okList.push(r); });
  if(okList.length>=2 && autoCalibrate(okList)){
    toast("已自动重新标定（"+okList.length+" 个编号）");
    drawScan();
  } else {
    $("scanStep").innerHTML="自动标定失败，请手动点两块拼图的中心（并输入编号）";
  }
});

/* 应用识别结果的核心（bApplyScan / bApplyGuide 共用）。返回 {targets, applied, demoted} */
function applyScanCore(){
  if(!scan.result||!scan.result.size){ toast("还没有识别结果"); return null; }
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
  var targets=Array.from(orig.keys());
  if(!targets.length) targets=Array.from(scan.result);
  var needSwitch=(S.viewZone!=="all" &&
    targets.some(function(i){ return String(zoneOf(i))!==S.viewZone; }));
  if(needSwitch){
    setView("all");   // 目标在其它大区：回全局视图再定位（同找点）
    setTimeout(function(){ centerOnSet(targets,true); flashRegion(targets); },60);
  } else {
    centerOnSet(targets,true);
    flashRegion(targets);
  }
  var msg="已应用 · "+applied+" 块";
  if(demoted) msg+="，其中 "+demoted+" 块待定";
  toast(msg);
  vibrate(30);
  return { targets:targets, applied:applied, demoted:demoted };
}

$("bApplyScan").addEventListener("click",function(){
  applyScanCore();
});

$("bApplyGuide").addEventListener("click",function(){
  var r=applyScanCore();
  if(r && r.targets.length){
    if(S.batchMode) exitBatch();     // 引导与批量互斥
    startGuide(r.targets);
  }
});
/* Esc 关闭放大选点面板（main.js 键盘处理用） */
export function cancelPick(){
  scan.picking=null; $("scanPick").classList.remove("on");
}
