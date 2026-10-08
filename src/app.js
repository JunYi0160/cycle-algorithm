import {CONFIG} from './strategy.js';
import {INPUT_FIELDS,computeTechValuation} from './valuation.js';
import {buildMonthlyScores,computePreview,calculatePortfolio,monthFromNumber,monthNumber,getFxRate} from './preview.js';
import {emptyData,uid,today,monthEnd,normalizeHolding,normalizeValuation,parseValuations,mergeValuations,validateBackup,formalMonthEnd,activateFormal,normalizeQuote,normalizeFxRate,normalizeJob} from './model.js';
import {load,save,exportBackup,STORAGE_KEY} from './storage.js';

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dec=(v,d=2)=>v==null||!Number.isFinite(v)?'—':Number(v).toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=v=>v==null?'—':dec(v*100,1)+'%';
const money=(v,curr='USD')=>v==null?'—':dec(v,2)+' '+(curr||data.referenceCurrency||'USD');

let data=emptyData(),restoreCandidate=null,currentPreviewSymbol=null,storageAvailable=true;
let helperConnected=false,helperInfo=null,activeTaskCount=0;
const HELPER_BASE='http://127.0.0.1:8789';

if(typeof navigator!=='undefined'&&'serviceWorker' in navigator){
  navigator.serviceWorker.getRegistrations().then(regs=>{for(const r of regs)r.unregister();}).catch(()=>{});
}

function error(e){$('error').hidden=false;$('error').textContent=e.message||String(e);$('error').scrollIntoView({behavior:'smooth',block:'center'});}
function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('show'),4500);}
function action(fn){return (...args)=>{try{$('error').hidden=true;fn(...args);}catch(e){error(e);}};}
function asyncAction(fn){return async(...args)=>{try{$('error').hidden=true;await fn(...args);}catch(e){error(e);}};}

function commit(next){
  if(!storageAvailable)throw new Error('本地数据读取失败。请先下载故障恢复文件，再选择有效备份恢复；当前原始数据没有被覆盖。');
  const stamped=save(next);data=stamped;render();toast('已保存到当前浏览器');
}

function symbols(){return [...new Set([...data.valuations.map(r=>r.symbol),...data.holdings.map(p=>p.symbol)])].sort();}

let helperToken=localStorage.getItem('cycle-algorithm-helper-token')||'';

async function ensureHelperToken(){
  if(helperToken)return helperToken;
  try{
    const res=await fetch(`${HELPER_BASE}/api/session-token`,{mode:'cors',signal:AbortSignal.timeout(2000)});
    if(res.ok){
      const json=await res.json();
      if(json.ok&&json.token){
        helperToken=json.token;
        localStorage.setItem('cycle-algorithm-helper-token',helperToken);
        return helperToken;
      }
    }
  }catch{}
  return '';
}

// Helper API communication
async function pingHelper(){
  try{
    await ensureHelperToken();
    const res=await fetch(`${HELPER_BASE}/api/status`,{method:'GET',mode:'cors',signal:AbortSignal.timeout(2500)});
    if(res.ok){
      helperInfo=await res.json();
      helperConnected=true;
      updateHelperUI();
      return true;
    }
  }catch{
    helperConnected=false;
    updateHelperUI();
    return false;
  }
}

function updateHelperUI(){
  const dot=$('helper-dot'),statusText=$('helper-status');
  const costOk=helperConnected&&helperInfo?.costProtection===true;
  const autostartActive=helperConnected&&helperInfo?.autostart===true;
  const autostartHtml=helperConnected ? `
    <div style="margin-top:10px;padding-top:8px;border-top:1px dashed rgba(0,0,0,0.12);font-size:13px;display:flex;align-items:center;gap:8px;">
      <span>守护进程开机自启：</span>
      <b style="color:${autostartActive ? '#2e7d32' : '#666'}">${autostartActive ? '已开启（开机静默运行）' : '未开启'}</b>
      <button id="btn-toggle-autostart" class="btn secondary" style="padding:2px 8px;font-size:12px;margin-left:auto;">${autostartActive ? '关闭自启' : '开启开机自启'}</button>
    </div>` : '';

  if(helperConnected&&costOk){
    dot.className='dot ok';
    statusText.textContent=`Antigravity 已连接 · 套餐额度已保护`;
    $('action-word').textContent='Antigravity 助手运行中';
    $('action-amount').textContent='已连接 · 基础额度已保护';
    $('helper-note').innerHTML=`已连接本机助手（端口 ${helperInfo?.port||8789}），useG1Credits: false 已锁定。<br>保存持仓后将自动调用官方 CLI 联网检索数据并严格复核。${autostartHtml}`;
    if($('btn-auto-enrich'))$('btn-auto-enrich').disabled=false;
  }else if(helperConnected&&!costOk){
    dot.className='dot warning';
    statusText.textContent=`Antigravity 已连接 · ⚠️ 费用保护未激活`;
    $('action-word').textContent='费用保护检查未通过';
    $('action-amount').textContent='暂停自动补数';
    $('helper-note').innerHTML=`检测到 CLI 配置可能启用了外部 API 或 credits 超额回退。为防止产生费用，自动补数已暂停。<br><button id="btn-fix-cost" class="btn primary" style="margin-top:8px;">立即锁定套餐基础额度</button>${autostartHtml}`;
    if($('btn-auto-enrich'))$('btn-auto-enrich').disabled=true;
    setTimeout(()=>{
      const btn=document.getElementById('btn-fix-cost');
      if(btn)btn.onclick=asyncAction(async()=>{
        await fetch(`${HELPER_BASE}/api/protect-cost`,{method:'POST',mode:'cors',headers:{'X-Helper-Token':helperToken}});
        await pingHelper();
      });
    },50);
  }else{
    dot.className='dot';
    statusText.textContent='本机助手未连接（离线模式）';
    $('action-word').textContent='本机助手未启动';
    $('action-amount').textContent='可离线使用已有数据';
    $('helper-note').innerHTML=`可正常使用已有数据与回放。如需自动联网补数，请双击桌面的“Cycle Algorithm 守护进程”快捷方式或运行 <code>npm run helper</code>。`;
    if($('btn-auto-enrich'))$('btn-auto-enrich').disabled=false;
  }

  if(helperConnected){
    setTimeout(()=>{
      const autoBtn=document.getElementById('btn-toggle-autostart');
      if(autoBtn)autoBtn.onclick=asyncAction(async()=>{
        await ensureHelperToken();
        const res=await fetch(`${HELPER_BASE}/api/autostart`,{
          method:'POST',
          mode:'cors',
          headers:{'Content-Type':'application/json','X-Helper-Token':helperToken},
          body:JSON.stringify({enabled:!autostartActive})
        });
        const data=await res.json();
        await pingHelper();
        toast(data.enabled ? '已开启开机自启动（已加入 Windows 启动项）' : '已关闭开机自启动（已移除启动项）');
      });
    },50);
  }
}

async function requestLiveQuote(sym){
  if(!helperConnected)throw new Error('本机助手未连接，无法联网获取最新报价');
  await ensureHelperToken();
  const res=await fetch(`${HELPER_BASE}/api/quote`,{
    method:'POST',
    mode:'cors',
    headers:{'Content-Type':'application/json','X-Helper-Token':helperToken},
    body:JSON.stringify({symbol:sym})
  });
  const json=await res.json();
  if(!json.ok)throw new Error(json.error||`获取 ${sym} 报价失败`);
  return normalizeQuote(json.quote);
}

async function requestLiveFx(base,target){
  if(!helperConnected)throw new Error('本机助手未连接，无法联网获取汇率');
  await ensureHelperToken();
  const res=await fetch(`${HELPER_BASE}/api/fx`,{
    method:'POST',
    mode:'cors',
    headers:{'Content-Type':'application/json','X-Helper-Token':helperToken},
    body:JSON.stringify({base,target})
  });
  const json=await res.json();
  if(!json.ok)throw new Error(json.error||`获取 ${base}/${target} 汇率失败`);
  return normalizeFxRate(json.fx.pair,json.fx);
}

async function requestEnrich(sym,missingMonths){
  if(!helperConnected)throw new Error('本机助手未连接，无法自动补数');
  await ensureHelperToken();
  const res=await fetch(`${HELPER_BASE}/api/enrich`,{
    method:'POST',
    mode:'cors',
    headers:{'Content-Type':'application/json','X-Helper-Token':helperToken},
    body:JSON.stringify({symbol:sym,missing_months:missingMonths})
  });
  const json=await res.json();
  if(!json.ok)throw new Error(json.error||`补数任务失败：${sym}`);
  return json;
}

// Holdings editor rendering
function renderHoldingEditor(){
  $('currency').value=data.referenceCurrency||'USD';
  $('holding-editor').innerHTML='';
  data.holdings.forEach(addHoldingRow);
  updateHoldingCalculations();
}

function addHoldingRow(p={id:uid(),symbol:'',input_mode:'market_value',quantity:'',market_value:'',ratio:'',sec_type:'STK',currency:''}){
  const row=document.createElement('tr');
  row.dataset.id=p.id;
  const mode=p.input_mode||(p.ratio!=null?'ratio':(p.market_value!=null&&p.market_value!==''?'market_value':'shares'));
  const curr=p.currency||data.referenceCurrency||'USD';
  const val=mode==='ratio'?(p.ratio??p.quantity??''):mode==='shares'?(p.quantity??''):(p.market_value??'');

  row.innerHTML=`
    <td><input data-field="symbol" value="${esc(p.symbol)}" aria-label="持仓 Symbol" required maxlength="20" placeholder="NVDA"></td>
    <td>
      <select data-field="input_mode" aria-label="输入模式">
        <option value="market_value" ${mode==='market_value'?'selected':''}>市值模式</option>
        <option value="shares" ${mode==='shares'?'selected':''}>股数模式</option>
        <option value="ratio" ${mode==='ratio'?'selected':''}>直接比例</option>
      </select>
    </td>
    <td><input data-field="value" type="number" step="any" value="${esc(val)}" aria-label="持仓数值" required placeholder="${mode==='shares'?'股数 (如 10)':mode==='ratio'?'比例 (如 75)':'市值 (如 15000)'}"></td>
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
    valInput.placeholder=m==='shares'?'股数 (如 10)':m==='ratio'?'比例 (如 75)':'市值 (如 15000)';
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
    if(mode==='ratio'){item.ratio=n;item.quantity=n;item.market_value=null;}
    else if(mode==='shares'){item.quantity=n;item.market_value=null;item.ratio=null;}
    else{item.market_value=n;item.quantity=null;item.ratio=null;}
    return item;
  });
}

function updateHoldingCalculations(){
  const holdings=readHoldingEditor();
  const asOf=today();
  const portfolio=calculatePortfolio(holdings,data.valuations,asOf,{quotes:data.quotes,fxRates:data.fxRates,referenceCurrency:$('currency').value});
  
  [...$('holding-editor').children].forEach(row=>{
    const sym=row.querySelector('[data-field="symbol"]').value.trim().toUpperCase();
    const mode=row.querySelector('[data-field="input_mode"]').value;
    const valInput=Number(row.querySelector('[data-field="value"]').value);
    const curr=row.querySelector('[data-field="currency"]').value.trim().toUpperCase();

    const derivedCell=row.querySelector('[data-derived]');
    const weightCell=row.querySelector('[data-weight]');
    const targetCell=row.querySelector('[data-target]');

    const quote=data.quotes[sym];
    if(mode==='shares'){
      if(quote&&Number.isFinite(quote.price)){
        const calcVal=Number.isFinite(valInput)?valInput*quote.price:null;
        derivedCell.innerHTML=`${quote.price} ${quote.currency}<br><span class="muted">${calcVal!=null?dec(calcVal,2)+' '+quote.currency:''}</span>`;
      }else{
        derivedCell.innerHTML='<span class="muted">待获取报价</span>';
      }
    }else if(mode==='market_value'){
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
  const refCurr=data.referenceCurrency||'USD';
  const portfolio=calculatePortfolio(data.holdings,data.valuations,asOf,{quotes:data.quotes,fxRates:data.fxRates,referenceCurrency:refCurr});

  $('storage-status').textContent=storageAvailable?'数据保存在此浏览器':'本地数据需要恢复';
  $('storage-dot').className='dot '+(storageAvailable?'ok':'bad');
  $('updated-at').textContent=data.updatedAt?'已保存更新 '+new Date(data.updatedAt).toLocaleString('zh-CN'):'尚未录入持仓';

  // Leverage and percentiles
  const tLev=portfolio.target_leverage;
  $('target-lev').textContent=tLev==null?'—':dec(tLev,2)+'×';
  $('summary-target-lev').textContent=tLev==null?'—':dec(tLev,2)+'×';
  $('holding-count').textContent=`${data.holdings.length} 笔持仓`;
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
    const q=data.quotes[p.symbol];
    const qStr=q?`· 报价 ${q.price} ${q.currency}`:'';
    const levStr=p.target_leverage!=null?`· 目标 ${dec(p.target_leverage,2)}×`:`· ${p.reason||'未就绪'}`;
    return `<div class="legend-row"><span class="legend-name">${esc(p.symbol)} (${esc(p.input_mode||'市值')}) ${qStr}</span><span>${pct(p.holding_weight)} ${levStr}</span></div>`;
  }).join('');
  $('holding-weights').innerHTML=legendHtml||'<p class="muted">保存持仓后在这里显示相对权重与逐标的目标杠杆。</p>';

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
  }).join('')||'<div class="empty">录入持仓或导入历史估值，或点击“体验虚构示例”。</div>';
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

// Auto-enrichment & Quote refresh runner
async function runAutoEnrichment({forceQuotes=false}={}){
  if(!helperConnected){
    await pingHelper();
    if(!helperConnected){
      toast('本地助手未连接，无法联网补数。请启动 scripts/start-helper.cmd');
      return;
    }
  }

  $('btn-cancel-job').hidden=false;
  activeTaskCount++;
  toast('开始通过 Antigravity 检查补全持仓数据...');

  try{
    const asOf=today();
    const expectedMonth=monthFromNumber(monthNumber(asOf)-1);
    let updatedQuotes=0,addedValuations=0,updatedFx=0;

    // 1. Fetch missing/expired FX rates for multi-currency holdings
    const refCurr=(data.referenceCurrency||'USD').toUpperCase();
    const neededCurrs=new Set();
    for(const p of data.holdings){
      if(p.input_mode!=='ratio'&&p.currency&&p.currency.toUpperCase()!==refCurr){
        neededCurrs.add(p.currency.toUpperCase());
      }
    }
    for(const curr of neededCurrs){
      const pair=`${curr}/${refCurr}`;
      const existing=data.fxRates[pair];
      const isExpired=!existing||(Date.now()-new Date(existing.retrieved_at).getTime()>24*3600*1000);
      if(isExpired){
        try{
          toast(`正在获取 ${pair} 最新汇率...`);
          const fx=await requestLiveFx(curr,refCurr);
          data.fxRates[pair]=fx;
          commit(data);
          updatedFx++;
        }catch(e){
          console.warn(`FX fetch failed for ${pair}:`,e);
        }
      }
    }

    // 2. Refresh quotes for shares mode
    for(const p of data.holdings){
      if(!p.symbol)continue;
      const isShares=p.input_mode==='shares';
      const existing=data.quotes[p.symbol];
      const isExpired=!existing||!Number.isFinite(existing.price)||(Date.now()-new Date(existing.retrieved_at).getTime()>12*3600*1000);
      const needsQuote=forceQuotes||(isShares&&isExpired);
      if(needsQuote){
        try{
          toast(`正在获取 ${p.symbol} 最新收盘价...`);
          const q=await requestLiveQuote(p.symbol);
          data.quotes[p.symbol]=q;
          commit(data);
          updatedQuotes++;
        }catch(e){
          console.warn(`Quote fetch failed for ${p.symbol}:`,e);
        }
      }
    }

    // 3. Check and sequentially batch missing valuation months (full 60 months)
    for(const p of data.holdings){
      if(!p.symbol)continue;
      const sym=p.symbol;
      const {coverage}=buildMonthlyScores(data.valuations.filter(r=>r.symbol===sym),{symbol:sym,asOf});
      
      let missingToEnrich=[];
      if(!coverage.ready){
        const end=coverage.end_month||expectedMonth;
        const startNum=monthNumber(end)-59;
        for(let i=0;i<60;i++){
          const m=monthFromNumber(startNum+i);
          if(!data.valuations.some(r=>r.symbol===sym&&r.is_current&&r.status==='valid'&&r.valuation_date.startsWith(m))){
            missingToEnrich.push(m);
          }
        }
      }else if(coverage.missing_months.length>0){
        missingToEnrich.push(...coverage.missing_months);
      }
      if(coverage.end_month&&coverage.end_month<expectedMonth){
        for(let i=monthNumber(coverage.end_month)+1;i<=monthNumber(expectedMonth);i++){
          const m=monthFromNumber(i);
          if(!missingToEnrich.includes(m))missingToEnrich.push(m);
        }
      }

      // Process in sequential batches of up to 12 months until finished or no further data found
      while(missingToEnrich.length>0){
        const batch=missingToEnrich.slice(0,12);
        toast(`正在为 ${sym} 检索 ${batch.length} 个月份的数据（剩余 ${missingToEnrich.length} 月）...`);
        try{
          const enrichRes=await requestEnrich(sym,batch);
          if(enrichRes.results&&enrichRes.results.length>0){
            const merged=mergeValuations(data,enrichRes.results);
            data=merged.data;
            addedValuations+=merged.added;
            commit(data);
          }
          const foundSet=new Set((enrichRes.results||[]).map(r=>r.valuation_date.slice(0,7)));
          data.enrichmentJobs.push(normalizeJob({
            symbol:sym,
            status:enrichRes.status,
            missing_months:enrichRes.missing,
            details:enrichRes.message
          }));
          commit(data);

          if(foundSet.size===0){
            // Public sources returned no data for this batch; stop loop for this symbol
            break;
          }
          missingToEnrich=missingToEnrich.filter(m=>!foundSet.has(m));
        }catch(e){
          console.warn(`Enrichment failed for ${sym}:`,e);
          break;
        }
      }
    }

    renderHoldingEditor();
    toast(`补数完成：更新 ${updatedQuotes} 个报价，${updatedFx} 个汇率，补充 ${addedValuations} 条有效估值`);
  }finally{
    activeTaskCount--;
    $('btn-cancel-job').hidden=true;
  }
}

// Event Bindings
$('add-holding').onclick=()=>{
  addHoldingRow({id:uid(),symbol:'',input_mode:'shares',quantity:'',market_value:'',ratio:'',sec_type:'STK',currency:data.referenceCurrency});
  updateHoldingCalculations();
};

$('account-form').onsubmit=action(e=>{
  e.preventDefault();
  const refCurr=($('currency').value||'USD').trim().toUpperCase();
  const rawPositions=readHoldingEditor();
  const normalized=rawPositions.map(p=>normalizeHolding(p,refCurr));
  const next={...data,referenceCurrency:refCurr,holdings:normalized};
  commit(next);
  renderHoldingEditor();
  if(helperConnected){
    runAutoEnrichment();
  }
});

$('btn-auto-enrich').onclick=asyncAction(()=>runAutoEnrichment({forceQuotes:false}));
$('btn-force-check').onclick=asyncAction(()=>runAutoEnrichment({forceQuotes:false}));
$('btn-refresh-quotes').onclick=asyncAction(()=>runAutoEnrichment({forceQuotes:true}));
$('btn-cancel-job').onclick=asyncAction(async()=>{
  if(!helperConnected)return;
  await fetch(`${HELPER_BASE}/api/cancel`,{method:'POST'});
  toast('已发送取消请求');
});

$('score-form').onsubmit=action(e=>{
  e.preventDefault();
  const values=Object.fromEntries(new FormData(e.target));
  const row=normalizeValuation({...values,valuation_date:monthEnd(values.month),interpolated:e.target.elements.interpolated.checked});
  commit(mergeValuations(data,[row]).data);
});

$('formula-inputs').innerHTML=INPUT_FIELDS.map(k=>`<label>${esc(k)}<input name="${esc(k)}" type="number" step="any" required aria-label="${esc(k)}"></label>`).join('');

$('formula-form').onsubmit=action(e=>{
  e.preventDefault();
  const values=Object.fromEntries(new FormData(e.target)),result=computeTechValuation(values);
  $('formula-result').textContent=result.status==='valid'?'S_Tech = '+dec(result.s_tech,6):result.reason;
  if(result.status!=='valid')throw new Error(result.reason);
  const inputs=Object.fromEntries(INPUT_FIELDS.map(k=>[k,Number(values[k])]));
  const row=normalizeValuation({symbol:values.symbol,valuation_date:monthEnd(values.month),s_tech:result.s_tech,source_code:'manual-fundamentals',raw_inputs:inputs,derived_result:result});
  commit(mergeValuations(data,[row]).data);
});

$('valuation-file').onchange=()=>fileAction($('valuation-file'),(text,name)=>{
  const rows=parseValuations(text,name),result=mergeValuations(data,rows);
  commit(result.data);
  toast(`导入 ${result.added} 条；跳过 ${result.skipped} 条相同记录。`);
});

$('export-backup').onclick=action(()=>download(exportBackup(data),`cycle-backup-${today()}.json`));
$('download-raw').onclick=action(()=>download(localStorage.getItem(STORAGE_KEY)||exportBackup(data),`cycle-recovery-${today()}.json`));

$('restore-file').onchange=()=>fileAction($('restore-file'),text=>{
  restoreCandidate=validateBackup(JSON.parse(text));
  $('restore-summary').textContent=`参考币种 ${restoreCandidate.referenceCurrency} · ${restoreCandidate.holdings.length} 笔持仓 · ${restoreCandidate.valuations.length} 条估值 · ${restoreCandidate.formalEvents.length} 条正式事件 · ${restoreCandidate.legacyFormalEvents.length} 条旧版审计事件。`;
  $('restore-dialog').showModal();
});

$('restore-confirm').onclick=action(()=>{
  if(!restoreCandidate)return;
  const stamped=save(restoreCandidate);
  storageAvailable=true;
  data=stamped;
  restoreCandidate=null;
  $('restore-dialog').close();
  currentPreviewSymbol=null;
  $('preview').classList.remove('show');
  renderHoldingEditor();
  render();
  toast('完整备份已恢复');
});

$('restore-cancel').onclick=()=>{
  $('restore-dialog').close();
  restoreCandidate=null;
};

$('formal-form').onsubmit=action(e=>{
  e.preventDefault();
  const values=Object.fromEntries(new FormData(e.target));
  commit(e.submitter?.value==='activate'?activateFormal(data,values.symbol,values.effective_date):formalMonthEnd(data,values.symbol,values.signal_date));
});

$('demo').onclick=action(()=>{
  const end=monthNumber(today())-1;
  const rows=Array.from({length:72},(_,i)=>normalizeValuation({symbol:'DEMO',valuation_date:monthEnd(monthFromNumber(end-71+i)),s_tech:5+i*.04+Math.sin(i*.4)*1.5,source_code:'synthetic-example',notes:'虚构示例，不代表真实证券'}));
  let next=mergeValuations(data,rows).data;
  if(!data.holdings.length){
    next={
      ...next,
      referenceCurrency:'USD',
      holdings:[
        {id:uid(),symbol:'DEMO',input_mode:'shares',quantity:100,currency:'USD',sec_type:'STK'}
      ],
      quotes:{
        'DEMO':{symbol:'DEMO',price:150.0,currency:'USD',as_of:today(),source_name:'示例报价',retrieved_at:new Date().toISOString()}
      }
    };
  }
  commit(next);
  renderHoldingEditor();
  toast('已加入虚构 DEMO 标的与估值');
});

// Initialization
try{
  data=load();
}catch(e){
  storageAvailable=false;
  error(new Error('本地数据暂时无法读取：'+e.message+'。先下载故障恢复文件；不会覆盖原数据。'));
}

$('signal-date').value=monthEnd(monthFromNumber(monthNumber(today())-1));
$('effective-date').value=today();

renderHoldingEditor();
render();
pingHelper();
setInterval(pingHelper,10000);
