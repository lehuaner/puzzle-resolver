import { S } from "./store.js";
import { $, toast, vibrate } from "./dom.js";
import { fmt, idxToRC, rcToIdx, zoneOf, zoneLetter, numInZone, zoneRangeOf } from "./coords.js";
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
window.__focus=function(x,y,z){ return scanFocusOn(x,y,z); };          // 同上：居中放大
window.__gaps=function(){ return fillGaps(); };                        // 同上：补漏扫描
window.__drop=dropReading;                                             // 同上：删除/恢复编号
window.__recalc=function(){ return recalcScan(); };
window.__autoBusy=function(){ return autoBusy; };                    // 同上：强制重算
window.__extend=function(cb){ return extendInfer(cb); };             // 同上：延伸一圈
window.__restore=function(i,n){ return restoreReading(i, n==null?i:n, null); }; // 同上：补回删掉的块
window.__extLv=function(){ return extLv; };
window.__autoVerify=function(tag,cb,opt){ return autoVerify(tag,cb,opt); };   // 同上：自动收尾链
window.__rc=idxToRC;                                                  // 同上：编号→行列
window.__cell=scanCellBase;                                           // 同上：行列→照片坐标
window.__guide=function(ids){ return startGuide(ids); };              // 同上：直接起引导（测排队）
var GRP_TXT=["#6ec8ff","#ffb050","#d878ff","#78ffd0","#ff78b8","#d0ff5a","#8ca0ff","#ffdc5a"]; // 拼好组文字色
var scanCanvas=$("scanCanvas"), scanCtx=null;

/* ---- PP-OCR 高精度服务（可选，与标注台同一服务，本机 8849）----
 * 页面走**自己的源** /ocrsvc/*（8848 服务端代理到本机 8849），不写死 127.0.0.1：
 * 换了设备（局域网 IP / 手机）访问时 127.0.0.1 指的是那台设备自己，必然「未连接」。
 * localStorage.scanOsvcHost 可强制指定别的地址（例如把 OCR 跑在另一台机器上）。 */
function osvcDefaultHost(){
  try{
    var o=localStorage.getItem("scanOsvcHost");
    if(o) return String(o).replace(/\/+$/,"");
  }catch(err){}
  if(location.protocol==="http:"||location.protocol==="https:") return location.origin+"/ocrsvc";
  return "http://127.0.0.1:8849";      // 直接双击 index.html（file://）时才直连本机
}
var OSVC={ host:osvcDefaultHost(), ok:false, checking:false, starting:false, tries:0 };
function osvcBadge(){
  var d=$("osvcDot"), st=$("osvcState"), box=$("osvcBadge");
  if(!d) return;
  d.style.background=OSVC.ok?"#3ddc84":(OSVC.starting?"#f0b13c":"#3a4656");
  st.textContent=OSVC.ok?"已连接":(OSVC.starting?"启动中…":"未连接");
  st.style.color=OSVC.ok?"var(--ok, #3ddc84)":(OSVC.starting?"#f0b13c":"");
  if(box) box.title="PP-OCR 高精度识别服务 · 当前走 "+OSVC.host+
    "（8848 服务端同源代理，局域网设备同样可用）。服务由 start-lan-server.bat 自动拉起；"+
    "点此重新检测。未连接时自动回退内置模板 OCR。";
}
function osvcProbe(manual){
  if(OSVC.checking) return;
  OSVC.checking=true;
  if(manual) OSVC.tries=0;
  var ctl=new AbortController(), t=setTimeout(function(){ ctl.abort(); },2500);
  fetch(OSVC.host+"/health",{signal:ctl.signal,cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(j){ OSVC.ok=!!(j&&j.ok); OSVC.starting=!!(j&&j.starting); })
    .catch(function(){ OSVC.ok=false; OSVC.starting=false; })
    .then(function(){
      OSVC.checking=false; clearTimeout(t); osvcBadge();
      // 服务是随 8848 一起拉起的，首轮 OCR 要加载模型（十几秒）：
      // 没就绪就退避重试，别让徽标一直停在「未连接」等用户手点
      if(!OSVC.ok && OSVC.tries<20){
        OSVC.tries++;
        setTimeout(function(){ osvcProbe(); }, OSVC.tries<8?1200:2500);
      }
    });
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

/* 纯灰度阈值前景覆盖率（只看 Otsu 阈值，不要求「小窗亮度均匀」）。
   maskWhite 多加了「(max-min)/max < 0.10」这一条用来滤光斑渐变，代价是**把侧光/
   阴影里的真片一起滤掉**——85890 实测：阴影里的片 maskWhite≈0.0，而 mask≈0.90，
   木地板两个都是 0.00。所以「延伸」用它当片心判据（够不到远处光斑，见下）。 */
function maskCov(x,y,rx,ry){
  var hit=0,tot=0;
  for(var dy=-ry;dy<=ry;dy+=2){
    var py=Math.round(y+dy);
    if(py<0||py>=scan.H) continue;
    for(var dx=-rx;dx<=rx;dx+=2){
      var px=Math.round(x+dx);
      if(px<0||px>=scan.W) continue;
      if((dx*dx)/(rx*rx)+(dy*dy)/(ry*ry)>1) continue;
      tot++; if(scan.mask[py*scan.W+px]) hit++;
    }
  }
  return tot?hit/tot:0;
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
/* 把照片上某个点（scan 坐标）摆到画面正中并放大——审核列表点条目时用 */
function scanFocusOn(x,y,nz){
  var stage=$("scanStage"); if(!stage) return;
  var fit=scan.fit||scanFitScale();
  scan.zoom=Math.max(0.3,Math.min(14,nz||3.2));
  var cw=scan.W*fit*scan.zoom, ch=scan.H*fit*scan.zoom;
  var bx=(stage.clientWidth-cw)/2, by=(stage.clientHeight-ch)/2;
  scan.ox=stage.clientWidth/2 - x*fit*scan.zoom - bx;
  scan.oy=stage.clientHeight/2 - y*fit*scan.zoom - by;
  layoutScanView();
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
/* 标定求解出来的原始网格位（不含「微调网格」的人工平移）。
   识别判据（对齐/残差/可疑）一律按它算：微调网格只是把格子挪到看着更顺的位置，
   不该反过来让识别结论变化（否则拖一下就掉一片、可疑全跑出来）。 */
function scanCellBase(p){
  var ax=(scan.baseAx!=null?scan.baseAx:scan.ax), ay=(scan.baseAy!=null?scan.baseAy:scan.ay);
  if(scan.rot) return { x:ax+(p.row-scan.ar)*scan.pitchX, y:ay+(p.col-scan.ac)*scan.pitchY };
  return { x:ax+(p.col-scan.ac)*scan.pitchX, y:ay+(p.row-scan.ar)*scan.pitchY };
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
  // 编号读取模式默认不画灰格底框：散块照片上网格映射是 garbage（画了干扰拼好组），
  // 整块照片上格子被结果框/推算框铺满，灰格只是噪点。手动标定（非 OCR）才画。
  // 例外：「微调网格」模式一定画——调格子的时候得看得见格子，否则拖了没反应。
  var showGrid = !ocrMode || scan.mode==="grid";
  var GRP_COLORS=["rgba(80,200,255,.30)","rgba(255,170,80,.30)","rgba(200,120,255,.30)",
                  "rgba(120,255,200,.30)","rgba(255,120,180,.30)","rgba(200,255,90,.30)",
                  "rgba(140,160,255,.30)","rgba(255,220,90,.30)"];
  // 同组统一框尺寸与角度。角度用 **4θ 圆均值（周期 90°）**：
  // PP-OCR det 的框角带 90° 歧义，同一组里 725:38.5° 与 748:-48.8° 其实是**同一根轴**
  // （-48.8+90=41.2）。用 2θ 平均会把两个垂直族平成一团（≈-3°），整组框歪 40°+ ——
  // 这正是"好几个组方向都不对"的根因。方框对 90° 旋转免疫，所以只取模 90° 的主方向。
  var gs={};
  if(ocrMode && scan.groups) scan.groups.forEach(function(m,gi){
    var ss=[], ax=0, ay=0, na=0;
    m.forEach(function(i){
      var r=scan.ocr.map.get(i); if(!r) return;
      var sd=readingSide(r); if(sd>0) ss.push(sd);
      if(isFinite(r.ang)){ ax+=Math.cos(4*r.ang); ay+=Math.sin(4*r.ang); na++; }
    });
    ss.sort(function(a,b){ return a-b; });
    gs[gi]={ side: ss.length ? ss[ss.length>>1]*0.88 : 0,
             ang: na ? 0.25*Math.atan2(ay,ax) : null };
  });

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
      var giG = scan.grpMap ? scan.grpMap[rd.idx] : null;
      if(blk && scan.alignedIdx && scan.alignedIdx.has(rd.idx)){
        var gp=scanCellXY(idxToRC(rd.idx));
        x=gp.x; y=gp.y; ang=scan.blockAng||0; rect=true;   // 网格位 + 统一尺寸
      } else if(giG!=null && gs[giG]){
        if(gs[giG].side>0) side=gs[giG].side*k2;           // 组内统一框宽
        if(gs[giG].ang!=null) ang=gs[giG].ang;             // 组内统一角度 → 相邻边平行
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
      // 推算块跟随来源组的统一角度（4θ 主轴），否则每个块用 seed.ang，9 片一列会歪
      var iAng = ip.ang||0;
      if(ip.grp!=null && gs[ip.grp] && gs[ip.grp].ang!=null) iAng = gs[ip.grp].ang;
      scanCtx.save();
      scanCtx.translate(x,y); scanCtx.rotate(iAng);
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
  // 二义位：有片、但编号在几何上定不下来（单轴组垂直方向 / 孤片四向）
  // 黄虚线问号框 + 候选编号；点它可以直接二选一/四选一，或点工具条「复核漏读」
  if(ocrMode && !scan.blockMode && scan.weakCells && scan.weakCells.length){
    var k4=scan.W/scan.ocr.w;
    scan.weakCells.forEach(function(w){
      var x=w.x*k4, y=w.y*k4, sd=Math.max(10,w.side*k4);
      if(x<-60||y<-60||x>W+60||y>H+60) return;
      scanCtx.save();
      scanCtx.translate(x,y);
      scanCtx.fillStyle="rgba(255,205,60,.20)";
      scanCtx.fillRect(-sd/2,-sd/2,sd,sd);
      scanCtx.strokeStyle="rgba(255,205,60,.95)";
      scanCtx.lineWidth=Math.max(1.2,sd*0.055);
      scanCtx.setLineDash([Math.max(4,sd*0.18),Math.max(3,sd*0.11)]);
      scanCtx.strokeRect(-sd/2,-sd/2,sd,sd);
      scanCtx.restore();
      var lab="?"+(w.cands.length<=2?" "+w.cands.join("|"):"");
      scanCtx.font="bold 14px monospace";
      var tw3=scanCtx.measureText(lab).width;
      scanCtx.fillStyle="rgba(8,12,18,.78)";
      scanCtx.fillRect(x-tw3/2-3, y+sd*0.5-2, tw3+6, 17);
      scanCtx.fillStyle="rgba(255,205,60,.98)";
      scanCtx.textAlign="center"; scanCtx.textBaseline="middle";
      scanCtx.fillText(lab, x, y+sd*0.5+7);
    });
  }
  // 漏识别片：前景是片、背上有墨迹，但 OCR 整句没检出 → 灰虚线方框 + 「?」
  // （区别于黄色「二义位」和红色「可疑」：这里连编号都没有，只是「这片没算进来」）
  if(ocrMode && scan.gaps && scan.gaps.length){
    var k6=scan.W/scan.ocr.w;
    scan.gaps.forEach(function(g){
      var x=g.x*k6, y=g.y*k6, sd=Math.max(10,g.side*k6);
      if(x<-60||y<-60||x>W+60||y>H+60) return;
      scanCtx.save();
      scanCtx.translate(x,y);
      scanCtx.fillStyle="rgba(150,170,195,.13)";
      scanCtx.fillRect(-sd/2,-sd/2,sd,sd);
      scanCtx.strokeStyle="rgba(170,190,215,.95)";
      scanCtx.lineWidth=Math.max(1.2,sd*0.05);
      scanCtx.setLineDash([Math.max(3,sd*0.14),Math.max(3,sd*0.12)]);
      scanCtx.strokeRect(-sd/2,-sd/2,sd,sd);
      scanCtx.restore();
      scanCtx.font="bold 14px monospace";
      scanCtx.fillStyle="rgba(8,12,18,.78)";
      scanCtx.fillRect(x-8, y+sd*0.5-2, 22, 17);
      scanCtx.fillStyle="rgba(185,205,230,.98)";
      scanCtx.textAlign="center"; scanCtx.textBaseline="middle";
      scanCtx.fillText("?", x+3, y+sd*0.5+7);
    });
  }
  // 改号/改完之后的「它在这一块的哪里」金色闪框（1.6s 自动消失）
  if(ocrMode && scan.flash && scan.flash.size){
    var kf=scan.W/scan.ocr.w;
    scan.flash.forEach(function(i){
      var pt=photoPosOf(i); if(!pt) return;
      var x=pt.x*kf, y=pt.y*kf, sd=Math.max(12,pt.s*kf);
      scanCtx.save();
      scanCtx.translate(x,y);
      scanCtx.strokeStyle="rgba(255,214,80,.98)";
      scanCtx.lineWidth=Math.max(2,sd*0.07);
      scanCtx.setLineDash([]);
      scanCtx.strokeRect(-sd/2,-sd/2,sd,sd);
      scanCtx.strokeStyle="rgba(255,214,80,.45)";
      scanCtx.lineWidth=Math.max(1,sd*0.03);
      scanCtx.strokeRect(-sd*0.62,-sd*0.62,sd*1.24,sd*1.24);
      scanCtx.restore();
    });
  }
  // 散块模式：把读到的编号标在照片上（conf 着色）。整块模式下对齐读数的标签
  // 跟着框一起放到网格位，与推算块混排时整列整齐。
  // **遍历 ocr.map 而不是 ocr.results**：复核漏读 / 补漏 / 人工补块 / 改号插进来的
  // 读数只在 map 里（results 是原始 OCR 输出），遍历 results 会让这些框光秃秃没编号。
  if(ocrMode && scan.ocr.map){
    var k=scan.W/scan.ocr.w;
    scan.ocr.map.forEach(function(r){
      if(scan.ocr.drop && scan.ocr.drop.has(r.idx)) return;   // ✕ 删掉的：连十字和编号一起消失
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
/* 照片上片宽的中位数（OCR 工作坐标）：删掉的读数没有 side 可用，
   浮层放大镜和「点回被删的块」的命中半径都得靠它。 */
function scanMedSide(){
  var ss=[];
  (scan.reads||[]).forEach(function(r){ var s=readingSide(r)||0; if(s>0) ss.push(s); });
  if(!ss.length && scan.ocr) (scan.ocr.map||new Map()).forEach(function(r){
    var s=readingSide(r)||0; if(s>0) ss.push(s);
  });
  if(!ss.length) return scan.ocr?Math.min(scan.ocr.w,scan.ocr.h)/18:64;
  ss.sort(function(a,b){ return a-b; });
  return ss[ss.length>>1];
}
/* 某块在**照片**里的位置（OCR 工作坐标）：优先读数，其次推算位，最后「已删除但记着位置」。
   引导浮条的小窗、改号后的「这是哪一块」高亮、删掉后再点回来的浮层都靠它。 */
function photoPosOf(i){
  var r=(scan.ocr&&scan.ocr.map)?scan.ocr.map.get(i):null;
  if(r){
    var s=readingSide(r)||0;
    if(!s) s=Math.min(scan.ocr.w,scan.ocr.h)/18;
    return { x:r.x, y:r.y, s:s, ang:r.ang||0, src:"read" };
  }
  var ip=scan.inferredPos&&scan.inferredPos[i];
  if(ip) return { x:ip.x, y:ip.y, s:ip.side||Math.min(scan.ocr.w,scan.ocr.h)/18, ang:ip.ang||0, src:"infer" };
  // 已被人工删掉：dropReading 存过原位置/角度，用它把「补回来」的浮层摆到原本那一块上
  if(scan.ocr && scan.ocr.drop && scan.ocr.drop.has(i) && scan.ocr.keep && scan.ocr.keep[i]){
    var kp=scan.ocr.keep[i];
    return { x:kp.x, y:kp.y, s:scanMedSide(), ang:kp.ang||0, src:"keep" };
  }
  return null;
}
/* 照片上短暂高亮一组块（改号后告诉用户「它和哪些块是一伙的」） */
var scanFlashT=null;
function scanFlash(ids){
  scan.flash=new Set(ids||[]);
  drawScan();
  if(scanFlashT) clearTimeout(scanFlashT);
  scanFlashT=setTimeout(function(){ scan.flash=null; drawScan(); }, 1600);
}

/* 「延伸」档位：0 = 常规范围；1 = 审完可疑点后放宽一圈（见 extendInfer）。
   只影响推算的范围/判据，不影响读数与拼好组判定。 */
var extLv=0;

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
    var suspIdx=new Set(), suspPairs=[], loosePairs=[];
    function grpSizeOf(i){ var gi=grpMap[i]; return gi==null?1:groups[gi].length; }
    // 散堆里「两块不相干的片挨着放」是常态：孤片有 50+，随便两块贴在一起就满足
    // 「一个片距 + 文本轴平行 + 编号不邻」。以前当成「拼合矛盾 → 疑似误读」标红，
    // 实测 85891 的 5 个可疑**全是这种误报**（用户：「既然识别出来了那为啥可疑呢」）。
    // 现在只写成软提示 loosePairs（明细里灰字列一行，不标红、不拦应用）；
    // 真正的红色可疑只留给整块模式下「读数与网格位矛盾」这种有网格证据的情况。
    defSusp.forEach(function(p){
      var ga=grpSizeOf(p[0])>=2, gb=grpSizeOf(p[1])>=2;
      if(ga&&gb) return;                               // 两簇相邻摆放：连提示都不给
      loosePairs.push(p[0]+"|"+p[1]);
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
    // —— 二义位（有片、但编号几何上定不下来）——
    // 判据：片心是实前景 + 该位置没有读数、也没被推算占用
    var weakCells=[], adopt=[];   // adopt：排除法唯一解，直接补成读数（不再问人）
    var pieceVacant=function(px,py,sidePx){
      var kk=scan.W/scan.ocr.w;
      if(whiteHit(px*kk,py*kk,sidePx*kk*0.30)<0.72) return false;
      var occ=false;
      scan.ocr.map.forEach(function(r){ if(Math.hypot(r.x-px,r.y-py)<sidePx*0.6) occ=true; });
      if(occ) return false;
      for(var kk2 in inferredPos){
        if(Math.hypot(inferredPos[kk2].x-px, inferredPos[kk2].y-py)<sidePx*0.6) return false;
      }
      return true;
    };
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
      /* 范围：常规 ±3（蔓延能多长两圈，四道关 + 上限兜底防扩散）；
         延伸档 ±6 —— 「只有一组的大图」整张拼成一片时，第三、四圈正好卡在 ±3 外面，
         这就是那几块「怎么也搞不上」的片。 */
      var ring=extLv?6:3;
      rmin=Math.max(1,rmin-ring); rmax=Math.min(S.rows,rmax+ring);
      cmin=Math.max(1,cmin-ring); cmax=Math.min(S.cfg.cols,cmax+ring);
      if(oneAxis==="row"){ cmin=c0min; cmax=c0max; }           // 垂直轴方向二义 → 不扩展
      else if(oneAxis==="col"){ rmin=r0min; rmax=r0max; }
      var k=scan.W/scan.ocr.w, added=0;
      var rx=side*k*0.28;
      var groupSet={}, chain={};                     // 蔓延锚点：本组成员读数 / 本组已推算格
      members.forEach(function(i){ groupSet[i]=true; });
      var maxPass=extLv?8:4, maxAdd=extLv?48:16;
      for(var pass=0; pass<maxPass; pass++){          // 多轮蔓延：链式锚点逐轮生长
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
            // 人工删掉的推算块：这个编号不再外推（散块模式的外推入口，同 pushInfer）
            if(scan.inferDrop && scan.inferDrop.has(idx)) continue;
            set.add(idx); inferredIdx.add(idx); inferred++;
            inferredPos[idx]={x:px,y:py,ang:seed.ang,side:side,grp:gi,weak:false};
            chain[idx]={x:px,y:py};
            fresh++; added++;
            if(added>maxAdd){ pass=99; break; }          // 单组外推上限，防映射意外扩散
          }
        }
        if(!fresh) break;
      }
      if(oneAxis){
        // 单轴组的垂直轴正负未知 → 垂直方向有片的那个位置，编号只可能是
        // 「相邻两号」之一（212 下面那块：237 或 187）。这里只找位置 + 候选，
        // 由 ROI 放大复核或用户二选一定夺，绝不自己猜。
        var kl2=Math.hypot(kx,ky)||1;
        var ux=-ky/kl2, uy=kx/kl2;
        var rc0=idxToRC(members[0]);
        var cd=oneAxis==="row"
          ? [rcToIdx(rc0.row,rc0.col-1), rcToIdx(rc0.row,rc0.col+1)]
          : [rcToIdx(rc0.row-1,rc0.col), rcToIdx(rc0.row+1,rc0.col)];
        // 已被别人占掉的编号不算候选。**看结果集而不只是读数**：推算/延伸出来的块
        // 也算占住了这个号（用户：『173、198 都有了，怎么还有一处复核漏读』）。
        cd=cd.filter(function(v){ return v>=1&&v<=S.cfg.total&&!scan.ocr.map.has(v)&&!set.has(v); });
        if(cd.length>=2){
          for(var sg2=-1; sg2<=1; sg2+=2){
            var px2=seed.x+ux*side*sg2, py2=seed.y+uy*side*sg2;
            if(!pieceVacant(px2,py2,side)) continue;
            weakCells.push({x:px2,y:py2,side:side,cands:cd.slice(),src:"1axis"});
          }
        } else if(cd.length===1){
          // 另一个候选编号已被别的片占用 → 排除法唯一解，直接补（不再问人）
          for(var sg5=-1; sg5<=1; sg5+=2){
            var qx5=seed.x+ux*side*sg5, qy5=seed.y+uy*side*sg5;
            if(!pieceVacant(qx5,qy5,side)) continue;
            adopt.push({idx:cd[0],x:qx5,y:qy5}); break;
          }
        }
      }
    });
    (scan.ocr.low||[]).forEach(function(r){            // 低置信检出：只问一句「是这个吗」
      if(scan.ocr.map.has(r.idx)||set.has(r.idx)) return;   // 这号已经有主了：别再问
      var sd0=readingSide(r)||0; if(!sd0) return;
      weakCells.push({x:r.x,y:r.y,side:sd0,cands:[r.idx],src:"low",conf:r.conf});
    });
    if(scan.suspAck && scan.suspAck.size && !scan._adopting){ // 人工审过「无误/已改」的不再标红
      suspIdx.forEach(function(i){ if(scan.suspAck.has(i)) suspIdx.delete(i); });
    }
    reads.forEach(function(r){
      if(grpMap[r.idx]!=null) return;                  // 组内的交给组处理
      var sd=readingSide(r); if(!sd||sd<8) return;
      var th=r.ang||0, cx1=Math.cos(th)*sd, cy1=Math.sin(th)*sd;
      var dirs=[[cx1,cy1],[-cx1,-cy1],[-cy1,cx1],[cy1,-cx1]];
      var rc1=idxToRC(r.idx), ald=[];
      [[0,-1],[0,1],[-1,0],[1,0]].forEach(function(dd){
        var rr=rc1.row+dd[0], cc=rc1.col+dd[1];
        if(rr<1||cc<1||rr>S.rows||cc>S.cfg.cols) return;
        var q=rcToIdx(rr,cc); if(q>=1&&q<=S.cfg.total) ald.push(q);
      });
      ald=ald.filter(function(v){ return !scan.ocr.map.has(v)&&!set.has(v); });  // 同上有主即排除
      if(ald.length<1) return;
      var hit=0;
      for(var d2=0;d2<4;d2++){
        var px3=r.x+dirs[d2][0], py3=r.y+dirs[d2][1];
        if(!pieceVacant(px3,py3,sd)) continue;
        hit++;
        if(hit>2) break;
        if(ald.length===1) adopt.push({idx:ald[0],x:px3,y:py3});
        else weakCells.push({x:px3,y:py3,side:sd,cands:ald.slice(),src:"single"});
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
      var q=scanCellBase(idxToRC(idx));      // 判据按标定解，不吃人工微调
      var d=Math.hypot(q.x-r.x*k, q.y-r.y*k);
      resid.push(d);
      if(d<mp*0.55) alignedIdx.add(idx);
    });
    resid.sort(function(a,b){ return a-b; });
    var medD=resid.length?resid[resid.length>>1]:1e9;
    var bmAuto = resid.length>=3 && medD < mp*0.5;
    /* 人工微调过网格就**保持**整块模式：拖格子本来就会让残差变大，若照旧自动裁决，
       第一下拖动就把 blockMode 判掉、所有框弹回读数原位 —— 表现成「微调网格拖不动图框」。
       （重新标定会清掉 gridAdj，恢复自动裁决） */
    scan.blockMode = (scan.gridAdj && scan.blockMode) ? true : bmAuto;
    scan.alignedIdx=alignedIdx;
    // 整块照片上网格映射可信 → 直接用它裁决，不再靠「两块一个片距」猜：
    //   读数没落在自己编号该在的格子上（d > 0.55 格距）、又不是「整群偏移的组」
    //   → 这块的编号读错了。散堆照片上这条无判据（网格无关），保持软提示。
    if(scan.blockMode){
      loosePairs=[];
      scan.ocr.map.forEach(function(r,idx){
        if(r.conf<0.5||idx<1||idx>S.cfg.total) return;
        if(grpMap[idx]!=null) return;                 // 组内整群位置偏移，自洽
        var q0=scanCellBase(idxToRC(idx));             // 同上：用标定解判，不受微调影响
        var d0=Math.hypot(q0.x-r.x*k, q0.y-r.y*k);
        if(d0>mp*0.55 && !suspIdx.has(idx)){
          suspIdx.add(idx); misread++;
          if(suspPairs.length<4) suspPairs.push(idx+"≠网格位");
        }
      });
    }
    if(scan.blockMode){
      // 整块统一文字方向：det 框角带 90° 歧义 → 用 4θ 圆均值（周期 90°）取主轴，
      // 结果落在 ±22.5°，正好是「格距矩形的朝向」，不会把整片框转成竖排。
      var sx=0, sy=0, na=0;
      scan.ocr.map.forEach(function(r){
        if(r.conf>=0.5 && isFinite(r.ang)){ sx+=Math.cos(4*r.ang); sy+=Math.sin(4*r.ang); na++; }
      });
      var blkAng = na ? 0.25*Math.atan2(sy,sx) : 0;
      scan.blockAng=blkAng;
      var bw=Math.abs(scan.pitchX), bh=Math.abs(scan.pitchY);
      var rx=bw*0.26, ry=bh*0.26;
      function fgAt(idx){
        var p=idxToRC(idx), q=scanCellBase(p);   // 前景判定按标定解（微调只影响画在哪）
        if(q.x<rx||q.y<ry||q.x>scan.W-rx||q.y>scan.H-ry) return false;
        if(isPieceAt(q.x,q.y,rx,ry,true)) return true;
        /* 延伸档：贴边的片大窗必有一侧压木地板、压在阴影带里的片大窗覆盖率会掉到
           0.50 以下，严格判据把它们整片判掉（「只有一组的大图有几个点怎么也搞不上」）。
           放宽到非严格档（只看片心椭圆），光斑仍由下面的「簇级 OCR 支持检查」兜住。 */
        return extLv ? isPieceAt(q.x,q.y,rx,ry,false) : false;
      }
      function pushInfer(idx){
        if(inferredIdx.has(idx)) return;
        if(scan.inferDrop && scan.inferDrop.has(idx)) return;   // 人工删掉的推算块：不再推算
        /* 已经有这条编号的读数就别再推算它 —— 否则画面上同一个号出现两次
           （读数框 + 网格位推算框，就是用户说的「有两个 778」）。
           读数是直接证据，位置以读数为准。 */
        if(scan.ocr.map.has(idx)) return;
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
      /* ---- 延伸：沿已确认的片往外再长一圈 ----
         单组大照片（整片拼好再拍）常有一整块压在阴影/侧光里：maskWhite 要求「小窗亮度
         均匀」，阴影有梯度 → 整片判成不是片（85890 实测 maskWhite≈0.00、mask≈0.90），
         于是这几块既推不出来、OCR 没读到时连「增删」都点不动。
         这里改用纯灰度阈值 mask（不要求均匀），并且**只从已确认的片 4 邻往外长、不跳格**
         —— 远处光斑够不着；已经过了上面「簇级 OCR 支持检查」的格子就是种子。 */
      if(extLv){
        var seeds=new Set();
        alignedIdx.forEach(function(i){ seeds.add(i); });
        inferredIdx.forEach(function(i){ seeds.add(i); });
        /* 延伸的准入比常规推算更严一格（宁可少推也不能把反光区整块算成片）：
           ① 贴邻 ≥2 块已确认的片 = 确认区内部的空洞，填它安全；
           ② 附近 0.8 格距内有任何 OCR 检出的文字（conf 不够被丢掉的也算）——
              85890 的阴影区就靠这条（片在、编号也读到了，只是残差/置信之外）；
           85889 那块反光区两条都不满足（整片无任何检出），所以延伸不会进去。 */
        var arrE=scan.ocr.results||[];
        function extOk(j){
          var pj=idxToRC(j), na=0;
          var nb=[[pj.row+1,pj.col],[pj.row-1,pj.col],[pj.row,pj.col+1],[pj.row,pj.col-1]];
          for(var t=0;t<4;t++){
            if(nb[t][0]<1||nb[t][1]<1||nb[t][0]>S.rows||nb[t][1]>S.cfg.cols) continue;
            if(seeds.has(rcToIdx(nb[t][0],nb[t][1]))) na++;
          }
          if(na>=2) return true;
          if(!arrE.length) return false;
          var q=scanCellXY(pj);
          for(var w=0;w<arrE.length;w++){
            if(Math.hypot(arrE[w].x*k-q.x, arrE[w].y*k-q.y) < mp*0.8) return true;
          }
          return false;
        }
        var q3=Array.from(seeds), seen3=new Set(seeds), add3=0;
        while(q3.length){
          var cp=idxToRC(q3.pop());
          var nb3=[[cp.row+1,cp.col],[cp.row-1,cp.col],[cp.row,cp.col+1],[cp.row,cp.col-1]];
          for(var n3=0;n3<4;n3++){
            var r3=nb3[n3][0], c3=nb3[n3][1];
            if(r3<1||c3<1||r3>S.rows||c3>S.cfg.cols) continue;
            var j3=rcToIdx(r3,c3);
            if(j3<1||j3>S.cfg.total||seen3.has(j3)) continue;
            seen3.add(j3);
            var qp=scanCellBase(idxToRC(j3));
            if(qp.x<rx||qp.y<ry||qp.x>scan.W-rx||qp.y>scan.H-ry) continue;
            if(maskCov(qp.x,qp.y,rx,ry)<0.55) continue;          // 木地板/空位：止步
            if(!extOk(j3)) continue;                             // 没有相邻实证 / 没有文字：不推
            var rd3=scan.ocr.map.get(j3);
            if(rd3 && !alignedIdx.has(j3)) continue;             // 别的编号占着：不抢
            if(!seeds.has(j3)){ pushInfer(j3); add3++; }
            q3.push(j3);
            if(add3>80){ q3.length=0; break; }                   // 兜底上限
          }
        }
      }
    }
    if(adopt.length && !scan._adopting){
      scan._adopting=true;
      adopt.forEach(function(a){ if(!scan.ocr.map.has(a.idx)) insertReading(a.idx,a.x,a.y); });
      recalcScan();
      scan._adopting=false;
      return;
    }
    scan.reads=reads; scan.groups=groups; scan.grpMap=grpMap;
    // 人工审过的（✓无误 / ✎已改号 / ✕删掉）不再算可疑——审查流程靠这条收尾
    if(scan.suspAck && scan.suspAck.size){
      suspIdx.forEach(function(i){ if(scan.suspAck.has(i)) suspIdx.delete(i); });
    }
    scan.suspIdx=suspIdx.size?suspIdx:null;
    scan.suspPairs=suspPairs;
    scan.loosePairs=loosePairs;
    scan.inferred=inferred; scan.inferredIdx=inferredIdx; scan.inferredPos=inferredPos;
    scan.inferredWeak=weakN;
    scan.weakCells = scan.blockMode ? [] : weakCells.filter(function(w){
      // 人工点过「删掉这处提示」的位置不再骚扰（按片宽 0.7 半径判同）
      var wd=scan.weakDrop||[];
      for(var wi=0;wi<wd.length;wi++){
        if(Math.hypot(wd[wi].x-w.x, wd[wi].y-w.y) < Math.max(w.side*0.7, 10)) return false;
      }
      return true;
    });
    // 漏识别片：OCR 整句漏检的片（前景实、有墨迹、周围无主）→ 灰虚线「?」提示
    scan.gaps = scanGaps(reads, inferredPos);
  } else {
    scan.reads=null; scan.groups=null; scan.grpMap=null;
    scan.suspIdx=null; scan.suspPairs=null; scan.loosePairs=null;
    scan.inferred=0; scan.inferredIdx=null; scan.inferredPos=null; scan.inferredWeak=0; scan.weakCells=null;
    scan.gaps=null;
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
  // 人工 ✕ 删掉的编号：从 map 删掉只是不再当读数，但组内/整块推算会按前景又把它
  // 算回来（照片上确实有片）→ 结果集里再剔一次，删了就是删了。
  if(scan.ocr && scan.ocr.drop && scan.ocr.drop.size){
    scan.ocr.drop.forEach(function(i){
      set.delete(i);
      if(inferredIdx){ inferredIdx.delete(i); delete inferredPos[i]; }
      if(suspIdx) suspIdx.delete(i);
    });
    if(inferredIdx) inferred=inferredIdx.size;
  }
  /* ---- 推算位 vs 读数：同一处出现两个编号 → 采纳推算（网格位）那个号 ----
     整块模式下网格映射整体可信，628/626、476/776 这类冲突实测都是 OCR 差一位、
     推算侧是对的（用户口径：『比较的正确结果就是延伸/推算出来的是正确的』）。
     处置必须是**原位换号**而不是删块：早期版本把 476、277 当成错号删掉 → 结果出空洞。
     换号沿用这条读数自己的位置/角度/comps —— 只是把印号改对，那块片还在。
     保留读数的唯一反例：读数的字母与编号自洽、推算的号反倒落在该字母段外（网格偏了）。
     改完记进 scan.zoneFixLog，明细里能看到改了哪几处。 */
  scan.dupFix=null;
  if(scan.blockMode && inferredPos){
    var dlist=[];
    Object.keys(inferredPos).forEach(function(ks){
      var i2=+ks, ip=inferredPos[i2];
      if(!ip || !ip.side) return;
      var lim=ip.side*0.45, hit=null, hd=1e9;
      scan.ocr.map.forEach(function(r,ri){
        if(ri===i2) return;                              // 同号：那条读数就是它（另见 pushInfer）
        var d=Math.hypot(r.x-ip.x, r.y-ip.y);
        if(d<lim && d<hd){ hd=d; hit=ri; }
      });
      if(hit!=null) dlist.push({ read:hit, infer:i2, d:hd });
    });
    if(dlist.length){
      dlist.sort(function(a,b){ return a.d-b.d; });
      var usedR=new Set(), keep=[];
      dlist.forEach(function(c){
        if(usedR.has(c.read)) return;                    // 同一条读数只跟一个推算块冲突
        usedR.add(c.read); keep.push(c);
      });
      /* 同一处两个编号 → **采纳推算（网格位）那个号**：整块模式下网格映射整体可信，
         错的是 OCR 那一位（628/626、476/776……实测推算侧是对的）。
         处置是**原位换号**：删除读数列、把这条读数改成推算的号，位置/角度/comps 全沿用
         ——不是删块，所以不会留空洞。
         唯一的反例：读数的字母与编号自洽、推算的号反而落在该字母段外，
         那说明推算偏了，保留读数。字母是分区校验位（D 段 751–1000 里不可能印 476）。 */
      var zfix=[], kept=[];
      keep.forEach(function(c){
        var rd=scan.ocr.map.get(c.read);
        var L=rd&&rd.letter, rOK=L?numInZone(L,c.read):true, iOK=L?numInZone(L,c.infer):true;
        if(rd && !(rOK && !iOK) && !scan.ocr.map.has(c.infer)){
          scan.ocr.map.delete(c.read);
          if(scan.ocr.drop) scan.ocr.drop.delete(c.read);   // 换号不是删块：旧号别进黑名单
          if(suspIdx) suspIdx.delete(c.read);
          /* 原地换号：沿用这条读数自己的 comps / 角度 / svc 标记（换的是号，片没换）。
             别用 insertReading 造一条「人工读数」——那会丢掉 comps，片宽算错，
             拼好组跟着散架。 */
          rd.idx=c.infer; rd.digits=fmt(c.infer); rd.zoneFix=c.read; rd.conf=1;
          rd.letter=(L&&numInZone(L,c.infer))?L:zoneLetter(zoneOf(c.infer));
          scan.ocr.map.set(c.infer, rd);
          /* 记住「这个位置读出来过这个错号」：补漏/复核的 ROI 会犯同一个错
             （476 改成 776 后，ROI 又把这块读成 476），不记下来就会被补回去。 */
          if(!scan.zoneFixAt) scan.zoneFixAt=[];
          scan.zoneFixAt.push({ old:c.read, x:rd.x, y:rd.y });
          set.delete(c.read);                               // 同一块：读数号让位给网格号
          if(inferredIdx) inferredIdx.delete(c.infer);      // 它现在是读数，不再是推算
          if(inferredPos) delete inferredPos[c.infer];
          zfix.push(c);
        } else {
          set.delete(c.infer);                              // 撤掉推算块：它和读数重合，不是两块
          if(inferredIdx) inferredIdx.delete(c.infer);
          if(inferredPos) delete inferredPos[c.infer];
          kept.push(c);
        }
      });
      if(inferredIdx) inferred=inferredIdx.size;
      scan.dupFix=kept.map(function(c){ return { read:c.read, infer:c.infer }; });
      if(zfix.length){
        scan.zoneFixLog=(scan.zoneFixLog||[]).concat(zfix.map(function(c){
          return c.read+"→"+c.infer; }));
      }
    }
  }
  /* ---- 可疑点查重：结果里已经有这块 → 不用人工审 ----
     「可疑」说的是「这块可能读错了（位置/编号对不上）」，但如果这个编号**已经进了结果集**
     （读数 / 推算 / 延伸 任一来源都算——用户明确说「即使是延伸出来的」），说明算法已经
     认定它在，再让人过一遍只是耽误时间。
     这里**只做自动确认、绝不删块**：删掉就会掉块，宁可留着。也不写进 `suspAck`（那是
     「人工已审」的永久黑名单）——每次重算重新查一遍，哪天它不在结果里了，可疑会重新冒出来。 */
  scan.suspAuto=null;
  if(suspIdx && suspIdx.size && set.size){
    var dup=[];
    suspIdx.forEach(function(i){ if(set.has(i)) dup.push(i); });
    if(dup.length){
      dup.sort(function(a,b){ return a-b; });
      dup.forEach(function(i){ suspIdx.delete(i); });   // 与 scan.suspIdx 同一个 Set，同步生效
      scan.suspAuto=dup;
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
  scan.baseAx=a.x; scan.baseAy=a.y;      // 标定解（「微调网格」只挪 ax/ay，判据仍按这份）
  scan.pitchX=pitchX; scan.pitchY=pitchY;
  scan.calibrated=true;
  scan.gridAdj=false;             // 重新求解 = 回到自动裁决（人工微调的痕迹清零）
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
    +(scan.weakCells&&scan.weakCells.length?(" · 待选 "+scan.weakCells.length):"")
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
  scan.suspIdx=null; scan.suspPairs=null; scan.loosePairs=null;
  scan.gaps=null; scan.gapTried=[];      // 补漏跑过但读不出编号的位置
  scan.weakDrop=[];                      // 人工「删掉这处提示」的二义位/漏读位
  scan.inferDrop=new Set();              // 人工删掉的推算块编号（不再推算）
  scan.gridFix=null; scan.gridFixLog=[]; // 「同一处两个编号」按网格位改号的记录
  scan.zoneBad=null; scan.zoneFixLog=[]; // 字母与编号不符的读数 / 按分区纠正的记录
  scan.zoneFixAt=[];                     // 判错换掉的号 + 位置（挡住 ROI 重复同一个误读）
  extLv=0;                               // 延伸档位归零（重新标定/换照片后按常规范围算）
  scan.gridAdj=false;                    // 人工微调过网格？（保持整块模式，别被自动裁决推翻）
  scan.suspAck=new Set();                       // 人工点过「无误」的可疑块
  scan.review=null;                             // 可疑点逐块审查状态
  var rvp=$("scanRv"); if(rvp) rvp.style.display="none";
  scan.inferred=0; scan.inferredIdx=null; scan.inferredPos=null; scan.inferredWeak=0; scan.weakCells=null;
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
  osvcProbe(true);              // 探测 PP-OCR 服务状态（手动开面板：重排重试次数）
  if(!scan.img){ resetScan(false); }
  else { drawScan(); }
  if(scan.review && scan.suspIdx && scan.suspIdx.size) startReview();  // 上次没审完：接着审
  setTimeout(drawScan,60);
});
$("scanClose").addEventListener("click",function(){
  $("ovScan").classList.remove("on");
  var rvp=$("scanRv"); if(rvp) rvp.style.display="none";   // 审查面板跟着收起（状态留着，回来接着审）
});
$("osvcBadge").addEventListener("click",function(){
  osvcProbe(true);
  toast(OSVC.ok?"OCR：PP-OCR 高精度（服务已连接）":"正在检测 PP-OCR 服务（"+OSVC.host+"）…");
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
              scan.ocr={ results:res, map:new Map(), low:[], drop:new Set(),
                         w:Math.round(img.width*Math.min(1,3072/Math.max(img.width,img.height))),
                         h:Math.round(img.height*Math.min(1,3072/Math.max(img.width,img.height))) };
              scan.gapTried=[];                     // 新照片：补漏黑名单重来
              // 置信度 0.30~0.50：模型读出来了但不敢算——留作「待审」，由人一键确认
              res.forEach(function(r){
                if(r.conf>=0.3 && r.conf<0.5 && r.idx>=1 && r.idx<=S.cfg.total) scan.ocr.low.push(r);
              });
              ok.forEach(function(r){ if(!scan.ocr.map.has(r.idx)) scan.ocr.map.set(r.idx,r); });
              if(ok.length>=2 && autoCalibrate(ok)) {
                toast("已自动识别 "+ok.length+" 个编号"+(ok.some(function(r){return r.svc;})?"（PP-OCR）":""));
                /* 自动识别的收尾：复核漏读 → 补漏 → 延伸（不点按钮也该补回来）。
                   带 extend 是必须的：可疑点大多会被「查重」自动确认掉，根本走不到
                   人工审查那条链（rvDone），得在这里补一次延伸，否则「审完就延伸」落空。 */
                setTimeout(function(){ autoVerify("自动识别", null, {extend:true}); }, 320);
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
    +"<span class=\"sn\">「重新标定」= 自动重标（Shift/Alt + 点 = 手动点两块）；网格在全部编号读数里自动找最自洽的一对片对齐，换照片同样适用。相邻且编号方向一致的块自动归为拼好组；组内编号在网格上对不上时会标红提示。识别有误的编号可以直接在照片上核对；「引导摆放」逐条引导，点「放好了」才落一条。</span>";
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
  if(del){ scan.result.delete(i); dropReading(i,true); }
  else { scan.result.add(i); dropReading(i,false); }
  updateScanStats(); drawScan();
}
/* 「这块不算」的黑名单：编号层面的删除，跨 recalc 生效（推算/标签都要让路）。
   同时把原读数（位置/角度）收进 scan.ocr.keep：再补回来时沿用原角度，
   否则 insertReading 只能借最近读数的角度，拼好组会因为角度对不上而散掉。 */
function dropReading(i,del){
  if(!scan.ocr) return;
  if(!scan.ocr.drop) scan.ocr.drop=new Set();
  if(del){
    if(!scan.ocr.keep) scan.ocr.keep={};
    var r0=scan.ocr.map&&scan.ocr.map.get(i);
    if(r0) scan.ocr.keep[i]={x:r0.x, y:r0.y, ang:r0.ang};
    scan.ocr.drop.add(i);
  } else scan.ocr.drop.delete(i);
}
/* 手动补一块：OCR 漏读的片（尤其拼在簇边、垂直方向又解不出轴向的那块），
   由人点位置 + 输编号补成「伪读数」，之后并查集/局部网格会自动把它并进簇，
   组内双轴由此可解，周围漏读片跟着一起推出来。 */
function insertReading(idx,ox,oy,letter){
  var near=null, bd=1e9;
  scan.ocr.map.forEach(function(r){ var d=Math.hypot(r.x-ox,r.y-oy); if(d<bd){ bd=d; near=r; } });
  // 之前删掉的编号：沿用它的原角度（不然借最近读数的角度，拼好组会因角度不匹配散架）
  var keep=(scan.ocr.keep&&scan.ocr.keep[idx])||null;
  var ang=keep?keep.ang:(near?(near.ang||0):0);
  var side=near?readingSide(near):0;
  if(!side) side=Math.min(scan.ocr.w,scan.ocr.h)/18;   // 无参照读数时按照片短边粗估片宽
  var tl=side*0.27, comps=[];
  for(var t=-1;t<=1;t+=2){
    comps.push({ x0:ox+Math.cos(ang)*tl*0.5*t-1, y0:oy+Math.sin(ang)*tl*0.5*t-1, w:2, h:2 });
  }
  scan.ocr.map.set(idx, { idx:idx, x:ox, y:oy, ang:ang, conf:1, svc:false, manual:true,
    comps:comps, letter:letter||zoneLetter(zoneOf(idx)), digits:fmt(idx) });
  if(scan.ocr.drop) scan.ocr.drop.delete(idx);      // 人工补回来 → 撤销「已删除」
  return true;
}
/* 落点附近有没有「刚删掉、位置还记着」的编号（散块模式点空白片时用）。
   命中半径 0.85 片宽：比读数框的命中半径略大一点，手指点偏一格也能补回来。 */
function dropNear(p){
  if(!scan.ocr) return null;
  var kk=scan.W/scan.ocr.w, lim=scanMedSide()*kk*0.85;
  var best=null, bd=1e9;
  function probe(i,kp){
    if(!kp||Math.hypot(kp.x*kk-p.x, kp.y*kk-p.y)>lim) return;
    var d=Math.hypot(kp.x*kk-p.x, kp.y*kk-p.y);
    if(d<bd){ bd=d; best=i; }
  }
  if(scan.ocr.drop) scan.ocr.drop.forEach(function(i){ probe(i, scan.ocr.keep&&scan.ocr.keep[i]); });
  if(scan.inferDrop) scan.inferDrop.forEach(function(i){ probe(i, scan.ocr.keep&&scan.ocr.keep[i]); });
  return best;
}
/* 把删掉的那块补回来：读数沿用原位置与原角度（角度丢了拼好组会散架），
   也可以顺手改成别的编号（删错了 + 当初读错，一起改）。 */
function restoreReading(old,num,pt){
  if(!scan.ocr) return false;
  if(num==null) return false;
  if(num!==old && scan.ocr.map.has(num)){ toast("第 "+fmt(num)+" 块已经有读数了"); return false; }
  var kp=(scan.ocr.keep&&scan.ocr.keep[old])||null;
  var k=(scan.ocr&&scan.ocr.w)?(scan.W/scan.ocr.w):1;
  /* 落点以**你点的那一块**为准：keep 里存的是当初 OCR 读到的坐标，和推算位是两回事
     （用户：『别把推算出来的点和 OCR 出来的点当成同一张图』）。差一格以上就用点的位置，
     角度仍然沿用 keep 里的原角度（丢了拼好组会散架）。 */
  var ox, oy, ang0=kp?kp.ang:null;
  if(pt && (!kp || Math.hypot(pt.x/k-kp.x, pt.y/k-kp.y) > (scanMedSide()||20))){
    ox=pt.x/k; oy=pt.y/k;
  } else { ox=kp?kp.x:0; oy=kp?kp.y:0; }
  if(num!==old) dropReading(old,true);        // 改成新号：旧号继续拉黑
  /* 同一格别再留着推算块（277 补回来时那格推算成 777）：推算让位给人工补回的读数，
     并且把它记进 inferDrop —— 否则下一轮它又推回来，跟人工结果反复打架。 */
  if(scan.inferredPos){
    var mside=(scanMedSide()||20);
    Object.keys(scan.inferredPos).forEach(function(m){
      var mi=+m, ip=scan.inferredPos[m];
      if(Math.hypot(ip.x-ox, ip.y-oy) < mside*0.6){
        delete scan.inferredPos[m];
        if(scan.inferredIdx) scan.inferredIdx.delete(mi);
        if(scan.result) scan.result.delete(mi);
        if(mi!==num){ if(!scan.inferDrop) scan.inferDrop=new Set(); scan.inferDrop.add(mi); }
      }
    });
  }
  insertReading(num,ox,oy);                   // 顺手把 num 从 ocr.drop 里去掉
  var nr0=scan.ocr.map.get(num); if(nr0 && ang0!=null) nr0.ang=ang0;
  if(scan.inferDrop && scan.inferDrop.has(num)) scan.inferDrop.delete(num);
  recalcScan(); drawScan(); updateScanStats();
  if(scan.calibrated) scanCalTip();
  toast("已补回 "+fmt(num)+(num!==old?("（原本记成 "+fmt(old)+"）"):"")+fmt0Grp(num));
  return true;
}
/* 补回/删掉时顺带报一句「它在哪一组」，省得用户自己回去找 */
function fmt0Grp(i){
  var gi=(scan.grpMap&&scan.grpMap[i]!=null)?scan.grpMap[i]:null;
  if(gi!=null && scan.groups && scan.groups[gi] && scan.groups[gi].length>=2)
    return " · 和这 "+(scan.groups[gi].length-1)+" 块拼成一组";
  return "";
}
function addManualReading(idx,sx,sy,noRecalc){
  if(!scan.ocr||!scan.ocr.map) { toast("先载入照片完成识别"); return false; }
  if(scan.ocr.map.has(idx)){ toast("第 "+idx+" 块已经读到了"); return false; }
  var k=scan.W/scan.ocr.w;
  insertReading(idx, sx/k, sy/k);
  if(!noRecalc){
    recalcScan();
    toast("已补第 "+idx+" 块，重新分组完成");
  }
  return true;
}

/* 这个号是不是刚在附近被「字母与编号不符」判错换掉的？
   补漏/复核的 ROI 会重复同一个误读（476 换成 776 后，ROI 又把这块读成 476），
   按位置挡一下。只在附近挡、不全局拉黑——同一编号可能在照片别处真的存在。 */
function zoneFixBlocks(idx,x,y,side){
  var a=scan.zoneFixAt; if(!a||!a.length) return false;
  var lim=Math.max(side||0,1)*1.1;
  for(var i=0;i<a.length;i++){
    if(a[i].old===idx && Math.hypot(a[i].x-x, a[i].y-y)<lim) return true;
  }
  return false;
}
/* ---- ROI 复核：把单块放大后单独送 PP-OCR ----
   整图 2×2 分片里编号字只有十几像素，det 直接漏检（85891 有 237/422 两块
   文字整句没检出）；按「0.72 片宽」裁一小块放大 3.2× 再识别，同一套模型
   就稳定读出来（实测 A-237@0.94、-422@0.98）。这是「二义位」的裁决手段：
   几何上 237/187 二选一时，让 OCR 直接投票。 */
/* ROI 里抓编号：顺手把字母也带上。字母是分区校验位——D-476 这种（D 段 751–1000）
   当场就能判错，不必等网格来裁决。抓不到字母就留空（不误杀）。 */
function roiNums(text){
  var out=[], s0=String(text||"");
  var lm=s0.match(/([A-Za-z])[-–—\s]?(\d{3,4})/);
  var letter=lm?lm[1].toUpperCase():null;
  var m=s0.match(/\d{3,4}/g)||[];
  m.forEach(function(d){
    if(d.length===3) out.push(parseInt(d,10));
    else if(d.length===4){ out.push(parseInt(d.substr(0,3),10)); out.push(parseInt(d.substr(1,3),10)); }
  });
  return out.filter(function(v){ return v>=1&&v<=S.cfg.total; })
            .map(function(v){ return { idx:v, letter:letter }; });
}
function roiOCR(x,y,side){
  return new Promise(function(resolve){
    var img=scan.img;
    if(!img||!scan.ocr||!OSVC.ok) return resolve([]);
    try{
      var sc=img.width/scan.ocr.w;                      // OCR 坐标 → 原图
      var rad=Math.max(26,side*0.62), z=3.2, s=Math.round(rad*2*z);
      // 边缘不要拉伸：窗口越界时把中心往画面内挪，保持正方形窗口
      var cx0=Math.min(Math.max(x,rad),Math.max(rad,scan.ocr.w-rad));
      var cy0=Math.min(Math.max(y,rad),Math.max(rad,scan.ocr.h-rad));
      var cv=document.createElement("canvas"); cv.width=s; cv.height=s;
      var sx=Math.max(0,Math.round(cx0*sc-rad*sc)), sy=Math.max(0,Math.round(cy0*sc-rad*sc));
      var ex=Math.min(img.width,Math.round(cx0*sc+rad*sc)), ey=Math.min(img.height,Math.round(cy0*sc+rad*sc));
      if(ex-sx<24||ey-sy<24) return resolve([]);
      cv.getContext("2d").drawImage(img,sx,sy,ex-sx,ey-sy,0,0,s,s);
      fetch(OSVC.host+"/ocr",{ method:"POST", headers:{"Content-Type":"application/json"},
          body:JSON.stringify({img:cv.toDataURL("image/jpeg",0.94)}) })
        .then(function(r){ return r.json(); })
        .then(function(j){
          var out=[];
          (j.lines||[]).forEach(function(l){
            roiNums(l.text).forEach(function(t){
              out.push({ idx:t.idx, letter:t.letter, score:l.score||0, text:l.text }); });
          });
          resolve(out);
        }).catch(function(){ resolve([]); });
    }catch(err){ resolve([]); }
  });
}
/* 把弱位（有片、编号二义）补成读数：位置就用预测位，角度/片宽沿用邻近读数 */
function adoptWeak(w,idx){
  var k=scan.W/scan.ocr.w;
  return addManualReading(idx, w.x*k, w.y*k, true);
}
/* 批量复核：对每个二义位做 ROI 识别，命中的候选直接采纳；读不出就留着让用户点选 */
var rechecking=false;
function recheckWeak(cb){
  var list=(scan.weakCells||[]).slice();
  if(rechecking||!list.length){ if(cb) cb(0); return; }
  if(!OSVC.ok){ toast("PP-OCR 服务未连接，无法复核（可以点黄框手动选）"); if(cb) cb(0); return; }
  rechecking=true;
  var i=0, done=0, ask=0;
  function step(){
    if(i>=list.length){
      rechecking=false;
      if(done) recalcScan();
      if(scan.calibrated) scanCalTip();
      drawScan();
      if(!autoChain) toast(done? ("复核补回 "+done+" 块"+(ask?("，还有 "+ask+" 块需要你点选"):"")) : "复核没能读出编号，请点黄框手动选");
      if(cb) cb(done);
      return;
    }
    var w=list[i++];
    if(!w||w.solved){ return step(); }
    $("scanTip").textContent="ROI 复核中… "+i+"/"+list.length;
    roiOCR(w.x,w.y,w.side).then(function(rs){
      var best=null;
      rs.forEach(function(r){
        if(r.letter && !numInZone(r.letter,r.idx)) return;    // 字母与编号自相矛盾：必错
        if(zoneFixBlocks(r.idx,w.x,w.y,w.side)) return;       // 刚在这儿判错换掉的那个号
        if(w.cands.indexOf(r.idx)>=0 && (!best||r.score>best.score)) best=r;
      });
      if(best&&best.score>=0.45){
        if(adoptWeak(w,best.idx)) done++;
        w.solved=true;
      } else ask++;
      step();
    });
  }
  step();
}
/* ---- 漏识别片（「明明很清晰却没算进来」）----
   散堆里有的片 PP-OCR 整句漏检（det 漏检，连低置信都没有），算法完全看不见它。
   这里用两条物理特征把它找出来，**只当提示**（灰虚线 + ?），点了才补编号：
     ① 片心 ±0.28 片宽的方窗是实前景：maskWhite 覆盖率落在「读数位实测分布」区间内
        ——下限摘掉木地板缝/凸头，上限摘掉过曝白斑（白斑没有墨迹，覆盖率≈1.0，
        而真片背印着编号，暗字会把覆盖率压到 0.99 以下）；
     ② 与任何读数 / 推算位距离 > 0.72 片宽：已经有主的片不算漏。
   实测 85891：94 条读数 → 检出 20+ 处这样的片，其中大半 ROI 复核能读出编号。 */
function scanGaps(reads, inferredPos){
  var gaps=[];
  if(!scan.maskWhite||!scan.gray||!reads||reads.length<6) return gaps;
  var k=scan.W/scan.ocr.w;
  var S0=0, ss=[];
  reads.forEach(function(r){ var s=readingSide(r)||0; if(s>0) ss.push(s); });
  if(ss.length<6) return gaps;
  ss.sort(function(a,b){ return a-b; }); S0=ss[ss.length>>1];
  if(!(S0>8)) return gaps;
  var R=Math.max(3,Math.round(S0*0.28*k));
  function cover(x,y){                      // 圆窗 maskWhite 覆盖率
    var hit=0,tot=0;
    for(var dy=-R;dy<=R;dy+=2){
      var py=y+dy; if(py<0||py>=scan.H) continue;
      for(var dx=-R;dx<=R;dx+=2){
        var px=x+dx; if(px<0||px>=scan.W) continue;
        if(dx*dx+dy*dy>R*R) continue;
        tot++; if(scan.maskWhite[py*scan.W+px]) hit++;
      }
    }
    return tot>12? hit/tot : -1;
  }
  // 用「读数位」自身标定覆盖率区间（不同照片白度/光照差别很大，硬编码阈值不可靠）
  var cv=[];
  reads.forEach(function(r){
    var v=cover(Math.round(r.x*k), Math.round(r.y*k));
    if(v>=0) cv.push(v);
  });
  if(cv.length<6) return gaps;
  cv.sort(function(a,b){ return a-b; });
  var lo=cv[Math.floor(cv.length*0.15)]-0.06;
  var hi=Math.min(0.985, cv[Math.floor(cv.length*0.92)]+0.02);
  if(hi<=lo) return gaps;
  var occ=[];
  reads.forEach(function(r){ occ.push([r.x*k, r.y*k]); });
  for(var ii in inferredPos) occ.push([inferredPos[ii].x*k, inferredPos[ii].y*k]);
  var minD=S0*k*0.72, step=Math.max(4,Math.round(S0*k*0.28));
  var cand=[];
  /* 屏蔽名单 = 补漏读不出的位置 + 人工点「删掉这处提示」的位置。
     以前只看 gapTried，于是**漏读的「?」删了又冒出来**（删除只写进 weakDrop）——
     用户：「有一个复核漏读，没有办法删除」。 */
  var tried=(scan.gapTried||[]).concat(scan.weakDrop||[]);
  var hitTried=function(ox,oy){
    for(var t=0;t<tried.length;t++){ if(Math.hypot(tried[t].x-ox, tried[t].y-oy)<S0*0.62) return true; }
    return false;
  };
  for(var y=R;y<scan.H-R;y+=step)for(var x=R;x<scan.W-R;x+=step){
    var v2=cover(x,y);
    if(v2<lo||v2>hi) continue;
    if(hitTried(x/k,y/k)) continue;                   // 补漏跑过、读不出编号的：不再重复提示
    var busy=false;
    for(var o=0;o<occ.length;o++){ if(Math.hypot(occ[o][0]-x,occ[o][1]-y)<minD){ busy=true; break; } }
    if(busy) continue;
    cand.push({x:x, y:y, v:v2, score:Math.abs(v2-(lo+hi)/2)});
  }
  // 最近优先 + 非极大抑制（一片只留一个点）
  cand.sort(function(a,b){ return a.score-b.score; });
  var keep=[];
  cand.forEach(function(c){
    for(var j=0;j<keep.length;j++){ if(Math.hypot(keep[j].x-c.x,keep[j].y-c.y)<minD){ return; } }
    for(var o2=0;o2<occ.length;o2++){ if(Math.hypot(occ[o2][0]-c.x,occ[o2][1]-c.y)<minD){ return; } }
    keep.push(c);
  });
  keep.forEach(function(c){ gaps.push({ x:c.x/k, y:c.y/k, side:S0, v:c.v }); });
  return gaps;
}
/* 补漏：对每个待补位做 ROI 放大识别，读出来就补成读数（最后统一重算） */
var filling=false;
function fillGaps(cb){
  if(filling){ if(cb) cb(0); return; }
  var list=(scan.gaps||[]).slice();
  if(!list.length){ if(cb) cb(0); else toast("没有待补的片"); return; }
  if(!OSVC.ok){ toast("PP-OCR 服务未连接，无法自动补漏（可以点灰框手动补）"); if(cb) cb(0); return; }
  filling=true;
  var i=0, got=0, seen=0;
  function step(){
    if(i>=list.length){
      filling=false;
      scan.gaps=null;
      recalcScan();          // 重算 gaps：读出来的并进结果，读不出的已被 gapTried 挡掉
      if(scan.calibrated) scanCalTip();
      drawScan(); updateScanStats();
      if(!autoChain) toast(got? ("补漏补回 "+got+" 块"+(seen>got?("，另有 "+(seen-got)+" 处读不出编号"):""))
              : "这些位置没读出编号（可点灰框手动补）");
      if(cb) cb(got);
      return;
    }
    var g=list[i++];
    var busy=false;
    scan.ocr.map.forEach(function(r){ if(Math.hypot(r.x-g.x,r.y-g.y)<g.side*0.55) busy=true; });
    if(busy){ return step(); }
    $("scanTip").textContent="补漏扫描 "+i+"/"+list.length+"…";
    seen++;
    roiOCR(g.x,g.y,g.side).then(function(rs){
      rs.sort(function(a,b){ return b.score-a.score; });
      var got1=false;
      for(var j=0;j<rs.length;j++){
        var t=rs[j];
        if(t.score<0.55) break;
        if(t.idx<1||t.idx>S.cfg.total) continue;
        if(scan.ocr.map.has(t.idx)) continue;
        if(t.letter && !numInZone(t.letter,t.idx)) continue;   // 字母与编号自相矛盾：必错
        if(zoneFixBlocks(t.idx,g.x,g.y,g.side)) continue;      // 刚在这儿判错换掉的那个号
        insertReading(t.idx, g.x, g.y, t.letter);
        got++; got1=true; g.solved=true;
        break;
      }
      if(!got1){                                     // 读不出 → 记住位置，别再拿它烦人
        if(!scan.gapTried) scan.gapTried=[];
        scan.gapTried.push({x:g.x, y:g.y});
      }
      setTimeout(step,60);
    });
  }
  step();
}
/* ---- 延伸：把「推到边上就停」的推算再往外放一圈 ----
   只有一组的大照片（整张拼成一片）里，边角那几块经常怎么也推不出来、增删也补不上：
   散块模式的组内推算给的是 bbox ±3 / 单组 16 块 / 4 轮蔓延，第三、四圈正好卡死；
   整块模式死在片心判据（贴边的片大窗有一侧压地板、阴影带宽高比掉到 0.50 以下）。
   这里把范围/判据放宽一档再跑一次：多推出来了就保持放宽（结果要稳定），
   一块也没多推就退回原范围（别让放宽状态长期留着）。
   纯几何、不调 OCR 服务，所以审完可疑点后可以无人值守地自动跑。 */
function extendInfer(cb){
  if(!scan.calibrated || !scan.ocr || scan.ocr.map.size<2){ if(cb) cb(0); return; }
  var before=scan.inferred||0, was=extLv;
  extLv=1;
  recalcScan(); drawScan(); updateScanStats();
  if(scan.calibrated) scanCalTip();
  var got=(scan.inferred||0)-before;
  /* 只有「从常规档第一次试探」失败才退回：已经在延伸档时再跑一次没收获，
     绝不能退回 0 —— 那会把上一次延伸出来的块全撤掉（掉块）。 */
  if(got<=0 && !was){
    extLv=was;
    recalcScan(); drawScan(); updateScanStats();
  }
  if(!autoChain) toast(got>0 ? ("延伸 "+got+" 块（放宽范围又推出一圈）")
                  : "延伸没有再推出新块（边角那块可以点空白处补编号）");
  if(cb) cb(got>0?got:0);
}
/* ---- 自动收尾：复核漏读 → 补漏 → 延伸 ----
   前两步是「单块 ROI 放大再识别一遍」，能补回整图 2×2 分片漏掉的小字编号
   （实测 85891 一次多出 11 块）；第三步是纯几何的往外推算。三步都不该等人手点：
   自动识别完、可疑点审完，都自动跑一遍（延伸只在「审完可疑点」这一路跑 —— 要把
   人工清理过的读数当基准，才敢放宽判据）。autoChain 打开时各步不弹 toast，结束时给一条合计。 */
var autoChain=false, autoBusy=false;
function autoVerify(tag, cb, opt){
  opt=opt||{};
  var doExt = !!opt.extend;          // 审完/补漏完都可以再推一次（extendInfer 内部自己判有没有收获）
  if(autoBusy || !scan.ocr){ if(cb) cb(0); return; }
  var nW=(scan.weakCells||[]).length, nG=(scan.gaps||[]).length;
  if(!OSVC.ok){ nW=0; nG=0; }                  // 服务没连：复核/补漏做不了，但延伸照跑
  if(!nW && !nG && !doExt){ if(cb) cb(0); return; }
  autoBusy=true; autoChain=true;
  $("scanTip").textContent="自动复核中…（复核漏读 + 补漏"+(doExt?" + 延伸":"")+"，别急着应用）";
  var got=0, gotExt=0;
  var stage1=function(next){
    if(!nW) return next();
    recheckWeak(function(d){ got+=d; next(); });
  };
  var stage2=function(next){
    if(!(scan.gaps||[]).length) return next();       // 复核之后 gaps 会变，现算
    fillGaps(function(d){ got+=d; next(); });
  };
  var stage3=function(next){
    if(!doExt) return next();
    extendInfer(function(d){ gotExt+=d; next(); });
  };
  var wrap=function(next){ try{ next(); }catch(err){ autoBusy=false; autoChain=false; if(cb) cb(got+gotExt); } };
  wrap(function(){
    stage1(function(){
      stage2(function(){
        stage3(function(){
          autoBusy=false; autoChain=false;
          if(scan.calibrated) scanCalTip();
          drawScan(); updateScanStats();
          var msg=[];
          if(got) msg.push("复核补回 "+got+" 块");
          if(gotExt) msg.push("延伸 "+gotExt+" 块");
          if(msg.length) toast((tag?tag+" · ":"")+msg.join(" · "));
          else if(tag) toast(tag+" · 没有可补的编号，可以直接应用");
          if(cb) cb(got+gotExt);
        });
      });
    });
  });
}
/* ---- 可疑点逐块审查（照标注台：✓确认 / 🔍重识别 / ✕删除 / ◀▶ 逐块过） ----
   有可疑点时底部「应用」变成「下一步：审查可疑 N」，点进去强制逐块过一遍：
   每块单独出大图 + 诊断（读到的编号 vs 该在的网格位）+ 四个动作，
   全部审完才回到「应用识别结果」。 */
var rvR=80;
function suspListNow(){
  var out=[];
  if(scan.suspIdx) scan.suspIdx.forEach(function(i){ out.push(i); });
  out.sort(function(a,b){ return a-b; });
  return out;
}
function rvDecided(idx){ return !!(scan.suspAck && scan.suspAck.has(idx)); }
function rvNextUndecided(from){
  var R=scan.review; if(!R) return -1;
  for(var j=from;j<R.list.length;j++){ if(!rvDecided(R.list[j])) return j; }
  return -1;
}
function drawRvZoom(){
  var R=scan.review; if(!R||!R.at||!scan.img) return;
  var cv=$("rvZoom"), c=cv.getContext("2d");
  var rad=Math.max(10,Math.min(320,rvR)), k=scan.img.width/scan.W;
  c.fillStyle="#060a10"; c.fillRect(0,0,cv.width,cv.height);
  try{ c.drawImage(scan.img,(R.at.x-rad)*k,(R.at.y-rad)*k,2*rad*k,2*rad*k,0,0,cv.width,cv.height); }catch(err){}
  c.strokeStyle="rgba(255,110,110,.75)"; c.lineWidth=2;
  c.strokeRect(2,2,cv.width-4,cv.height-4);
  c.strokeStyle="rgba(255,212,94,.75)"; c.lineWidth=1.2;
  c.beginPath();
  c.moveTo(cv.width/2,0); c.lineTo(cv.width/2,cv.height);
  c.moveTo(0,cv.height/2); c.lineTo(cv.width,cv.height/2);
  c.stroke();
  $("rvZoomVal").textContent="×"+(cv.width/(2*rad)).toFixed(1).replace(/\.0$/,"");
}
function rvShow(){
  var R=scan.review; if(!R) return;
  if(R.i>=R.list.length){ rvDone(); return; }
  var idx=R.list[R.i], k=scan.W/scan.ocr.w;
  var rd=(scan.ocr&&scan.ocr.map)?scan.ocr.map.get(idx):null;
  var x,y;
  if(rd){ x=rd.x*k; y=rd.y*k; }
  else { var q0=scanCellXY(idxToRC(idx)); x=q0.x; y=q0.y; }
  R.at={x:x,y:y};
  $("rvTitle").textContent="审查 "+(R.i+1)+"/"+R.list.length+" · "+zoneLetter(zoneOf(idx))+"-"+fmt(idx);
  var lines=[];
  if(rd) lines.push("照片读到 <b>"+fmt(idx)+"</b> · 置信 <b>"+(rd.conf!=null?Number(rd.conf).toFixed(2):"—")+"</b>");
  else lines.push("<b>"+fmt(idx)+"</b> · 无读数（推算补入）");
  if(scan.blockMode){
    var q2=scanCellXY(idxToRC(idx));
    var mp=(Math.abs(scan.pitchX)+Math.abs(scan.pitchY))/2;
    var d2=rd?Math.hypot(q2.x-rd.x*k,q2.y-rd.y*k):0;
    lines.push(d2>0 ? ("离它编号该在的网格位 <b>"+(d2/mp).toFixed(1)+"</b> 格")
                    : "位置对齐，可能是邻片读数串号");
  } else {
    lines.push("与相邻片的拼合关系对不上（编号差/间距矛盾）");
  }
  $("rvInfo").innerHTML=lines.join("<br>");
  $("rvNum").value="";
  var acts=$("rvActs"); acts.innerHTML="";
  function mk(label,title,fn,col){
    var b=document.createElement("button");
    b.className="btn ghost sm"; b.textContent=label; b.title=title;
    if(col) b.style.color=col;
    b.addEventListener("click",fn);
    acts.appendChild(b);
  }
  mk("✓ 无误","这块没问题，保留",function(){ rvAck(idx,true); },"#6cffb0");
  mk("🔍 重识别","对这块单独放大再识别一次",function(){ rvReocr(idx); });
  mk("✕ 删掉","这块不该算（误读/错位）",function(){ rvAck(idx,false); },"#ff8080");
  mk("✓ 改为输入值","用上面填的编号替换这块",function(){ rvReplace(idx); });
  drawRvZoom();
}
function rvDone(){
  $("scanRv").style.display="none";
  scan.review=null;
  recalcScan(); drawScan(); updateScanStats();
  toast("可疑点已全部审完，接着自动复核 + 延伸一遍");
  /* 可疑点审完 → 自动跑「复核漏读 + 补漏 + 延伸」：
     前两步补回 OCR 漏掉的编号，第三步把清理过误读之后的新基准往外推一圈
     （边角那几块「怎么也搞不上」的片，多半就在这一步出来）。 */
  setTimeout(function(){ autoVerify("可疑点审完", null, {extend:true}); }, 260);
}
function rvAdvance(){
  var R=scan.review; if(!R) return;
  var j=rvNextUndecided(R.i+1);
  if(j<0) j=rvNextUndecided(0);
  if(j<0){ rvDone(); return; }
  R.i=j; rvShow();
}
function rvAck(idx,keep){
  if(!scan.suspAck) scan.suspAck=new Set();
  scan.suspAck.add(idx);
  if(!keep){
    dropReading(idx,true);                       // 先记下原角度，再拉黑（别让推算补回来）
    if(scan.ocr && scan.ocr.map) scan.ocr.map.delete(idx);
  }
  recalcScan(); drawScan(); updateScanStats();
  rvAdvance();
}
function rvReplace(idx){
  var n=parsePickNum($("rvNum").value);
  if(!n||n<1||n>S.cfg.total){ toast("请输入 1 ~ "+S.cfg.total+" 的编号"); return; }
  if(n!==idx && scan.ocr.map.has(n)){ toast("第 "+n+" 块已经有读数了"); return; }
  var R=scan.review, k=scan.W/scan.ocr.w, rd=scan.ocr.map.get(idx);
  var at=(R&&R.at)?R.at:null;
  var ox=at?at.x/k:(rd?rd.x:0), oy=at?at.y/k:(rd?rd.y:0);
  dropReading(idx,true);                          // 旧号是误读：先记角度，再别算
  scan.ocr.map.delete(idx);
  insertReading(n,ox,oy);
  if(!scan.suspAck) scan.suspAck=new Set();
  scan.suspAck.add(idx);
  scan.suspAck.add(n);            // 人工改的号是权威：新旧都收进「已审」，否则新号又标红、审查永远收敛不了
  toast("已改为 "+n);
  recalcScan(); drawScan(); updateScanStats(); rvAdvance();
}
/* 「改某一块的编号」——手动改结果的正规入口（点结果块 / 审查面板都走这里）。
   改完自动判定它属于哪一块：落在拼好组里就把整组闪一下并放大过去，
   孤片就只说它在整图的第几行第几列。 */
function applyRename(old,n){
  if(!scan.ocr||!scan.ocr.map){ return; }
  if(!n||n<1||n>S.cfg.total){ toast("编号要在 1 ~ "+S.cfg.total+" 之间"); return; }
  if(n===old){ toast("编号没变（还是 "+fmt(n)+"）"); return; }
  if(scan.ocr.map.has(n)){ toast("第 "+fmt(n)+" 块已经有读数了，先把那一块改掉"); return; }
  var r=scan.ocr.map.get(old);
  var ox=r?r.x:0, oy=r?r.y:0;
  dropReading(old,true);                        // 记下原角度 + 拉黑旧号
  if(scan.ocr.map) scan.ocr.map.delete(old);
  if(scan.result) scan.result.delete(old);
  insertReading(n,ox,oy);
  recalcScan(); drawScan(); updateScanStats();
  // —— 自动识别「属于哪一块」——
  var gi=scan.grpMap?scan.grpMap[n]:null;
  var mates=(gi!=null && scan.groups&&scan.groups[gi])?scan.groups[gi]:[];
  var p=idxToRC(n), where=zoneLetter(zoneOf(n))+"区 第"+p.col+"列 第"+p.row+"行";
  var k=scan.W/scan.ocr.w;
  if(mates.length>=2){
    var others=mates.filter(function(x){ return x!==n; });
    scanFlash(mates);
    var sx=0, sy=0, cnt=0;
    mates.forEach(function(i){ var q=photoPosOf(i); if(q){ sx+=q.x; sy+=q.y; cnt++; } });
    if(cnt) scanFocusOn(sx/cnt*k, sy/cnt*k, 2.4);
    toast("已改为 "+fmt(n)+" · 和 "+others.slice(0,3).map(fmt).join("/")
      +(others.length>3?"…":"")+" 拼成一组（共 "+mates.length+" 块）");
  } else {
    scanFlash([n]);
    if(photoPosOf(n)) scanFocusOn(photoPosOf(n).x*k, photoPosOf(n).y*k, 3.0);
    toast("已改为 "+fmt(n)+" · "+where+" · 暂时没和别的片拼上");
  }
  if(scan.calibrated) scanCalTip();
  drawScan();
}
function rvReocr(idx){  var R=scan.review; if(!R||!R.at) return;
  if(!OSVC.ok){ toast("PP-OCR 未连接，无法重识别"); return; }
  var k=scan.W/scan.ocr.w, rd=scan.ocr.map.get(idx);
  var side=rd?readingSide(rd):0;
  if(!side) side=Math.min(scan.ocr.w,scan.ocr.h)/18;
  $("rvInfo").innerHTML="<b>重识别中…</b>";
  roiOCR(R.at.x/k, R.at.y/k, side).then(function(rs){
    if(!rs.length){ toast("没识别出编号"); rvShow(); return; }
    rs.sort(function(a,b){ return b.score-a.score; });
    var top=rs[0];
    if(top.idx===idx){ toast("重识别仍是 "+idx+"（置信 "+top.score.toFixed(2)+"）"); rvShow(); return; }
    if(scan.ocr.map.has(top.idx)){ toast("识别为 "+top.idx+"，但那个编号已有读数"); rvShow(); return; }
    scan.ocr.map.delete(idx);
    insertReading(top.idx, R.at.x/k, R.at.y/k);
    if(!scan.suspAck) scan.suspAck=new Set();
    scan.suspAck.add(idx);
    scan.suspAck.add(top.idx);
    toast("已改为 "+top.idx+"（置信 "+top.score.toFixed(2)+"）");
    recalcScan(); drawScan(); updateScanStats(); rvAdvance();
  });
}
function startReview(){
  var list=suspListNow();
  if(!list.length){ toast("没有待审查的可疑点"); return; }
  scan.review={list:list,i:0};
  var pr=$("scanRv"), st=$("scanStage").getBoundingClientRect();
  pr.style.left=Math.max(8, st.width-292)+"px";
  pr.style.top="10px";
  pr.style.display="block";
  rvShow();
}
$("rvPrev").addEventListener("click",function(){
  var R=scan.review; if(!R) return;
  if(R.i<=0){ toast("已经是第一块"); return; }
  R.i--; rvShow();
});
$("rvNext").addEventListener("click",function(){
  var R=scan.review; if(!R) return;
  var j=rvNextUndecided(R.i+1);
  if(j<0){ rvDone(); return; }
  R.i=j; rvShow();
});
$("rvZoomIn").addEventListener("click",function(){ rvR=Math.max(14,rvR/1.5); drawRvZoom(); });
$("rvZoomOut").addEventListener("click",function(){ rvR=Math.min(320,rvR*1.5); drawRvZoom(); });

function updateScanStats(){
  var set=scan.result||new Set(), newly=0;
  set.forEach(function(i){ if(S.states[i]!==1) newly++; });
  scan.newCount=newly;
  scan.pendingSet=previewPendingSet();
  /* 字母与编号不符的读数：片背字母是编号所在分区的重述，等于一条免费校验位。
     区间一律由 total / zoneSize 推出来（zoneRangeOf），不写死 A-D 与具体数字。 */
  scan.zoneBad=null;
  if(scan.ocr && scan.ocr.map){
    var zb=[];
    scan.ocr.map.forEach(function(r,i){ if(!numInZone(r.letter,i)) zb.push(i); });
    if(zb.length){ zb.sort(function(a,b){ return a-b; }); scan.zoneBad=zb; }
  }
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
  // 二义位（有片但编号定不下来）：工具条上给「复核漏读 N」
  var nW=(scan.weakCells&&!scan.blockMode)?scan.weakCells.length:0;
  var rb=$("bRecheck");
  if(rb){ rb.style.display=nW?"inline-block":"none"; var rn=$("recheckN"); if(rn) rn.textContent=nW; }
  // 漏识别片（前景是片、没有读数）：工具条给「补漏 N」
  var nGp=(scan.gaps?scan.gaps.length:0);
  var fb=$("bFillGaps");
  if(fb){ fb.style.display=nGp?"inline-block":"none"; var fn2=$("fillGapsN"); if(fn2) fn2.textContent=nGp; }
  // 延伸：编号读取模式下一直留着（审完可疑点会自动跑，也随时能手动再推一圈）
  var eb=$("bExtend");
  if(eb) eb.style.display=(scan.calibrated && scan.ocr && scan.ocr.map.size>=2)?"inline-block":"none";
  var det=$("scanGrpDetail");
  var parts=[];
  if(nG) scan.groups.forEach(function(m,gi){
    parts.push("<span style=\"color:"+(GRP_TXT[gi%GRP_TXT.length])+"\">组"+(gi+1)+": "+m.join(",")+"</span>");
  });
  if(nS){
    // 可疑块逐条列出来：点编号定位放大、✓ 确认无误、✕ 删掉——不必在照片上挨个找
    var chips=[], sp=scan.suspPairs||[];
    scan.suspIdx.forEach(function(i){
      chips.push('<span style="display:inline-flex;align-items:center;gap:4px;margin:3px 5px 0 0;'
        +'padding:1px 6px;border-radius:6px;background:rgba(255,90,90,.15);color:#ff9a9a">'
        +'<span data-focus="'+i+'" style="cursor:pointer;font-variant-numeric:tabular-nums">'+fmt(i)+'</span>'
        +'<b data-ack="'+i+'" title="这块没问题，别再标红" style="cursor:pointer;color:#6cffb0">✓</b>'
        +'<b data-del="'+i+'" title="这块不该算（误读/错位），删掉" style="cursor:pointer;color:#ff8080">✕</b></span>');
    });
    parts.push('<span style="color:#ff8080">⚠可疑 '+nS+'（点编号跳过去 · ✓无误 · ✕删掉）'
      +(sp.length?('　'+sp.join("、")+"…"):'')+'</span>');
    parts.push(chips.join(""));
  }
  if(scan.dupFix && scan.dupFix.length){
    /* 同一处两个编号：默认已经自动采纳了推算（网格位）那个号。
       还留在这里的是**没能自动换**的（网格位那个号在别处已经有读数了，不能抢），
       画面上仍显示读数号 —— 点编号可以强行改过去（先确认别处那条是不是读错了）。 */
    var ch=[];
    scan.dupFix.slice(0,12).forEach(function(c){
      ch.push('<span style="display:inline-flex;align-items:center;gap:4px;margin:3px 5px 0 0;'
        +'padding:1px 6px;border-radius:6px;background:rgba(255,200,80,.14);color:#ffd05a">'
        +'<span data-fix="'+c.read+'-'+c.infer+'" title="点一下：改用网格位的编号 '+fmt(c.infer)
        +'" style="cursor:pointer;font-variant-numeric:tabular-nums">'+fmt(c.read)+'⇄'+fmt(c.infer)+'</span>'
        +'</span>');
    });
    parts.push('<span style="color:#ffd05a">⚠同一处两个编号 '+scan.dupFix.length
      +'（网格位的号在别处已有读数，先留着读数 · 点编号强行改用网格位'
      +' · <b data-fixall style="cursor:pointer;color:#6cffb0">全部改用</b>）</span>');
    parts.push(ch.join(""));
  }
  if(scan.zoneBad && scan.zoneBad.length){
    var zc=[];
    scan.zoneBad.slice(0,10).forEach(function(i){
      var r=scan.ocr.map.get(i); if(!r) return;
      var rg=zoneRangeOf(r.letter), L=r.letter||"?";
      zc.push('<span style="display:inline-flex;align-items:center;gap:4px;margin:3px 5px 0 0;'
        +'padding:1px 6px;border-radius:6px;background:rgba(255,110,110,.14);color:#ff9a9a">'
        +'<span data-zone="'+i+'" title="跳到照片上这块；'+L+' 段是 '
        +(rg?rg.lo+"–"+rg.hi:"?")+'，点黄框可改号" style="cursor:pointer;font-variant-numeric:tabular-nums">'
        +L+'-'+fmt(i)+'</span></span>');
    });
    parts.push('<span style="color:#ff9a9a">⚠字母与编号不符 '+scan.zoneBad.length
      +'（字母就是分区，编号必须落在该分区段内 · 点编号跳过去改）</span>');
    parts.push(zc.join(""));
  }
  if(scan.zoneFixLog && scan.zoneFixLog.length){
    parts.push('<span style="color:#8fa3bb">已按字母分区纠正 '+scan.zoneFixLog.length+' 处：'
      +scan.zoneFixLog.slice(0,6).join("、")+(scan.zoneFixLog.length>6?"…":"")+'</span>');
  }
  if(scan.gridFixLog && scan.gridFixLog.length){
    parts.push('<span style="color:#8fa3bb">已按你的选择改用网格位编号 '
      +scan.gridFixLog.length+' 处：'+scan.gridFixLog.slice(0,6).join("、")
      +(scan.gridFixLog.length>6?"…":"")+'</span>');
  }
  if(scan.suspAuto && scan.suspAuto.length){
    // 查重自动确认的：结果里已经有这块，只确认、不删除（删了就掉块）
    parts.push('<span style="color:#8fa3bb">已自动确认 '+scan.suspAuto.length+' 个可疑（结果里已有该块，'
      +'不用人工审）：'+scan.suspAuto.slice(0,8).map(fmt).join("、")
      +(scan.suspAuto.length>8?"…":"")+'</span>');
  }
  if(scan.loosePairs && scan.loosePairs.length){
    parts.push('<span style="color:#8fa3bb">相邻但编号不邻：'
      +scan.loosePairs.slice(0,5).join("、")+(scan.loosePairs.length>5?"…":"")
      +'（散堆里两块不相干的片贴在一起就是这样，不算可疑）</span>');
  }
  det.style.display=parts.length?"block":"none";
  det.innerHTML=parts.join("<br>");
  $("bApplyScan").disabled = set.size===0;
  // 引导按钮：散块模式（编号读取）下才出现
  var guideMode = set.size>0 && scan.ocr && scan.ocr.map.size>=2;
  $("bApplyGuide").style.display = guideMode ? "block" : "none";
  $("bApplyGuide").disabled = set.size===0;
  // 「应用」始终在：「引导摆放」是逐条走一遍的可选流程，不该把直接应用顶掉
  $("bApplyScan").style.display="block";
  // 有可疑点 → 「应用」变成「下一步」：先逐块审查，审完才允许应用
  var bA=$("bApplyScan");
  if(nS) bA.textContent="下一步：审查可疑 "+nS;
  else bA.textContent="应用识别结果";
  if(autoChain){                       // 自动复核还没跑完：先别让人应用半成品
    bA.disabled=true; $("bApplyGuide").disabled=true;
  }
}
/* 「同一处两个编号」裁决：默认保留读数，这里改成网格位那个号（用户判断 OCR 读错时点）。
   只换号、不动位置与角度 → 不产生空洞。 */
function useGridNum(list){
  var done=0;
  (list||[]).forEach(function(c){
    var rd=scan.ocr.map.get(c.read); if(!rd) return;
    if(scan.ocr.map.has(c.infer) && c.infer!==c.read) return;   // 目标号另有读数：不抢
    var L0=rd.letter;
    dropReading(c.read,true);                                   // 旧号记角度 + 拉黑
    scan.ocr.map.delete(c.read);
    // 原地换号（沿用这条读数的 comps/角度，片没换）
    rd.idx=c.infer; rd.digits=fmt(c.infer); rd.zoneFix=c.read; rd.conf=1;
    rd.letter=(L0&&numInZone(L0,c.infer))?L0:zoneLetter(zoneOf(c.infer));
    scan.ocr.map.set(c.infer, rd);
    done++;
  });
  if(!done) return 0;
  scan.gridFixLog=(scan.gridFixLog||[]).concat(list.slice(0,done).map(function(c){
    return c.read+"→"+c.infer; }));
  recalcScan(); drawScan(); updateScanStats();
  return done;
}
/* 可疑块审核：点编号跳过去 / ✓ 无误 / ✕ 删掉（一次把 5 个过完，不用在照片上找） */
$("scanGrpDetail").addEventListener("click",function(e){
  var t=e.target.closest?e.target.closest("[data-ack],[data-del],[data-focus],[data-fix],[data-fixall],[data-zone]"):null;
  if(!t||!scan.calibrated) return;
  var znV=t.getAttribute("data-zone");
  if(znV!=null){
    var zi=+znV, zp=photoPosOf(zi), zk=scan.W/scan.ocr.w;
    if(zp) scanFocusOn(zp.x*zk, zp.y*zk, 3.4);
    var zr=scan.ocr.map.get(zi), zz=zoneRangeOf(zr&&zr.letter);
    toast("第 "+zi+" 块："+(zr&&zr.letter?zr.letter:"?")+" 段是 "+(zz?zz.lo+"–"+zz.hi:"?")
      +"，这个号不在段内 — 点黄框改号");
    return;
  }
  var fxV=t.getAttribute("data-fix");
  if(fxV!=null){
    var ab=fxV.split("-");
    var n0=useGridNum([{ read:+ab[0], infer:+ab[1] }]);
    toast(n0 ? ("第 "+ab[0]+" 块已改用网格位的编号 "+ab[1])
             : (scan.ocr.map.has(+ab[1]) ? ("第 "+ab[1]+" 块在别处已经有读数了，先去确认那一条")
                                         : "这块改不了"));
    return;
  }
  if(t.getAttribute("data-fixall")!=null){
    var n1=useGridNum((scan.dupFix||[]).slice());
    toast(n1? ("已全部改用网格位的编号（"+n1+" 处）") : "没有可改的（网格位的号都已被别处占用）");
    return;
  }
  var ackV=t.getAttribute("data-ack"), delV=t.getAttribute("data-del"), focV=t.getAttribute("data-focus");
  if(ackV!=null){
    scan.suspAck.add(+ackV); recalcScan(); drawScan();
    toast("第 "+ackV+" 块：已确认无误");
  } else if(delV!=null){
    var i=+delV;
    scan.suspAck.add(i);                             // 删掉之后也别再标红
    dropReading(i,true);                             // 先记原角度，再拉黑
    if(scan.ocr&&scan.ocr.map) scan.ocr.map.delete(i);
    if(scan.result) scan.result.delete(i);
    recalcScan(); drawScan();
    toast("第 "+i+" 块：已删除");
  } else if(focV!=null){
    var i2=+focV, kk=scan.W/scan.ocr.w, p=null;
    if(scan.ocr&&scan.ocr.map.has(i2)){ var r2=scan.ocr.map.get(i2); p={x:r2.x*kk,y:r2.y*kk}; }
    else if(scan.inferredPos&&scan.inferredPos[i2]){ p={x:scan.inferredPos[i2].x*kk,y:scan.inferredPos[i2].y*kk}; }
    if(p){ scanFocusOn(p.x,p.y,3.4); drawScan(); }
  }
});

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

function openPick(p,clientX,clientY,add,cands,ren,opt){
  opt=opt||{};
  scan.picking={x:p.x,y:p.y,add:!!add,ren:(ren==null?null:ren),
                inferred:(opt.inferred==null?null:opt.inferred), weak:opt.weak||null,
                restore:(opt.restore==null?null:opt.restore),
                cell:(opt.cell==null?null:opt.cell)};
  var pr=$("scanPick");
  pr.classList.add("on");
  var h4=pr.querySelector("h4");
  if(h4) h4.textContent = (ren!=null)
    ? ("这块现在记成 "+fmt(ren)+" · 改成正确的编号")
    : (scan.picking.restore!=null)
      ? ("这块你删掉了（原本记成 "+fmt(scan.picking.restore)+"）· 补回来？")
      : (scan.picking.cell!=null)
        ? ("这个格子该是 "+fmt(scan.picking.cell)+"，但它没算进来 · 确认补上？")
        : (scan.picking.inferred!=null)
          ? ("这块是推算出来的（"+fmt(scan.picking.inferred)+"）· 没读到编号")
          : (scan.picking.weak)
            ? "这处有片、但编号认不准 · 输入编号或删掉这处提示"
            : (add ? "这块拼图上印的数字（补进结果）" : "这一块上印的数字");
  // 「删掉」适用范围：改已有结果 / 推算块 / 认不准提示（都能删）
  var pdl=$("pickDel");
  if(pdl) pdl.style.display =
    (ren!=null || scan.picking.inferred!=null || scan.picking.weak) ? "inline-block" : "none";
  // 推算块没有原文可改：输入框/结果提示/确定都收起来，只留「删掉」
  var onlyDel = scan.picking.inferred!=null;
  ["pickNum","pickRes","pickOk"].forEach(function(id){
    var el=$(id); if(el) el.style.display = onlyDel ? "none" : "";
  });
  // 二义位：把候选编号直接摆出来点一下就行（几何上只可能是这几个之一）
  var cd=$("pickCands");
  if(cd){
    cd.innerHTML="";
    if(add && cands && cands.length){
      cd.style.display="flex";
      var tip=document.createElement("div");
      tip.style.cssText="width:100%;font-size:11px;color:#8ea0b5;margin-bottom:2px";
      tip.textContent = cands.length>2 ? "几何上只可能是这 4 个之一，点选："
        : cands.length===2 ? "几何上二选一，点选："
        : "OCR 读到了但置信度不足，确认是这块吗？";
      cd.appendChild(tip);
      cands.forEach(function(i){
        var b=document.createElement("button");
        b.className="btn ghost sm";
        b.style.cssText="min-width:64px;font-variant-numeric:tabular-nums";
        b.textContent=fmt(i);
        b.addEventListener("click",function(){
          $("pickNum").value=String(i); updatePickRes();
          $("pickOk").click();
        });
        cd.appendChild(b);
      });
    } else cd.style.display="none";
  }
  var stage=$("scanStage").getBoundingClientRect();
  var left=clientX-stage.left+14, top=clientY-stage.top+14;
  if(left+290>stage.width) left=clientX-stage.left-300;
  if(top+420>stage.height) top=Math.max(8,clientY-stage.top-420);
  pr.style.left=Math.max(8,left)+"px";
  pr.style.top=Math.max(8,top)+"px";
  $("pickNum").value = (ren!=null) ? String(ren)
    : (scan.picking.restore!=null) ? String(scan.picking.restore)
    : (scan.picking.cell!=null) ? String(scan.picking.cell) : "";
  var okb=$("pickOk");
  if(okb) okb.textContent = (scan.picking.restore!=null) ? "补回来"
    : (scan.picking.cell!=null) ? "补上" : "确定";
  updatePickRes();
  drawPickZoom();
  if(!onlyDel) setTimeout(function(){ try{ $("pickNum").focus(); }catch(err){} },60);
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
    if(i!==null){
      // 先不执行增删：单击=改这块的编号，拖动=连续刷（pointermove 里再刷）
      scanDrag.cell=i; scanDrag.del=scan.result.has(i); scanDrag.last=i;
    }
    else if(scan.ocr && scan.ocr.map.size>=2){
      scanDrag.addPt=p;                                  // 点空白片 → 补一块
      var wh=weakHit(p);
      if(wh){ scanDrag.weak=wh.w; scanDrag.addPt=wh.pt; } // 命中二义位/漏读位 → 对齐到片心
    }
  }
  /* 二义位 / 漏读位（「认不准」的黄虚线、灰虚线「?」）**任何模式下都能点** ——
     用户要「不用切增删模式，移动的时候直接点」。只有真正命中提示才记 addPt，
     所以移动模式下点空白处仍然是纯平移，不会弹出补块浮层。 */
  else if(scan.calibrated && inside && scan.mode==="move" && scan.ocr && scan.ocr.map.size>=2){
    var wh2=weakHit(p);
    if(wh2){ scanDrag.weak=wh2.w; scanDrag.addPt=wh2.pt; }
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
    /* 拖动过程中只重画、不 recalc：整块模式的重算会把 blockMode 判掉（框弹回原位），
       而且每帧跑一遍前景蔓延很卡。松手在 endScanPointer 里补一次完整重算。 */
    scan.gridAdj=true;
    drawScan();
    return;
  }
  if(scan.calibrated && scan.mode==="edit"){
    var p=scanImgXY(e.clientX,e.clientY);
    if(p.x<0||p.y<0||p.x>scan.W||p.y>scan.H) return;
    if(scanDrag.cell!=null){ scanToggleCell(scanDrag.cell,scanDrag.del); scanDrag.cell=null; }
    var i=scanHitIdx(p.x,p.y);
    if(i!==null && i!==scanDrag.last){ scanDrag.last=i; scanToggleCell(i,scanDrag.del); }
  } else {
    scan.ox=scanDrag.ox+dx; scan.oy=scanDrag.oy+dy; layoutScanView();
  }
});

/* 命中「认不准/漏读」提示：返回 {w, pt}（pt 已换算到 scan 工作坐标，对齐到片心）。
   二义位带 cands（几何上只可能是这几个之一），漏读位 cands=null。 */
function weakHit(p){
  if(!scan.ocr||!scan.ocr.w) return null;
  var kk=scan.W/scan.ocr.w, wc=null;
  (scan.weakCells||[]).forEach(function(w){
    if(wc) return;
    if(Math.hypot(w.x*kk-p.x, w.y*kk-p.y) < Math.max(16,w.side*kk*0.8)) wc=w;
  });
  if(!wc) (scan.gaps||[]).forEach(function(g){        // 命中灰虚线「?」
    if(wc) return;
    if(Math.hypot(g.x*kk-p.x, g.y*kk-p.y) < Math.max(16,g.side*kk*0.8)){
      wc={x:g.x, y:g.y, side:g.side, cands:null};
    }
  });
  return wc?{ w:wc, pt:{x:wc.x*kk, y:wc.y*kk} }:null;
}

function endScanPointer(e){
  scanPtr.delete(e.pointerId);
  if(scanPinch){ if(scanPtr.size<2) scanPinch=null; scanDrag=null; return; }
  if(!scanDrag||scanDrag.id!==e.pointerId) return;
  var d=scanDrag; scanDrag=null;
  if(d.moved){
    // 微调网格拖动结束：补一次完整重算（拖动过程中只重画，见 pointermove）
    if(scan.calibrated && scan.mode==="grid"){ recalcScan(); drawScan(); updateScanStats(); }
    return;                       // 拖过 = 平移照片/挪网格，不当作选点
  }
  if(!scan.calibrated){
    if(scan.anchors.length>=2){ toast("已标定两块，点「重新标定」可重来"); return; }
    if(d.inside) openPick(d.pt,e.clientX,e.clientY);   // 只有点在照片范围内才选锚点
  } else if(d.cell!=null && scan.mode==="edit"){
    /* 单击已有结果：改这块的编号（改完自动判定它属于哪一组）。
       注意坐标系：photoPosOf 给的是 **OCR 工作坐标**（≈3072 宽），
       浮层放大镜吃的是 **scan 工作坐标**（scan.W），必须乘 k 换算，
       否则采样点偏到画面外 → 预览是一片黑。 */
    var kk=(scan.ocr&&scan.ocr.w)?(scan.W/scan.ocr.w):1;
    /* 放大镜摆在**你点的那块**上。别用 photoPosOf 去查：它按编号查，而编号只此一个，
       读数位与推算位会互相顶替——补点时就会弹出「之前 OCR 那个点」的原图。
       只有这一格确实有这条读数时才用读数的坐标（那就是同一块）。 */
    var rd0=scan.ocr?scan.ocr.map.get(d.cell):null;
    var pt0=rd0?{x:rd0.x*kk, y:rd0.y*kk}:{x:d.pt.x, y:d.pt.y};
    if(scan.ocr && scan.ocr.map.has(d.cell)) openPick(pt0,e.clientX,e.clientY,false,null,d.cell);
    /* 删掉一块后，那一格会立刻被推算成邻居的号（277 删了 → 777 顶上来）：再点它
       就变成「推算块 777」，原来的号再也点不回来（用户：『补回 277/476，另一个地方
       突然也出现了这两个点』）。所以先看看落点附近有没有刚删掉、位置还记着的编号
       —— 有就优先给「补回来」。 */
    else if(dropNear(pt0)!=null)
      openPick(pt0,e.clientX,e.clientY,false,null,null,{restore:dropNear(pt0)});
    else if(scan.inferredPos && scan.inferredPos[d.cell])
      openPick(pt0,e.clientX,e.clientY,false,null,null,{inferred:d.cell});   // 推算块：只能删
    /* 删掉的块（读数进了 ocr.drop，或推算块进了 inferDrop）：以前这两条都不满足 →
       点什么都没反应。现在给出「补回来」，位置用 keep 里记的原坐标（放大镜也摆对）。 */
    else if(scan.ocr && ((scan.ocr.drop && scan.ocr.drop.has(d.cell))
                      || (scan.inferDrop && scan.inferDrop.has(d.cell))))
      openPick(pt0,e.clientX,e.clientY,false,null,null,{restore:d.cell});
    /* 整块模式：网格位就是编号。这块照片上确实有片（点得到格子）却没算进结果
       ——贴边压着地板、压在阴影带里的片，前景判据过不了，光「增删」根本补不上
       （以前这里什么都不弹，用户说「点了它什么反应都没有」）。 */
    else if(scan.blockMode){
      var q0=scanCellXY(idxToRC(d.cell));
      openPick(q0,e.clientX,e.clientY,true,null,null,{cell:d.cell});
    }
  } else if(d.addPt){
    /* 点空白片 → 补编号（命中二义位/漏读位时带候选与「删掉这处提示」）。
       移动模式下只有真正命中提示才会走到这里（见 scanDown），不必切到增删模式。
       散块模式下 scanHitIdx 只认「现有读数/推算位」，刚删掉的那块在照片上是空白的，
       会走到这里 —— 落点附近有已删除的编号时直接给「补回来」，不用重新输一遍。 */
    var dc=dropNear(d.addPt);
    if(dc!=null){
      openPick(d.addPt,e.clientX,e.clientY,false,null,null,{restore:dc});   // 原图用点的位置
    } else openPick(d.addPt,e.clientX,e.clientY,true, d.weak?d.weak.cands:null,null,
      d.weak?{weak:d.weak}:null);
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
    $("scanTip").textContent="增删模式：点已有的块 = 改这块的编号 · 点空白片 = 补一块 · 按住拖动 = 连续增删";
  } else if(m==="grid"){
    var ocrM = scan.ocr && scan.ocr.map.size>=2;
    $("scanTip").textContent = (!ocrM || scan.blockMode)
      ? "微调模式：拖动平移网格（结果框跟着格子走），或用下方方向键"
      : "微调模式：拖动平移网格 · 散块照片上结果框贴在读数处，网格只影响推算/增删";
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
  else if(b.id==="bRecheck") recheckWeak();
  else if(b.id==="bFillGaps") fillGaps();
  else if(b.id==="bExtend"){
    if(extLv) toast("已经延伸过了（再点不会多推；改完结果会自动重算）");
    else extendInfer();
  }
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
    scan.gridAdj=false;
    if(solveScan(!scan.rot)) scanCalTip();
    drawScan();
    return;
  }
  scan.gridAdj=true;            // 人工微调过：整块模式不再被自动裁决推翻（见 recalcScan）
  recalcScan(); drawScan();
});

$("pickCancel").addEventListener("click",function(){
  scan.picking=null; $("scanPick").classList.remove("on");
});
$("pickDel").addEventListener("click",function(){
  var P=scan.picking; if(!P) return;
  if(P.ren==null && P.inferred==null && !P.weak) return;
  scan.picking=null; $("scanPick").classList.remove("on");
  // ① 已有读数（含复核漏读/补漏/人工补进来的）：编号进黑名单，读数与结果一起删
  if(P.ren!=null){
    var old=P.ren;
    dropReading(old,true);
    if(scan.ocr&&scan.ocr.map) scan.ocr.map.delete(old);
    if(scan.result) scan.result.delete(old);
    recalcScan(); drawScan(); updateScanStats();
    if(scan.calibrated) scanCalTip();
    toast("已删掉 "+fmt(old)+"（点空白片可以重新补回来）");
    return;
  }
  // ② 推算块（整块模式按前景蔓延推出来的，OCR 没读到）：只进黑名单，不再推算它
  if(P.inferred!=null){
    if(!scan.inferDrop) scan.inferDrop=new Set();
    scan.inferDrop.add(P.inferred);
    if(scan.result) scan.result.delete(P.inferred);
    recalcScan(); drawScan(); updateScanStats();
    toast("已删掉推算块 "+fmt(P.inferred)+"（不会再推算它）");
    return;
  }
  // ③ 二义位/漏读位的黄色「?」提示：忽略这个位置，不再弹提示
  if(P.weak){
    if(!scan.weakDrop) scan.weakDrop=[];
    scan.weakDrop.push({x:P.weak.x, y:P.weak.y});
    // 漏读位（灰虚线「?」）走的是 gapTried 那条屏蔽链，两份名单都写，删了就不会再冒出来
    if(!P.weak.cands){ if(!scan.gapTried) scan.gapTried=[]; scan.gapTried.push({x:P.weak.x, y:P.weak.y}); }
    recalcScan(); drawScan(); updateScanStats();
    toast("已忽略这处「认不准」提示");
  }
});
$("pickOk").addEventListener("click",function(){
  if(!scan.picking) return;
  var idx=updatePickRes();
  if(!idx){ toast("请输入拼图块上印的数字（1 ~ "+S.cfg.total+"）"); return; }
  if(scan.picking.ren!=null){                      // 「改号」：替换读数 + 自动判定属于哪一块
    var old=scan.picking.ren;
    scan.picking=null; $("scanPick").classList.remove("on");
    applyRename(old,idx);
    return;
  }
  if(scan.picking.restore!=null){                  // 「补回来」：删掉的块按原位置/原角度恢复
    var ro=scan.picking.restore, rp={x:scan.picking.x,y:scan.picking.y};
    scan.picking=null; $("scanPick").classList.remove("on");
    restoreReading(ro,idx,rp);
    return;
  }
  if(scan.picking.cell!=null){                     // 整块模式补这一格（编号默认＝格子编号）
    var cp={x:scan.picking.x,y:scan.picking.y};
    scan.picking=null; $("scanPick").classList.remove("on");
    if(!scan.ocr.map.has(idx)) addManualReading(idx,cp.x,cp.y);
    else toast("第 "+fmt(idx)+" 块已经有读数了");
    return;
  }
  if(scan.picking.inferred!=null){                 // 推算块浮层只有「删掉」，确定键不该生效
    scan.picking=null; $("scanPick").classList.remove("on"); return;
  }
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
      if(S.states[i]===1 && !mainSet.has(i)){ S.states[i]=3; }
    });
    // 已有的待定块如果这次连上了主片，转完成
    promoteConnected().forEach(function(c){ if(!orig.has(c[0])) orig.set(c[0],c[1]); });
    /* 待定数在 promoteConnected 之后数（先数会把已经被转回完成的也报进去） */
    orig.forEach(function(v,i){ if(S.states[i]===3) demoted++; });
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
  if(scan.weakCells&&scan.weakCells.length) msg+="（还有 "+scan.weakCells.length+" 处待选没算进去）";
  toast(msg);
  vibrate(30);
  return { targets:targets, applied:applied, demoted:demoted };
}

$("bApplyScan").addEventListener("click",function(){
  // 还有可疑点：先走逐块审查，审完再应用（避免带着 12 个红框直接铺到主界面）
  if(scan.suspIdx && scan.suspIdx.size){ startReview(); return; }
  applyScanCore();
});

$("bApplyGuide").addEventListener("click",function(){
  /* 「引导摆放」：**不**先把结果全铺到棋盘——那样一进引导就已经全绿了。
     这里只把「还没拼上」的块排成队列，用户在引导里点「放好了」才一条条落库。 */
  if(!scan.result||!scan.result.size){ toast("还没有识别结果"); return; }
  var targets=[];
  scan.result.forEach(function(i){ if(S.states[i]!==1) targets.push(i); });
  if(!targets.length) targets=Array.from(scan.result);
  $("ovScan").classList.remove("on");        // 先回棋盘，引导在棋盘上看
  if(S.batchMode) exitBatch();               // 引导与批量互斥
  startGuide(targets);
});
/* Esc 关闭放大选点面板（main.js 键盘处理用） */
export function cancelPick(){
  scan.picking=null; $("scanPick").classList.remove("on");
  if(scan.review){ scan.review=null; $("scanRv").style.display="none"; }
}

/* ---- 引导浮条的两个注入口（main.js 接线，避免 scan↔guide 循环 import）---- */

/* 哪些块其实同属一个「拼好组」：引导里一组算一条，不用一块一块走 */
export function scanGuideInfo(){
  var grpOf={};
  if(scan.grpMap){ for(var k in scan.grpMap){ if(scan.grpMap[k]!=null) grpOf[k]=scan.grpMap[k]; } }
  if(scan.inferredPos){ for(var k2 in scan.inferredPos){
    if(grpOf[k2]==null && scan.inferredPos[k2].grp!=null) grpOf[k2]=scan.inferredPos[k2].grp; } }
  /* block：整块模式（网格可信）→ 引导排队时允许把没组的块顺着 4 邻并进相邻组 */
  return { grpOf:grpOf, nGroups:(scan.groups?scan.groups.length:0), block:!!scan.blockMode };
}

/* 照片小窗 = **整张输入照片 + 目标所在位置**（地图思路：先看全貌，再找钉子）。
   以前是裁目标周围的一小块——只看到局部，看不出这块在整张照片的哪个角落，
   换一条目标时画面整块跳走，完全没有"我进行到哪儿了"的感觉。
   现在：整图按 contain 铺进小窗（**不裁剪、不转正/不旋转**，保持拍下来的原始方向），
   其余压暗、目标那一小块原样重画提亮，再套金色框 + 每块中心一个点。 */
export function scanGuideDraw(cv, ids){
  var ctx=cv.getContext("2d"), W=cv.width, H=cv.height;
  ctx.clearRect(0,0,W,H);
  if(!scan.img||!scan.ocr) return false;
  var iw=scan.img.width, ih=scan.img.height;
  if(!(iw>0&&ih>0)) return false;
  ctx.fillStyle="#0b0f08"; ctx.fillRect(0,0,W,H);
  var s=Math.min(W/iw, H/ih), dw=iw*s, dh=ih*s, ox=(W-dw)/2, oy=(H-dh)/2;
  try{ ctx.drawImage(scan.img, ox, oy, dw, dh); }catch(err){ return false; }
  var k=iw/scan.ocr.w, pts=[];
  (ids||[]).forEach(function(i){
    var p=photoPosOf(i); if(!p) return;
    if(!p.s) p.s=Math.min(scan.ocr.w,scan.ocr.h)/18;
    pts.push({ x:p.x*k, y:p.y*k, s:p.s*k });
  });
  if(!pts.length) return true;                  // 整图照画，只是这一条没有可钉的位置
  var bx=1e9, by=1e9, ex=-1e9, ey=-1e9;
  pts.forEach(function(p){ var hs=(p.s||0)*0.6;
    if(p.x-hs<bx) bx=p.x-hs; if(p.y-hs<by) by=p.y-hs;
    if(p.x+hs>ex) ex=p.x+hs; if(p.y+hs>ey) ey=p.y+hs; });
  function tx(x){ return ox+x*s; } function ty(y){ return oy+y*s; }
  var wx0=tx(bx), wy0=ty(by), wx1=tx(ex), wy1=ty(ey);
  /* 整图缩到小窗后，一块拼图只剩两三个像素 —— 给标记一个最小可视尺寸，
     钉得住（看得见在哪），又不至于盖住半张图。 */
  var MIN=Math.max(14, Math.min(dw,dh)*0.20);
  if(wx1-wx0<MIN){ var cx=(wx0+wx1)/2; wx0=cx-MIN/2; wx1=cx+MIN/2; }
  if(wy1-wy0<MIN){ var cy=(wy0+wy1)/2; wy0=cy-MIN/2; wy1=cy+MIN/2; }
  wx0=Math.max(ox,wx0); wy0=Math.max(oy,wy0);
  wx1=Math.min(ox+dw,wx1); wy1=Math.min(oy+dh,wy1);
  // 压暗 → 目标区原样重画提亮（地图上的高亮块）
  ctx.fillStyle="rgba(6,10,8,.46)"; ctx.fillRect(ox,oy,dw,dh);
  var ix0=(wx0-ox)/s, iy0=(wy0-oy)/s, isw=(wx1-wx0)/s, ish=(wy1-wy0)/s;
  var sx0=Math.max(0,ix0), sy0=Math.max(0,iy0);
  var sw=Math.min(iw,ix0+isw)-sx0, sh=Math.min(ih,iy0+ish)-sy0;
  if(sw>1&&sh>1) ctx.drawImage(scan.img, sx0,sy0,sw,sh, tx(sx0),ty(sy0), sw*s, sh*s);
  ctx.strokeStyle="rgba(255,214,80,.98)"; ctx.lineWidth=Math.max(1.6,W*0.018);
  ctx.strokeRect(wx0,wy0,wx1-wx0,wy1-wy0);
  var pad=Math.max(3,W*0.045);
  ctx.strokeStyle="rgba(255,214,80,.40)"; ctx.lineWidth=Math.max(1,W*0.010);
  ctx.strokeRect(wx0-pad,wy0-pad,(wx1-wx0)+pad*2,(wy1-wy0)+pad*2);
  pts.forEach(function(p){
    ctx.fillStyle="rgba(255,233,168,.95)";
    ctx.beginPath(); ctx.arc(tx(p.x),ty(p.y),Math.max(1.4,W*0.013),0,6.2832); ctx.fill();
  });
  return true;
}
