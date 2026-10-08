import {ALGORITHM_ID,CONFIG,Controller,valuationState,envelope} from './strategy.js';
import {monthNumber,monthFromNumber} from './preview.js';
import {INPUT_FIELDS} from './valuation.js';
export const SCHEMA_VERSION=4;
export const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
export const uid=()=>globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(16).slice(2)}`;
export function emptyData(){return {schemaVersion:SCHEMA_VERSION,algorithm:ALGORITHM_ID,
  valuations:[],prices:[],fxRates:{},formalEvents:[],legacyFormalEvents:[],migrationNotes:[],updatedAt:null};}
export function number(value,label){
  if(value===null||value===undefined||typeof value==='boolean'||String(value).trim()===''||!Number.isFinite(Number(value)))throw new Error(`${label} 必须是有限数值`);
  return Number(value);
}
function optionalText(value){if(value==null)return null;if(typeof value==='object')throw new Error('来源时间和记录引用须为文本');return String(value);}
export function symbol(value){const s=String(value??'').trim().toUpperCase();if(!/^[A-Z0-9.\-]{1,20}$/.test(s))throw new Error('Symbol 须为 1–20 位字母、数字、点或连字符');return s;}
export function validDate(value){
  const s=String(value??'');const d=new Date(s+'T12:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==s)throw new Error(`无效日期：${s}`);
  return s;
}
export function monthEnd(month){
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new Error('月份须为 YYYY-MM');
  const [y,m]=month.split('-').map(Number);return `${month}-${String(new Date(Date.UTC(y,m,0)).getUTCDate()).padStart(2,'0')}`;
}
function flag(value,name,defaultValue){if(value===undefined||value===null||value==='')return defaultValue;
  if(value===true||value==='true'||value==='1'||value===1)return true;
  if(value===false||value==='false'||value==='0'||value===0)return false;throw new Error(`${name} 必须为 true/false`);}
export function normalizeValuation(row){
  const status=row.status||'valid';if(!['valid','na'].includes(status))throw new Error('status 须为 valid 或 na');
  const score=status==='valid'?number(row.s_tech,'S_Tech'):null;
  const date=validDate(row.valuation_date||monthEnd(String(row.month||'')));
  const interpolated=flag(row.interpolated,'interpolated',false);
  const provenance=row.provenance||(interpolated?'source-interpolated':'observation');
  if(!['observation','source-interpolated','legacy-unknown'].includes(provenance))throw new Error('来源标记无效');
  const scoreMethod=row.score_method||'manual';
  if(!['manual','formula'].includes(scoreMethod))throw new Error('score_method 须为 manual 或 formula');
  const raw=row.raw_inputs?Object.fromEntries(INPUT_FIELDS.filter(k=>row.raw_inputs[k]!==undefined&&row.raw_inputs[k]!==null&&row.raw_inputs[k]!=='').map(k=>[k,number(row.raw_inputs[k],k)])):null;
  // Only public market data and source evidence belong in the project dataset.
  return {id:String(row.id||uid()),symbol:symbol(row.symbol),valuation_date:date,s_tech:score,status,
    source_code:String(row.source_code||'manual'),notes:String(row.notes||''),interpolated,provenance,
    is_current:flag(row.is_current,'is_current',true),revision:row.revision===undefined?1:number(row.revision,'revision'),
    observed_at:optionalText(row.observed_at),source_timestamp:optionalText(row.source_timestamp),raw_inputs:raw,
    supersedes:optionalText(row.supersedes),
    source_institution:row.source_institution?String(row.source_institution):null,
    as_of_period:row.as_of_period?String(row.as_of_period):null,
    evidence_summary:row.evidence_summary?String(row.evidence_summary):null,
    source_url:row.source_url?String(row.source_url):null,
    retrieved_at:row.retrieved_at?String(row.retrieved_at):null,
    score_method:scoreMethod};
}
export function parseTable(text){
  const rows=[];let row=[],cell='',quoted=false;
  const src=String(text).replace(/^\uFEFF/,'');
  for(let i=0;i<src.length;i++){
    const c=src[i];
    if(quoted){if(c==='"'){if(src[i+1]==='"'){cell+='"';i++;}else quoted=false;}else cell+=c;}
    else if(c==='"'){if(cell)throw new Error('CSV 引号位置无效');quoted=true;}
    else if(c===','){row.push(cell);cell='';}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&src[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  if(quoted)throw new Error('CSV 存在未闭合引号');
  row.push(cell);if(row.some(x=>x.trim()))rows.push(row);
  if(!rows.length)throw new Error('CSV 文件为空');
  const header=rows.shift().map(x=>x.trim());
  if(new Set(header).size!==header.length)throw new Error('CSV 表头重复');
  return rows.map((r,i)=>{if(r.length!==header.length)throw new Error(`CSV 第 ${i+2} 行列数不一致`);return Object.fromEntries(header.map((k,j)=>[k,r[j]]));});
}
export function parseCSV(text){
  const rows=parseTable(text);
  if(rows.length&&!('symbol' in rows[0]&&'s_tech' in rows[0]&&('valuation_date' in rows[0]||'month' in rows[0])))throw new Error('CSV 需要 symbol、valuation_date（或 month）、s_tech 列');
  return rows;
}
export function parseValuations(text,filename){
  let rows;if(/\.csv$/i.test(filename))rows=parseCSV(text);
  else {const parsed=JSON.parse(text);rows=Array.isArray(parsed)?parsed:parsed.valuations;}
  if(!Array.isArray(rows)||!rows.length)throw new Error('需要非空估值数组');
  const errors=[],normalized=[];
  rows.forEach((r,i)=>{try{normalized.push(normalizeValuation(r));}catch(e){errors.push(`第 ${i+1} 条：${e.message}`);}});
  if(errors.length)throw new Error(errors.slice(0,12).join('\n')+(errors.length>12?`\n另有 ${errors.length-12} 条错误`:''));
  return normalized;
}
export function mergeValuations(data,rows){
  const next=structuredClone(data);let added=0,skipped=0;
  for(const input of rows){const row=normalizeValuation(input);
    if(!row.is_current){if(!next.valuations.some(r=>r.id===row.id))next.valuations.push(row);else skipped++;continue;}
    const current=next.valuations.filter(r=>r.symbol===row.symbol&&r.valuation_date===row.valuation_date&&r.is_current);
    const comparable=r=>JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k])=>!['id','revision','supersedes'].includes(k))));
    if(current.some(r=>comparable(r)===comparable(row))){skipped++;continue;}
    for(const old of current)old.is_current=false;
    next.valuations.push({...row,id:uid(),revision:current.length?Math.max(...current.map(r=>r.revision))+1:row.revision,supersedes:current.at(-1)?.id??row.supersedes});added++;
  }
  return {data:next,added,skipped};
}
// Calculation inputs live only in memory. Never include these in a dataset export.
export function normalizeSessionHolding(p,defaultCurrency='USD'){
  const mode=p.input_mode||'ratio';
  if(!['ratio','market_value'].includes(mode))throw new Error('请选择市值或比例');
  const value=number(mode==='ratio'?p.ratio:p.market_value,mode==='ratio'?'比例':'市值');
  if(value<=0)throw new Error('市值或比例须为正数');
  const currency=String(p.currency||defaultCurrency).trim().toUpperCase();
  if(!/^[A-Z]{3}$/.test(currency))throw new Error('币种须为三位代码');
  return {id:String(p.id||uid()),symbol:symbol(p.symbol),input_mode:mode,sec_type:'STK',currency,
    ...(mode==='ratio'?{ratio:value}:{market_value:value})};
}
export function controllerFromLegacyRun(run){
  let cfg=run.strategy_config;if(typeof cfg==='string'){try{cfg=JSON.parse(cfg);}catch{cfg=null;}}
  if(!cfg||Object.entries(CONFIG).some(([key,value])=>cfg[key]!==value))return null;
  const pivot=cfg.controller_pivot;
  if((run.entered||run.entry_pending||run.z!=null)&&(!pivot||pivot.x==null||pivot.z==null))return null;
  return validateControllerState({initialized:!!(run.entered||run.entry_pending||run.z!==null&&run.z!==undefined),entered:!!run.entered,entry_pending:!!run.entry_pending,
    z:run.z==null?null:Number(run.z),previous_x:run.x==null?null:Number(run.x),direction:run.controller_direction||'flat',
    alpha:run.controller_alpha==null?1:Number(run.controller_alpha),beta:run.controller_beta==null?1:Number(run.controller_beta),
    pivot_x:pivot?.x==null?null:Number(pivot.x),pivot_z:pivot?.z==null?null:Number(pivot.z),
    pending_target:run.pending_target==null?null:Number(run.pending_target),current_target:run.current_target==null?null:Number(run.current_target)});
}
export function validateControllerState(st){
  if(!st||typeof st!=='object')throw new Error('正式控制器状态无效');
  for(const k of ['initialized','entered','entry_pending'])if(typeof st[k]!=='boolean')throw new Error(`控制器 ${k} 无效`);
  if(!['up','down','flat'].includes(st.direction))throw new Error('控制器方向无效');
  for(const k of ['z','previous_x','pivot_x','pivot_z'])if(st[k]!==null&&(!Number.isFinite(st[k])||st[k]<0||st[k]>1))throw new Error(`控制器 ${k} 无效`);
  for(const k of ['alpha','beta'])if(!Number.isFinite(st[k])||st[k]<0)throw new Error(`控制器 ${k} 无效`);
  for(const k of ['pending_target','current_target'])if(st[k]!==null&&(!Number.isFinite(st[k])||st[k]<CONFIG.l_min||st[k]>CONFIG.l_max))throw new Error(`控制器 ${k} 无效`);
  if((st.entered||st.entry_pending)&&(st.z===null||st.previous_x===null))throw new Error('正式控制器缺少 z / previous_x');
  if(st.initialized&&(st.pivot_x===null||st.pivot_z===null))throw new Error('正式控制器缺少反转锚点');
  if(st.entry_pending&&st.pending_target===null||st.entered&&st.current_target===null)throw new Error('正式控制器缺少目标');
  const keys=['initialized','entered','entry_pending','z','previous_x','direction','alpha','beta','pivot_x','pivot_z','pending_target','current_target'];
  return Object.fromEntries(keys.map(k=>[k,st[k]]));
}
export function normalizeQuote(q){
  if(!q||typeof q!=='object')throw new Error('无效报价');
  const sym=symbol(q.symbol),pr=number(q.price,'价格');
  if(pr<=0)throw new Error('价格必须为正数');
  const curr=String(q.currency||'USD').trim().toUpperCase();
  if(!/^[A-Z]{3}$/.test(curr))throw new Error('报价币种须为三位代码');
  return {symbol:sym,price:pr,currency:curr,as_of:q.as_of?validDate(q.as_of):today(),
    source_url:String(q.source_url||''),source_name:String(q.source_name||''),notes:String(q.notes||''),retrieved_at:optionalText(q.retrieved_at)};
}
export function normalizeFxRate(pair,r){
  const p=String(pair||'').trim().toUpperCase();
  if(!/^[A-Z]{3}[\/_][A-Z]{3}$/.test(p))throw new Error('汇率对格式须为 EUR/USD');
  const normalizedPair=p.replace('_','/');
  const val=typeof r==='object'&&r!==null?r.rate:r;
  const rate=number(val,'汇率');if(rate<=0)throw new Error('汇率必须为正数');
  return {pair:normalizedPair,rate,as_of:(typeof r==='object'&&r?.as_of)?validDate(r.as_of):today(),
    source_url:String(typeof r==='object'&&r?.source_url||''),notes:String(typeof r==='object'&&r?.notes||''),retrieved_at:optionalText(typeof r==='object'?r?.retrieved_at:null)};
}
export function validateBackup(input){
  const legacy=input?.algorithm==='finite-rational-60-rho0.9'&&[1,2].includes(input?.schemaVersion);
  const current=input?.algorithm===ALGORITHM_ID&&[2,3,SCHEMA_VERSION].includes(input?.schemaVersion);
  if(!legacy&&!current)throw new Error('数据版本或策略标识不兼容');
  if(!Array.isArray(input.valuations))throw new Error('数据缺少估值数组');
  const data=emptyData();
  data.valuations=input.valuations.map(normalizeValuation);
  const ids=new Set(),currents=new Set();
  for(const row of data.valuations){
    if(ids.has(row.id))throw new Error('估值记录 ID 重复');ids.add(row.id);
    if(!Number.isInteger(row.revision)||row.revision<1)throw new Error('revision 须为正整数');
    if(row.is_current){const key=row.symbol+'/'+row.valuation_date;
      if(currents.has(key))throw new Error('同日当前估值记录重复');currents.add(key);}
  }
  data.formalEvents=(legacy?[]:(input.formalEvents||[])).map(event=>{
    if(!event.config||Object.entries(CONFIG).some(([k,v])=>event.config[k]!==v))throw new Error('正式事件参数与当前策略不一致');
    if(!['month_end','activate','migration'].includes(event.event_type))throw new Error('正式事件类型无效');
    const x=event.x==null?null:number(event.x,'x');if(x!==null&&(x<0||x>1))throw new Error('正式事件 x 须在 0–1 之间');
    return {id:String(event.id||uid()),symbol:symbol(event.symbol),event_type:event.event_type,
      signal_date:validDate(event.signal_date),effective_date:event.effective_date?validDate(event.effective_date):null,
      createdAt:optionalText(event.createdAt),valuation_id:optionalText(event.valuation_id),x,boundaries:x===null?null:envelope(x),
      config:{...CONFIG},state:validateControllerState(event.state),history_replayed:!!event.history_replayed};
  });
  const legacySymbols=[...(input.legacyFormalEvents||[]),...(legacy?(input.formalEvents||[]):[])];
  data.legacyFormalEvents=[...new Set(legacySymbols.map(event=>symbol(event.symbol)))].map(sym=>({symbol:sym}));
  data.prices=(input.prices||Object.entries(input.quotes||{}).map(([sym,q])=>({...q,symbol:sym}))).map(normalizeQuote);
  const priceKeys=new Set();for(const row of data.prices){const key=row.symbol+'/'+row.as_of;
    if(priceKeys.has(key))throw new Error('同日价格记录重复');priceKeys.add(key);}
  for(const [pair,row] of Object.entries(input.fxRates||{})){
    const normalized=normalizeFxRate(pair,row);data.fxRates[normalized.pair]=normalized;
  }
  // Old account, position and job fields are deliberately never copied.
  data.updatedAt=optionalText(input.updatedAt);return data;
}
export function formalMonthEnd(data,sym,date,asOf=today()){
  symbol(sym);validDate(date);if(date>asOf)throw new Error('不能生成未来日期的月末信号');
  if(date!==monthEnd(date.slice(0,7)))throw new Error('正式信号日期须为月末');
  const events=data.formalEvents.filter(r=>r.symbol===sym),last=events.at(-1);
  if(last&&date<=last.signal_date)throw new Error('该月已有正式记录；新信号须晚于上一信号月份');
  if(last?.state.entry_pending||last?.state.pending_target!==null&&last?.state.pending_target!==undefined)throw new Error('先激活上一 pending target，再生成下一月信号');
  const monthly=new Map();for(const row of data.valuations){if(row.symbol!==sym||!row.is_current||row.status!=='valid'||row.valuation_date>date)continue;
    const m=row.valuation_date.slice(0,7),old=monthly.get(m);if(!old||row.valuation_date>=old.valuation_date)monthly.set(m,row);}
  const current=monthly.get(date.slice(0,7));if(!current)throw new Error('该月没有有效 S_Tech');
  const previous=[...monthly.entries()].filter(([m])=>m<date.slice(0,7)).sort(([a],[b])=>a.localeCompare(b)).map(([,r])=>r.s_tech);
  const x=valuationState(current.s_tech,previous,true),ctl=new Controller(CONFIG,last?.state??null);
  const replayed=!last&&(data.legacyFormalEvents||[]).some(e=>String(e.symbol||'').trim().toUpperCase()===sym);
  if(replayed)for(let i=CONFIG.valuation_window_months-1;i<previous.length;i++){
    ctl.observeMonthEnd(valuationState(previous[i],previous.slice(0,i),true));ctl.activatePendingTarget();
  }
  ctl.observeMonthEnd(x);
  const event={id:uid(),symbol:sym,event_type:'month_end',signal_date:date,effective_date:null,createdAt:new Date().toISOString(),
    valuation_id:current.id,x,boundaries:envelope(x),config:{...CONFIG},state:structuredClone(ctl.state),history_replayed:replayed};
  const next=structuredClone(data);next.formalEvents.push(event);return next;
}
export function activateFormal(data,sym,effectiveDate,asOf=today()){
  validDate(effectiveDate);if(effectiveDate>asOf)throw new Error('尚未到激活日期');
  const last=data.formalEvents.filter(e=>e.symbol===sym).at(-1);if(!last)throw new Error('没有正式信号');
  if(monthNumber(effectiveDate)<=monthNumber(last.signal_date))throw new Error('目标最早在下一月份首个交易日收盘激活');
  const ctl=new Controller(CONFIG,last.state);if(ctl.activatePendingTarget()===null)throw new Error('没有 pending target 可激活');
  const next=structuredClone(data);next.formalEvents.push({...last,id:uid(),event_type:'activate',effective_date:effectiveDate,
    createdAt:new Date().toISOString(),state:structuredClone(ctl.state)});return next;
}
