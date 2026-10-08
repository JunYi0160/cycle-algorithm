import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {emptyData,normalizeValuation,formalMonthEnd,monthEnd} from '../src/model.js';
import {projectFiles,projectZIP,readProjectData,readValuationsCSV,readPricesCSV,latestQuotes,validateManifest} from '../src/project-data.js';
import {computeTechValuation,INPUT_FIELDS} from '../src/valuation.js';
import {load,exportBackup} from '../src/storage.js';
import {checkProjectData} from '../scripts/project-files.mjs';
const sample=()=>({...emptyData(),valuations:[normalizeValuation({id:'one',symbol:'AAA',valuation_date:'2025-01-31',s_tech:5,source_url:'https://example.org/report',notes:'一行,备注\n下一行',raw_inputs:{price:100}})],prices:[{symbol:'AAA',as_of:'2025-01-31',price:100,currency:'USD'}]});
test('public CSV files roundtrip raw inputs, evidence, revisions and prices',async()=>{
  const data=sample(),files=projectFiles(data,{AAA:'Example'});
  const loaded=await readProjectData(path=>files[path]);
  assert.equal(loaded.manifest.assets[0].name,'Example');assert.equal(loaded.data.valuations[0].notes,data.valuations[0].notes);
  assert.deepEqual(loaded.data.valuations[0].raw_inputs,{price:100});assert.equal(loaded.data.prices[0].price,100);
  assert.deepEqual(projectFiles(loaded.data,{AAA:'Example'}),files);
});
test('schema protects data paths, columns, symbols and duplicate observation dates',async()=>{
  const files=projectFiles(sample());const manifest=JSON.parse(files['manifest.json']);
  assert.throws(()=>validateManifest({...manifest,assets:[{...manifest.assets[0],valuations:'../private.json'}]}));
  assert.throws(()=>readValuationsCSV(files['valuations/AAA.csv'].replace('s_tech,','market_value,')),/未知列/);
  assert.throws(()=>readPricesCSV(files['prices/AAA.csv'].replace(',USD,',',,')),/币种/);
  await assert.rejects(readProjectData(path=>path==='valuations/AAA.csv'?files[path].replace(',AAA,',',BBB,'):files[path]),/标的/);
  const doubled=sample();doubled.prices.push({...doubled.prices[0]});assert.throws(()=>projectFiles(doubled),/价格记录重复/);
});
test('computed scores must agree with all eleven preserved inputs',()=>{
  const input={price:100,eps_ttm:3,eps_ntm:4,eps_ntm_90d:3.7,revenue_ttm:100,revenue_ntm:120,g_revenue_2:.15,g_eps_2:.2,fcf_ttm:20,sbc_ttm:3,ni_ttm:22};
  assert.equal(Object.keys(input).length,INPUT_FIELDS.length);
  const result=computeTechValuation(input),data=sample();
  data.valuations[0]=normalizeValuation({...data.valuations[0],raw_inputs:input,score_method:'formula',s_tech:result.s_tech});
  const text=projectFiles(data)['valuations/AAA.csv'];assert.equal(readValuationsCSV(text)[0].s_tech,result.s_tech);
  assert.throws(()=>readValuationsCSV(text.replace(String(result.s_tech),'1234')),/不一致/);
});
test('a failed data request rejects without silent empty fallback, uses only same project paths and no cache',async()=>{
  const files=projectFiles(sample()),requests=[];
  const loaded=await load(async(url,options)=>{
    assert.equal(url.origin,'https://example.org');assert.equal(options.cache,'no-store');requests.push(url.pathname);
    return {ok:true,text:async()=>files[url.pathname.replace('/some-project/data/','')]};
  },new URL('https://example.org/some-project/data/'));
  assert.equal(loaded.data.valuations.length,1);assert.ok(requests.includes('/some-project/data/manifest.json'));
  await assert.rejects(load(async()=>({ok:false,status:404}),new URL('https://example.org/data/')),/404/);
});
test('export whitelist removes session values and nested private state from JSON, CSV and ZIP',async()=>{
  const history=Array.from({length:60},(_,i)=>normalizeValuation({symbol:'AAA',valuation_date:monthEnd(`${2020+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`),s_tech:i}));
  const data=formalMonthEnd({...sample(),valuations:history},'AAA','2024-12-31','2025-01-01');
  data.holdings=[{market_value:987654321}];data.account={financing:87654321};data.formalEvents[0].state.account_id='PRIVATE';
  data.valuations[0].raw_inputs={price:100,portfolio_weight:999};
  const files=projectFiles(data),serialized=JSON.stringify(files)+exportBackup(data);
  for(const token of ['market_value','portfolio_weight','account_id','"financing":','PRIVATE','987654321'])assert.ok(!serialized.includes(token),token);
  const zip=projectZIP(data),view=new DataView(zip.buffer),decoded={},decoder=new TextDecoder();let pos=0;
  while(view.getUint32(pos,true)===0x04034b50){
    const size=view.getUint32(pos+18,true),nameLength=view.getUint16(pos+26,true),extra=view.getUint16(pos+28,true);
    const name=decoder.decode(zip.slice(pos+30,pos+30+nameLength)),start=pos+30+nameLength+extra;
    decoded[name.replace(/^data\//,'')]=decoder.decode(zip.slice(start,start+size));pos=start+size;
  }
  assert.deepEqual(decoded,files);assert.equal(view.getUint32(pos,true),0x02014b50);
  const restored=await readProjectData(path=>decoded[path]);assert.deepEqual(restored.data.formalEvents[0].state,JSON.parse(exportBackup(data)).formalEvents[0].state);
  mkdirSync(new URL('./artifacts/',import.meta.url),{recursive:true});writeFileSync(new URL('./artifacts/public-data.zip',import.meta.url),zip);
});
test('latest price respects as-of dates, and actual repository data passes the full validator',async()=>{
  const prices=[{symbol:'AAA',as_of:'2025-01-31',price:100},{symbol:'AAA',as_of:'2025-02-28',price:200}];
  assert.equal(latestQuotes(prices,'2025-02-01').AAA.price,100);
  const project=await checkProjectData(fileURLToPath(new URL('../data/',import.meta.url)));
  assert.ok(project.data.valuations.length);assert.ok(project.data.prices.length);
});
