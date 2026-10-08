import {CONFIG,Controller,valuationState,envelope,Account} from './strategy.js';
import {monthNumber,monthFromNumber} from './preview.js';
export const SCHEMA_VERSION=1;
export const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
export const uid=()=>globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(16).slice(2)}`;
export function emptyData(){return {schemaVersion:SCHEMA_VERSION,algorithm:'finite-rational-60-rho0.9',
  account:{currency:'EUR',financing:0,updatedAt:null},holdings:[],valuations:[],formalEvents:[],migrationNotes:[],updatedAt:null};}
export function number(value,label){
  if(value===null||value===undefined||typeof value==='boolean'||String(value).trim()===''||!Number.isFinite(Number(value)))throw new Error(`${label} 必须是有限数值`);
  return Number(value);
}
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
  // Whitelist keeps the public/local schema small while retaining source evidence.
  return {id:String(row.id||uid()),symbol:symbol(row.symbol),valuation_date:date,s_tech:score,status,
    source_code:String(row.source_code||'manual'),notes:String(row.notes||''),interpolated,provenance,
    is_current:flag(row.is_current,'is_current',true),revision:row.revision===undefined?1:number(row.revision,'revision'),
    observed_at:row.observed_at??null,source_timestamp:row.source_timestamp??null,raw_inputs:row.raw_inputs??null,
    derived_result:row.derived_result??null,supersedes:row.supersedes??null};
}
export function parseCSV(text){
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
  if(!header.includes('symbol')||!header.includes('s_tech')||!(header.includes('valuation_date')||header.includes('month')))throw new Error('CSV 需要 symbol、valuation_date（或 month）、s_tech 列');
  return rows.map((r,i)=>{if(r.length!==header.length)throw new Error(`CSV 第 ${i+2} 行列数不一致`);return Object.fromEntries(header.map((k,j)=>[k,r[j]]));});
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
    if(current.some(r=>r.s_tech===row.s_tech&&r.status===row.status&&r.source_code===row.source_code&&r.interpolated===row.interpolated&&r.provenance===row.provenance&&r.notes===row.notes&&JSON.stringify(r.raw_inputs)===JSON.stringify(row.raw_inputs))){skipped++;continue;}
    for(const old of current)old.is_current=false;
    next.valuations.push({...row,id:uid(),revision:current.length?Math.max(...current.map(r=>r.revision))+1:row.revision,supersedes:current.at(-1)?.id??row.supersedes});added++;
  }
  return {data:next,added,skipped};
}
export function normalizeHolding(p,currency){
  const quantity=number(p.quantity,'数量'),market_value=number(p.market_value,'市值');
  if(quantity<0)throw new Error('当前账户模型不支持空头；数量不得为负');
  if(market_value<0||quantity>0&&market_value<=0||quantity===0&&market_value!==0)throw new Error('非零持仓市值须为正；零数量的市值须为零');
  if(p.currency&&p.currency!==currency)throw new Error('全部持仓市值须换算到账户基础币种');
  const result={id:String(p.id||uid()),symbol:symbol(p.symbol),quantity,market_value,sec_type:String(p.sec_type||'STK'),currency};
  if(p.source_currency){
    result.source_currency=String(p.source_currency);result.source_market_value=number(p.source_market_value,'原币种市值');
    result.conversion_rate=number(p.conversion_rate,'迁移汇率');if(result.conversion_rate<=0)throw new Error('迁移汇率须为正');
    result.conversion_snapshot_time=p.conversion_snapshot_time??null;
  }
  return result;
}
export function normalizeAccount(account,holdings){
  const currency=String(account.currency||'').trim().toUpperCase();
  if(!/^[A-Z]{3}$/.test(currency))throw new Error('基础币种须为三位代码，例如 EUR / USD');
  const financing=number(account.financing,'融资余额 B'),positions=holdings.map(p=>normalizeHolding(p,currency));
  const A=positions.reduce((s,p)=>s+p.market_value,0),E=A-financing;
  if(!Number.isFinite(A)||!Number.isFinite(E)||E<=0)throw new Error('净值 E=A−B 必须为正；请检查市值、融资余额或负值现金');
  return {account:{currency,financing,updatedAt:account.updatedAt||new Date().toISOString()},holdings:positions};
}
export function accountSummary(data,portfolio){
  const A=data.holdings.reduce((s,p)=>s+p.market_value,0),B=data.account.financing,E=A-B;
  const valid=Number.isFinite(E)&&E>0;
  const target=valid&&portfolio.status==='ready'?portfolio.target_leverage:null;
  const targetMarketValue=target===null?null:E*target,adjustment=targetMarketValue===null?null:targetMarketValue-A;
  let exact=null;
  if(target!==null){const account=new Account(A,B);const [trade,fee]=account.rebalanceTo(target);exact={trade,fee};}
  return {A,B,E,valid,actualLeverage:valid?(A>0?A/E:0):null,target,targetMarketValue,adjustment,exact,
    hardCapBreached:valid&&A>0&&A/E>CONFIG.hard_cap};
}
export function controllerFromLegacyRun(run){
  let cfg=run.strategy_config;if(typeof cfg==='string'){try{cfg=JSON.parse(cfg);}catch{cfg=null;}}
  if(!cfg||!('rho' in cfg))return null;
  return {initialized:!!(run.entered||run.entry_pending||run.z!==null&&run.z!==undefined),entered:!!run.entered,entry_pending:!!run.entry_pending,
    z:run.z==null?null:Number(run.z),previous_x:run.x==null?null:Number(run.x),direction:run.controller_direction||'flat',
    alpha:run.controller_alpha==null?1:Number(run.controller_alpha),beta:run.controller_beta==null?1:Number(run.controller_beta),
    pending_target:run.pending_target==null?null:Number(run.pending_target),current_target:run.current_target==null?null:Number(run.current_target)};
}
export function validateControllerState(st){
  if(!st||typeof st!=='object')throw new Error('正式控制器状态无效');
  for(const k of ['initialized','entered','entry_pending'])if(typeof st[k]!=='boolean')throw new Error(`控制器 ${k} 无效`);
  if(!['up','down','flat'].includes(st.direction))throw new Error('控制器方向无效');
  for(const k of ['z','previous_x'])if(st[k]!==null&&(!Number.isFinite(st[k])||st[k]<0||st[k]>1))throw new Error(`控制器 ${k} 无效`);
  for(const k of ['alpha','beta'])if(!Number.isFinite(st[k])||st[k]<0)throw new Error(`控制器 ${k} 无效`);
  for(const k of ['pending_target','current_target'])if(st[k]!==null&&(!Number.isFinite(st[k])||st[k]<CONFIG.l_min||st[k]>CONFIG.l_max))throw new Error(`控制器 ${k} 无效`);
  if((st.entered||st.entry_pending)&&(st.z===null||st.previous_x===null))throw new Error('正式控制器缺少 z / previous_x');
  if(st.entry_pending&&st.pending_target===null||st.entered&&st.current_target===null)throw new Error('正式控制器缺少目标');
  return structuredClone(st);
}
export function validateBackup(input){
  if(input?.schemaVersion!==SCHEMA_VERSION||input?.algorithm!=='finite-rational-60-rho0.9')throw new Error('备份版本或策略标识不兼容');
  if(!['holdings','valuations','formalEvents'].every(k=>Array.isArray(input[k])))throw new Error('备份缺少持仓、估值或正式状态数组');
  const data=emptyData();
  // An untouched empty account is a valid backup, but cannot yield an account recommendation.
  if(!input.holdings.length&&Number(input.account?.financing)===0){
    const currency=String(input.account.currency||'').toUpperCase();if(!/^[A-Z]{3}$/.test(currency))throw new Error('基础币种无效');
    data.account={currency,financing:0,updatedAt:input.account.updatedAt??null};
  }else Object.assign(data,normalizeAccount(input.account,input.holdings));
  data.valuations=input.valuations.map(normalizeValuation);
  const ids=new Set(),currents=new Set();
  for(const row of data.valuations){if(ids.has(row.id))throw new Error('估值记录 ID 重复');ids.add(row.id);
    if(row.is_current){const key=`${row.symbol}/${row.valuation_date}`;if(currents.has(key))throw new Error('同日当前估值记录重复');currents.add(key);}}
  data.formalEvents=input.formalEvents.map(event=>{
    if(!event.config||JSON.stringify(Object.keys(CONFIG).map(k=>event.config[k]))!==JSON.stringify(Object.values(CONFIG)))throw new Error('正式事件参数与当前策略不一致');
    if(!['month_end','activate','migration'].includes(event.event_type))throw new Error('正式事件类型无效');
    validDate(event.signal_date);if(event.effective_date)validDate(event.effective_date);
    return {...event,symbol:symbol(event.symbol),state:validateControllerState(event.state)};
  });
  data.migrationNotes=Array.isArray(input.migrationNotes)?input.migrationNotes:[];
  data.updatedAt=input.updatedAt??null;return data;
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
  const x=valuationState(current.s_tech,previous,true),ctl=new Controller(CONFIG,last?.state??null);ctl.observeMonthEnd(x);
  const event={id:uid(),symbol:sym,event_type:'month_end',signal_date:date,effective_date:null,createdAt:new Date().toISOString(),
    valuation_id:current.id,x,boundaries:envelope(x),config:{...CONFIG},state:structuredClone(ctl.state)};
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
