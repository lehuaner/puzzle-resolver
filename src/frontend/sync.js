import { S, DEFAULT_CFG, LS_PRE, loadJSON, saveJSON, viewKey, SCALE_MIN, SCALE_MAX } from "./store.js";
import { $, toast, esc, ago } from "./dom.js";
import { calcRows, zoneCount } from "./coords.js";
import { statesStr } from "./grid.js";
import { buildBoard, renderZones, updateStats, applyPan, resetView, setView, paint } from "./board.js";
import { exitBatch } from "./interact.js";
import { renderLocCard, hideLocCard } from "./search.js";

/* ================= 同步层 =================
 * 一张图 = 一个房间。改动打成 patch 发服务器落库并广播，
 * 断网时退化为只存本机（localStorage）。
 */
var peers=1;
var ws=null, wsOpen=false, wsRetry=0, wsTimer=null;
var dirty=new Map();          // 待同步的改动 idx → 新状态
var localMode=false;          // true = 没连上服务器，只存本机

export function wsUrl(){
  if(location.protocol==="https:") return "wss://"+location.host+"/ws";
  if(location.protocol==="http:"||location.protocol==="https:") return "ws://"+location.host+"/ws";
  return null;                // file:// 打开：没有服务器
}
export function send(o){
  if(wsOpen && ws && ws.readyState===1){ try{ ws.send(JSON.stringify(o)); return true; }catch(e){} }
  return false;
}
export function setStateOnline(on){
  wsOpen=on;
  var b=$("bBoards");
  b.classList.toggle("on",on);
  b.classList.toggle("off",!on&&!localMode);
  $("wsStat").textContent = on ? ("已连接 · "+peers+" 台设备") : (localMode?"仅本机保存":"连接中…");
  $("wsStat").classList.toggle("on",on);
}

/* 收集改动 */
export function markChange(i){ if(!dirty.has(i)) dirty.set(i,S.states[i]); }

/* 同步出口：有服务器就发 patch，没有就写本机 */
export function flushChanges(){
  if(!dirty.size) return;
  var cells={};
  dirty.forEach(function(v,k){ cells[k]=v; });
  dirty=new Map();
  if(send({t:"patch", id:S.boardId, cells:cells})) return;
  saveLocal();
}
export function saveLocal(){
  if(!S.boardId) return;
  if(!saveJSON(LS_PRE+"data."+S.boardId,{w:S.cfg.total,s:statesStr()})) { /* 存不下就算了 */ }
  saveJSON(LS_PRE+"cfg."+S.boardId,S.cfg);
}
export function saveNow(){ saveLocal(); }        // 兼容旧调用
export function scheduleSave(){ flushChanges(); }

/* 应用远端改动（不再回发） */
export function applyRemoteCells(cells){
  var changed=false;
  Object.keys(cells||{}).forEach(function(k){
    var i=parseInt(k,10), v=parseInt(cells[k],10);
    if(!(i>=1&&i<=S.cfg.total)) return;
    if(S.states[i]!==v){ S.states[i]=v; paint(i); changed=true; }
  });
  if(changed){ updateStats(); renderLocCard(); }
}
export function applyRemoteCfg(c){
  S.cfg=Object.assign({},DEFAULT_CFG,c||{});
  if(!S.cfg.origin) S.cfg.origin="tl";
  S.cellSize=S.cfg.cellSize||56; S.gap=(S.cfg.gap==null?3:S.cfg.gap); S.step=S.cellSize+S.gap;
  S.rows=calcRows();
  var arr=new Uint8Array(S.cfg.total+1);
  for(var i=1;i<=S.cfg.total;i++) arr[i]=S.states[i]||0;
  S.states=arr;
  S.undoStack=[]; exitBatch(); S.viewZone="all";
  renderZones(); buildBoard(); updateStats();
}
/* ================= 多设备同步（WebSocket） ================= */
var boardCache=null;


export function connectWS(){
  var url=wsUrl();
  if(!url){ localMode=true; setStateOnline(false); toast("未连接服务器 · 进度只存在本机"); return; }
  try{ ws=new WebSocket(url); }catch(e){ localMode=true; setStateOnline(false); return; }
  ws.onopen=function(){
    wsOpen=true; wsRetry=0; localMode=false; setStateOnline(true);
    var want=(location.hash.match(/[#&]b=([\w-]+)/)||[])[1] || loadJSON(LS_PRE+"last",null);
    send({t:"list"});
    if(want) send({t:"join", id:want});
  };
  ws.onmessage=function(e){
    var m=null; try{ m=JSON.parse(e.data); }catch(err){ return; }
    onServerMsg(m);
  };
  ws.onclose=function(){ wsOpen=false; setStateOnline(false); retryWS(); };
  ws.onerror=function(){};
}
export function retryWS(){
  if(localMode) return;
  wsRetry=Math.min(wsRetry+1,10);
  clearTimeout(wsTimer);
  wsTimer=setTimeout(connectWS, Math.min(1200*wsRetry, 8000));
}
function lastBoardId(){ return loadJSON(LS_PRE+"last",null); }
var serverJoined=false;
export function pickBoardId(){
  var has=function(id){ return (boardCache||[]).some(function(b){ return b.id===id; }); };
  var h=(location.hash.match(/[#&]b=([\w-]+)/)||[])[1];
  if(h&&has(h)) return h;
  var last=lastBoardId();
  if(last&&has(last)) return last;
  return boardCache&&boardCache.length?boardCache[0].id:null;
}

export function onServerMsg(m){
  if(!m||!m.t) return;
  if(m.t==="list"){
    boardCache=m.boards||[]; renderBoardList();
    if(!serverJoined){                       // 第一次连上：地址栏指定 > 上次进过 > 第一张
      var id=pickBoardId();
      if(id) joinBoard(id,true);
    }
    return;
  }
  if(m.t==="snapshot"){
    loadBoard(m.board);
    if(m.peers){ peers=m.peers; setStateOnline(true); }
    return;
  }
  if(m.t==="created"){ joinBoard(m.board.id,true); return; }   // 只发给创建者，新建后直接进去
  if(m.t==="patch"){ if(m.id===S.boardId) applyRemoteCells(m.cells); return; }
  if(m.t==="replace"){
    if(m.id!==S.boardId) return;
    var st=m.states;
    applyRemoteCfg(m.cfg);
    if(typeof st==="string") applyRemoteStates(st);
    return;
  }
  if(m.t==="renamed"){
    if(m.id===S.boardId){ S.boardName=m.name; $("boardName").textContent=m.name; }
    send({t:"list"}); return;
  }
  if(m.t==="deleted"){
    boardCache=(boardCache||[]).filter(function(b){ return b.id!==m.id; });
    if(m.id===S.boardId){
      S.boardId=null; serverJoined=false;
      toast("这张图被删除了");
      try{ history.replaceState(null,"",location.pathname+location.search); }catch(e){}
      var next=boardCache.length?boardCache[0].id:null;
      if(next) joinBoard(next,true);          // 自动进另一张，避免卡在已删的图上
      else send({t:"join", id:"-"});           // 一张不剩：让服务端开一张新的
    }
    renderBoardList();
    return;
  }
  if(m.t==="peers"){ peers=m.n||1; setStateOnline(true); return; }
  if(m.t==="error"){ toast(m.msg||"同步出错"); }
}
export function applyRemoteStates(s){
  for(var i=1;i<=S.cfg.total;i++){ var c=s.charCodeAt(i-1)-48; S.states[i]=(c>=0&&c<=4)?c:0; }
  for(var k=1;k<=S.cfg.total;k++) paint(k);
  updateStats(); renderLocCard();
}

export function loadBoard(b){
  if(!b) return;
  serverJoined=true; localMode=false;
  S.boardId=b.id; S.boardName=b.name||"未命名拼图";
  saveJSON(LS_PRE+"last",S.boardId);
  try{ history.replaceState(null,"",location.pathname+location.search+"#b="+S.boardId); }catch(e){}
  $("boardName").textContent=S.boardName;
  S.cfg=Object.assign({},DEFAULT_CFG,b.cfg||{});
  if(!S.cfg.origin) S.cfg.origin="tl";
  S.cellSize=S.cfg.cellSize||56; S.gap=(S.cfg.gap==null?3:S.cfg.gap); S.step=S.cellSize+S.gap;
  S.rows=calcRows();
  S.states=new Uint8Array(S.cfg.total+1);
  var s=b.states||"";
  for(var i=1;i<=S.cfg.total;i++){ var c=s.charCodeAt(i-1)-48; S.states[i]=(c>=0&&c<=4)?c:0; }
  S.undoStack=[]; exitBatch(); S.viewZone="all"; dirty=new Map();
  renderZones(); buildBoard(); updateStats(); bootView();
}
export function bootView(){
  var sv=loadJSON(viewKey(),null), saved=null, lastView="all";
  if(typeof sv==="string") lastView=sv;
  else if(sv&&typeof sv==="object"){
    lastView=(typeof sv.z==="string"?sv.z:"all");
    if(isFinite(sv.s)&&isFinite(sv.x)&&isFinite(sv.y)) saved={s:+sv.s,x:+sv.x,y:+sv.y};
  }
  if(lastView!=="all"){
    var zi=parseInt(lastView,10);
    S.viewZone=(zi>=0&&zi<zoneCount())?String(zi):"all";
  }
  renderZones();
  if(saved){ S.scale=Math.max(SCALE_MIN,Math.min(SCALE_MAX,saved.s)); S.tx=saved.x; S.ty=saved.y; applyPan(false); }
  else if(S.viewZone==="all") resetView(false);
  else setView(S.viewZone,{recenter:true});
}

/* ---- 图谱列表 ---- */
export function renderBoardList(){
  var list=boardCache||[];
  if(localMode||!wsOpen){
    $("boardList").innerHTML='<div class="empty">还没连上服务器（'+(wsUrl()?"连接中…":"请用 start-lan-server.bat 启动服务后访问，才能多设备同步")+'）<br>当前进度只保存在这台设备上</div>';
    return;
  }
  if(!list.length){ $("boardList").innerHTML='<div class="empty">还没有拼图，点右上「＋ 新建」</div>'; return; }
  var html="";
  list.forEach(function(b){
    var pct=b.total?Math.round(b.done/b.total*100):0;
    html+='<div class="brow'+(b.id===S.boardId?" cur":"")+'" data-id="'+esc(b.id)+'">'
      +'<div class="binfo"><div class="bname">'+esc(b.name)+'</div>'
      +'<div class="bmeta">'+b.total+' 片 · 已完成 '+b.done+'（'+pct+'%） · '+ago(b.updatedAt)+'</div></div>'
      +'<div class="bops">'
      +(b.id===S.boardId?'<button data-a="enter" class="pri" disabled style="opacity:.5">当前</button>'
                      :'<button data-a="enter" class="pri">进入</button>')
      +'<button data-a="rename">重命名</button><button data-a="del" class="dgr">删除</button>'
      +'</div></div>';
  });
  $("boardList").innerHTML=html;
}
export function joinBoard(id,silent){
  if(!id) return;
  if(!send({t:"join", id:id})){ toast("还没连上服务器"); return; }
  if(!silent) $("ovBoards").classList.remove("on");
  hideLocCard(); exitBatch();
}
export function pushFull(){
  if(send({t:"replace", id:S.boardId, cfg:S.cfg, states:statesStr()})) return;
  saveLocal();
}

$("bBoards").addEventListener("click",function(){
  $("ovBoards").classList.add("on");
  setStateOnline(wsOpen);
  if(wsOpen) send({t:"list"});
  renderBoardList();
});
$("boardsClose").addEventListener("click",function(){ $("ovBoards").classList.remove("on"); });
$("ovBoards").addEventListener("click",function(e){ if(e.target===$("ovBoards")) $("ovBoards").classList.remove("on"); });

$("boardList").addEventListener("click",function(e){
  var b=e.target.closest?e.target.closest("button[data-a]"):null; if(!b) return;
  var row=b.closest(".brow"); if(!row) return;
  var id=row.dataset.id, a=b.dataset.a;
  if(a==="enter"){ joinBoard(id); return; }
  if(a==="rename"){
    var nameEl=row.querySelector(".bname"), old=nameEl.textContent;
    nameEl.innerHTML='<input value="'+esc(old)+'">';
    var inp=nameEl.querySelector("input");
    inp.focus(); inp.select();
    var finish=function(ok){
      var v=inp.value.trim();
      if(ok&&v){
        send({t:"rename", id:id, name:v});
        if(id===S.boardId){ S.boardName=v; $("boardName").textContent=v; }
        var it=boardCache&&boardCache.filter(function(x){return x.id===id;})[0];
        if(it){ it.name=v; }
      }
      renderBoardList();
    };
    inp.addEventListener("keydown",function(ev){
      if(ev.key==="Enter"){ finish(true); }
      else if(ev.key==="Escape"){ finish(false); }
    });
    inp.addEventListener("blur",function(){ finish(true); });
    return;
  }
  if(a==="del"){
    if(confirm("删除这张图？里面的进度会一起删掉，无法恢复。")) send({t:"delete", id:id});
  }
});
$("bNewBoard").addEventListener("click",function(){
  var def="拼图 "+(new Date().getMonth()+1)+"月"+(new Date().getDate())+"日";
  var name=prompt("新拼图的名字",def);
  if(name===null) return;
  send({t:"create", name:name||def, cfg:S.cfg});
});
/* 没连上服务器时的降级入口（boot 用） */
export function setLocalMode(){ localMode=true; setStateOnline(false); }
