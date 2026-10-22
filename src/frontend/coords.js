import { S } from "./store.js";

export function calcRows(){ return Math.max(1, Math.ceil(S.cfg.total/S.cfg.cols)); }
// 编号 = 起点(origin) + 递增方向(order)
//   origin: tl 左上 / tr 右上 / bl 左下 / br 右下
//   order : col 列优先（先沿竖向数满一列，再挪到下一列） / row 行优先（先沿横向数满一行，再挪到下一行）
// 内部先算“从起点开始的逻辑序号 (a=主方向, b=次方向)”，再按起点翻转成真实行列。
export var ORIGIN_LR={ tl:"l", bl:"l", tr:"r", br:"r" };   // 起点靠左还是靠右
export var ORIGIN_TB={ tl:"t", tr:"t", bl:"b", br:"b" };   // 起点靠上还是靠下
export function originCfg(){
  var o=ORIGIN_LR[S.cfg.origin]?S.cfg.origin:"tl";
  return { lr:ORIGIN_LR[o], tb:ORIGIN_TB[o] };
}
export function idxToRC(i){
  var n=i-1, R=S.rows, C=S.cfg.cols, a, b, row, col;
  if(S.cfg.order==="col"){ a=Math.floor(n/R); b=n%R; row=b+1; col=a+1; }
  else { a=Math.floor(n/C); b=n%C; row=a+1; col=b+1; }
  var o=originCfg();
  if(o.lr==="r") col=C-col+1;
  if(o.tb==="b") row=R-row+1;
  return { row:row, col:col };
}
export function rcToIdx(row,col){
  var R=S.rows, C=S.cfg.cols, r=row, c=col, o=originCfg();
  if(o.lr==="r") c=C-c+1;
  if(o.tb==="b") r=R-r+1;
  if(S.cfg.order==="col") return (c-1)*R+r;
  return (r-1)*C+c;
}
// 起点的方位说明，用在提示文案里
export var ORIGIN_NAME={ tl:"左上", tr:"右上", bl:"左下", br:"右下" };
export function zoneOf(i){ return Math.floor((i-1)/S.cfg.zoneSize); }
export function zoneLetter(z){ return String.fromCharCode(65+z); }
export function zoneCount(){ return Math.max(1,Math.ceil(S.cfg.total/S.cfg.zoneSize)); }
export function zoneStart(z){ return z*S.cfg.zoneSize+1; }
export function zoneEnd(z){ return Math.min((z+1)*S.cfg.zoneSize, S.cfg.total); }
/* ---- 字母 ↔ 编号范围（ABCD 各有各的一段，全部由 total/zoneSize 推出来，不写死）----
   片背印的是「字母 + 全局编号」，字母只是编号所在分区的重述——它是一枚**校验位**：
   读到 D-476 而 D 段是 751–1000，那这条读数必错（字母是单个大字，比三位小数字稳得多，
   所以判错时改数字、不改字母）。分区数随盘大小走（zoneCount），盘只有两袋时 E 就是不合法字母。 */
export function letterZone(L){
  if(!L) return -1;
  var z=String(L).toUpperCase().charCodeAt(0)-65;
  if(!(z>=0) || z>=zoneCount()) return -1;   // 空字母 / 超出本盘分区数：无从判断
  return z;
}
export function zoneRangeOf(L){
  var z=letterZone(L);
  return z<0?null:{ lo:zoneStart(z), hi:zoneEnd(z) };
}
// 编号是否落在该字母的段内；字母读不出来（或不是本盘的字母）时不误杀，返回 true
export function numInZone(L,n){
  if(!(n>=1) || n>S.cfg.total) return false;
  var z=letterZone(L);
  if(z<0) return true;
  return n>=zoneStart(z) && n<=zoneEnd(z);
}
export function fmt(i){ var s=String(i); while(s.length<3) s="0"+s; return s; }