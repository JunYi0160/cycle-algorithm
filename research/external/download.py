"""Download the predeclared asset universe; preserve raw responses and audit failures."""
import csv
import hashlib
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor,as_completed
from datetime import datetime,timezone
from pathlib import Path
from urllib.request import Request,urlopen

HERE=Path(__file__).resolve().parent
protocol=json.loads((HERE/'protocol.json').read_text(encoding='utf-8'))
candidate_file=HERE/'retained-candidates.json'
retained=json.loads(candidate_file.read_text(encoding='utf-8'))['candidates']
original=json.loads((HERE.parent/'v2/spec.json').read_text(encoding='utf-8'))['candidates']
assert retained==[d for d in original if d['id'] in protocol['retained_research_candidates']]
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
frozen={'frozen_utc':datetime.now(timezone.utc).isoformat(),'protocol_sha256':sha(HERE/'protocol.json'),
        'candidate_sha256':sha(candidate_file),'engine_sha256':sha(HERE.parent/'v2/engine.py'),
        'benchmark_sha256':sha(HERE.parent/'v2/fixed_leverage.py'),
        'universe_before_price_download':list(protocol['single_assets']),
        'asset_selection_after_results':False,'parameters_changed':False}
if not (HERE/'frozen.json').exists():
    (HERE/'frozen.json').write_text(json.dumps(frozen,indent=2),encoding='utf-8')
else:
    old=json.loads((HERE/'frozen.json').read_text(encoding='utf-8'))
    for k in ['protocol_sha256','candidate_sha256','engine_sha256','benchmark_sha256']:assert old[k]==frozen[k],k
    frozen=old
(HERE/'raw').mkdir(exist_ok=True)
end=int(datetime.fromisoformat(protocol['request_complete_through']).replace(tzinfo=timezone.utc).timestamp())+86400


def fetch(ticker):
    failures=[]
    for attempt,host in enumerate(['query2.finance.yahoo.com','query1.finance.yahoo.com','query2.finance.yahoo.com']):
        url=f'https://{host}/v8/finance/chart/{ticker}?period1=0&period2={end}&interval=1d&events=div%2Csplits&includeAdjustedClose=true'
        try:
            raw_path=HERE/'raw'/f'{ticker}.json'
            prior_audit_path=HERE/'data-audit.json'
            prior_audit=json.loads(prior_audit_path.read_text(encoding='utf-8')) if prior_audit_path.exists() else {}
            prior_source=prior_audit.get('sources',{}).get(ticker,{})
            cached=raw_path.exists() and prior_source.get('status')=='ok'
            if cached:
                body=raw_path.read_bytes();url=prior_source['source_url']
            else:
                req=Request(url,headers={'User-Agent':'Mozilla/5.0','Accept':'application/json'})
                with urlopen(req,timeout=30) as response:body=response.read()
            document=json.loads(body);result=document['chart']['result'][0]
            assert result['meta']['symbol'].upper()==ticker
            if not cached:raw_path.write_bytes(body)
            quote=result['indicators']['quote'][0];adj=result['indicators']['adjclose'][0]['adjclose']
            rows=[];empty=[];partial=[];out_of_range=[]
            for i,ts in enumerate(result['timestamp']):
                date=datetime.fromtimestamp(ts,timezone.utc).date().isoformat()
                if date>protocol['request_complete_through']:continue
                values=[quote[k][i] for k in ['open','close','high','low']]+[adj[i]]
                if all(v is None for v in values):empty.append(date);continue
                if any(v is None for v in values):partial.append(date);continue
                if any(not math.isfinite(v) or v<=0 for v in values):raise ValueError(f'Invalid price {date}')
                op,cl,hi,lo,ac=values;factor=ac/cl
                if lo>min(op,cl)*(1+1e-5) or hi<max(op,cl)*(1-1e-5):out_of_range.append(date)
                rows.append({'date':date,'open':op*factor,'close':ac,'high':hi*factor,'low':lo*factor,'raw_close':cl})
            if partial or out_of_range:raise ValueError(f'Partial quote rows {partial[:5]}, OHLC errors {out_of_range[:5]}')
            if len(rows)<1000:raise ValueError('Insufficient historical observations')
            assert len({r['date'] for r in rows})==len(rows)
            assert all(rows[i]['date']<rows[i+1]['date'] for i in range(len(rows)-1))
            returns=[rows[i]['close']/rows[i-1]['close']-1 for i in range(1,len(rows))]
            audit={'symbol':ticker,'source_url':url,'retrieved_utc':prior_source['retrieved_utc'] if cached else datetime.now(timezone.utc).isoformat(),
                   'reused_saved_raw_response':cached,
                   'raw_file':str(raw_path),'raw_sha256':sha(raw_path),'rows':len(rows),'start':rows[0]['date'],'end':rows[-1]['date'],
                   'instrument_name':result['meta'].get('longName',result['meta'].get('shortName')),
                   'instrument_type':result['meta'].get('instrumentType'),'exchange':result['meta'].get('exchangeName'),
                   'empty_timestamp_rows_omitted':empty,'partially_missing_quotes':partial,'ohlc_errors':out_of_range,
                   'duplicate_dates':0,'minimum_close_return':min(returns),'maximum_close_return':max(returns),
                   'return_outliers_above_50pct':[rows[i]['date'] for i in range(1,len(rows)) if abs(returns[i-1])>.5],
                   'dividend_events':len(result.get('events',{}).get('dividends',{})),
                   'split_events':len(result.get('events',{}).get('splits',{})),
                   'attempt_errors':failures,'status':'ok'}
            return ticker,rows,audit
        except Exception as e:
            failures.append(str(e));time.sleep(attempt+1)
    return ticker,None,{'symbol':ticker,'status':'download_or_validation_failed','errors':failures}


data={};audits={}
with ThreadPoolExecutor(max_workers=2) as executor:
    audit_symbol=protocol['audit_only_download'].split(',')[0].strip()
    futures=[executor.submit(fetch,t) for t in [*protocol['single_assets'],audit_symbol]]
    for future in as_completed(futures):
        ticker,rows,audit=future.result();audits[ticker]=audit
        if rows:data[ticker]=rows
        print(ticker,audit['status'],audit.get('rows'),audit.get('start'),audit.get('end'),flush=True)

# Same asset, two downloaded snapshots: report return/quote discrepancies, never blend them.
qqq_audit={}
if 'QQQ' in data:
    previous=json.loads((HERE.parent/'historical/prices.json').read_text(encoding='utf-8'))['QQQ']
    old={r['date']:r for r in previous};new={r['date']:r for r in data['QQQ']}
    dates=sorted(set(old)&set(new))
    differences=[abs(new[dates[i]]['close']/new[dates[i-1]]['close']-old[dates[i]]['close']/old[dates[i-1]]['close']) for i in range(1,len(dates))]
    qqq_audit={'overlap_rows':len(dates),'max_daily_return_difference':max(differences) if differences else None,
               'fresh_start':data['QQQ'][0]['date'],'fresh_end':data['QQQ'][-1]['date'],
               'role':'Snapshot quality check only, not a held-out asset'}
coverage=[t for t in protocol['single_assets'] if t not in data]
(HERE/'prices.json').write_text(json.dumps({t:data[t] for t in protocol['single_assets'] if t in data},separators=(',',':')),encoding='utf-8')
audit={'frozen':frozen,'sources':audits,'missing_predeclared_assets':coverage,'qqq_snapshot_check':qqq_audit,
       'normalized_prices_sha256':sha(HERE/'prices.json'),'date_cutoff_requested':protocol['request_complete_through'],
       'price_adjustment':'adjusted_open/high/low = raw value * adjusted_close/raw_close; no second split adjustment'}
(HERE/'data-audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf-8')
if coverage:raise SystemExit('Predeclared assets missing; do not silently treat the reduced universe as a complete test: '+','.join(coverage))
print('All predeclared held-out assets downloaded and validated.')
