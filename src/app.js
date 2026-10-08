import {CONFIG} from './strategy.js';
import {INPUT_FIELDS,computeTechValuation} from './valuation.js';
import {buildMonthlyScores,computePreview,calculatePortfolio,monthFromNumber,monthNumber} from './preview.js';
import {emptyData,uid,today,monthEnd,normalizeAccount,normalizeValuation,parseValuations,mergeValuations,accountSummary,validateBackup,formalMonthEnd,activateFormal} from './model.js';
import {load,save,exportBackup,STORAGE_KEY} from './storage.js';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dec=(v,d=2)=>v==null||!Number.isFinite(v)?'—':Number(v).toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=v=>v==null?'—':dec(v*100,1)+'%';
const money=v=>v==null?'—':dec(v,2)+' '+data.account.currency;
let data=emptyData(),restoreCandidate=null,currentPreviewSymbol=null,storageAvailable=true;
function error(e){$('error').hidden=false;$('error').textContent=e.message||String(e);$('error').scrollIntoView({behavior:'smooth',block:'center'});}
function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('show'),4500);}
function action(fn){return (...args)=>{try{$('error').hidden=true;fn(...args);}catch(e){error(e);}};}
function commit(next){
  if(!storageAvailable)throw new Error('本地数据读取失败。请先下载故障恢复文件，再选择有效备份恢复；当前原始数据没有被覆盖。');
  const stamped=save(next);data=stamped;render();toast('已保存到当前浏览器');
}
function symbols(){return [...new Set([...data.valuations.map(r=>r.symbol),...data.holdings.map(p=>p.symbol)])].sort();}
function renderHoldingEditor(){
  $('currency').value=data.account.currency;$('financing-input').value=data.account.financing;
  $('holding-editor').innerHTML='';data.holdings.forEach(addHoldingRow);updateDraftTotal();
}
function addHoldingRow(p={id:uid(),symbol:'',quantity:'',market_value:'',sec_type:'STK'}){
  const row=document.createElement('tr');row.dataset.id=p.id;
  row.innerHTML=`<td><input data-field="symbol" value="${esc(p.symbol)}" aria-label="持仓 Symbol" required maxlength="20"></td><td><input data-field="quantity" type="number" step="any" value="${esc(p.quantity)}" aria-label="持仓数量" required></td><td><input data-field="market_value" type="number" step="any" value="${esc(p.market_value)}" aria-label="持仓基础币种市值" required></td><td><select data-field="sec_type" aria-label="持仓类型"><option value="STK">正股 STK</option><option value="OPT">期权 OPT</option><option value="OTHER">其他</option></select></td><td><button type="button" class="btn soft" aria-label="删除持仓">删除</button></td>`;
  row.querySelector('select').value=['STK','OPT','OTHER'].includes(p.sec_type)?p.sec_type:'OTHER';
  row.querySelector('button').onclick=()=>{row.remove();updateDraftTotal();};
  row.querySelectorAll('input').forEach(input=>input.oninput=updateDraftTotal);
  $('holding-editor').append(row);
}
function updateDraftTotal(){const values=[...document.querySelectorAll('[data-field="market_value"]')].map(i=>Number(i.value));$('draft-a').textContent=values.every(Number.isFinite)?dec(values.reduce((s,n)=>s+n,0)):'市值输入无效';}
function readHoldingEditor(){return [...$('holding-editor').children].map(row=>Object.fromEntries([['id',row.dataset.id],...Array.from(row.querySelectorAll('[data-field]')).map(i=>[i.dataset.field,i.value])]));}
function healthRow(label,text,severity=''){return `<div class="health-row"><i class="${severity}"></i><span>${esc(label)}</span><span>${esc(text)}</span></div>`;}
function render(){
  const asOf=today(),portfolio=calculatePortfolio(data.holdings,data.valuations,asOf),h=accountSummary(data,portfolio);
  $('storage-status').textContent=storageAvailable?'数据保存在此浏览器':'本地数据需要恢复';$('storage-dot').className='dot '+(storageAvailable?'ok':'bad');
  $('updated-at').textContent=data.account.updatedAt?'手动更新 '+new Date(data.account.updatedAt).toLocaleString('zh-CN'):'尚未录入账户';
  $('actual-lev').textContent=h.actualLeverage==null?'—':dec(h.actualLeverage)+'×';$('target-lev').textContent=h.target==null?'—':dec(h.target)+'×';
  $('actual-mv').textContent=money(h.A);$('target-mv').textContent=money(h.targetMarketValue);
  const scale=Math.max(2,h.actualLeverage||0,h.target||0);
  for(const [key,value] of [['actual',h.actualLeverage],['target',h.target]]){$(key+'-bar').style.width=((value||0)/scale*100)+'%';$(key+'-bar-label').textContent=value==null?'—':dec(value)+'×';}
  $('action-word').textContent=h.adjustment==null?'等待账户与全部持仓可计算':Math.abs(h.adjustment)<.005?'已达到回放目标':h.adjustment>0?'增持市值差额':'减持市值差额';
  $('action-amount').textContent=money(h.adjustment==null?null:Math.abs(h.adjustment));$('action-amount').className='action-amount '+(h.adjustment>0?'up':h.adjustment<0?'down':'');
  $('equity').textContent=money(h.valid?h.E:null);$('stock-value').textContent=money(h.A);$('financing').textContent=money(h.B);$('portfolio-x').textContent=pct(portfolio.percentile);
  $('risk-note').className='notice '+(h.hardCapBreached?'error':'');$('risk-note').textContent=h.hardCapBreached?`实际杠杆 ${dec(h.actualLeverage)}× 已超过 2.25× 硬上限。核心规则为回到已生效目标；本页不会自动交易。`:'目标范围 1.00–1.75× · 实际杠杆硬上限 2.25×';
  $('exact-trade').textContent=h.exact?`含费用的精确交易金额：${money(h.exact.trade)}；预计单边费用：${money(h.exact.fee)}。`:'账户与组合目标可用后显示。';
  const weightTotal=data.holdings.reduce((s,p)=>s+p.market_value,0);
  $('holding-weights').innerHTML=data.holdings.map(p=>`<div class="legend-row"><span class="legend-name">${esc(p.symbol)} · ${dec(p.quantity,3)} · ${esc(p.sec_type)}</span><span>${money(p.market_value)} · ${pct(weightTotal?p.market_value/weightTotal:null)}</span></div>`).join('')||'<p class="muted">添加持仓后在这里显示保存后的市值与权重。</p>';
  $('as-of').textContent='检查日期 '+asOf;
  const x=portfolio.percentile;$('percentile-ring').style.setProperty('--ring',(x==null?0:x*100)+'%');$('ring-value').textContent=pct(x);
  $('valuation-state').textContent=x==null?'组合目标不可用':x<.3?'估值处于较低百分位':x>.7?'估值处于较高百分位':'估值处于中间区间';$('strategy-message').textContent=portfolio.message;
  let warn=false,html=healthRow('账户',h.valid?'净值为正；持仓市值采用 '+data.account.currency:'请录入持仓与融资余额，使 E=A−B 为正',h.valid?'':'bad');
  for(const p of portfolio.positions){
    const c=p.coverage;
    if(p.status!=='ready'){html+=healthRow(p.symbol||'未知持仓',p.reason,'bad');if(c){html+=healthRow('补数范围',c.start_month?`至少补入 ${monthFromNumber(monthNumber(c.start_month)-c.shortage_months)} 至 ${monthFromNumber(monthNumber(c.start_month)-1)} 的 ${c.shortage_months} 个月，或扩充末端真实历史。`:'导入至少 60 个月的 S_Tech 历史。','bad');}continue;}
    const temp=c.interpolated_months.length,source=c.source_interpolated_months.length,unknown=c.source_unknown_months.length,stale=p.valuation_lag_months;
    if(temp||source||unknown||stale||p.entry_fallback)warn=true;
    html+=healthRow(p.symbol,`权重 ${pct(p.holding_weight)} · 最新 ${c.end_month} · 来源 ${p.source_code||'未标注'} · 落后 ${stale} 月 · 临时插值 ${temp} 月 · 来源插值 ${source} 月`,temp||source||unknown||stale?'warn':'');
    if(temp)html+=healthRow('建议补数',c.interpolated_months.join('、'),'warn');
    if(source)html+=healthRow('来源插值',c.source_interpolated_months.join('、'),'warn');
    if(unknown)html+=healthRow('来源待核实',`${unknown} 个月迁自缺少独立插值标记的旧记录，保留来源和备注，请核对。`,'warn');
    if(stale)html+=healthRow('建议更新',`${monthFromNumber(monthNumber(c.end_month)+1)} 至 ${portfolio.expected_month}，当前仍可计算。`,'warn');
    if(p.entry_fallback)html+=healthRow('强制入场',p.entry_note,'warn');
  }
  $('health-list').innerHTML=html;$('quality').className='quality '+(portfolio.status!=='ready'||!h.valid?'bad':warn?'warn':'');$('quality').textContent=portfolio.status!=='ready'||!h.valid?'需要处理':warn?'可用，有提示':'数据完整';
  renderAssets(asOf);renderFormal();$('record-count').textContent=`${data.valuations.filter(r=>r.is_current).length} 条当前记录 · ${data.valuations.length} 条含修订记录`;
  $('migration-notes').innerHTML=data.migrationNotes.length?`<details class="small-detail"><summary>查看旧系统迁移说明</summary>${data.migrationNotes.map(n=>'<p class="muted">'+esc(n)+'</p>').join('')}</details>`:'';
  if(currentPreviewSymbol)showPreview(currentPreviewSymbol,false);
}
function renderAssets(asOf){
  $('asset-grid').innerHTML=symbols().map(sym=>{
    const {coverage:c}=buildMonthlyScores(data.valuations.filter(r=>r.symbol===sym),{symbol:sym,asOf});
    return `<div class="asset"><div class="asset-top"><div class="asset-symbol">${esc(sym)}</div><span class="pill ${c.ready?'':'bad'}">${c.ready?'可计算':'历史不足'}</span></div><div class="asset-stats">有效记录 ${c.valid_month_count} 月 · 临时插值 ${c.interpolated_months.length} 月 · 来源插值 ${c.source_interpolated_months.length} 月${c.source_unknown_months.length?' · 来源待核实 '+c.source_unknown_months.length+' 月':''}<br>范围 ${esc(c.start_month||'—')} 至 ${esc(c.end_month||'—')}<br>${esc(c.reason)}${c.missing_months.length?'<br>缺失：'+esc(c.missing_months.join('、')):''}${c.excluded_future_records?'<br>已排除未来记录 '+c.excluded_future_records+' 条':''}</div><button class="btn ${c.ready?'primary':'soft'}" ${c.ready?'':'disabled'} data-preview="${esc(sym)}">临时计算并可视化</button></div>`;
  }).join('')||'<div class="empty">先导入估值历史，或点击“体验虚构示例”。</div>';
  document.querySelectorAll('[data-preview]').forEach(b=>b.onclick=action(()=>showPreview(b.dataset.preview)));
}
function showPreview(sym,scroll=true){
  const {coverage,scores}=buildMonthlyScores(data.valuations.filter(r=>r.symbol===sym),{symbol:sym,asOf:today()});
  if(!coverage.ready){$('preview').classList.remove('show');currentPreviewSymbol=null;return;}
  const p=computePreview(coverage,scores);currentPreviewSymbol=sym;$('preview').classList.add('show');$('preview-title').textContent=sym+' 策略结果';
  $('entry-note').textContent=p.entry.note;$('entry-note').className='notice '+(p.entry.fallback?'warn':'');
  $('entry-month').textContent=p.entry.month;$('entry-x').textContent=pct(p.entry.x);$('latest-x').textContent=pct(p.latest.x);$('latest-target').textContent=dec(p.latest.target_leverage,3)+'×';$('interp-count').textContent=p.coverage.interpolated_months.length;
  $('recent').innerHTML=p.points.filter(q=>q.x!==null).slice(-12).map(q=>`<tr><td>${q.month} ${q.interpolated?'（临时插值）':q.source_interpolated?'（来源插值）':q.source_unknown?'（来源待核实）':'（原始观测）'}</td><td>${dec(q.score,3)}</td><td>${pct(q.x)}</td><td>${dec(q.z,3)}</td><td>${q.target_leverage==null?'—':dec(q.target_leverage,3)+'×'}</td></tr>`).join('');
  drawStrategy(p);if(scroll)$('preview').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function drawStrategy(p){
  const pts=p.points.filter(q=>q.x!==null&&q.target_leverage!==null),W=1000,H=270,L=45,R=45,T=20,B=35,PW=W-L-R,PH=H-T-B,c=p.config;
  const xp=i=>pts.length===1?L+PW/2:L+PW*i/(pts.length-1),yx=v=>T+PH*(1-v),yl=v=>T+PH*(1-(v-c.l_min)/(c.l_max-c.l_min));
  const path=(key,y)=>pts.map((q,i)=>(i?'L':'M')+xp(i).toFixed(1)+','+y(q[key]).toFixed(1)).join(' '),last=pts.length-1,entry=pts.findIndex(q=>q.is_entry),labels=[...new Set([0,Math.floor(last/2),last])];
  $('strategy-chart').innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="百分位与目标杠杆历史图">${[0,.25,.5,.75,1].map(r=>`<line x1="${L}" x2="${W-R}" y1="${T+PH*r}" y2="${T+PH*r}" stroke="#dfe3dc"/>`).join('')}${pts.length>1?`<path d="${path('x',yx)}" fill="none" stroke="#315f86" stroke-width="3"/><path d="${path('target_leverage',yl)}" fill="none" stroke="#146c4d" stroke-width="3"/>`:''}<circle cx="${xp(last)}" cy="${yx(pts[last].x)}" r="5" fill="#315f86"/><circle cx="${xp(last)}" cy="${yl(pts[last].target_leverage)}" r="5" fill="#146c4d"/>${entry>=0?`<line x1="${xp(entry)}" x2="${xp(entry)}" y1="${T}" y2="${T+PH}" stroke="#af3d45" stroke-dasharray="6 5"/>`:''}${labels.map(i=>`<text x="${xp(i)}" y="${H-9}" text-anchor="middle" fill="#66716a" font-size="12">${pts[i].month}</text>`).join('')}<text x="4" y="${T+5}" fill="#315f86" font-size="12">100%</text><text x="14" y="${T+PH}" fill="#315f86" font-size="12">0%</text><text x="${W-38}" y="${T+5}" fill="#146c4d" font-size="12">${dec(c.l_max)}×</text><text x="${W-38}" y="${T+PH}" fill="#146c4d" font-size="12">${dec(c.l_min)}×</text></svg>`;
}
function renderFormal(){
  const selected=$('formal-symbol').value;$('formal-symbol').innerHTML=symbols().map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');if(symbols().includes(selected))$('formal-symbol').value=selected;
  $('formal-list').innerHTML=data.formalEvents.slice(-25).reverse().map(e=>`<tr><td>${esc(e.symbol)}</td><td>${esc(e.signal_date)}</td><td>${pct(e.x)}</td><td>${e.state.pending_target==null?'—':dec(e.state.pending_target,3)+'×'}</td><td>${e.state.current_target==null?'—':dec(e.state.current_target,3)+'×'}</td><td>${esc(e.event_type)}${e.effective_date?' · '+esc(e.effective_date):''}</td></tr>`).join('')||'<tr><td colspan="6">还没有正式策略事件；历史预览不会在此生成记录。</td></tr>';
}
function download(text,filename,mime='application/json'){
  const url=URL.createObjectURL(new Blob([text],{type:mime})),a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function fileAction(input,fn){const file=input.files[0];if(!file)return;try{$('error').hidden=true;await fn(await file.text(),file.name);}catch(e){error(e);}finally{input.value='';}}
$('add-holding').onclick=()=>{addHoldingRow();updateDraftTotal();};
$('account-form').onsubmit=action(e=>{e.preventDefault();const account={currency:$('currency').value,financing:$('financing-input').value,updatedAt:new Date().toISOString()};const normalized=normalizeAccount(account,readHoldingEditor());commit({...data,...normalized});renderHoldingEditor();});
$('score-form').onsubmit=action(e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.target));const row=normalizeValuation({...values,valuation_date:monthEnd(values.month),interpolated:e.target.elements.interpolated.checked});commit(mergeValuations(data,[row]).data);});
$('formula-inputs').innerHTML=INPUT_FIELDS.map(k=>`<label>${esc(k)}<input name="${esc(k)}" type="number" step="any" required aria-label="${esc(k)}"></label>`).join('');
$('formula-form').onsubmit=action(e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.target)),result=computeTechValuation(values);$('formula-result').textContent=result.status==='valid'?'S_Tech = '+dec(result.s_tech,6):result.reason;if(result.status!=='valid')throw new Error(result.reason);const inputs=Object.fromEntries(INPUT_FIELDS.map(k=>[k,Number(values[k])]));const row=normalizeValuation({symbol:values.symbol,valuation_date:monthEnd(values.month),s_tech:result.s_tech,source_code:'manual-fundamentals',raw_inputs:inputs,derived_result:result});commit(mergeValuations(data,[row]).data);});
$('valuation-file').onchange=()=>fileAction($('valuation-file'),(text,name)=>{const rows=parseValuations(text,name),result=mergeValuations(data,rows);commit(result.data);toast(`导入 ${result.added} 条；跳过 ${result.skipped} 条相同记录。`);});
$('export-backup').onclick=action(()=>download(exportBackup(data),`cycle-backup-${today()}.json`));
$('download-raw').onclick=action(()=>download(localStorage.getItem(STORAGE_KEY)||exportBackup(data),`cycle-recovery-${today()}.json`));
$('restore-file').onchange=()=>fileAction($('restore-file'),text=>{restoreCandidate=validateBackup(JSON.parse(text));$('restore-summary').textContent=`币种 ${restoreCandidate.account.currency} · ${restoreCandidate.holdings.length} 笔持仓 · ${restoreCandidate.valuations.length} 条估值 · ${restoreCandidate.formalEvents.length} 条正式事件。`;$('restore-dialog').showModal();});
$('restore-confirm').onclick=action(()=>{if(!restoreCandidate)return;const stamped=save(restoreCandidate);storageAvailable=true;data=stamped;restoreCandidate=null;$('restore-dialog').close();currentPreviewSymbol=null;$('preview').classList.remove('show');renderHoldingEditor();render();toast('完整备份已恢复');});
$('restore-cancel').onclick=()=>{$('restore-dialog').close();restoreCandidate=null;};
$('formal-form').onsubmit=action(e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.target));commit(e.submitter?.value==='activate'?activateFormal(data,values.symbol,values.effective_date):formalMonthEnd(data,values.symbol,values.signal_date));});
$('demo').onclick=action(()=>{
  const end=monthNumber(today())-1,rows=Array.from({length:72},(_,i)=>normalizeValuation({symbol:'DEMO',valuation_date:monthEnd(monthFromNumber(end-71+i)),s_tech:5+i*.04+Math.sin(i*.4)*1.5,source_code:'synthetic-example',notes:'虚构示例，不代表证券或真实账户'}));
  let next=mergeValuations(data,rows).data;
  if(!data.holdings.length&&!data.account.updatedAt){next={...next,account:{currency:'EUR',financing:3000,updatedAt:new Date().toISOString()},holdings:[{id:uid(),symbol:'DEMO',quantity:100,market_value:15000,sec_type:'STK',currency:'EUR'}]};}
  commit(next);renderHoldingEditor();toast('已加入虚构 DEMO 估值；可导出备份或用真实数据替换持仓。');
});
try{data=load();}catch(e){storageAvailable=false;error(new Error('本地数据暂时无法读取：'+e.message+'。先下载故障恢复文件；不会覆盖原数据。'));}
$('signal-date').value=monthEnd(monthFromNumber(monthNumber(today())-1));$('effective-date').value=today();
renderHoldingEditor();render();
