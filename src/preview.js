// Port of monthly preparation/preview and positive market-value aggregation.
import {CONFIG,Controller,valuationState,envelope} from './strategy.js';
export function monthNumber(value){const [y,m]=value.slice(0,7).split('-').map(Number);return y*12+m-1;}
export function monthFromNumber(value){return `${Math.floor(value/12)}`.padStart(4,'0')+'-'+String(value%12+1).padStart(2,'0');}
export function monthRange(start,end){const a=monthNumber(start),b=monthNumber(end);if(b<a)throw new Error('结束月份不能早于开始月份');return Array.from({length:b-a+1},(_,i)=>monthFromNumber(a+i));}
export function buildMonthlyScores(rows,{symbol,name=symbol,asOf,cfg=CONFIG}){
  const monthly=new Map();let validCount=0,excluded=0;
  for(const row of rows){
    const d=row.valuation_date;if(!d||row.is_current===false)continue;
    if(d>asOf){excluded++;continue;}
    if(row.status!=='valid'||row.s_tech===null||!Number.isFinite(Number(row.s_tech)))continue;
    validCount++;const m=d.slice(0,7),old=monthly.get(m);
    if(!old||d>=old.valuation_date)monthly.set(m,row);
  }
  const required=cfg.valuation_window_months-1;
  const coverage={symbol,name,valid_valuation_count:validCount,valid_month_count:monthly.size,start_month:null,end_month:null,
    total_month_count:0,missing_months:[],interpolated_months:[],source_interpolated_months:[],source_unknown_months:[],required_preceding_months:required,
    ready:false,shortage_months:required+1,excluded_future_records:excluded,reason:'没有截至检查日可用的 S_Tech 估值记录。'};
  if(!monthly.size)return {coverage,scores:[]};
  const anchors=[...monthly.keys()].sort(),keys=monthRange(anchors[0],anchors.at(-1));
  let left=0;
  const scores=keys.map(month=>{
    const row=monthly.get(month);
    if(row)return {month,score:Number(row.s_tech),interpolated:false,source_interpolated:!!row.interpolated,source_unknown:row.provenance==='legacy-unknown',source_date:row.valuation_date};
    while(left+1<anchors.length&&anchors[left+1]<month)left++;
    const l=anchors[left],r=anchors[left+1],ratio=(monthNumber(month)-monthNumber(l))/(monthNumber(r)-monthNumber(l));
    return {month,score:Number(monthly.get(l).s_tech)+ratio*(Number(monthly.get(r).s_tech)-Number(monthly.get(l).s_tech)),
      interpolated:true,source_interpolated:false,source_unknown:false,source_date:null};
  });
  coverage.start_month=keys[0];coverage.end_month=keys.at(-1);coverage.total_month_count=keys.length;
  coverage.missing_months=keys.filter(m=>!monthly.has(m));coverage.interpolated_months=[...coverage.missing_months];
  coverage.source_interpolated_months=anchors.filter(m=>monthly.get(m).interpolated);
  coverage.source_unknown_months=anchors.filter(m=>monthly.get(m).provenance==='legacy-unknown');
  coverage.shortage_months=Math.max(0,cfg.valuation_window_months-keys.length);coverage.ready=coverage.shortage_months===0;
  coverage.reason=coverage.ready?`可运行：${keys.length} 个连续月，包含 ${coverage.missing_months.length} 个临时插值月份。`:
    `历史不足：${keys.length} 个连续月，需要 ${cfg.valuation_window_months} 个；还缺 ${coverage.shortage_months} 个月，不做区间外推。`;
  return {coverage,scores};
}
export function computePreview(coverage,scores,cfg=CONFIG){
  if(!coverage.ready)throw new Error(coverage.reason);
  const need=cfg.valuation_window_months-1,eligible=[];
  for(let i=need;i<scores.length;i++)eligible.push([i,valuationState(scores[i].score,scores.slice(i-need,i).map(r=>r.score),true,cfg)]);
  const qualifying=eligible.find(([,x])=>x<cfg.entry_x),fallback=!qualifying,[entryIndex,entryX]=qualifying||eligible[0];
  const xs=new Map(eligible),controller=new Controller(cfg);
  const points=scores.map((row,i)=>{
    const x=xs.get(i)??null,isEntry=i===entryIndex;let target=null,lo=null,hi=null;
    if(i>=entryIndex&&x!==null){target=controller.observeMonthEnd(x,{forceEntry:isEntry&&fallback});
      if(isEntry)controller.activatePendingTarget();[lo,hi]=envelope(x,cfg.rho);}
    return {...row,x,z:i>=entryIndex?controller.state.z:null,lower_boundary:lo,upper_boundary:hi,target_leverage:target,is_entry:isEntry};
  });
  return {coverage,config:{...cfg},entry:{month:scores[entryIndex].month,x:entryX,fallback,
    note:fallback?`历史中没有 x < 30% 的入场点；本次预览从 ${scores[entryIndex].month} 强制入场。`:`采用最早满足 x < 30% 的月份 ${scores[entryIndex].month} 入场。`},
    latest:points.at(-1),points,read_only:true,writes_database:false};
}
export function getFxRate(from, to, fxRates = {}) {
  const f = String(from || '').trim().toUpperCase();
  const t = String(to || '').trim().toUpperCase();
  if (!f || !t || f === t) return 1.0;
  const direct = `${f}/${t}`, inv = `${t}/${f}`;
  const directAlt = `${f}_${t}`, invAlt = `${t}_${f}`;
  const pick = key => {
    const item = fxRates[key];
    if (item == null) return null;
    const r = typeof item === 'number' ? item : item.rate;
    return Number.isFinite(r) && r > 0 ? r : null;
  };
  const d = pick(direct) ?? pick(directAlt);
  if (d !== null) return d;
  const i = pick(inv) ?? pick(invAlt);
  if (i !== null) return 1 / i;
  return null;
}
export function aggregateWeightedResults(rows){
  if(!rows.length)throw new Error('没有可用于组合加权的正市值持仓');
  for(const r of rows){
    const w = r.holding_weight ?? (r.market_value != null ? r.market_value : null);
    if(!Number.isFinite(w)||w<=0||!Number.isFinite(r.percentile)||r.percentile<0||r.percentile>1||!Number.isFinite(r.target_leverage)||r.target_leverage<0)throw new Error('持仓结果或市值无效');
  }
  const hasWeights = rows.every(r => Number.isFinite(r.holding_weight) && r.holding_weight > 0);
  if (hasWeights) {
    const sumW = rows.reduce((s, r) => s + r.holding_weight, 0);
    const total = rows.reduce((s, r) => s + (r.market_value || 0), 0);
    return {
      market_value: total,
      percentile: rows.reduce((s, r) => s + (r.holding_weight / sumW) * r.percentile, 0),
      target_leverage: rows.reduce((s, r) => s + (r.holding_weight / sumW) * r.target_leverage, 0)
    };
  }
  const total = rows.reduce((s, r) => s + r.market_value, 0);
  return {
    market_value: total,
    percentile: rows.reduce((s, r) => s + (r.market_value / total) * r.percentile, 0),
    target_leverage: rows.reduce((s, r) => s + (r.market_value / total) * r.target_leverage, 0)
  };
}
export function calculatePortfolio(holdings, valuations, asOf, { quotes = {}, fxRates = {}, referenceCurrency = null } = {}){
  const raw = holdings.filter(p => {
    if (p.ratio != null) return Number(p.ratio) !== 0;
    if (p.input_mode === 'shares') return Number(p.quantity) !== 0;
    if (p.input_mode === 'market_value') return Number(p.market_value) !== 0;
    if (p.market_value != null) return Number(p.market_value) !== 0;
    return Number(p.quantity) !== 0;
  });
  const expected = monthFromNumber(monthNumber(asOf) - 1);
  if (!raw.length) return { status: 'empty', message: '没有非零持仓。', percentile: null, target_leverage: null, positions: [], expected_month: expected };

  const refCurr = (referenceCurrency ? String(referenceCurrency) : (raw.find(h => h.currency)?.currency || 'USD')).toUpperCase();
  const parsed = [];
  let hasRatio = false, hasMonetary = false;
  for (const p of raw) {
    let reason = null;
    if (!p.symbol) reason = '缺少 symbol';
    else if (p.sec_type && p.sec_type !== 'STK') reason = `当前策略不支持 ${p.sec_type} 合约`;

    const mode = p.input_mode || (p.ratio != null ? 'ratio' : (p.market_value != null ? 'market_value' : 'shares'));
    let val = null, quoteUsed = null;

    if (!reason) {
      if (mode === 'ratio') {
        hasRatio = true;
        const r = Number(p.ratio ?? p.quantity);
        if (!Number.isFinite(r) || r <= 0) reason = '持仓比例必须为正数';
        else val = r;
      } else {
        hasMonetary = true;
        if (p.quantity !== undefined && p.quantity !== null && (!Number.isFinite(Number(p.quantity)) || Number(p.quantity) <= 0)) {
          reason = '当前策略仅支持正股多头';
        } else if (p.market_value !== undefined && p.market_value !== null && (!Number.isFinite(Number(p.market_value)) || Number(p.market_value) <= 0)) {
          reason = '市值必须为正数';
        } else if (mode === 'shares') {
          const q = Number(p.quantity);
          const quote = quotes[p.symbol];
          if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) {
            reason = `缺少 ${p.symbol} 的有效价格（需手动输入）`;
          } else {
            quoteUsed = quote;
            const quoteCurr = String(quote.currency || p.currency || refCurr).toUpperCase();
            const fx = getFxRate(quoteCurr, refCurr, fxRates);
            if (fx === null) reason = `缺少 ${quoteCurr} 到 ${refCurr} 的换汇汇率`;
            else val = q * quote.price * fx;
          }
        } else { // market_value
          const mv = Number(p.market_value);
          const itemCurr = String(p.currency || refCurr).toUpperCase();
          const fx = getFxRate(itemCurr, refCurr, fxRates);
          if (fx === null) reason = `缺少 ${itemCurr} 到 ${refCurr} 的换汇汇率`;
          else val = mv * fx;
        }
      }
    }
    parsed.push({ ...p, input_mode: mode, calc_value: val, quote: quoteUsed, reason, status: reason ? 'blocked' : 'pending' });
  }

  if (hasRatio && hasMonetary) {
    for (const item of parsed) {
      item.status = 'blocked';
      item.reason = '不能将无单位比例与货币金额混在同一组合中';
    }
  }

  const validVals = parsed.filter(i => i.status !== 'blocked' && Number.isFinite(i.calc_value) && i.calc_value > 0);
  const totalVal = validVals.reduce((s, i) => s + i.calc_value, 0);
  if(!Number.isFinite(totalVal))return {status:'blocked',message:'组合输入合计超出有限数值范围',percentile:null,target_leverage:null,positions:parsed.map(p=>({...p,status:'blocked',reason:'输入合计过大'})),expected_month:expected};

  // Group by symbol
  const grouped = new Map();
  for (const item of parsed) {
    const sym = item.symbol || 'UNKNOWN';
    const old = grouped.get(sym);
    if (!old) {
      grouped.set(sym, { ...item, total_calc_value: item.calc_value || 0, items: [item] });
    } else {
      if (item.status === 'blocked') {
        old.status = 'blocked';
        old.reason = (old.reason ? old.reason + '；' : '') + item.reason;
      }
      old.total_calc_value += item.calc_value || 0;
      old.items.push(item);
    }
  }

  const positions = [];
  for (const p of grouped.values()) {
    if (p.status === 'blocked') {
      positions.push(p);
      continue;
    }
    const weight = totalVal > 0 && p.total_calc_value > 0 ? p.total_calc_value / totalVal : null;
    p.holding_weight = weight;
    p.market_value = p.total_calc_value; // normalized value in reference currency

    const { coverage, scores } = buildMonthlyScores(valuations.filter(r => r.symbol === p.symbol), { symbol: p.symbol, asOf });
    const lag = coverage.end_month ? Math.max(0, monthNumber(expected) - monthNumber(coverage.end_month)) : null;
    const latest = valuations.filter(r => r.symbol === p.symbol && r.is_current && r.status === 'valid' && r.valuation_date <= asOf).sort((a,b)=>a.valuation_date.localeCompare(b.valuation_date)).at(-1);
    const row = { ...p, coverage, valuation_lag_months: lag, valuation_month: coverage.end_month, source_code: latest?.source_code ?? null };

    if (!coverage.ready) {
      positions.push({ ...row, status: 'blocked', reason: coverage.reason });
      continue;
    }
    try {
      const preview = computePreview(coverage, scores);
      positions.push({
        ...row,
        status: 'ready',
        percentile: preview.latest.x,
        target_leverage: preview.latest.target_leverage,
        entry_fallback: preview.entry.fallback,
        entry_note: preview.entry.note
      });
    } catch(e) {
      positions.push({ ...row, status: 'blocked', reason: e.message });
    }
  }

  const blocked = positions.filter(p => p.status === 'blocked');
  if (blocked.length) {
    return {
      status: 'blocked',
      message: blocked.map(p => `${p.symbol}：${p.reason}`).join('；'),
      percentile: null,
      target_leverage: null,
      positions,
      expected_month: expected
    };
  }

  const aggregate = aggregateWeightedResults(positions);
  return {
    status: 'ready',
    message: `全部 ${positions.length} 个标的可计算；按持仓权重加权。`,
    ...aggregate,
    positions,
    expected_month: expected
  };
}
