"""Causal, long-only, self-financing strategy replay over a fixed-share basket."""
import math
from datetime import date
import numpy as np


class Account:
    def __init__(self,capital,cost):
        self.cash=capital;self.units=0.;self.cost=cost;self.fees=0.;self.turnover=0.
    def equity(self,p):return self.cash+self.units*p
    def to_weight(self,w,p):
        if not 0<=w<=1:raise ValueError('unfunded weight')
        eq=self.equity(p);gap=w*eq-self.units*p
        trade=gap/(1+self.cost*w if gap>=0 else 1-self.cost*w)
        self.to_units(self.units+trade/p,p)
    def to_units(self,q,p):
        if q<0:raise ValueError('short position')
        trade=(q-self.units)*p;fee=abs(trade)*self.cost
        self.cash-=trade+fee;self.units=q;self.fees+=fee;self.turnover+=abs(trade)
        if self.cash< -1e-8:raise ValueError('unfunded trade')
        if abs(self.cash)<1e-10:self.cash=0.


def replay(definition,dates,opening,closing,cost=.0005,capital=10000,frequency='monthly',extra_delay=0,retain_path=False):
    if not dates or len(dates)!=len(opening) or len(dates)!=len(closing):raise ValueError('empty/mismatched observations')
    if any(dates[i]>=dates[i+1] for i in range(len(dates)-1)):raise ValueError('unordered dates')
    if any(not math.isfinite(p) or p<=0 for p in [*opening,*closing]):raise ValueError('invalid prices')
    d=definition;family=d['family'];a=Account(capital,cost)
    peak_price=opening[0];initial_units=None;variance=.2**2/252
    lam=2**(-1/d.get('half_life',63))
    initial_w=d['alpha'] if family=='peak_power' else min(1,(d['target']/.2)**(1 if d['risk_measure']=='standard_deviation' else 2))
    peak_nav=capital;max_dd=0.;weights=[];path=[];annual={};prev_eq=capital;year_base=capital;prior_year=None
    observed_states=[];previous_close=None;trade_days=0;max_residual=0.;returns=[]
    for i,(dt,op,cl) in enumerate(zip(dates,opening,closing)):
        year=dt[:4]
        if year!=prior_year:
            if prior_year:annual[prior_year]=prev_eq/year_base-1
            year_base=prev_eq;prior_year=year
        scheduled=i==0 or frequency=='daily' or dt[:7]!=dates[i-1][:7]
        before=a.equity(op);old_fees=a.fees
        if i==0:
            a.to_weight(initial_w,op);initial_units=a.units
        elif scheduled:
            # With no extra delay use state after yesterday's close. Never today's close.
            state_index=max(0,len(observed_states)-1-extra_delay)
            signal_peak,signal_variance=observed_states[state_index]
            if family=='peak_power':
                desired=initial_units*(signal_peak/opening[0])**(d['alpha']-1)
                a.to_units(min(a.units,desired),op)
            else:
                ratio=d['target']/math.sqrt(252*signal_variance)
                w=min(1,ratio**(1 if d['risk_measure']=='standard_deviation' else 2))
                a.to_weight(w,op)
        residual=a.equity(op)-before+(a.fees-old_fees)
        max_residual=max(max_residual,abs(residual))
        if abs(residual)>1e-8*max(capital,before):raise AssertionError('cash conservation failed')
        if a.fees>old_fees+1e-9:trade_days+=1
        eq=a.equity(cl);weight=a.units*cl/eq
        if not 0<=weight<=1+1e-10:raise AssertionError('unfunded exposure')
        peak_nav=max(peak_nav,eq);max_dd=min(max_dd,eq/peak_nav-1)
        weights.append(weight);returns.append(math.log(eq/prev_eq));prev_eq=eq
        if retain_path:path.append({'date':dt,'equity':eq,'stock_weight':weight,'cash':a.cash,'fees':a.fees,'units':a.units})
        # Consume today's close only after all of today's trades and marks.
        peak_price=max(peak_price,cl)
        if previous_close is not None:
            r=math.log(cl/previous_close)
            variance=lam*variance+(1-lam)*r*r
        previous_close=cl;observed_states.append((peak_price,variance))
    annual[prior_year]=prev_eq/year_base-1
    years=(date.fromisoformat(dates[-1])-date.fromisoformat(dates[0])).days/365.25
    return {'strategy':d['id'],'start':dates[0],'end':dates[-1],'terminal_equity':prev_eq,
            'cagr':(prev_eq/capital)**(1/years)-1,'max_drawdown':max_dd,'average_stock_weight':float(np.mean(weights)),
            'terminal_stock_weight':weights[-1],'fees_paid':a.fees,'turnover':a.turnover,'trade_days':trade_days,
            'maximum_cash_conservation_residual':max_residual,'annual_returns':annual,'path':path}
