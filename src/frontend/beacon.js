import { S } from "./store.js";

/* ================= 目标高亮（找点 / 摆放引导共用） =================
   亮的那一相**就是图例里的「进行中」**：`.gblink` = 绿底 + `breath` 呼吸闪；
   灭的那一相退回这块本来的颜色（未拼灰 / 待定黄 / 孤片浅黄都各显示各的）；
   位置由一直挂着的 `.gcur::after` 绿描边钉住，所以灭了也看得见目标在哪。
   周期 620ms —— 比纯呼吸更容易在满屏灰块里一眼扫到。
   同一时刻只有一组目标：谁调用 beaconShow 谁接管，旧的全部清掉。 */

var cur=[], timer=null, on=false;

function apply(v){
  on=v;
  for(var k=0;k<cur.length;k++){
    var el=S.cells[cur[k]];
    if(!el) continue;
    if(v) el.classList.add("gblink"); else el.classList.remove("gblink");
  }
}

/* ids：要点亮（并持续闪）的块；会先清掉上一次的目标 */
export function beaconShow(ids){
  beaconHide();
  cur=(ids||[]).filter(function(i){ return i!=null && S.cells[i]; });
  if(!cur.length) return;
  for(var k=0;k<cur.length;k++) S.cells[cur[k]].classList.add("gcur");
  apply(true);
  timer=setInterval(function(){ apply(!on); }, 620);
}

/* 收掉高亮：清定时器、去 .gcur/.gblink */
export function beaconHide(){
  if(timer){ clearInterval(timer); timer=null; }
  for(var k=0;k<cur.length;k++){
    var el=S.cells[cur[k]];
    if(!el) continue;
    el.classList.remove("gcur");
    el.classList.remove("gblink");
  }
  cur=[];
  on=false;
}

export function beaconActive(){ return cur.length>0; }
