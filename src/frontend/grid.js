import { S, loadJSON, LS_PRE } from "./store.js";
import { idxToRC, rcToIdx } from "./coords.js";

export function statesStr(){
  var p=new Array(S.cfg.total);
  for(var i=1;i<=S.cfg.total;i++) p[i-1]=S.states[i]?String(S.states[i]):"0";
  return p.join("");
}
export function loadStates(){
  var arr=new Uint8Array(S.cfg.total+1);
  var raw=loadJSON(LS_PRE+"data."+S.boardId,null);
  if(raw && typeof raw.s==="string"){
    var s=raw.s, n=Math.min(S.cfg.total,s.length);
    for(var i=0;i<n;i++){ var c=s.charCodeAt(i)-48; arr[i+1]=(c>=0&&c<=4)?c:0; }
  }
  return arr;
}
/* ---- 连通片区 ---- */
// 有实际拼图块的状态：1=已完成 3=待定片 4=孤片
export function isPresent(i){ var s=S.states[i]; return s===1||s===3||s===4; }

export function buildAdj(){
  S.adj=new Array(S.cfg.total+1);
  for(var i=1;i<=S.cfg.total;i++){
    var p=idxToRC(i), list=[];
    if(p.row>1){ var a=rcToIdx(p.row-1,p.col); if(a>=1&&a<=S.cfg.total) list.push(a); }
    if(p.row<S.rows){ var b=rcToIdx(p.row+1,p.col); if(b>=1&&b<=S.cfg.total) list.push(b); }
    if(p.col>1){ var c=rcToIdx(p.row,p.col-1); if(c>=1&&c<=S.cfg.total) list.push(c); }
    if(p.col<S.cfg.cols){ var d=rcToIdx(p.row,p.col+1); if(d>=1&&d<=S.cfg.total) list.push(d); }
    S.adj[i]=list;
  }
}

// 返回所有连通的片区，按大小降序
export function components(){
  var seen=new Uint8Array(S.cfg.total+1), out=[], stack=[];
  for(var i=1;i<=S.cfg.total;i++){
    if(seen[i]||!isPresent(i)) continue;
    var comp=[];
    stack.length=0; stack.push(i); seen[i]=1;
    while(stack.length){
      var q=stack.pop(); comp.push(q);
      var nb=S.adj[q]||[];
      for(var k=0;k<nb.length;k++){
        var j=nb[k];
        if(!seen[j]&&isPresent(j)){ seen[j]=1; stack.push(j); }
      }
    }
    out.push(comp);
  }
  out.sort(function(a,b){ return b.length-a.length; });
  return out;
}

// 连通域里是否含“基准已完成块”：
//   · 不传 base → 用当前状态里的 1 判定
//   · 传 base（拍照流程里改动前的已完成块集合）→ 用 base 判定，避免刚设成 1 的新块自己“当选”主片区
export function compHasDone(c,base){
  for(var j=0;j<c.length;j++){
    var idx=c[j];
    if(base ? base.has(idx) : S.states[idx]===1) return true;
  }
  return false;
}
// 主片区 = 含有已完成块的最大连通域（拍照流程用来判断新块连没连上）
export function mainComp(base){
  var comps=components(), best=null, k;
  if(base && base.size===0){            // 一块都还没拼过：照片里最大的那片就是主片区
    for(k=0;k<comps.length;k++){ if(!best || comps[k].length>best.length) best=comps[k]; }
    return best||[];
  }
  for(k=0;k<comps.length;k++){
    if(!compHasDone(comps[k],base)) continue;
    if(!best || comps[k].length>best.length) best=comps[k];
  }
  return best||[];
}

// 只要一个连通区域里有“已完成”的块，这片里的待定(3)/孤片(4)就算连上了 → 全部转已完成。
// 返回变化列表 [[idx,oldState]]
export function promoteConnected(){
  var comps=components(), out=[];
  for(var k=0;k<comps.length;k++){
    var c=comps[k];
    if(!compHasDone(c,null)) continue;      // 整片都没有已完成的块 → 保持待定
    for(var i=0;i<c.length;i++){
      var idx=c[i];
      if(S.states[idx]===3||S.states[idx]===4){ out.push([idx,S.states[idx]]); S.states[idx]=1; }
    }
  }
  return out;
}

// 找点用：该点是否紧挨着已完成/待定的块
// 邻居分类：main=挨着已完成(1)/待定(3)的主片区；lone=挨着孤片(4)
export function neighborKind(i){
  var nb=S.adj[i]||[], main=false, lone=false;
  for(var k=0;k<nb.length;k++){
    var s=S.states[nb[k]];
    if(s===1||s===3) main=true;
    else if(s===4) lone=true;
  }
  return {main:main, lone:lone};
}
/* ================= 布局 ================= */
export function metrics(){
  S.step=S.cellSize+S.gap;
  S.contentW=S.cfg.cols*S.step-S.gap;
  S.contentH=S.rows*S.step-S.gap;
}