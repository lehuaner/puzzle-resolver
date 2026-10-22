import "./styles.css";
import { S } from "./store.js";
import { $, toast } from "./dom.js";
import { calcRows } from "./coords.js";
import { loadStates } from "./grid.js";
import { buildBoard, renderZones, updateStats, initMinimap, applyPan, placeMinimap, zoomCenter, fitToScreen } from "./board.js";
import { doUndo, exitBatch } from "./interact.js";
import { closeSearch } from "./search.js";
import { cancelPick, drawScan } from "./scan.js";
import { guideExit } from "./guide.js";
import { detectNumbers } from "./ocr.js";
import "./settings.js";   // 无导出：仅注册设置面板的交互
import { wsUrl, connectWS, setLocalMode, bootView } from "./sync.js";

window.__ocr = detectNumbers;   // 调试/E2E 钩子

/* ================= 键盘 ================= */
document.addEventListener("keydown",function(e){
  if((e.ctrlKey||e.metaKey)&&e.key==="z"){ e.preventDefault(); doUndo(); }
  if(e.key==="Escape"){
    if($("ovScan").classList.contains("on")&&$("scanPick").classList.contains("on")){
      cancelPick();
    }
    else if($("ovSearch").classList.contains("on")) closeSearch();
    else if($("ovSet").classList.contains("on")) $("ovSet").classList.remove("on");
    else if($("ovScan").classList.contains("on")) $("ovScan").classList.remove("on");
    else if(S.guideActive) guideExit();
    else exitBatch();
  }
  // 方向键平移 / +/- 缩放 / 0 适应
  var K=48;
  if(e.key==="ArrowLeft"){ S.tx+=K; applyPan(false); }
  if(e.key==="ArrowRight"){ S.tx-=K; applyPan(false); }
  if(e.key==="ArrowUp"){ S.ty+=K; applyPan(false); }
  if(e.key==="ArrowDown"){ S.ty-=K; applyPan(false); }
  if(e.key==="+"||e.key==="="){ zoomCenter(1.2); }
  if(e.key==="-"){ zoomCenter(1/1.2); }
  if(e.key==="0"){ fitToScreen(true); }
});
/* ================= 启动 ================= */
function boot(){
  // 先用本机数据渲染一版（离线时就是最终状态；连上服务器后由 loadBoard 重建）
  S.boardId=S.boardId||"local";
  S.rows=calcRows(); S.states=loadStates();
  renderZones(); buildBoard(); updateStats();
  if(wsUrl()) connectWS();
  else {
    setLocalMode();
    $("boardName").textContent="仅本机";
    toast("直接打开文件无法多设备同步，请用 start-lan-server.bat 启动后访问");
    bootView();
  }
  try{ if(navigator.wakeLock&&navigator.wakeLock.request)
    navigator.wakeLock.request("screen").catch(function(){}); }catch(e){}
}

window.addEventListener("resize",function(){
  clearTimeout(window.__rt);
  window.__rt=setTimeout(function(){
    initMinimap(); applyPan(false); placeMinimap();
    if($("ovScan").classList.contains("on")) drawScan();
  },150);
});
window.addEventListener("orientationchange",function(){ setTimeout(function(){ initMinimap(); applyPan(false); },250); });

if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",boot);
else boot();