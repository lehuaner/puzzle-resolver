

export var $=function(id){return document.getElementById(id);};
export function vibrate(ms){ try{ if(navigator.vibrate) navigator.vibrate(ms); }catch(e){} }
var toastTimer=null;
export function toast(msg){
  var t=$("toast"); t.textContent=msg; t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){ t.classList.remove("on"); },1700);
}
export function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]; }); }
export function ago(t){
  var d=Date.now()-(t||0), m=d/60000;
  if(m<1) return "刚刚";
  if(m<60) return Math.floor(m)+" 分钟前";
  if(m<1440) return Math.floor(m/60)+" 小时前";
  var dt=new Date(t||Date.now());
  return (dt.getMonth()+1)+"月"+dt.getDate()+"日";
}