/* Memory Graph Protocol 1.0: no dependencies, no network, no evaluation of source text. */
export const PROTOCOL = 'mgp/1.0';
const types = new Set(['memory','person','project','topic','event','preference','goal','skill','other']);
const states = new Set(['confirmed','inferred','deprecated','disputed','unknown']);
const basis = new Set(['explicit','inferred','rule']);
const has = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = x => typeof x === 'string' && x.trim().length > 0;
const validId = x => str(x) && x.length <= 256 && !/[\u0000-\u001F]/.test(x);
const iso = s => s === undefined || (typeof s === 'string' && !Number.isNaN(Date.parse(s)));
function error(issues,where,message){issues.push(`${where}: ${message}`)}
export function validateMgp(value, knownIds = []){
  const errors=[],warnings=[];
  if(!obj(value)){error(errors,'root','必须是 JSON 对象');return {ok:false,errors,warnings};}
  if(value.protocol !== PROTOCOL) error(errors,'protocol',`需要 ${PROTOCOL}`);
  if(!obj(value.source) || !validId(value.source.id)) error(errors,'source.id','必须提供稳定的来源标识');
  if(value.source && has(value.source,'completeness') && !['full','partial','unknown'].includes(value.source.completeness)) error(errors,'source.completeness','只能是 full / partial / unknown');
  if(!Array.isArray(value.nodes))error(errors,'nodes','必须是数组');
  if(!Array.isArray(value.edges))error(errors,'edges','必须是数组');
  if(errors.length)return {ok:false,errors,warnings};
  if(value.nodes.length>50000 || value.edges.length>250000)error(errors,'limits','单次导入超过安全上限，请分批导入（协议本身没有数量上限）');
  const ids=new Set(); const allIds=new Set(knownIds);
  value.nodes.forEach((n,i)=>{
    const p=`nodes[${i}]`;
    if(!obj(n)){error(errors,p,'必须是对象');return;}
    if(!validId(n.id))error(errors,p+'.id','必须是非空、稳定的 ID（最长 256 字符）');
    else if(ids.has(n.id))error(errors,p+'.id','重复 ID'); else {ids.add(n.id);allIds.add(n.id);}
    if(!str(n.label)||n.label.length>200)error(errors,p+'.label','必须是 1 至 200 字符的标题');
    if(!types.has(n.type))error(errors,p+'.type','不支持的类别');
    if(n.content!==undefined && (typeof n.content!=='string'||n.content.length>100000))error(errors,p+'.content','必须是文本（最长 100000 字符）');
    if(n.tags!==undefined && (!Array.isArray(n.tags)||n.tags.some(t=>!str(t)||t.length>100)))error(errors,p+'.tags','必须是字符串数组');
    if(n.state!==undefined && !states.has(n.state))error(errors,p+'.state','状态非法');
    if(!iso(n.updated_at))error(errors,p+'.updated_at','时间格式不合法');
    if(n.sensitive!==undefined && typeof n.sensitive!=='boolean')error(errors,p+'.sensitive','必须是布尔值');
    if(n.source_ref!==undefined && typeof n.source_ref!=='string')error(errors,p+'.source_ref','必须是文本');
  });
  const edges=new Set();
  value.edges.forEach((e,i)=>{
    const p=`edges[${i}]`;
    if(!obj(e)){error(errors,p,'必须是对象');return;}
    if(!validId(e.from)||!validId(e.to))error(errors,p,'from/to 必须是稳定 ID');
    else if(!allIds.has(e.from)||!allIds.has(e.to))error(errors,p,'引用了不存在的节点（可把跨批次关系放到后续增量批次）');
    if(!validId(e.type))error(errors,p+'.type','关系类型必须是非空文本');
    if(!basis.has(e.basis))error(errors,p+'.basis','必须标记 explicit / inferred / rule');
    if(e.from===e.to)warnings.push(`${p}: 自环关系，请确认是否有必要`);
    const k=[e.from,e.to,e.type].join('\u0000'); if(edges.has(k))warnings.push(`${p}: 重复关系，将被合并`);else edges.add(k);
    if(e.evidence!==undefined && typeof e.evidence!=='string')error(errors,p+'.evidence','必须是文本');
  });
  if(value.source?.completeness==='full')warnings.push('来源声明 full 仅代表导出方自述，星盘无法独立证明全量覆盖');
  return {ok:errors.length===0,errors,warnings};
}
export function parseMgp(text, knownIds = []){
  let data;try{data=JSON.parse(text)}catch(e){throw Error('JSON 解析失败：'+e.message)}
  const result=validateMgp(data,knownIds);if(!result.ok)throw Error(result.errors.slice(0,12).join('\n')+(result.errors.length>12?`\n…另有 ${result.errors.length-12} 条错误`:''));
  return {graph:data,warnings:result.warnings};
}
export function mergeMgp(base,incoming){
  const v=validateMgp(incoming,(base?.nodes||[]).map(n=>n.id));if(!v.ok)throw Error(v.errors.join('\n'));
  if(base){const check=validateMgp(base);if(!check.ok)throw Error('原有图谱无效：'+check.errors.join('\n'));}
  const nodes=new Map((base?.nodes||[]).map(n=>[n.id,n]));
  incoming.nodes.forEach(n=>nodes.set(n.id,{...nodes.get(n.id),...n}));
  const edges=new Map((base?.edges||[]).map(e=>[[e.from,e.to,e.type].join('\u0000'),e]));
  incoming.edges.forEach(e=>edges.set([e.from,e.to,e.type].join('\u0000'),e));
  const sources=new Map((base?.sources||[]).map(s=>[s.id,s]));
  if(base?.source?.id)sources.set(base.source.id,base.source);
  sources.set(incoming.source.id,incoming.source);
  const merged={protocol:PROTOCOL,source:{id:'merged',completeness:'unknown'},sources:[...sources.values()],nodes:[...nodes.values()],edges:[...edges.values()]};
  const checked=validateMgp(merged);if(!checked.ok)throw Error('合并后关系失效：'+checked.errors.join('\n'));
  return merged;
}
export const example={
  protocol:PROTOCOL,
  source:{id:'demo:fictional',platform:'example',scope:'示例数据',completeness:'partial',exported_at:'2026-01-01T00:00:00Z'},
  nodes:[
    {id:'demo:project:galaxy',label:'记忆星盘',type:'project',content:'通过开放数据协议呈现任意来源的记忆。',state:'confirmed'},
    {id:'demo:topic:graph',label:'知识图谱',type:'topic',content:'以节点和关系表示知识。',state:'confirmed'},
    {id:'demo:topic:protocol',label:'统一协议',type:'topic',content:'让各平台自行生成结构化 JSON。',state:'confirmed'},
    {id:'demo:skill:typescript',label:'TypeScript',type:'skill',content:'用于静态类型约束和前端开发。',state:'confirmed'},
    {id:'demo:topic:import',label:'复制粘贴导入',type:'topic',state:'confirmed'},
    {id:'demo:topic:traceability',label:'来源可追溯',type:'topic',state:'confirmed'},
    {id:'demo:goal:privacy',label:'隐私优先',type:'goal',state:'confirmed'},
    {id:'demo:topic:offline',label:'离线运行',type:'topic',state:'confirmed'}
  ],
  edges:[
    {from:'demo:project:galaxy',to:'demo:topic:graph',type:'uses',basis:'explicit'},
    {from:'demo:project:galaxy',to:'demo:topic:protocol',type:'uses',basis:'explicit'},
    {from:'demo:topic:protocol',to:'demo:topic:import',type:'enables',basis:'explicit'},
    {from:'demo:topic:protocol',to:'demo:topic:traceability',type:'supports',basis:'explicit'},
    {from:'demo:topic:graph',to:'demo:skill:typescript',type:'implemented_with',basis:'explicit'},
    {from:'demo:goal:privacy',to:'demo:topic:offline',type:'supports',basis:'explicit'},
    {from:'demo:project:galaxy',to:'demo:goal:privacy',type:'prioritizes',basis:'explicit'}
  ]
};
