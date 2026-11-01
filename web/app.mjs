import {example,parseMgp,mergeMgp,validateMgp} from './mgp.mjs';
import {promptText} from './prompt.mjs';
const $=id=>document.getElementById(id);
const canvas=$('sky'),ctx=canvas.getContext('2d');
const palette={memory:'#9daeff',person:'#fca4d0',project:'#f4c477',topic:'#77c9ff',event:'#ff99ab',preference:'#ffb98e',goal:'#cfb5ff',skill:'#78e2cb',other:'#bbc7df'};
const names={memory:'记忆',person:'人物',project:'项目',topic:'主题',event:'事件',preference:'偏好',goal:'目标',skill:'技能',other:'其他'};
const cats=Object.keys(names);
let graph=structuredClone(example),stars=[],segments=[],selected=null,filter='all',search='',zoom=1,pan={x:0,y:0},drag=null,ticks=0,dirty=true;
const hash=s=>{let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0};
const rnd=s=>(hash(s)%100000)/100000;
const color=t=>palette[t]||palette.other;
const warn=(msg,err=false)=>{const el=$('notice');el.textContent=msg;el.classList.toggle('error',err)};
function setGraph(g){
 graph=g;stars=graph.nodes.map(n=>{const a=rnd(n.id+'a')*Math.PI*2,cat=cats.indexOf(n.type),seed=rnd(n.id+'r');const cx=Math.cos(cat*2.399)*140,cy=Math.sin(cat*2.399)*115;return {...n,x:cx+Math.cos(a)*(55+seed*130),y:cy+Math.sin(a)*(55+seed*130),vx:0,vy:0}});
 const id=new Map(stars.map((n,i)=>[n.id,i]));
 segments=graph.edges.map(e=>({...e,a:id.get(e.from),b:id.get(e.to)})).filter(e=>e.a!==undefined&&e.b!==undefined);
 const degree=new Map();segments.forEach(e=>{degree.set(e.from,(degree.get(e.from)||0)+1);degree.set(e.to,(degree.get(e.to)||0)+1)});stars.forEach(s=>s.degree=degree.get(s.id)||0);
 selected=null;ticks=0;zoom=1;pan={x:0,y:0};update();fitCanvas();
}
function update(){
 $('nodeCount').textContent=stars.length.toLocaleString();$('edgeCount').textContent=segments.length.toLocaleString();$('sourceCount').textContent=(graph.sources?.length||1).toLocaleString();
 const src=graph.source||{};$('coverage').textContent=`覆盖范围：${src.scope||'多来源'} · ${src.completeness==='full'?'导出方声称全量（未经验证）':src.completeness==='partial'?'部分':'未知'}`;
 renderFilters();renderDetail();dirty=true;
}
function renderFilters(){
 const wrap=$('filters');wrap.replaceChildren();const shown=new Set(stars.map(s=>s.type));
 [['all','全部'],...cats.filter(c=>shown.has(c)).map(c=>[c,names[c]])].forEach(([key,label])=>{const b=document.createElement('button');b.className='chip'+(key===filter?' active':'');b.textContent=label;b.onclick=()=>{filter=key;renderFilters();dirty=true};wrap.append(b)});
}
function isVisible(s){return(filter==='all'||s.type===filter)&&(!search||[s.label,s.content||'',s.type,...(s.tags||[])].join(' ').toLowerCase().includes(search))}
function visible(){return stars.map((s,i)=>isVisible(s)?i:null).filter(i=>i!==null)}
function fitCanvas(){const dpr=Math.min(2,devicePixelRatio||1),w=canvas.clientWidth,h=canvas.clientHeight;canvas.width=Math.floor(w*dpr);canvas.height=Math.floor(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);dirty=true}
new ResizeObserver(fitCanvas).observe(canvas);
function physics(){
 if(ticks++>340)return;const n=stars.length,strength=n>2000?.13:n>500?.3:1;
 const size=75,grid=new Map(),key=(x,y)=>`${x},${y}`;
 stars.forEach((s,i)=>{const a=Math.floor(s.x/size),b=Math.floor(s.y/size),k=key(a,b);if(!grid.has(k))grid.set(k,[]);grid.get(k).push(i)});
 for(let i=0;i<n;i++){
  const s=stars[i],a=Math.floor(s.x/size),b=Math.floor(s.y/size);let fx=0,fy=0;
  for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const j of grid.get(key(a+dx,b+dy))||[]){
   if(i===j)continue;const ox=s.x-stars[j].x,oy=s.y-stars[j].y,d2=ox*ox+oy*oy+30,power=190/d2;fx+=ox*power;fy+=oy*power;
  }
  const ci=cats.indexOf(s.type),cx=Math.cos(ci*2.399)*150,cy=Math.sin(ci*2.399)*120;
  fx+=(cx-s.x)*.0009*strength;fy+=(cy-s.y)*.0009*strength;s.vx=(s.vx+fx)*.84;s.vy=(s.vy+fy)*.84;
 }
 for(const e of segments){const a=stars[e.a],b=stars[e.b],dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1,t=(d-78)*.007*strength,x=dx/d*t,y=dy/d*t;a.vx+=x;a.vy+=y;b.vx-=x;b.vy-=y}
 for(const s of stars){s.x+=Math.max(-5,Math.min(5,s.vx));s.y+=Math.max(-5,Math.min(5,s.vy))}dirty=true;
}
function draw(){
 if(!dirty)return;dirty=false;const w=canvas.clientWidth,h=canvas.clientHeight;ctx.clearRect(0,0,w,h);
 for(let i=0;i<90;i++){const x=rnd('bgx'+i)*w,y=rnd('bgy'+i)*h;ctx.globalAlpha=.1+rnd('bgo'+i)*.3;ctx.fillStyle='#becffa';ctx.beginPath();ctx.arc(x,y,.5+rnd('bgr'+i)*1.15,0,Math.PI*2);ctx.fill()}ctx.globalAlpha=1;
 ctx.save();ctx.translate(w/2+pan.x,h/2+pan.y);ctx.scale(zoom,zoom);
 const visibleSet=new Set(visible());let count=0;
 for(const e of segments){
  if(!visibleSet.has(e.a)||!visibleSet.has(e.b))continue;if(stars.length>4500&&count++>14000)break;
  const a=stars[e.a],b=stars[e.b],connected=selected&&(selected.id===a.id||selected.id===b.id);
  ctx.strokeStyle=connected?'#a8c8ff':e.basis==='inferred'?'#bd90ed':'#7087b0';
  ctx.globalAlpha=connected?.74:e.basis==='inferred'?.18:.24;ctx.lineWidth=connected?1.4:0.8;ctx.setLineDash(e.basis==='inferred'?[4,5]:[]);
  ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
 }
 ctx.setLineDash([]);
 const showLabels=stars.length<160||zoom>1.5;
 for(const i of visible()){
  const s=stars[i],sel=s.id===selected?.id,r=sel?9:Math.max(2.1,Math.min(6.5,3+Math.sqrt(s.degree)*.65));
  if(sel){ctx.beginPath();ctx.arc(s.x,s.y,20,0,7);ctx.fillStyle='#94b4ff25';ctx.fill();ctx.beginPath();ctx.arc(s.x,s.y,13.5,0,7);ctx.strokeStyle='#adc7ff88';ctx.stroke()}
  ctx.globalAlpha=s.state==='deprecated'?.38:1;ctx.shadowBlur=sel?25:10;ctx.shadowColor=color(s.type);ctx.fillStyle=color(s.type);ctx.beginPath();ctx.arc(s.x,s.y,r,0,7);ctx.fill();ctx.shadowBlur=0;ctx.globalAlpha=1;
  if(showLabels&&(sel||stars.length<160||zoom>2.6)){ctx.fillStyle=sel?'#ffffff':'#bbcae7';ctx.font=(sel?'600 ':'')+`${Math.max(9,11/Math.sqrt(zoom))}px sans-serif`;ctx.textAlign='center';ctx.fillText(s.label.slice(0,22),s.x,s.y+r+15/zoom)}
 }
 ctx.restore();
}
function loop(){physics();draw();requestAnimationFrame(loop)}requestAnimationFrame(loop);
function toScreen(s){return{x:canvas.clientWidth/2+pan.x+s.x*zoom,y:canvas.clientHeight/2+pan.y+s.y*zoom}}
function hit(x,y){let closest=null,min=17;for(const s of stars){if(!isVisible(s))continue;const p=toScreen(s),d=Math.hypot(x-p.x,y-p.y);if(d<min){min=d;closest=s}}return closest}
function renderDetail(){
 const el=$('inspector');if(!selected){el.classList.remove('visible');return}
 el.classList.add('visible');$('detailTitle').textContent=selected.label;$('detailType').textContent=names[selected.type]||selected.type;$('detailContent').textContent=selected.content||'暂无正文';
 $('detailMeta').textContent=[`状态: ${selected.state||'unknown'}`,selected.source_ref&&`出处: ${selected.source_ref}`,selected.updated_at&&`更新: ${selected.updated_at}`].filter(Boolean).join('  ·  ');
 const links=segments.filter(e=>e.from===selected.id||e.to===selected.id);
 $('detailLinks').textContent=links.length?`关联 (${links.length}): `+links.slice(0,25).map(e=>{const other=stars.find(s=>s.id===(e.from===selected.id?e.to:e.from));return `${other?.label||'未知'} [${e.type}, ${e.basis}]`}).join('，'):'暂无关联';
}
canvas.addEventListener('pointerdown',e=>{const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;drag={x,y,px:pan.x,py:pan.y,moved:false};canvas.setPointerCapture(e.pointerId);canvas.classList.add('grabbing')});
canvas.addEventListener('pointermove',e=>{if(!drag)return;const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;drag.moved||=(Math.hypot(x-drag.x,y-drag.y)>4);if(drag.moved){pan.x=drag.px+x-drag.x;pan.y=drag.py+y-drag.y;dirty=true}});
canvas.addEventListener('pointerup',e=>{const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(drag&&!drag.moved){selected=hit(x,y);renderDetail();dirty=true}drag=null;canvas.classList.remove('grabbing')});
canvas.addEventListener('wheel',e=>{e.preventDefault();const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,old=zoom;zoom=Math.max(.12,Math.min(6,zoom*Math.exp(-e.deltaY*.001)));pan.x=x-canvas.clientWidth/2-(x-canvas.clientWidth/2-pan.x)*zoom/old;pan.y=y-canvas.clientHeight/2-(y-canvas.clientHeight/2-pan.y)*zoom/old;dirty=true},{passive:false});
canvas.addEventListener('dblclick',()=>{zoom=1;pan={x:0,y:0};dirty=true});
$('closeInspector').onclick=()=>{selected=null;renderDetail();dirty=true};
$('search').oninput=e=>{search=e.target.value.trim().toLowerCase();dirty=true};
$('copyPrompt').onclick=async()=>{
 try{await navigator.clipboard.writeText(promptText);warn('导出提示词已复制。发送给 AI 后，将它输出的 JSON 粘贴到这里即可。')}
 catch{const input=$('input');input.value=promptText;input.focus();input.select();warn('浏览器拒绝读取剪贴板，已将提示词放入文本框，请手动复制。')}
};
function importText(text){
 try{
  const {graph:incoming,warnings}=parseMgp(text,graph.nodes.map(n=>n.id));const merged=mergeMgp(graph,incoming);setGraph(merged);
  warn(`导入成功：本批 ${incoming.nodes.length} 颗星、${incoming.edges.length} 条关系；累计 ${merged.nodes.length} 颗星。${warnings.length?'\n注意：'+warnings.join('；'):''}`);$('input').value='';
 }catch(e){warn('导入失败：'+e.message,true)}
}
$('importBtn').onclick=()=>importText($('input').value);
$('resetBtn').onclick=()=>{setGraph(structuredClone(example));warn('已恢复虚构示例星图，未覆盖本机缓存。')};
$('chooseFile').onclick=()=>$('fileInput').click();
$('fileInput').onchange=async e=>{const file=e.target.files?.[0];if(file){if(file.size>12*1024*1024)warn('文件超过 12MB，请拆成多个批次。',true);else importText(await file.text());e.target.value=''}};
function download(data,name){const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
$('exportBtn').onclick=()=>download(graph,'memory-galaxy.mgp.json');
$('saveBtn').onclick=()=>{try{localStorage.setItem('memory-galaxy-mgp-v1',JSON.stringify(graph));warn('已主动保存到这个浏览器的本地存储。注意：localStorage 不加密。')}catch(e){warn('保存失败：'+e.message,true)}};
$('clearSaveBtn').onclick=()=>{localStorage.removeItem('memory-galaxy-mgp-v1');warn('已清除本地缓存。页面里的当前图谱仍然保留。')};
const zone=$('viewport'),drop=$('drop');
zone.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('active')});
zone.addEventListener('dragleave',e=>{if(!zone.contains(e.relatedTarget))drop.classList.remove('active')});
zone.addEventListener('drop',async e=>{e.preventDefault();drop.classList.remove('active');const file=e.dataTransfer?.files?.[0];if(file){if(file.size>12*1024*1024)warn('文件超过 12MB，请拆成多个批次。',true);else importText(await file.text())}});
try{const saved=localStorage.getItem('memory-galaxy-mgp-v1');if(saved){const g=JSON.parse(saved);if(validateMgp(g).ok){graph=g;warn('已读取你此前主动保存的本地图谱。')}}}catch{warn('本地缓存格式异常，已加载示例。',true)}
setGraph(graph);
