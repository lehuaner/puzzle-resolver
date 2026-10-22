import { S } from "./store.js";
import { $, toast, vibrate } from "./dom.js";
import { fmt, idxToRC, rcToIdx, zoneOf, zoneLetter, zoneCount } from "./coords.js";
import { neighborKind, promoteConnected } from "./grid.js";
import { focusSet, setView, placeMinimap, paint, afterChange } from "./board.js";
import { pushUndo } from "./interact.js";
import { markChange } from "./sync.js";
import { beaconShow, beaconHide } from "./beacon.js";

/* ================= 找点 ================= */
var fZone="all", fState="all";

export function buildChips(){
  var zc=zoneCount();
  var hz='<span class="lb">大区</span><button class="chip'+(fZone==="all"?" on":"")+'" data-z="all">全部</button>';
  for(var z=0;z<zc;z++){
    hz+='<button class="chip'+(fZone===String(z)?" on":"")+'" data-z="'+z+'">'+zoneLetter(z)+'区</button>';
  }
  $("chipsZone").innerHTML=hz;
  var sts=[["all","不限"],["0","未拼"],["1","已拼"],["p","待定"],["2","进行中"]];
  var hs='<span class="lb">状态</span>';
  sts.forEach(function(s){
    hs+='<button class="chip'+(fState===s[0]?" on":"")+'" data-s="'+s[0]+'">'+s[1]+'</button>';
  });
  $("chipsState").innerHTML=hs;
}

function scoreOf(i,q){
  if(!q) return 1;
  var num=String(i), pad=fmt(i), z=zoneOf(i), Z=zoneLetter(z), p=idxToRC(i), m;

  m=q.match(/^([A-Z])(\d{1,4})$/);
  if(m){
    var zi=m[1].charCodeAt(0)-65, n=parseInt(m[2],10), gi=zi*S.cfg.zoneSize+n;
    if(i===gi) return 100;
    if(zi===z && String(n)===num) return 92;
    if(zi===z && num.indexOf(String(n))===0) return 55;
    return 0;
  }
  if(/^[A-Z]$/.test(q)) return Z===q?50:0;
  m=q.match(/^(\d{1,4})-(\d{1,4})$/);
  if(m){
    var a=parseInt(m[1],10), b=parseInt(m[2],10);
    return (i>=Math.min(a,b)&&i<=Math.max(a,b))?70:0;
  }
  m=q.match(/^(R|行)(\d{1,3})$/); if(m) return p.row===parseInt(m[2],10)?45:0;
  m=q.match(/^(C|列)(\d{1,3})$/); if(m) return p.col===parseInt(m[2],10)?45:0;
  if(/^\d{1,4}$/.test(q)){
    var qn=String(parseInt(q,10));
    if(num===qn) return 100;
    if(pad.indexOf(q)===0) return 88;
    if(num.indexOf(qn)!==-1) return 62;
    return 0;
  }
  return 0;
}

export function runSearch(){
  var q=($("q").value||"").trim().toUpperCase().replace(/\s+/g,"");
  var hits=[];
  for(var i=1;i<=S.cfg.total;i++){
    if(fZone!=="all" && String(zoneOf(i))!==fZone) continue;
    if(fState!=="all"){
      var sv=S.states[i];
      if(fState==="p"){ if(sv!==3&&sv!==4) continue; }
      else if(String(sv)!==fState) continue;
    }
    var sc=scoreOf(i,q);
    if(sc>0) hits.push({i:i,sc:sc});
  }
  hits.sort(function(a,b){ return b.sc!==a.sc ? b.sc-a.sc : a.i-b.i; });
  $("hitCount").textContent=hits.length;
  var stName={"all":"全部状态","0":"未拼","1":"已拼","2":"进行中","p":"待定"};
  var zName=fZone==="all"?"全部大区":zoneLetter(parseInt(fZone,10))+"区";
  $("scopeText").textContent=zName+" · "+stName[fState]+" · 共 "+S.cfg.total+" 块";

  var box=$("results");
  if(hits.length===0){
    box.innerHTML='<div class="empty">没有符合条件的拼图块<br>试试换个编号，或放宽大区 / 状态筛选</div>';
    return;
  }
  var limit=Math.min(hits.length,240), html="";
  for(var k=0;k<limit;k++){
    var i2=hits[k].i, p=idxToRC(i2), st=S.states[i2];
    var stTxt = st===1?"已拼" : st===2?"进行中" : st===3?"待定" : st===4?"孤片" : "未拼";
    html+='<button class="ritem" data-i="'+i2+'">'
      +'<span class="rn">'+fmt(i2)+'</span>'
      +'<span class="rz">'+zoneLetter(zoneOf(i2))+'区</span>'
      +'<span class="rp">第 '+p.col+' 列 · 第 '+p.row+' 行</span>'
      +'<span class="rs s'+st+'">'+stTxt+'</span></button>';
  }
  if(hits.length>limit){
    html+='<div class="empty">仅显示前 '+limit+' 条（共 '+hits.length+' 条）<br>继续输入编号或选大区来缩小范围</div>';
  }
  box.innerHTML=html;
}

/* 找到点之后的高亮：与「引导摆放」同一套 —— 亮的那一相是图例里的「进行中」
   （绿底呼吸闪），灭相退回真实状态色，位置靠常驻绿描边钉住。9 秒后自动收掉。
   引导进行中时不抢它的目标（同一时刻只能有一组高亮）。 */
var beaconTimer=null;
export function flashFound(i){
  if(S.guideActive) return;
  clearTimeout(beaconTimer);
  beaconShow([i]);
  beaconTimer=setTimeout(function(){
    beaconHide();
    placeMinimap();
  },9000);
  placeMinimap();
}

// 区域高亮：给一组块画外沿边框（与相邻高亮块共用的边不画），不规则形状也连成一条完整轮廓
var regionTimer=null;
export function flashRegion(list,ms){
  var set=new Set(list), els=[];
  set.forEach(function(i){
    var el=S.cells[i]; if(!el) return;
    var p=idxToRC(i);
    function nb(dr,dc){
      var r=p.row+dr, c=p.col+dc;
      if(r<1||c<1||r>S.rows||c>S.cfg.cols) return -1;
      return rcToIdx(r,c);
    }
    el.classList.add("hl");
    if(!set.has(nb(-1,0))) el.classList.add("hb-t");
    if(!set.has(nb(0,1)))  el.classList.add("hb-r");
    if(!set.has(nb(1,0)))  el.classList.add("hb-b");
    if(!set.has(nb(0,-1))) el.classList.add("hb-l");
    els.push(el);
  });
  if(!els.length) return;
  clearTimeout(regionTimer);
  regionTimer=setTimeout(function(){
    for(var k=0;k<els.length;k++) els[k].classList.remove("hl","hb-t","hb-r","hb-b","hb-l");
    placeMinimap();
  }, ms||9000);
  placeMinimap();
}

export function locate(i){
  var z=String(zoneOf(i));
  var p=idxToRC(i);
  var needSwitch=(S.viewZone!=="all" && S.viewZone!==z);
  if(needSwitch) setView("all");   // 跨区查找时回到全局，避免被大区边界锁住

  // 找点规则：未拼的块，只要不挨着主片区（已完成1 / 待定3），就归到孤片待定(4)
  //   · 谁也不挨        → 孤片
  //   · 只挨着孤片(4)    → 并入这个孤片小岛，同样标 4
  //   · 挨着主片区       → 保持原样，用下面的定位卡自己决定状态
  var autoPend=false, kind=neighborKind(i);
  if(S.states[i]===0 && !kind.main){
    pushUndo([[i,0]]);
    S.states[i]=4; paint(i); markChange(i); afterChange();
    autoPend=true;
  }

  // 先亮定位卡再去聚焦：focusSet 要量它盖住了画面底部多少，才能把目标居中到没被压住的地方
  showLocCard(i);
  if(needSwitch){
    setTimeout(function(){ focusSet([i]); flashFound(i); },60);
  } else {
    focusSet([i]);
    flashFound(i);
  }
  closeSearch();
  if(autoPend) toast(fmt(i)+(kind.lone?" 挨着孤片区 · ":" 不挨着已拼区域 · ")+"已标为孤片待定");
  else toast(fmt(i)+" · "+zoneLetter(zoneOf(i))+"区 第"+p.col+"列 第"+p.row+"行");
  vibrate(20);
}

/* ---------- 定位卡：找到点之后就地改状态 ---------- */
var locIdx=0;
export function showLocCard(i){
  if(!i) return;
  locIdx=i;
  document.body.classList.add("locon");
  renderLocCard();
}
export function renderLocCard(){
  if(!locIdx) return;
  var p=idxToRC(locIdx), st=S.states[locIdx], el=$("lcState");
  $("lcNum").textContent=fmt(locIdx);
  $("lcInfo").textContent=zoneLetter(zoneOf(locIdx))+"区 第"+p.col+"列 第"+p.row+"行";
  el.textContent = st===1?"已完成" : st===2?"进行中" : st===3?"待定片" : st===4?"孤片待定" : "未拼";
  el.className="lc-st s"+st;
  var bs=document.querySelectorAll("#locCard .lc-btns button[data-t]");
  for(var k=0;k<bs.length;k++){
    bs[k].classList.toggle("on", parseInt(bs[k].dataset.t,10)===st);
  }
}
export function hideLocCard(){ locIdx=0; document.body.classList.remove("locon"); }

$("locCard").addEventListener("click",function(e){
  // 点左边编号区：重新居中并再闪一次
  var m=e.target.closest?e.target.closest(".lc-main"):null;
  if(m){
    if(locIdx){ focusSet([locIdx]); flashFound(locIdx); vibrate(15); }
    return;
  }
  var b=e.target.closest?e.target.closest("button"):null; if(!b) return;
  if(b.id==="lcClose"){ hideLocCard(); return; }
  if(!locIdx) return;
  var t=parseInt(b.dataset.t,10);
  if(!isFinite(t) || S.states[locIdx]===t) return;
  var orig=new Map();
  orig.set(locIdx,S.states[locIdx]);
  S.states[locIdx]=t;
  if(t===1){ promoteConnected().forEach(function(c){ if(!orig.has(c[0])) orig.set(c[0],c[1]); }); }
  orig.forEach(function(v,k){ paint(k); markChange(k); });
  pushUndo(Array.from(orig.entries()));
  afterChange(); renderLocCard(); vibrate(20);
  toast(fmt(locIdx)+" → "+(t===1?"已完成":t===2?"进行中":t===3?"待定片":"未拼")
        +" · 可点 ↶ 撤销");
});

$("q").addEventListener("input",runSearch);
$("chipsZone").addEventListener("click",function(e){
  var b=e.target.closest?e.target.closest(".chip"):null; if(!b) return;
  fZone=b.dataset.z; buildChips(); runSearch();
});
$("chipsState").addEventListener("click",function(e){
  var b=e.target.closest?e.target.closest(".chip"):null; if(!b) return;
  fState=b.dataset.s; buildChips(); runSearch();
});
$("results").addEventListener("click",function(e){
  var b=e.target.closest?e.target.closest(".ritem"):null; if(!b) return;
  locate(parseInt(b.dataset.i,10));
});
export function openSearch(){
  if(S.viewZone!=="all" && fZone==="all") fZone=String(S.viewZone);
  hideLocCard();
  $("q").value="";               // 每次打开都是干净的输入框，不留上次输入的编号
  $("ovSearch").classList.add("on");
  buildChips(); runSearch();
  setTimeout(function(){ try{ $("q").focus(); }catch(e){} },80);
}
export function closeSearch(){ $("ovSearch").classList.remove("on"); }
$("bSearch").addEventListener("click",openSearch);
$("qClose").addEventListener("click",closeSearch);
$("ovSearch").addEventListener("click",function(e){ if(e.target===$("ovSearch")) closeSearch(); });
/* setView 里“搜索范围跟随当前视图”的钩子（原 IIFE 中内联在 setView） */
export function syncSearchZone(){
  if(!$("ovSearch").classList.contains("on")) return;
  fZone = (S.viewZone==="all") ? "all" : String(S.viewZone);
  buildChips(); runSearch();
}
