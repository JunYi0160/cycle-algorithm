import math
import unittest
from datetime import date
import numpy as np
from engine import Account,replay
from fixed_leverage import FixedLeverage


class ResearchTests(unittest.TestCase):
    def test_exact_fee_and_budget_after_rebalance(self):
        a=Account(10000,.0005)
        for weight,price in [(.5,100),(.8,80),(.2,120),(1,70),(0,110)]:
            before=a.equity(price);old_fees=a.fees
            a.to_weight(weight,price)
            self.assertAlmostEqual(a.equity(price)+a.fees-old_fees,before,places=8)
            self.assertAlmostEqual(a.units*price/a.equity(price),weight,places=12)
            self.assertGreaterEqual(a.cash,0)

    def test_peak_power_roundtrip_and_repeated_old_peak(self):
        d={'id':'AY-50','family':'peak_power','alpha':.5}
        dates=['2020-01-02','2020-01-03','2020-02-03','2020-03-02','2020-04-01','2020-05-01']
        prices=[100,120,120,100,120,100]
        r=replay(d,dates,prices,prices,cost=0,retain_path=True)
        expected_q=50/math.sqrt(1.2)
        self.assertAlmostEqual(r['path'][2]['units'],expected_q,places=10)
        self.assertAlmostEqual(r['terminal_equity'],10000+(50-expected_q)*20,places=8)
        self.assertEqual(r['path'][3]['equity'],r['path'][5]['equity'])
        self.assertTrue(all(r['path'][i]['units']>=r['path'][i+1]['units'] for i in range(len(prices)-1)))

    def test_risk_return_sign_symmetry(self):
        d={'id':'RV-10','family':'risk_budget','risk_measure':'standard_deviation','target':.1,'half_life':63}
        dates=['2020-01-02','2020-01-03','2020-02-03']
        pos=[100,110,100];neg=[100,100/1.1,100]
        a=replay(d,dates,pos,pos,cost=0,retain_path=True)
        b=replay(d,dates,neg,neg,cost=0,retain_path=True)
        self.assertAlmostEqual(a['path'][2]['stock_weight'],b['path'][2]['stock_weight'],places=12)

    def test_no_same_day_close_lookahead(self):
        d={'id':'RV-10','family':'risk_budget','risk_measure':'standard_deviation','target':.1,'half_life':63}
        dates=['2020-01-02','2020-01-03','2020-02-03','2020-02-04']
        op=[100,100,100,100];cl=[100,105,100,100]
        a=replay(d,dates,op,cl,retain_path=True)
        altered=cl.copy();altered[2]=50
        b=replay(d,dates,op,altered,retain_path=True)
        self.assertEqual(a['path'][2]['units'],b['path'][2]['units'])
        short=replay(d,dates[:3],op[:3],cl[:3],retain_path=True)
        self.assertEqual(a['path'][:3],short['path'])

    def test_unanticipated_gap_is_not_avoided(self):
        d={'id':'RV-10','family':'risk_budget','risk_measure':'standard_deviation','target':.1,'half_life':63}
        dates=['2020-01-02','2020-01-03','2020-01-06']
        prices=[100,100,60]
        r=replay(d,dates,prices,prices,cost=0,frequency='daily',retain_path=True)
        self.assertAlmostEqual(r['path'][-1]['equity'],8000,places=8)

    def test_fixed_leverage_matches_independent_daily_debt_ledger(self):
        dates=['2020-01-02','2020-01-03','2020-01-06','2020-02-03','2020-02-04']
        op=[1,1.05,.9,1.2,.95];cl=[1.02,1,.95,1.1,1]
        c=.0005;rate=.053;control=FixedLeverage(dates,op,cl,cost=c,rate=rate)
        for l in [.5,1,1.3]:
            stock=0.;cash=10000.;peak=10000.;dd=0.
            for i,dt in enumerate(dates):
                if i:
                    stock*=op[i]/cl[i-1]
                    days=(date.fromisoformat(dt)-date.fromisoformat(dates[i-1])).days
                    cash-=max(-cash,0)*rate*days/365
                if i==0 or dt[:7]!=dates[i-1][:7]:
                    eq=stock+cash;gap=l*eq-stock
                    trade=gap/(1+c*l if gap>=0 else 1-c*l)
                    stock+=trade;cash-=trade+c*abs(trade)
                stock*=cl[i]/op[i]
                eq=stock+cash;peak=max(peak,eq);dd=min(dd,eq/peak-1)
            result=control.path(l)
            self.assertAlmostEqual(eq,result['terminal_equity'],places=8)
            self.assertAlmostEqual(dd,result['max_drawdown'],places=12)
            match=control.match(eq)
            self.assertIsNotNone(match)
            self.assertLess(match['relative_terminal_matching_error'],1e-10)

    def test_invalid_input_is_rejected(self):
        d={'id':'AY-50','family':'peak_power','alpha':.5}
        with self.assertRaises(ValueError):replay(d,['2020-01-02','2020-01-02'],[100,100],[100,100])
        with self.assertRaises(ValueError):replay(d,['2020-01-02','2020-01-03'],[100,0],[100,100])
        with self.assertRaises(ValueError):Account(10000,.0005).to_weight(1.1,100)


if __name__=='__main__':unittest.main(verbosity=2)
