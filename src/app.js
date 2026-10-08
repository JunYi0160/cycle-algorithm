import {CONFIG} from './strategy.js';
import {INPUT_FIELDS,computeTechValuation} from './valuation.js';
import {buildMonthlyScores,computePreview,calculatePortfolio,monthFromNumber,monthNumber} from './preview.js';
import {emptyData,uid,today,monthEnd,normalizeSessionHolding,normalizeValuation,parseValuations,mergeValuations,validateBackup,formalMonthEnd,activateFormal,normalizeQuote,normalizeFxRate} from './model.js';
import {load,exportBackup} from './storage.js';
import {latestQuotes,projectFiles,projectZIP,readValuationsCSV,readPricesCSV,readFxCSV} from './project-data.js';

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dec=(v,d=2)=>v==null||!Number.isFinite(v)?'—':Number(v).toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=v=>v==null?'—':dec(v*100,1)+'%';

let data=emptyData(),restoreCandidate=null,currentPreviewSymbol=null,storageAvailable=false,dirty=false;
let session={referenceCurrency:'USD',holdings:[]},assetNames={},editingValuation=null;

function error(e){$('error').hidden=false;$('error').textContent=e.message||String(e);$('error').scrollIntoView({behavior:'smooth',block:'center'});}
function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('show'),4500);}
function action(fn){return (...args)=>{try{$('error').hidden=true;fn(...args);}catch(e){error(e);}};}

function commit(next){
  if(!storageAvailable)throw new Error('项目数据尚未成功读取，请重新加载后再编辑。');
  data=validateBackup(next);dirty=true;render();toast('已更新本页；请导出数据文件并提交到仓库');
}
function symbols(){return [...new Set([...Object.keys(assetNames),...data.valuations.map(r=>r.symbol),...data.prices.map(r=>r.symbol),...session.holdings.map(p=>p.symbol)])].sort();}
// Holdings editor rendering
function renderHoldingEditor(){
  $('currency').value=session.referenceCurrency||'USD';
  $('holding-editor').innerHTML='';
  session.holdings.forEach(addHoldingRow);
  updateHoldingCalculations();
}

function addHoldingRow(p={id:uid(),symbol:'',input_mode:'ratio',market_value:'',ratio:'',currency:''}){
  const row=document.createElement('tr');
  row.dataset.id=p.id;
  const mode=p.input_mode||'ratio';
  const curr=p.currency||session.referenceCurrency||'USD';
  const val=mode==='ratio'?(p.ratio??''):(p.market_value??'');

  row.innerHTML=`
    <td><input data-field="symbol" value="${esc(p.symbol)}" aria-label="持仓 Symbol" required maxlength="20" placeholder="NVDA"></td>
    <td>
      <select data-field="input_mode" aria-label="输入模式">
        <option value="market_value" ${mode==='market_value'?'selected':''}>市值模式</option>
        <option value="ratio" ${mode==='ratio'?'selected':''}>直接比例</option>
      </select>
    </td>
    <td><input data-field="value" type="number" step="any" value="${esc(val)}" aria-label="持仓数值" required placeholder="${mode==='ratio'?'比例 (如 75)':'市值 (如 15000)'}"></td>
    <td><input data-field="currency" maxlength="3" value="${esc(curr)}" aria-label="币种" ${mode==='ratio'?'disabled':''}></td>
    <td class="holding-derived" data-derived>—</td>
    <td class="holding-weight" data-weight>—</td>
    <td class="holding-target" data-target>—</td>
    <td><button type="button" class="btn soft" aria-label="删除持仓" style="padding: 6px 10px;">删除</button></td>
  `;

  const modeSelect=row.querySelector('[data-field="input_mode"]');
  const valInput=row.querySelector('[data-field="value"]');
  const currInput=row.querySelector('[data-field="currency"]');

  modeSelect.onchange=()=>{
    const m=modeSelect.value;
    currInput.disabled=m==='ratio';
    valInput.placeholder=m==='ratio'?'比例 (如 75)':'市值 (如 15000)';
    updateHoldingCalculations();
  };

  row.querySelector('button').onclick=()=>{row.remove();updateHoldingCalculations();};
  row.querySelectorAll('input').forEach(i=>i.oninput=updateHoldingCalculations);
  $('holding-editor').append(row);
}

function readHoldingEditor(){
  const refCurr=($('currency').value||'USD').trim().toUpperCase();
  return [...$('holding-editor').children].map(row=>{
    const sym=row.querySelector('[data-field="symbol"]').value.trim().toUpperCase();
    const mode=row.querySelector('[data-field="input_mode"]').value;
    const rawVal=row.querySelector('[data-field="value"]').value;
    const curr=(row.querySelector('[data-field="currency"]').value||refCurr).trim().toUpperCase();
    const item={id:row.dataset.id,symbol:sym,input_mode:mode,sec_type:'STK',currency:curr};
    const n=rawVal===''?null:Number(rawVal);
    if(mode==='ratio')item.ratio=n;else item.market_value=n;
    return item;
  });
}

function updateHoldingCalculations(){
  const holdings=readHoldingEditor();
  const asOf=today();
  const portfolio=calculatePortfolio(holdings,data.valuations,asOf,{quotes:latestQuotes(data.prices,today()),fxRates:data.fxRates,referenceCurrency:$('currency').value});
  
  [...$('holding-editor').children].forEach(row=>{
    const sym=row.querySelector('[data-field="symbol"]').value.trim().toUpperCase();
    const mode=row.querySelector('[data-field="input_mode"]').value;
    const valInput=Number(row.querySelector('[data-field="value"]').value);
    const curr=row.querySelector('[data-field="currency"]').value.trim().toUpperCase();

    const derivedCell=row.querySelector('[data-derived]');
    const weightCell=row.querySelector('[data-weight]');
    const targetCell=row.querySelector('[data-target]');

    if(mode==='market_value'){
      derivedCell.textContent=Number.isFinite(valInput)?dec(valInput,2)+' '+curr:'—';
    }else{
      derivedCell.textContent='比例 '+valInput;
    }

    const pos=portfolio.positions.find(p=>p.symbol===sym);
    if(pos&&pos.status==='ready'){
      weightCell.textContent=pct(pos.holding_weight);
      targetCell.textContent=dec(pos.target_leverage,2)+'×';
    }else if(pos){
      weightCell.textContent=pos.holding_weight!=null?pct(pos.holding_weight):'—';
      targetCell.textContent=pos.reason?'阻塞':'—';
    }else{
      weightCell.textContent='—';
      targetCell.textContent='—';
    }
  });
}

function healthRow(label,text,severity=''){return `<div class="health-row"><i class="${severity}"></i><span>${esc(label)}</span><span>${esc(text)}</span></div>`;}

function render(){
  const asOf=today();
  const refCurr=session.referenceCurrency||'USD';
  const portfolio=calculatePortfolio(session.holdings,data.valuations,asOf,{quotes:latestQuotes(data.prices,today()),fxRates:data.fxRates,referenceCurrency:refCurr});

  $('storage-status').textContent=storageAvailable?(dirty?'有修改待提交到仓库':'已读取项目数据'):'项目数据未加载';
  $('storage-dot').className='dot '+(storageAvailable?'ok':'bad');
  $('updated-at').textContent=session.holdings.length?'本次手动输入 · 刷新后清空':'请填写本次市值或比例';

  // Leverage and percentiles
  const tLev=portfolio.target_leverage;
  $('target-lev').textContent=tLev==null?'—':dec(tLev,2)+'×';
  $('summary-target-lev').textContent=tLev==null?'—':dec(tLev,2)+'×';
  $('holding-count').textContent=`${session.holdings.length} 笔持仓`;
  $('summary-currency').textContent=refCurr;

  // Target bar (1.0 to 1.75)
  if(tLev!=null){
    const pctFill=Math.min(100,Math.max(0,(tLev-1.0)/(1.75-1.0)*100));
    $('target-bar').style.width=pctFill+'%';
    $('target-bar-label').textContent=dec(tLev,2)+'×';
  }else{
    $('target-bar').style.width='0%';
    $('target-bar-label').textContent='—';
  }

  const x=portfolio.percentile;
  $('portfolio-x').textContent=pct(x);
  $('ring-value').textContent=x==null?'—':pct(x);
  $('ring-value-card').textContent=x==null?'—':pct(x);
  $('percentile-ring').style.setProperty('--ring',(x==null?0:x*100)+'%');

  const valDesc=x==null?'等待策略结果':x<.3?'估值处于较低百分位 (更有吸引力)':x>.7?'估值处于较高百分位':'估值处于中间区间';
  $('valuation-state').textContent=valDesc;
  $('valuation-state-card').textContent=valDesc;
  $('strategy-message').textContent=portfolio.message;

  // Legend weights summary
  const legendHtml=portfolio.positions.map(p=>{
    const q=latestQuotes(data.prices,today())[p.symbol];
    const qStr=q?`· 报价 ${q.price} ${q.currency}`:'';
    const levStr=p.target_leverage!=null?`· 目标 ${dec(p.target_leverage,2)}×`:`· ${p.reason||'未就绪'}`;
    return `<div class="legend-row"><span class="legend-name">${esc(p.symbol)} (${esc(p.input_mode||'市值')}) ${qStr}</span><span>${pct(p.holding_weight)} ${levStr}</span></div>`;
  }).join('');
  $('holding-weights').innerHTML=legendHtml||'<p class="muted">本次计算后在这里显示相对权重与逐标的目标杠杆。</p>';

  // Health and data quality
  $('as-of').textContent='检查日期 '+asOf;
  let warn=false;
  let healthHtml='';

  for(const p of portfolio.positions){
    const c=p.coverage;
    if(p.status!=='ready'){
      warn=true;
      healthHtml+=healthRow(p.symbol||'未知标的',p.reason||'数据不足','bad');
      if(c&&c.shortage_months>0){
        healthHtml+=healthRow('缺少历史',`需补足覆盖 ${c.start_month?monthFromNumber(monthNumber(c.start_month)-c.shortage_months):'前序'} 的 ${c.shortage_months} 个月。`,'bad');
      }
      continue;
    }
    const temp=c.interpolated_months.length,source=c.source_interpolated_months.length,unknown=c.source_unknown_months.length,stale=p.valuation_lag_months;
    if(temp||source||unknown||stale||p.entry_fallback)warn=true;
    healthHtml+=healthRow(p.symbol,`权重 ${pct(p.holding_weight)} · 目标 ${dec(p.target_leverage,2)}× · 最新 ${c.end_month} · 落后 ${stale} 月 · 临时插值 ${temp} 月`,temp||source||unknown||stale?'warn':'');
    if(temp)healthHtml+=healthRow('建议补数',c.interpolated_months.join('、'),'warn');
    if(source)healthHtml+=healthRow('来源插值',c.source_interpolated_months.join('、'),'warn');
    if(unknown)healthHtml+=healthRow('来源待核实',`${unknown} 个月迁自缺少独立标记记录，请核对。`,'warn');
    if(stale)healthHtml+=healthRow('建议更新',`已结束月 ${c.end_month} 落后于期望月 ${portfolio.expected_month}`,'warn');
    if(p.entry_fallback)healthHtml+=healthRow('强制入场',p.entry_note,'warn');
  }

  $('health-list').innerHTML=healthHtml||healthRow('持仓', '尚无持仓数据', 'bad');
  $('quality').className='quality '+(portfolio.status!=='ready'?'bad':warn?'warn':'');
  $('quality').textContent=portfolio.status!=='ready'?'需要补齐数据':warn?'可用，有提示':'数据完整';

  renderAssets(asOf);
  renderFormal();
  renderDataTable();
  $('record-count').textContent=`${data.valuations.filter(r=>r.is_current).length} 条当前记录 · ${data.valuations.length} 条含修订记录`;
  $('migration-notes').innerHTML=data.migrationNotes.length?`<details class="small-detail"><summary>查看算法升级与数据迁移说明</summary>${data.migrationNotes.map(n=>'<p class="muted">'+esc(n)+'</p>').join('')}</details>`:'';

  if(currentPreviewSymbol)showPreview(currentPreviewSymbol,false);
}

function renderAssets(asOf){
  $('asset-grid').innerHTML=symbols().map(sym=>{
    const {coverage:c}=buildMonthlyScores(data.valuations.filter(r=>r.symbol===sym),{symbol:sym,asOf});
    return `<div class="asset">
      <div class="asset-top"><div class="asset-symbol">${esc(sym)}</div><span class="pill ${c.ready?'':'bad'}">${c.ready?'可计算':'历史不足'}</span></div>
      <div class="asset-stats">有效记录 ${c.valid_month_count} 月 · 临时插值 ${c.interpolated_months.length} 月 · 来源插值 ${c.source_interpolated_months.length} 月${c.source_unknown_months.length?' · 待核实 '+c.source_unknown_months.length+' 月':''}<br>范围 ${esc(c.start_month||'—')} 至 ${esc(c.end_month||'—')}<br>${esc(c.reason)}${c.missing_months.length?'<br>缺失：'+esc(c.missing_months.join('、')):''}${c.excluded_future_records?'<br>已排除未来记录 '+c.excluded_future_records+' 条':''}</div>
      <button class="btn ${c.ready?'primary':'soft'}" ${c.ready?'':'disabled'} data-preview="${esc(sym)}">临时计算并可视化</button>
    </div>`;
  }).join('')||'<div class="empty">请添加标的历史估值或价格数据。</div>';
  document.querySelectorAll('[data-preview]').forEach(b=>b.onclick=action(()=>showPreview(b.dataset.preview)));
}

function showPreview(sym,scroll=true){
  const {coverage,scores}=buildMonthlyScores(data.valuations.filter(r=>r.symbol===sym),{symbol:sym,asOf:today()});
  if(!coverage.ready){$('preview').classList.remove('show');currentPreviewSymbol=null;return;}
  const p=computePreview(coverage,scores);
  currentPreviewSymbol=sym;
  $('preview').classList.add('show');
  $('preview-title').textContent=sym+' 策略结果';
  $('entry-note').textContent=p.entry.note;$('entry-note').className='notice '+(p.entry.fallback?'warn':'');
  $('entry-month').textContent=p.entry.month;$('entry-x').textContent=pct(p.entry.x);
  $('latest-x').textContent=pct(p.latest.x);$('latest-target').textContent=dec(p.latest.target_leverage,3)+'×';
  $('interp-count').textContent=p.coverage.interpolated_months.length;
  $('recent').innerHTML=p.points.filter(q=>q.x!==null).slice(-12).map(q=>`<tr><td>${q.month} ${q.interpolated?'（临时插值）':q.source_interpolated?'（来源插值）':q.source_unknown?'（来源待核实）':'（原始观测）'}</td><td>${dec(q.score,3)}</td><td>${pct(q.x)}</td><td>${dec(q.z,3)}</td><td>${q.target_leverage==null?'—':dec(q.target_leverage,3)+'×'}</td></tr>`).join('');
  drawStrategy(p);
  if(scroll)$('preview').scrollIntoView({behavior:'smooth',block:'nearest'});
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

// Session inputs never enter data, downloads or URLs.
$('add-holding').onclick=()=>{addHoldingRow({id:uid(),symbol:'',input_mode:'ratio',ratio:'',currency:$('currency').value});};
$('currency').oninput=updateHoldingCalculations;
$('account-form').onsubmit=action(e=>{
  e.preventDefault();
  const referenceCurrency=$('currency').value.trim().toUpperCase();
  if(!/^[A-Z]{3}$/.test(referenceCurrency))throw new Error('参考币种须为三位代码');
  session={referenceCurrency,holdings:readHoldingEditor().map(p=>normalizeSessionHolding(p,referenceCurrency))};
  render();updateHoldingCalculations();toast('本次输入已计算，刷新后清空');
});
$('clear-session').onclick=()=>{session.holdings=[];renderHoldingEditor();render();};

function renderDataTable(){
  const selected=$('data-symbol').value,all=symbols();
  $('data-symbol').innerHTML='<option value="">全部标的</option>'+all.map(sym=>'<option>'+esc(sym)+'</option>').join('');
  if(all.includes(selected))$('data-symbol').value=selected;
  const kind=$('data-kind').value,query=$('data-search').value.trim().toLowerCase(),showOld=$('show-revisions').checked;
  let rows=kind==='valuations'?data.valuations:kind==='prices'?data.prices:Object.values(data.fxRates);
  $('data-symbol').disabled=kind==='fx';
  rows=rows.filter(r=>kind==='fx'||!selected||r.symbol===selected);
  if(kind==='valuations'&&!showOld)rows=rows.filter(r=>r.is_current);
  rows=rows.filter(r=>!query||JSON.stringify(r).toLowerCase().includes(query)).sort((a,b)=>(b.valuation_date||b.as_of).localeCompare(a.valuation_date||a.as_of));
  $('data-table-count').textContent=rows.length+' 条记录';
  $('data-table-head').innerHTML=kind==='valuations'?'<tr><th>标的</th><th>日期</th><th>S_Tech / 状态</th><th>来源 / 修订</th><th>备注</th><th>操作</th></tr>':'<tr><th>标的 / 汇率对</th><th>日期</th><th>价格 / 汇率</th><th>币种 / 来源</th><th>备注</th><th>操作</th></tr>';
  $('data-table-body').innerHTML=rows.slice(0,250).map(r=>{
    const key=kind==='valuations'?r.id:kind==='prices'?r.symbol+'/'+r.as_of:r.pair;
    return '<tr><td>'+esc(r.symbol||r.pair)+'</td><td>'+esc(r.valuation_date||r.as_of)+'</td><td>'+esc(kind==='valuations'?(r.status==='valid'?dec(r.s_tech,6):'N/A'):dec(r.price??r.rate,6))+'</td><td>'+esc(kind==='valuations'?r.source_code+' · r'+r.revision+(r.is_current?' 当前':' 历史'):(r.currency||r.source_url||'手动'))+'</td><td class="record-notes">'+esc(r.notes)+'</td><td><button class="btn soft" type="button" data-edit-kind="'+kind+'" data-edit-key="'+esc(key)+'">查看 / 编辑</button></td></tr>';
  }).join('')||'<tr><td colspan="6">没有符合筛选条件的记录。</td></tr>';
  $('table-limit').hidden=rows.length<=250;
  document.querySelectorAll('[data-edit-key]').forEach(button=>button.onclick=action(()=>editRecord(button.dataset.editKind,button.dataset.editKey)));
}
function fillForm(form,row){for(const [key,value] of Object.entries(row)){
  const field=form.elements.namedItem(key);if(!field)continue;
  if(field.type==='checkbox')field.checked=!!value;else field.value=value??'';
}}
function editRecord(kind,key){
  if(kind==='valuations'){
    const row=data.valuations.find(r=>r.id===key);editingValuation=row;
    $('score-form').reset();$('formula-form').reset();
    fillForm($('score-form'),row);fillForm($('formula-form'),{...row,...row.raw_inputs});
    $('record-detail').textContent=JSON.stringify(row,null,2);
    $('record-dialog').showModal();
  }else if(kind==='prices'){
    fillForm($('price-form'),data.prices.find(r=>r.symbol+'/'+r.as_of===key));$('price-form').closest('details').open=true;$('price-form').scrollIntoView({block:'center'});
  }else{fillForm($('fx-form'),data.fxRates[key]);$('fx-form').closest('details').open=true;$('fx-form').scrollIntoView({block:'center'});}
}
$('record-close').onclick=()=>{$('record-dialog').close();$('score-form').scrollIntoView({block:'center'});};
for(const id of ['data-symbol','data-kind','show-revisions'])$(id).onchange=renderDataTable;
$('data-search').oninput=renderDataTable;
$('new-score').onclick=()=>{editingValuation=null;$('score-form').reset();$('formula-form').reset();};
$('score-form').onsubmit=action(e=>{
  e.preventDefault();const values=Object.fromEntries(new FormData(e.target));
  const same=editingValuation&&editingValuation.symbol===values.symbol.trim().toUpperCase()&&editingValuation.valuation_date===values.valuation_date;
  const row=normalizeValuation({...(same?editingValuation:{}),...values,
    interpolated:e.target.elements.interpolated.checked,provenance:e.target.elements.provenance.value,
    score_method:'manual',is_current:true});
  commit(mergeValuations(data,[row]).data);editingValuation=null;
});
$('formula-inputs').innerHTML=INPUT_FIELDS.map(k=>'<label>'+esc(k)+'<input name="'+esc(k)+'" type="number" step="any" required></label>').join('');
$('formula-form').onsubmit=action(e=>{
  e.preventDefault();const values=Object.fromEntries(new FormData(e.target)),result=computeTechValuation(values);
  $('formula-result').textContent=result.status==='valid'?'S_Tech = '+dec(result.s_tech,6):result.reason;
  const inputs=Object.fromEntries(INPUT_FIELDS.map(k=>[k,Number(values[k])]));
  const same=editingValuation&&editingValuation.symbol===values.symbol.trim().toUpperCase()&&editingValuation.valuation_date===values.valuation_date;
  const row=normalizeValuation({...(same?editingValuation:{}),...values,status:result.status,s_tech:result.s_tech,
    notes:values.notes||result.reason||'',score_method:'formula',raw_inputs:inputs,is_current:true});
  commit(mergeValuations(data,[row]).data);editingValuation=null;
});
$('price-form').onsubmit=action(e=>{
  e.preventDefault();const row=normalizeQuote(Object.fromEntries(new FormData(e.target)));
  commit({...data,prices:[...data.prices.filter(r=>r.symbol!==row.symbol||r.as_of!==row.as_of),row]});
});
$('fx-form').onsubmit=action(e=>{
  e.preventDefault();const values=Object.fromEntries(new FormData(e.target)),row=normalizeFxRate(values.pair,values);
  commit({...data,fxRates:{...data.fxRates,[row.pair]:row}});
});
$('valuation-file').onchange=()=>fileAction($('valuation-file'),(text,name)=>{
  const kind=$('import-kind').value;
  if(kind==='valuations'){
    const rows=/\.csv$/i.test(name)&&text.split(/\r?\n/,1)[0].includes('score_method')?readValuationsCSV(text):parseValuations(text,name);
    const result=mergeValuations(data,rows);commit(result.data);toast('已导入 '+result.added+' 条估值，跳过 '+result.skipped+' 条相同记录');
  }else if(kind==='prices'){
    const rows=readPricesCSV(text),prices=[...data.prices];
    for(const row of rows){const i=prices.findIndex(r=>r.symbol===row.symbol&&r.as_of===row.as_of);if(i<0)prices.push(row);else prices[i]=row;}
    commit({...data,prices});
  }else{const fxRates={...data.fxRates};for(const row of readFxCSV(text))fxRates[row.pair]=row;commit({...data,fxRates});}
});
$('export-backup').onclick=action(()=>download(exportBackup(data),'market-data-'+today()+'.json'));
$('export-project').onclick=action(()=>download(projectZIP(data,assetNames),'cycle-data-'+today()+'.zip','application/zip'));
$('export-symbol').onclick=action(()=>{
  const sym=$('data-symbol').value;if(!sym)throw new Error('请先在表格筛选中选择一个标的');
  const kind=$('data-kind').value;if(kind==='fx')throw new Error('汇率请通过项目数据包导出');
  const path=kind+'/'+sym+'.csv';download(projectFiles(data,assetNames)[path],sym+'.csv','text/csv');
});
$('restore-file').onchange=()=>fileAction($('restore-file'),text=>{
  restoreCandidate=validateBackup(JSON.parse(text));
  $('restore-summary').textContent=restoreCandidate.valuations.length+' 条估值 · '+restoreCandidate.prices.length+' 条价格 · '+restoreCandidate.formalEvents.length+' 条正式状态。账户和持仓不会导入。';
  $('restore-dialog').showModal();
});
$('restore-confirm').onclick=action(()=>{
  if(!restoreCandidate)return;storageAvailable=true;commit(restoreCandidate);restoreCandidate=null;$('restore-dialog').close();
});
$('restore-cancel').onclick=()=>{restoreCandidate=null;$('restore-dialog').close();};
$('formal-form').onsubmit=action(e=>{
  e.preventDefault();const values=Object.fromEntries(new FormData(e.target));
  commit(e.submitter?.value==='activate'?activateFormal(data,values.symbol,values.effective_date):formalMonthEnd(data,values.symbol,values.signal_date));
});
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
$('signal-date').value=monthEnd(monthFromNumber(monthNumber(today())-1));$('effective-date').value=today();
renderHoldingEditor();render();
try{
  const loaded=await load();data=loaded.data;assetNames=Object.fromEntries(loaded.manifest.assets.map(a=>[a.symbol,a.name]));
  storageAvailable=true;render();
}catch(e){error(new Error('未能读取项目数据：'+e.message));}
