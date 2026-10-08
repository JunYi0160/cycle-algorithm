// Optional UI integration checks; Playwright is a development dependency only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),artifacts=resolve(root,'tests/artifacts');
mkdirSync(artifacts,{recursive:true});
const base=process.env.PREVIEW_URL||'http://127.0.0.1:8788/cycle-algorithm/';
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:960},acceptDownloads:true});
await context.addInitScript(()=>{
  window.__storageAccess=0;
  for(const key of ['localStorage','sessionStorage','indexedDB'])Object.defineProperty(window,key,{get(){window.__storageAccess++;throw new Error('Persistence accessed: '+key);}});
});
const page=await context.newPage(),errors=[],requests=[];
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
page.on('dialog',dialog=>dialog.accept());
const click=name=>page.getByRole('button',{name,exact:true}).click();
const text=async(id,pattern)=>{
  await page.waitForFunction(([id,source,flags])=>new RegExp(source,flags).test(document.getElementById(id)?.innerText||''),[id,pattern.source,pattern.flags]);
  assert.match(await page.locator('#'+id).innerText(),pattern);
};
let downloads=0;
async function download(name,extension){
  const pending=page.waitForEvent('download');await click(name);const result=await pending;
  const target=resolve(artifacts,'download-'+(++downloads)+'.'+extension);await result.saveAs(target);return target;
}
const read=async()=>JSON.parse(readFileSync(await download('导出公开数据 JSON','json'),'utf8'));
async function fill(form,values){for(const [key,value] of Object.entries(values))await page.locator('#'+form+' [name="'+key+'"]').fill(String(value));}
async function addInput(sym,value,mode='ratio'){
  await click('＋ 添加标的');const row=page.locator('#holding-editor tr').last();
  await row.locator('[data-field="symbol"]').fill(sym);await row.locator('[data-field="input_mode"]').selectOption(mode);
  await row.locator('[data-field="value"]').fill(String(value));
}
try{
  await page.goto(base,{waitUntil:'networkidle'});await text('storage-status',/已读取项目数据/);
  await text('target-lev',/—/);assert.equal(await page.locator('#holding-editor tr').count(),0);
  assert.doesNotMatch(await page.locator('body').innerText(),/Antigravity|自动补数|本机助手|股数模式/);
  const original=await read();assert.equal(original.valuations.length,130);assert.equal(original.prices.length,128);
  await addInput('NVDA',75);await addInput('AVGO',25);await click('计算本次组合');await text('target-lev',/×/);
  const initialTarget=await page.locator('#target-lev').innerText();
  await page.locator('#holding-editor tr').first().locator('[data-field="value"]').fill('150');
  await page.locator('#holding-editor tr').last().locator('[data-field="value"]').fill('50');
  await click('计算本次组合');assert.equal(await page.locator('#target-lev').innerText(),initialTarget);
  await addInput('MISSING',5);await click('计算本次组合');await text('target-lev',/—/);
  await page.locator('#holding-editor tr').last().getByRole('button',{name:'删除持仓',exact:true}).click();
  await click('计算本次组合');await text('target-lev',/×/);
  const afterInputs=await read();assert.deepEqual(afterInputs,original,'session values must never enter export');
  await page.reload({waitUntil:'networkidle'});await text('storage-status',/已读取项目数据/);
  assert.equal(await page.locator('#holding-editor tr').count(),0);await text('target-lev',/—/);
  const records=Array.from({length:63},(_,i)=>{
    const y=2020+Math.floor(i/12),m=i%12+1,day=new Date(Date.UTC(y,m,0)).getUTCDate();
    return {symbol:'TEST',valuation_date:y+'-'+String(m).padStart(2,'0')+'-'+day,s_tech:i+1,source_code:'synthetic-test',interpolated:i===0};
  }).filter((_,i)=>i!==20);
  await page.locator('#valuation-file').evaluate(input=>input.closest('details').open=true);
  await page.locator('#valuation-file').setInputFiles({name:'test.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(records))});
  await text('asset-grid',/缺失：2021-09/);await page.locator('[data-preview="TEST"]').click();assert.equal(await page.locator('#strategy-chart svg').count(),1);
  const beforeBad=await read();
  await page.locator('#valuation-file').setInputFiles({name:'bad.csv',mimeType:'text/csv',buffer:Buffer.from('symbol,valuation_date,s_tech\nTEST,2025-02-30,4')});
  await text('error',/无效日期/);assert.deepEqual(await read(),beforeBad,'failed import is atomic');
  await fill('score-form',{symbol:'TEST',valuation_date:'2021-09-30',s_tech:21});await click('更新本页评分');
  const asset=page.locator('.asset').filter({has:page.locator('[data-preview="TEST"]')});assert.match(await asset.innerText(),/临时插值 0 月/);
  await page.locator('#data-symbol').selectOption('TEST');await page.locator('#data-search').fill('2021-09');
  await page.locator('#data-table-body [data-edit-key]').click();assert.match(await page.locator('#record-detail').innerText(),/2021-09-30/);
  await click('关闭并编辑');await fill('score-form',{s_tech:22,notes:'人工修订'});await click('更新本页评分');
  const updated=await read();assert.equal(updated.valuations.filter(r=>r.symbol==='TEST'&&r.valuation_date==='2021-09-30').length,2);
  await page.locator('#price-form').evaluate(form=>form.closest('details').open=true);
  await fill('price-form',{symbol:'TEST',as_of:'2026-09-30',price:123,currency:'USD',notes:'manual test'});await click('更新本页价格');
  await page.locator('#fx-form').evaluate(form=>form.closest('details').open=true);
  await fill('fx-form',{pair:'USD/EUR',as_of:'2026-09-30',rate:.9});await click('更新本页汇率');
  await page.locator('#formal-symbol').selectOption('TEST');await page.locator('#signal-date').fill('2024-12-31');await click('生成月末信号');
  await page.locator('#effective-date').fill('2025-01-02');await click('激活 pending target');
  assert.equal((await read()).formalEvents.length,2);
  await page.locator('#formula-form').evaluate(form=>form.closest('details').open=true);
  const inputs={price:100,eps_ttm:4,eps_ntm:5,eps_ntm_90d:4.5,revenue_ttm:100,revenue_ntm:120,g_revenue_2:.15,g_eps_2:.2,fcf_ttm:10,sbc_ttm:2,ni_ttm:8};
  await fill('formula-form',{symbol:'FUND',valuation_date:'2026-09-30',...inputs});await click('计算并更新本页');
  const result=await read();assert.deepEqual(result.valuations.find(r=>r.symbol==='FUND').raw_inputs,inputs);
  assert.equal(result.prices.find(r=>r.symbol==='TEST').price,123);assert.equal(result.fxRates['USD/EUR'].rate,.9);
  assert.ok(!('holdings' in result)&&!('account' in result));
  await download('下载项目数据包 ZIP','zip');
  const legacy={...result,holdings:[{symbol:'PRIVATE',market_value:123456789}],account:{financing:123456789}};
  await page.locator('#restore-file').setInputFiles({name:'legacy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(legacy))});
  await click('使用这份数据');assert.ok(!JSON.stringify(await read()).includes('123456789'));
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo(0,0));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile overflow');
  await page.screenshot({path:resolve(artifacts,'mobile.png')});
  await page.locator('#data').scrollIntoViewIfNeeded();await page.screenshot({path:resolve(artifacts,'mobile-data.png')});
  await page.setViewportSize({width:1440,height:960});await page.locator('#data-search').fill('');await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:resolve(artifacts,'desktop.png')});
  await page.reload({waitUntil:'networkidle'});assert.equal((await read()).valuations.length,original.valuations.length,'uncommitted edits do not persist');
  assert.equal(await page.evaluate(()=>window.__storageAccess),0);
  assert.equal(errors.length,0,errors.join('\n'));assert.ok(requests.every(url=>url.startsWith(base)),requests.join('\n'));
  writeFileSync(resolve(artifacts,'browser-results.json'),JSON.stringify({status:'passed',requests:requests.length,errors,checks:['project-data','ratio-scale','blocking','ephemeral-inputs','atomic-import','score-revisions','manual-prices','manual-FX','formula','formal-activation','privacy-export','ZIP','legacy-filter','mobile','no-persistence','same-origin']},null,2));
  console.log('Browser integration PASS: 16 flows, no persistent storage access, no external data requests.');
}finally{await browser.close();}
