import {ALGORITHM_ID} from './strategy.js';
import {INPUT_FIELDS,computeTechValuation} from './valuation.js';
import {emptyData,parseTable,normalizeValuation,normalizeQuote,normalizeFxRate,validateBackup,symbol} from './model.js';

export const VALUATION_COLUMNS=['id','symbol','valuation_date','status','s_tech','score_method',...INPUT_FIELDS,
  'source_code','source_url','source_institution','as_of_period','evidence_summary','notes',
  'interpolated','provenance','is_current','revision','supersedes','observed_at','source_timestamp','retrieved_at'];
export const PRICE_COLUMNS=['symbol','as_of','price','currency','source_name','source_url','notes','retrieved_at'];
export const FX_COLUMNS=['pair','as_of','rate','source_url','notes','retrieved_at'];
const cell=v=>{const s=v==null?'':String(v);return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};
export function toCSV(columns,rows){return columns.join(',')+'\n'+rows.map(r=>columns.map(k=>cell(r[k])).join(',')).join('\n')+(rows.length?'\n':'');}
function table(text,columns){
  const header=String(text).replace(/^\uFEFF/,'').split(/\r?\n/,1)[0].split(',');
  if(header.some(k=>!columns.includes(k)))throw new Error('CSV 有未知列：'+header.filter(k=>!columns.includes(k)).join('、'));
  if(columns.some(k=>!header.includes(k)))throw new Error('CSV 缺少列：'+columns.filter(k=>!header.includes(k)).join('、'));
  return parseTable(text);
}
export function readValuationsCSV(text){
  return table(text,VALUATION_COLUMNS).map((input,i)=>{
    try{
      const row=Object.fromEntries(Object.entries(input).map(([k,v])=>[k,v===''?null:v]));
      row.raw_inputs=Object.fromEntries(INPUT_FIELDS.filter(k=>row[k]!=null).map(k=>[k,row[k]]));
      if(!Object.keys(row.raw_inputs).length)row.raw_inputs=null;
      row.revision=row.revision??1;
      const normalized=normalizeValuation(row);
      if(normalized.score_method==='formula'){
        const result=computeTechValuation(normalized.raw_inputs||{});
        if(result.status!==normalized.status||result.status==='valid'&&Math.abs(result.s_tech-normalized.s_tech)>1e-8*Math.max(1,Math.abs(result.s_tech)))throw new Error('公式输入与保存的 S_Tech 不一致');
      }
      return normalized;
    }catch(e){throw new Error(`估值 CSV 第 ${i+2} 行：${e.message}`);}
  });
}
export function readPricesCSV(text){return table(text,PRICE_COLUMNS).map(r=>{
  if(!r.as_of||!r.currency)throw new Error('价格必须注明日期和币种');return normalizeQuote(r);
});}
export function readFxCSV(text){return table(text,FX_COLUMNS).map(r=>{
  if(!r.as_of)throw new Error('汇率必须注明日期');return normalizeFxRate(r.pair,r);
});}
export function latestQuotes(prices,asOf){
  const quotes={};for(const row of prices)if(row.as_of<=asOf&&(!quotes[row.symbol]||quotes[row.symbol].as_of<row.as_of))quotes[row.symbol]=row;
  return quotes;
}
export function validateManifest(input){
  if(input?.schemaVersion!==1||input.algorithm!==ALGORITHM_ID||!Array.isArray(input.assets))throw new Error('项目数据 manifest 版本无效');
  const seen=new Set();
  const assets=input.assets.map(a=>{
    const sym=symbol(a.symbol);if(seen.has(sym))throw new Error('manifest 标的重复：'+sym);seen.add(sym);
    if(a.valuations!==`valuations/${sym}.csv`||a.prices!==`prices/${sym}.csv`)throw new Error('manifest 路径须与标的名称一致');
    return {symbol:sym,name:String(a.name||sym),valuations:a.valuations,prices:a.prices};
  });
  if(input.fxRates!=='fx-rates.csv'||input.formalEvents!=='formal-events.json')throw new Error('manifest 公共数据路径无效');
  return {schemaVersion:1,algorithm:ALGORITHM_ID,assets,fxRates:input.fxRates,formalEvents:input.formalEvents};
}
export async function readProjectData(readText){
  const manifest=validateManifest(JSON.parse(await readText('manifest.json'))),data=emptyData();
  const assets=await Promise.all(manifest.assets.map(async asset=>{
    const [valuations,prices]=await Promise.all([readText(asset.valuations),readText(asset.prices)]);
    const rows=readValuationsCSV(valuations),pricesRows=readPricesCSV(prices);
    if([...rows,...pricesRows].some(r=>r.symbol!==asset.symbol))throw new Error('文件标的与 manifest 不一致：'+asset.symbol);
    return {rows,pricesRows};
  }));
  for(const asset of assets){data.valuations.push(...asset.rows);data.prices.push(...asset.pricesRows);}
  for(const r of readFxCSV(await readText(manifest.fxRates))){if(data.fxRates[r.pair])throw new Error('汇率对重复：'+r.pair);data.fxRates[r.pair]=r;}
  const formal=JSON.parse(await readText(manifest.formalEvents));
  if(Array.isArray(formal))data.formalEvents=formal;
  else{
    if(!Array.isArray(formal.events)||!Array.isArray(formal.legacySymbols))throw new Error('正式状态文件结构无效');
    data.formalEvents=formal.events;data.legacyFormalEvents=formal.legacySymbols.map(sym=>({symbol:sym}));
  }
  return {manifest,data:validateBackup(data)};
}
export function projectFiles(input,names={}){
  const data=validateBackup(input);
  const symbols=[...new Set([...data.valuations.map(r=>r.symbol),...data.prices.map(r=>r.symbol)])].sort();
  const manifest={schemaVersion:1,algorithm:ALGORITHM_ID,assets:symbols.map(sym=>({symbol:sym,name:names[sym]||sym,
    valuations:`valuations/${sym}.csv`,prices:`prices/${sym}.csv`})),fxRates:'fx-rates.csv',formalEvents:'formal-events.json'};
  const files={'manifest.json':JSON.stringify(manifest,null,2)+'\n',
    'fx-rates.csv':toCSV(FX_COLUMNS,Object.values(data.fxRates).sort((a,b)=>a.pair.localeCompare(b.pair))),
    'formal-events.json':JSON.stringify({events:data.formalEvents,legacySymbols:data.legacyFormalEvents.map(e=>e.symbol)},null,2)+'\n'};
  for(const sym of symbols){
    const rows=data.valuations.filter(r=>r.symbol===sym).sort((a,b)=>a.valuation_date.localeCompare(b.valuation_date)||a.revision-b.revision);
    files[`valuations/${sym}.csv`]=toCSV(VALUATION_COLUMNS,rows.map(r=>({...r,...r.raw_inputs})));
    files[`prices/${sym}.csv`]=toCSV(PRICE_COLUMNS,data.prices.filter(r=>r.symbol===sym).sort((a,b)=>a.as_of.localeCompare(b.as_of)));
  }
  return files;
}
// A single ZIP download preserves the repository folders, with no runtime library.
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
export function projectZIP(data,names={}){
  const encoder=new TextEncoder(),parts=[],central=[];let offset=0;
  for(const [path,text] of Object.entries(projectFiles(data,names))){
    const name=encoder.encode('data/'+path),body=encoder.encode(text),crc=crc32(body);
    const local=new Uint8Array(30+name.length),v=new DataView(local.buffer);
    v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x0800,true);v.setUint16(12,33,true);
    v.setUint32(14,crc,true);v.setUint32(18,body.length,true);v.setUint32(22,body.length,true);v.setUint16(26,name.length,true);local.set(name,30);
    const directory=new Uint8Array(46+name.length),d=new DataView(directory.buffer);
    d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x0800,true);d.setUint16(14,33,true);
    d.setUint32(16,crc,true);d.setUint32(20,body.length,true);d.setUint32(24,body.length,true);d.setUint16(28,name.length,true);d.setUint32(42,offset,true);directory.set(name,46);
    parts.push(local,body);central.push(directory);offset+=local.length+body.length;
  }
  const centralLength=central.reduce((sum,p)=>sum+p.length,0),end=new Uint8Array(22),v=new DataView(end.buffer);
  v.setUint32(0,0x06054b50,true);v.setUint16(8,central.length,true);v.setUint16(10,central.length,true);v.setUint32(12,centralLength,true);v.setUint32(16,offset,true);
  parts.push(...central,end);const output=new Uint8Array(offset+centralLength+end.length);let position=0;
  for(const p of parts){output.set(p,position);position+=p.length;}return output;
}
