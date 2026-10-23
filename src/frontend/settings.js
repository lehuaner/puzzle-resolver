import { S, DEFAULT_CFG, LS_CFG, saveJSON, viewKey } from "./store.js";
import { $, toast } from "./dom.js";
import { ORIGIN_NAME, calcRows, fmt, zoneLetter } from "./coords.js";
import { buildBoard, renderZones, updateStats, paint, refreshMM } from "./board.js";
import { exitBatch } from "./interact.js";
import { saveNow, pushFull } from "./sync.js";

/* ================= 设置 ================= */
function cfgPreview(){
  var total=parseInt($("fTotal").value,10)||0;
  var cols=parseInt($("fCols").value,10)||0;
  var zs=parseInt($("fZone").value,10)||0;
  var mv=parseInt($("fMinView").value,10)||0;
  var sz=parseInt(getSeg("segSize"),10)||56;
  if(!total||!cols||!zs){ $("cfgPreview").textContent="请填写完整的数字"; return; }
  if(mv<10||mv>100){ $("cfgPreview").textContent="引导最少可见要填 10 ~ 100 之间的百分数"; return; }
  var r=Math.ceil(total/cols), zc=Math.ceil(total/zs), per=[];
  for(var z=0;z<zc;z++) per.push(zoneLetter(z)+" "+(Math.min((z+1)*zs,total)-z*zs));
  var cw=r*cols;
  var org=getSeg("segOrigin")||"tl", od=getSeg("segOrder")||"col";
  var lastRC=(function(){
    var R=r, C=cols, a, b, row, col;
    var n=total-1;
    if(od==="col"){ a=Math.floor(n/R); b=n%R; row=b+1; col=a+1; }
    else { a=Math.floor(n/C); b=n%C; row=a+1; col=b+1; }
    var lr=(org==="tr"||org==="br"), tb=(org==="bl"||org==="br");
    if(lr) col=C-col+1;
    if(tb) row=R-row+1;
    return {row:row,col:col};
  })();
  $("cfgPreview").innerHTML="将生成 <b>"+r+" 行 × "+cols+" 列</b>，共 <b>"+total+"</b> 块；"
    +"编号 <b>001</b> 在"+ORIGIN_NAME[org]+"，<b>"+fmt(total)+"</b> 在第 "+lastRC.col+" 列 · 第 "+lastRC.row+" 行；"
    +"共 "+zc+" 个大区："+per.join("、")
    +"<br>递增："+(od==="col"?"先竖向数满一列再挪列":"先横向数满一行再挪行")
    +"<br>画布尺寸 <b>"+Math.round(cols*(sz+3))+" × "+Math.round(r*(sz+3))+"</b> 像素"
    +(cw>total?"；最后一行空 "+(cw-total)+" 格":"");
}
function setSeg(id,v){
  var bs=$(id).querySelectorAll("button");
  for(var i=0;i<bs.length;i++) bs[i].classList.toggle("on",bs[i].dataset.v===String(v));
}
function getSeg(id){ var b=$(id).querySelector("button.on"); return b?b.dataset.v:null; }

function fillSetForm(){
  $("fTotal").value=S.cfg.total; $("fCols").value=S.cfg.cols; $("fZone").value=S.cfg.zoneSize;
  $("fMinView").value=(S.cfg.guideMinView==null?30:S.cfg.guideMinView);
  setSeg("segSize",S.cellSize); setSeg("segOrder",S.cfg.order);
  setSeg("segOrigin",S.cfg.origin||"tl"); setSeg("segShow",S.cfg.showIndex?"1":"0");
  cfgPreview();
}
["fTotal","fCols","fZone","fMinView"].forEach(function(id){ $(id).addEventListener("input",cfgPreview); });
["segSize","segOrder","segOrigin","segShow"].forEach(function(id){
  $(id).addEventListener("click",function(e){
    var b=e.target.closest?e.target.closest("button"):null; if(!b) return;
    setSeg(id,b.dataset.v); cfgPreview();
  });
});

$("bSet").addEventListener("click",function(){ fillSetForm(); $("ovSet").classList.add("on"); });
$("setClose").addEventListener("click",function(){ $("ovSet").classList.remove("on"); });
$("ovSet").addEventListener("click",function(e){ if(e.target===$("ovSet")) $("ovSet").classList.remove("on"); });
$("bDefault").addEventListener("click",function(){
  $("fTotal").value=DEFAULT_CFG.total; $("fCols").value=DEFAULT_CFG.cols; $("fZone").value=DEFAULT_CFG.zoneSize;
  $("fMinView").value=(DEFAULT_CFG.guideMinView==null?30:DEFAULT_CFG.guideMinView);
  setSeg("segSize",DEFAULT_CFG.cellSize); setSeg("segOrder",DEFAULT_CFG.order);
  setSeg("segOrigin",DEFAULT_CFG.origin); setSeg("segShow","1");
  cfgPreview();
});

$("bApply").addEventListener("click",function(){
  var total=parseInt($("fTotal").value,10);
  var cols=parseInt($("fCols").value,10);
  var zs=parseInt($("fZone").value,10);
  var mv=parseInt($("fMinView").value,10);
  var sz=parseInt(getSeg("segSize"),10)||56;
  if(!total||total<4||total>4000){ toast("总片数需在 4 ~ 4000 之间"); return; }
  if(!cols||cols<2||cols>100){ toast("每行片数需在 2 ~ 100 之间"); return; }
  if(!zs||zs<1){ toast("每个大区片数需大于 0"); return; }
  if(!mv||mv<10||mv>100){ toast("引导最少可见需在 10% ~ 100% 之间"); return; }

  saveNow();
  var old=S.states, oldTotal=S.cfg.total;
  S.cfg.total=total; S.cfg.cols=cols; S.cfg.zoneSize=zs; S.cfg.cellSize=sz;
  S.cfg.order=getSeg("segOrder")||"col";
  S.cfg.origin=getSeg("segOrigin")||"tl";
  S.cfg.showIndex=getSeg("segShow")==="1";
  S.cfg.guideMinView=mv;                    // 引导/找点缩放时画布至少可见的比例（%）
  S.cellSize=sz; S.rows=calcRows();
  var arr=new Uint8Array(S.cfg.total+1);
  var n=Math.min(oldTotal,S.cfg.total);
  for(var i=1;i<=n;i++) arr[i]=old[i];
  S.states=arr;

  S.undoStack=[]; exitBatch(); S.viewZone="all"; saveJSON(viewKey(),"all");
  pushFull();          // 设置变了：整张图一起同步到服务器
  renderZones(); buildBoard(); updateStats(); saveNow();
  $("ovSet").classList.remove("on"); toast("已保存并重建");
});

$("bReset").addEventListener("click",function(){
  if(!confirm("确定清空本幅全部进度？所有块会回到「未拼」，此操作不可撤销。")) return;
  S.states=new Uint8Array(S.cfg.total+1); S.undoStack=[]; exitBatch();
  for(var i=1;i<=S.cfg.total;i++) paint(i);
  updateStats(); refreshMM(); pushFull(); toast("已清空");
});

$("bExport").addEventListener("click",function(){
  var arr=[]; for(var i=1;i<=S.cfg.total;i++) arr.push(S.states[i]);
  var payload={app:"puzzle-map",version:2,exportedAt:new Date().toISOString(),cfg:S.cfg,states:arr};
  var blob=new Blob([JSON.stringify(payload)],{type:"application/json"});
  var a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="puzzle-progress-"+S.cfg.total+"-"+Date.now()+".json";
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },1500);
  toast("已导出");
});
$("bImport").addEventListener("click",function(){ $("fImport").click(); });
$("fImport").addEventListener("change",function(e){
  var f=e.target.files&&e.target.files[0]; if(!f) return;
  var reader=new FileReader();
  reader.onload=function(){
    try{
      var o=JSON.parse(String(reader.result));
      if(!o||!o.states||!o.cfg) throw new Error("bad");
      S.cfg=Object.assign({},DEFAULT_CFG,o.cfg);
      S.cfg.total=S.cfg.total||o.states.length;
      S.cellSize=S.cfg.cellSize||56;
      S.rows=calcRows();
      var arr=new Uint8Array(S.cfg.total+1);
      for(var i=0;i<Math.min(o.states.length,S.cfg.total);i++){
        var v=o.states[i];
        arr[i+1]=(v>=1&&v<=4)?v:0;
      }
      S.states=arr; saveJSON(LS_CFG,S.cfg);
      S.undoStack=[]; exitBatch(); S.viewZone="all";
      renderZones(); buildBoard(); updateStats(); pushFull();
      $("ovSet").classList.remove("on"); toast("导入成功 · "+S.cfg.total+" 块");
    }catch(err){ toast("文件格式不对，导入失败"); }
  };
  reader.readAsText(f); e.target.value="";
});