"""Read-only one-time export. Private files never enter the publish directory."""
import argparse
import calendar
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--engine',type=Path,default=ROOT/'engine')
parser.add_argument('--env',type=Path)
parser.add_argument('--output',type=Path)
args=parser.parse_args()
sys.path.insert(0,str(args.engine.resolve()))
from directus_client import DirectusClient,DirectusConfig
from core.strategy import CFG
from dataclasses import asdict

ALGORITHM_ID='finite-rational-pivot-v2-60-rho0.9'
if getattr(CFG,'controller_version',None)!='pivot-hysteresis-v2':
    raise RuntimeError('导出需要包含 pivot-hysteresis-v2 的 Python 引擎；请通过 --engine 指定新版 engine 目录。')

def export_data(client):
    assets=client.get_items('assets',params={'limit':-1,'fields':'id,symbol,name,active'})
    names={str(a['id']):a['symbol'] for a in assets}
    def asset_id(value):return str(value.get('id')) if isinstance(value,dict) else str(value)
    valuations=client.get_items('valuation_history',params={'limit':-1,'sort':'valuation_date,revision',
        'fields':'id,asset,valuation_date,s_tech,status,is_current,revision,notes,observed_at,source_timestamp,source.code,supersedes,price,eps_ttm,eps_ntm,eps_ntm_90d,revenue_ttm,revenue_ntm,g_revenue_2,g_eps_2,fcf_ttm,sbc_ttm,ni_ttm'})
    raw_keys=['price','eps_ttm','eps_ntm','eps_ntm_90d','revenue_ttm','revenue_ntm','g_revenue_2','g_eps_2','fcf_ttm','sbc_ttm','ni_ttm']
    rows=[];notes=[]
    for r in valuations:
        sym=names.get(asset_id(r.get('asset')))
        if not sym:
            notes.append(f'估值记录 {r.get("id")} 无法关联资产，未迁入计算数据。');continue
        source=r.get('source') or {}
        source=source.get('code') if isinstance(source,dict) else str(source)
        # Existing schema does not have a dedicated interpolation field. Preserve
        # source/notes as evidence and flag explicitly labelled estimates.
        evidence=str(r.get('notes') or '').lower()
        # EPS 90-day interpolation is an input derivation, not evidence that the
        # entire monthly score was filled. Only explicit score labels are used.
        inferred=bool(re.search(r'interpolat|插值',str(source or '').lower()) or
            re.search(r'(?:s_tech|score|评分|估值)\s*(?:linear|线性)?\s*(?:interpolat\w*|插值)',evidence))
        rows.append({'id':f'directus-valuation-{r["id"]}','symbol':sym,'valuation_date':r['valuation_date'],
            's_tech':float(r['s_tech']) if r.get('s_tech') is not None else None,'status':r.get('status') or 'na',
            'source_code':source or 'legacy-directus','notes':r.get('notes') or '',
            'interpolated':inferred,'provenance':'source-interpolated' if inferred else 'legacy-unknown',
            'is_current':bool(r.get('is_current')), 'revision':int(r.get('revision') or 1),
            'observed_at':r.get('observed_at'),'source_timestamp':r.get('source_timestamp'),
            'supersedes':f'directus-valuation-{r["supersedes"]}' if r.get('supersedes') else None,
            'raw_inputs':{k:float(r[k]) if r.get(k) is not None else None for k in raw_keys},'derived_result':None})
    notes.append('来源或备注明确标注评分插值的记录已标记为来源插值；单纯 EPS 90 天输入插值不当作评分插值。其余旧记录标记为来源待核实，保留来源和备注，不宣称为原始观测。')
    snapshots=client.get_items('account_snapshots',params={'filter[is_current][_eq]':'true','sort':'-snapshot_time,-id','limit':1,
        'fields':'id,snapshot_time,currency,stock_value_a,financing_b,equity_e,raw_payload'})
    account={'currency':'EUR','financing':0,'updatedAt':None};holdings=[]
    if snapshots:
        snap=snapshots[0];currency=snap.get('currency') or 'EUR'
        if len(currency)!=3:raise RuntimeError('旧账户缺少三位基础币种，请先明确币种再迁移。')
        raw=snap.get('raw_payload') or {}
        if isinstance(raw,str):raw=json.loads(raw)
        ledger=raw.get('currency_ledger') or {}
        positions=client.get_items('positions',params={'filter[account_snapshot][_eq]':snap['id'],'limit':-1,
            'fields':'id,asset.symbol,quantity,market_value,sec_type,currency'})
        for p in positions:
            asset=p.get('asset') or {};sym=asset.get('symbol') if isinstance(asset,dict) else names.get(str(asset))
            if not sym:raise RuntimeError(f'持仓 {p.get("id")} 缺少标的，未生成不完整账户。')
            qty=float(p.get('quantity') or 0);mv=p.get('market_value')
            if mv is None or qty<0:raise RuntimeError(f'{sym} 市值缺失或为空头，不能映射到当前手动账户模型。')
            original_currency=p.get('currency')
            if not original_currency:raise RuntimeError(f'{sym} 缺少持仓市值币种，不能默认为基础币种。')
            rate=1 if original_currency in [currency,'BASE'] else (ledger.get(original_currency) or {}).get('ExchangeRate')
            if rate is None or not math.isfinite(float(rate)) or float(rate)<=0:
                raise RuntimeError(f'{sym} 缺少同一账户快照的 {original_currency}→{currency} 汇率；请先确认基础币种市值，不能猜测换汇。')
            converted=float(mv)*float(rate)
            holdings.append({'id':f'directus-position-{p["id"]}','symbol':sym,'quantity':qty,'market_value':converted,
                'sec_type':p.get('sec_type') or 'STK','currency':currency,'source_currency':original_currency,
                'source_market_value':float(mv),'conversion_rate':float(rate),'conversion_snapshot_time':snap.get('snapshot_time')})
            if original_currency!=currency:
                notes.append(f'{sym} 市值已按快照 {snap["id"]} 的 ExchangeRate={rate} 从 {original_currency} 换算为 {currency}；保留原币种市值与汇率作为来源证据。')
        a=sum(p['market_value'] for p in holdings);equity=float(snap['equity_e'])
        account={'currency':currency,'financing':a-equity,'updatedAt':snap.get('snapshot_time')}
        notes.append(f'迁自账户快照 {snap["id"]}；旧 A={snap.get("stock_value_a")}、旧 B={snap.get("financing_b")}、E={equity}。新 A 取持仓市值合计 {a}，B=A−E，保留净值；请核对手动账户。')
    runs=client.get_items('strategy_runs',params={'limit':-1,'sort':'run_time,id',
        'fields':'id,asset,x,z,entered,entry_pending,controller_direction,controller_alpha,controller_beta,pending_target,current_target,strategy_config,strategy_engine_hash,signal_month,effective_date,event_type,run_time'})
    events=[];archived=[]
    def archive(run,sym):
        archived.append({'id':f'directus-run-{run["id"]}','symbol':sym,'source_run':run})
    for run in runs:
        sym=names.get(asset_id(run.get('asset')));cfg=run.get('strategy_config')
        if isinstance(cfg,str):
            try:cfg=json.loads(cfg)
            except ValueError:cfg=None
        if not sym or not isinstance(cfg,dict) or any(cfg.get(k)!=v for k,v in asdict(CFG).items()):
            archive(run,sym);continue
        pivot=cfg.get('controller_pivot') or {}
        initialized=bool(run.get('entered') or run.get('entry_pending') or run.get('z') is not None)
        try:
            valid_pivot=isinstance(pivot,dict) and all(pivot.get(k) is not None and math.isfinite(float(pivot[k])) and 0<=float(pivot[k])<=1 for k in ['x','z'])
        except (TypeError,ValueError):valid_pivot=False
        if initialized and not valid_pivot:
            archive(run,sym);continue
        if not isinstance(pivot,dict):
            archive(run,sym);continue
        month=str(run.get('signal_month') or '')
        try:
            if len(month)!=7:raise ValueError('invalid month')
            year,mon=map(int,month.split('-'));signal=f'{month}-{calendar.monthrange(year,mon)[1]:02d}'
        except (TypeError,ValueError):
            archive(run,sym);continue
        n=lambda key:float(run[key]) if run.get(key) is not None else None
        state={'initialized':initialized,
            'entered':bool(run.get('entered')),'entry_pending':bool(run.get('entry_pending')),'z':n('z'),'previous_x':n('x'),
            'direction':run.get('controller_direction') or 'flat','alpha':n('controller_alpha') if n('controller_alpha') is not None else 1,
            'beta':n('controller_beta') if n('controller_beta') is not None else 1,
            'pivot_x':float(pivot['x']) if pivot.get('x') is not None else None,
            'pivot_z':float(pivot['z']) if pivot.get('z') is not None else None,
            'pending_target':n('pending_target'),'current_target':n('current_target')}
        events.append({'id':f'directus-run-{run["id"]}','symbol':sym,'event_type':run['event_type'] if run.get('event_type') in ['month_end','activate'] else 'migration',
            'signal_date':signal,'effective_date':str(run['effective_date'])[:10] if run.get('effective_date') else None,
            'createdAt':run.get('run_time'),'x':n('x'),'config':cfg,'state':state,'source_engine_hash':run.get('strategy_engine_hash')})
    if archived:notes.append(f'{len(archived)} 条旧版或不兼容策略事件完整归档到 legacyFormalEvents，也仍保留在旧数据库；不能作为新版状态或 pending target 使用。')
    disabled=[a['symbol'] for a in assets if not a.get('active')]
    if disabled:notes.append('旧系统中未启用的标的也保留了历史；新版由手动持仓确定计算范围：'+', '.join(disabled))
    stamp=datetime.now(timezone.utc).isoformat()
    return {'schemaVersion':3,'algorithm':ALGORITHM_ID,'referenceCurrency':currency if account else 'USD',
        'account':account,'holdings':holdings,'valuations':rows,'formalEvents':events,'legacyFormalEvents':archived,
        'migrationNotes':notes,'updatedAt':stamp,'exportedAt':stamp}

def main():
    output=args.output or Path(__file__).resolve().parents[1]/'private-exports'/('legacy-migration-'+datetime.now().strftime('%Y%m%d-%H%M%S')+'.json')
    output=output.resolve()
    app=Path(__file__).resolve().parents[1]
    if any(output.is_relative_to(app/p) for p in ['public','src','dist','.github','tests']):raise RuntimeError('迁移文件必须留在发布/源码/测试目录之外。')
    client=DirectusClient(DirectusConfig.discover(args.env));client.login();data=export_data(client)
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('x',encoding='utf-8') as handle:json.dump(data,handle,ensure_ascii=False,indent=2)
    print(json.dumps({'output':str(output),'valuations':len(data['valuations']),'holdings':len(data['holdings']),
        'formal_events':len(data['formalEvents']),'migration_notes':len(data['migrationNotes'])},ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except Exception as exc:
        print(f'迁移导出未完成：{exc}',file=sys.stderr)
        sys.exit(1)
