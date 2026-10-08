// Numerical port of engine/core/strategy.py. No DOM, storage or network access.
export const ALGORITHM_ID='finite-rational-pivot-v2-60-rho0.9';
export const CONFIG = Object.freeze({valuation_window_months:60, entry_x:0.30, rho:0.9,
  l_min:1, l_max:1.75, hard_cap:2.25, financing_rate:0.053, one_way_cost:0.0005, day_basis:365,
  controller_version:'pivot-hysteresis-v2'});
function requireRange(value, min, max, name) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must lie in [${min},${max}]`);
}
export function valuationState(current, preceding, higherIsCheaper=true, cfg=CONFIG) {
  const need=cfg.valuation_window_months-1;
  if(preceding.length<need) throw new Error(`need at least ${need} preceding monthly observations`);
  const history=preceding.slice(-need);
  if(![current,...history].every(Number.isFinite)) throw new Error('valuations must be finite');
  const rank=history.filter(v=>higherIsCheaper?v<current:v>current).length;
  return 1-rank/need;
}
export function rawShape(u,rho=CONFIG.rho) {
  requireRange(u,0,1,'u');
  return 1/(1-rho*u)-1-rho*u;
}
export function shape(u,rho=CONFIG.rho) { return rawShape(u,rho)/rawShape(1,rho); }
export function cheapnessEnvelope(u,rho=CONFIG.rho) {
  const lo=shape(u,rho),hi=1-shape(1-u,rho);
  if(lo>hi && lo-hi>1e-10) throw new Error('invalid non-convex envelope');
  return [Math.min(lo,hi),Math.max(lo,hi)];
}
export function envelope(x,rho=CONFIG.rho) { requireRange(x,0,1,'x');return cheapnessEnvelope(1-x,rho); }
export function targetLeverage(x,z,cfg=CONFIG) {
  requireRange(x,0,1,'x');requireRange(z,0,1,'z');
  return Math.min(cfg.l_max,Math.max(cfg.l_min,cfg.l_min+(cfg.l_max-cfg.l_min)*z));
}
export const emptyControllerState=()=>({initialized:false,entered:false,entry_pending:false,z:null,
  previous_x:null,direction:'flat',alpha:1,beta:1,pivot_x:null,pivot_z:null,pending_target:null,current_target:null});
export class Controller {
  constructor(cfg=CONFIG,state=null) {
    this.cfg=cfg;
    if(state?.initialized&&[state.pivot_x,state.pivot_z].some(v=>!Number.isFinite(v)||v<0||v>1))throw new Error('控制器缺少有效反转锚点；旧状态需要从估值历史回放，不能用于新版转向公式');
    this.state=state?structuredClone(state):emptyControllerState();
  }
  observeMonthEnd(x,{forceEntry=false}={}) {
    requireRange(x,0,1,'x');const st=this.state;
    if(!st.entered && !st.entry_pending) {
      if(x>=this.cfg.entry_x && !forceEntry) return null;
      st.initialized=true;st.z=shape(1-x,this.cfg.rho);st.previous_x=x;
      st.direction='flat';st.alpha=st.beta=1;st.pivot_x=x;st.pivot_z=st.z;st.pending_target=targetLeverage(x,st.z,this.cfg);
      st.entry_pending=true;return st.pending_target;
    }
    if(st.entry_pending && !st.entered) return st.pending_target;
    if(st.z===null || st.previous_x===null) throw new Error('incomplete controller state');
    const oldU=1-st.previous_x,newU=1-x,du=newU-oldU;let z;
    if(du>1e-12) {
      if(st.direction!=='up') {st.pivot_x=st.previous_x;st.pivot_z=st.z;}
      const a=st.pivot_x,za=st.pivot_z,t=a>0?Math.min(1,Math.max(0,(a-x)/a)):1;
      z=za+(1-za)*shape(t,this.cfg.rho);st.direction='up';
    } else if(du< -1e-12) {
      if(st.direction!=='down') {st.pivot_x=st.previous_x;st.pivot_z=st.z;}
      const a=st.pivot_x,za=st.pivot_z,t=a<1?Math.min(1,Math.max(0,(x-a)/(1-a))):1;
      z=za*(1-shape(t,this.cfg.rho));st.direction='down';
    } else z=st.z;
    const [lo,hi]=cheapnessEnvelope(newU,this.cfg.rho);
    st.z=Math.min(hi,Math.max(lo,z));st.previous_x=x;
    st.pending_target=targetLeverage(x,st.z,this.cfg);return st.pending_target;
  }
  activatePendingTarget() {
    const st=this.state;if(st.pending_target===null)return null;
    st.current_target=st.pending_target;st.pending_target=null;
    if(st.entry_pending){st.entry_pending=false;st.entered=true;}return st.current_target;
  }
}
export class Account {
  constructor(stockValue=0,financing=-1){this.stockValue=stockValue;this.financing=financing;}
  get equity(){return this.stockValue-this.financing;}
  get naturalLeverage(){return this.stockValue<=0?0:this.equity<=0?Infinity:this.stockValue/this.equity;}
  applyReturnAndInterest(totalReturn,days,cfg=CONFIG) {
    if(!Number.isFinite(totalReturn)||totalReturn<= -1||!Number.isFinite(days)||days<0)throw new Error('invalid return or days');
    this.stockValue*=1+totalReturn;
    const interest=Math.max(this.financing,0)*cfg.financing_rate*days/cfg.day_basis;
    this.financing+=interest;if(this.equity<=0)throw new Error('insolvent account');return interest;
  }
  rebalanceTo(target,cfg=CONFIG) {
    requireRange(target,cfg.l_min,cfg.l_max,'target');
    const gap=target*this.equity-this.stockValue,cost=cfg.one_way_cost;
    const trade=gap/(gap>=0?1+cost*target:1-cost*target),fee=cost*Math.abs(trade);
    this.stockValue+=trade;this.financing+=trade+fee;
    if(Math.abs(this.naturalLeverage-target)>1e-10)throw new Error('exact rebalance failed');
    return [trade,fee];
  }
  hardCapBreached(cfg=CONFIG){return this.stockValue>0&&this.naturalLeverage>cfg.hard_cap;}
}
export function dailyCloseStep(account,{totalReturn,days,currentTarget,scheduledRebalance,cfg=CONFIG}) {
  const interest=account.applyReturnAndInterest(totalReturn,days,cfg),before=account.naturalLeverage;
  const hard=account.hardCapBreached(cfg);let trade=0,fee=0,reason=null;
  if(currentTarget!==null&&(scheduledRebalance||hard)){
    [trade,fee]=account.rebalanceTo(currentTarget,cfg);reason=scheduledRebalance?'scheduled':'hard_cap';
  }
  return {equity:account.equity,natural_leverage_before_trade:before,natural_leverage_after_trade:account.naturalLeverage,
    hard_cap_triggered:hard,trade,fee,interest,reason};
}
export function priceDropToReachHardCap(start=CONFIG.l_max,cap=CONFIG.hard_cap) {
  if(!(1<start&&start<cap))throw new Error('require 1 < start_leverage < hard_cap');
  return 1-cap*(start-1)/(start*(cap-1));
}
