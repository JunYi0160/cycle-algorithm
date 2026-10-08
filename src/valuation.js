// Port of engine/valuation_formula.py. Growth rates are decimals (30% = 0.30).
export const INPUT_FIELDS=['price','eps_ttm','eps_ntm','eps_ntm_90d','revenue_ttm','revenue_ntm',
  'g_revenue_2','g_eps_2','fcf_ttm','sbc_ttm','ni_ttm'];
export function computeTechValuation(input) {
  const p={};for(const key of INPUT_FIELDS){
    if(input[key]===null||input[key]===undefined||String(input[key]).trim()===''||!Number.isFinite(Number(input[key])))throw new Error(`${key} 必须是有限数值`);
    p[key]=Number(input[key]);
  }
  const na=reason=>({status:'na',reason,forward_pe:null,g_revenue_1:null,g_eps_1:null,g1:null,g2:null,
    growth_acceleration:null,estimate_revision:null,cash_quality:null,v_tech:null,s_tech:null});
  if(p.eps_ntm<=0)return na('EPS_NTM<=0，Forward PE 失去经济意义');
  if(p.price<=0)return na('price<=0，Forward PE 无法定义');
  for(const [key,reason] of [['eps_ttm','第一阶段 EPS 增速'],['eps_ntm_90d','盈利预期修正 r'],
    ['revenue_ttm','第一阶段收入增速'],['ni_ttm','现金质量 q']])if(p[key]===0)return na(`${key}=0，${reason}无法定义`);
  const forward_pe=p.price/p.eps_ntm,g_revenue_1=p.revenue_ntm/p.revenue_ttm-1,g_eps_1=p.eps_ntm/p.eps_ttm-1;
  const g1=.6*g_revenue_1+.4*g_eps_1;if(1+g1<=0)return na('1+g1<=0，幂项在实数域无定义');
  const g2=.6*p.g_revenue_2+.4*p.g_eps_2,a=g2-g1,r=p.eps_ntm/p.eps_ntm_90d-1;
  const q=Math.min(1,Math.max(0,(p.fcf_ttm-p.sbc_ttm)/p.ni_ttm));
  const v=100/forward_pe*(1+g1)**1.5*Math.exp(.75*a)*Math.exp(.5*r)*(.75+.25*q);
  const result={status:'valid',reason:null,forward_pe,g_revenue_1,g_eps_1,g1,g2,growth_acceleration:a,
    estimate_revision:r,cash_quality:q,v_tech:v,s_tech:2*v};
  if(!Object.values(result).filter(x=>typeof x==='number').every(Number.isFinite))return na('计算结果不是有限数值');
  return result;
}
