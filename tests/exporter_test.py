"""Synthetic read-only migration checks; no live database used."""
import importlib.util
import json
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('legacy_export',ROOT/'scripts/export_legacy.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
from dataclasses import asdict

class FakeClient:
    def __init__(self):self.reads=[]
    def get_items(self,collection,params=None):
        self.reads.append((collection,params))
        data={
            'assets':[{'id':1,'symbol':'DEMO','name':'Synthetic','active':True}],
            'valuation_history':[
                {'id':1,'asset':1,'valuation_date':'2025-01-31','status':'valid','s_tech':5,'is_current':False,'revision':1,'source':{'code':'manual'},'notes':'S_Tech linear interpolation','price':100},
                {'id':2,'asset':1,'valuation_date':'2025-01-31','status':'valid','s_tech':6,'is_current':True,'revision':2,'source':{'code':'source-data'},'notes':'90-day EPS NTM time interpolation','supersedes':1,'price':101},
            ],
            'account_snapshots':[{'id':7,'snapshot_time':'2026-10-01T00:00:00Z','currency':'EUR','stock_value_a':1100,'financing_b':300,'equity_e':800}],
            'positions':[{'id':8,'asset':{'symbol':'DEMO'},'quantity':10,'market_value':1000,'sec_type':'STK','currency':'EUR'}],
            'strategy_runs':[
                {'id':10,'asset':1,'x':.2,'z':.4,'entered':True,'entry_pending':False,'controller_direction':'up','controller_alpha':.7,'controller_beta':.8,
                    'pending_target':None,'current_target':1.3,'strategy_config':asdict(module.CFG),'signal_month':'2025-01','effective_date':'2025-02-03',
                    'event_type':'activate','run_time':'2025-02-03T00:00:00Z','strategy_engine_hash':'synthetic-hash'},
                {'id':9,'asset':1,'strategy_config':{'k':5},'signal_month':'2024-12'},
            ],
        }
        return data[collection]

client=FakeClient();data=module.export_data(client)
assert len(client.reads)==5
assert data['valuations'][0]['is_current'] is False
assert data['valuations'][0]['interpolated'] is True
assert data['valuations'][1]['interpolated'] is False
assert data['valuations'][1]['provenance']=='legacy-unknown'
assert data['valuations'][1]['supersedes']=='directus-valuation-1'
assert data['account']['financing']==200
assert data['formalEvents'][0]['state']['alpha']==.7
assert len(data['formalEvents'])==1
assert data['holdings'][0]['currency']=='EUR'
assert all(collection in ['assets','valuation_history','account_snapshots','positions','strategy_runs'] for collection,_ in client.reads)
class ForeignCurrencyClient(FakeClient):
    def get_items(self,collection,params=None):
        result=super().get_items(collection,params)
        if collection=='positions':result[0]['currency']='USD'
        if collection=='account_snapshots':result[0]['raw_payload']={'currency_ledger':{'USD':{'ExchangeRate':.8}}}
        return result
foreign=module.export_data(ForeignCurrencyClient())
assert foreign['holdings'][0]['market_value']==800
assert foreign['holdings'][0]['source_market_value']==1000
assert foreign['holdings'][0]['source_currency']=='USD'
assert foreign['holdings'][0]['conversion_rate']==.8
assert foreign['account']['financing']==0
class MissingRateClient(ForeignCurrencyClient):
    def get_items(self,collection,params=None):
        result=super().get_items(collection,params)
        if collection=='account_snapshots':result[0]['raw_payload']={}
        return result
try:module.export_data(MissingRateClient())
except RuntimeError as exc:assert '汇率' in str(exc)
else:raise AssertionError('Missing FX rate must block migration')
output=ROOT/'tests/artifacts/synthetic-legacy-export.json'
output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
print('Migration exporter PASS: read-only collections, revisions/source evidence, A/B/E mapping, native/base currency conversion, missing-rate block, compatible formal states.')
