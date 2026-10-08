"""One-time read-only export of public valuations and prices. No account reads."""
import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ALGORITHM_ID = 'finite-rational-pivot-v2-60-rho0.9'
RAW_KEYS = ['price', 'eps_ttm', 'eps_ntm', 'eps_ntm_90d', 'revenue_ttm',
            'revenue_ntm', 'g_revenue_2', 'g_eps_2', 'fcf_ttm', 'sbc_ttm', 'ni_ttm']

def export_data(client):
    assets = client.get_items('assets', params={'limit': -1, 'fields': 'id,symbol,name,currency'})
    names = {str(a['id']): a for a in assets}
    fields = ['id', 'asset', 'valuation_date', 's_tech', 'status', 'is_current',
              'revision', 'notes', 'observed_at', 'source_timestamp', 'source.code', 'supersedes', *RAW_KEYS]
    valuations = client.get_items('valuation_history', params={
        'limit': -1, 'sort': 'valuation_date,revision', 'fields': ','.join(fields)})
    rows, prices = [], {}
    for row in valuations:
        value = row.get('asset')
        asset_id = str(value.get('id')) if isinstance(value, dict) else str(value)
        asset = names.get(asset_id)
        if not asset:
            raise RuntimeError(f'估值记录 {row.get("id")} 缺少标的；导出停止。')
        sym = asset['symbol']
        source = row.get('source') or {}
        source = source.get('code') if isinstance(source, dict) else str(source)
        evidence = str(row.get('notes') or '').lower()
        inferred = bool(re.search(r'interpolat|插值', str(source or '').lower()) or
                        re.search(r'(?:s_tech|score|评分|估值)\s*(?:linear|线性)?\s*(?:interpolat\w*|插值)', evidence))
        rows.append({
            'id': f'legacy-valuation-{row["id"]}', 'symbol': sym,
            'valuation_date': row['valuation_date'],
            's_tech': float(row['s_tech']) if row.get('s_tech') is not None else None,
            'status': row.get('status') or 'na', 'is_current': bool(row.get('is_current')),
            'revision': int(row.get('revision') or 1), 'score_method': 'manual',
            'source_code': source or 'legacy-import', 'notes': row.get('notes') or '',
            'interpolated': inferred, 'provenance': 'source-interpolated' if inferred else 'legacy-unknown',
            'observed_at': row.get('observed_at'), 'source_timestamp': row.get('source_timestamp'),
            'supersedes': f'legacy-valuation-{row["supersedes"]}' if row.get('supersedes') else None,
            'raw_inputs': {key: float(row[key]) if row.get(key) is not None else None for key in RAW_KEYS}
        })
        price = row.get('price')
        if row.get('is_current') and price is not None and math.isfinite(float(price)) and float(price) > 0:
            currency = asset.get('currency')
            if not currency:
                raise RuntimeError(f'{sym} 的价格没有币种，不能猜测。')
            prices[(sym, row['valuation_date'])] = {
                'symbol': sym, 'as_of': row['valuation_date'], 'price': float(price), 'currency': currency,
                'source_name': source or 'legacy-import', 'source_url': '',
                'notes': '迁自对应日期估值的 price 输入；并非实时价格。'
            }
    return {
        'schemaVersion': 4, 'algorithm': ALGORITHM_ID, 'valuations': rows,
        'prices': list(prices.values()), 'fxRates': {}, 'formalEvents': [],
        'updatedAt': datetime.now(timezone.utc).isoformat()
    }

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=Path(r'C:\strategy-directus\engine'))
    parser.add_argument('--env', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.engine.resolve()))
    from directus_client import DirectusClient, DirectusConfig
    client = DirectusClient(DirectusConfig.discover(args.env))
    client.login()
    data = export_data(client)
    output = args.output or Path(__file__).resolve().parents[1] / 'private-exports' / 'public-market-data.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    print(json.dumps({'output': str(output), 'valuations': len(data['valuations']), 'prices': len(data['prices']),
                      'collections_read': ['assets', 'valuation_history']}, ensure_ascii=False))

if __name__ == '__main__':
    main()
