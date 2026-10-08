"""Same buy-and-hold basket, monthly leverage reset; exact fee accounting."""
from datetime import date
import numpy as np


class FixedLeverage:
    def __init__(self, dates, opening, closing, cost=.0005, rate=.053, capital=10000):
        self.cost,self.capital=cost,capital
        self.dates=dates;op=np.asarray(opening);cl=np.asarray(closing)
        trade=np.array([i for i,d in enumerate(dates) if i==0 or d[:7]!=dates[i-1][:7]])
        days=np.array([0]+[(date.fromisoformat(dates[i])-date.fromisoformat(dates[i-1])).days for i in range(1,len(dates))])
        log_interest=np.cumsum(np.log1p(rate*days/365))
        self.trade_g=op[trade[1:]]/op[trade[:-1]]
        self.trade_debt_factor=np.exp(log_interest[trade[1:]]-log_interest[trade[:-1]])
        self.last=np.searchsorted(trade,np.arange(len(dates)),side='right')-1
        self.close_g=cl/op[trade[self.last]]
        self.open_g=op/op[trade[self.last]]
        self.debt_factor=np.exp(log_interest-log_interest[trade[self.last]])
        self.years=(date.fromisoformat(dates[-1])-date.fromisoformat(dates[0])).days/365.25
        self.grid=np.linspace(0,3,301)
        self.grid_values=np.array([self.terminal(l) for l in self.grid])

    def trade_equities(self,l):
        debt=self.trade_debt_factor if l>1 else np.ones_like(self.trade_g)
        before=l*self.trade_g+(1-l)*debt
        gap=l*(before-self.trade_g)
        after=before-self.cost*np.abs(gap)/(1+self.cost*l*np.where(gap>=0,1,-1))
        if np.any(before<=0) or np.any(after<=0):return None
        return self.capital/(1+self.cost*l)*np.r_[1.,np.cumprod(after)]

    def terminal(self,l):
        eq=self.trade_equities(l)
        if eq is None:return float('nan')
        factor=l*self.close_g[-1]+(1-l)*(self.debt_factor[-1] if l>1 else 1.)
        return float(eq[-1]*factor) if factor>0 else float('nan')

    def path(self,l):
        eq=self.trade_equities(l)
        if eq is None:return None
        debt=self.debt_factor if l>1 else np.ones_like(self.debt_factor)
        close=eq[self.last]*(l*self.close_g+(1-l)*debt)
        op=eq[self.last]*(l*self.open_g+(1-l)*debt)
        if np.any(close<=0) or np.any(op<=0):return None
        peak=np.maximum.accumulate(np.maximum(close,self.capital))
        return {'terminal_equity':float(close[-1]),'cagr':float((close[-1]/self.capital)**(1/self.years)-1),
                'max_drawdown':float(np.min(close/peak-1))}

    def match(self,target):
        residual=self.grid_values-target;roots=[]
        for i,l in enumerate(self.grid):
            if np.isfinite(residual[i]) and abs(residual[i]/target)<1e-12:roots.append(float(l))
            if i==0 or not np.isfinite(residual[i-1]) or not np.isfinite(residual[i]) or residual[i-1]*residual[i]>=0:continue
            low,high,fl=self.grid[i-1],l,residual[i-1]
            for _ in range(65):
                mid=(low+high)/2;fm=self.terminal(mid)-target
                if fl*fm<=0:high=mid
                else:low,fl=mid,fm
            roots.append(float((low+high)/2))
        for l in sorted(set(roots)):
            control=self.path(l)
            if control is None:continue
            error=abs(control['terminal_equity']/target-1)
            assert error<1e-10
            return {'fixed_leverage':l,'fixed_cagr':control['cagr'],'fixed_max_drawdown':control['max_drawdown'],
                    'relative_terminal_matching_error':error}
        return None
