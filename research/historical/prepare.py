"""Normalize existing caches without downloading or altering source files."""
import csv
import hashlib
import json
import math
from datetime import date, datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
OLD = Path(r'C:\Users\jun\Documents\Codex\2026-09-09\referenced-chatgpt-conversation-this-is-an')
QQQ = Path(r'C:\Users\jun\Documents\Codex\2026-09-10\new-chat\outputs\qqq-candidates\qqq_prices.csv')
RAW = OLD / 'work/nvda-goog-msft-validation/raw'
VAL = OLD / 'outputs/nvda-goog-msft-validation'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def yahoo(path):
    result = json.loads(path.read_text(encoding='utf-8'))['chart']['result'][0]
    q = result['indicators']['quote'][0]
    ac = result['indicators']['adjclose'][0]['adjclose']
    rows = []
    for i, timestamp in enumerate(result['timestamp']):
        values = [q[k][i] for k in ('open', 'close', 'high', 'low')] + [ac[i]]
        if any(x is None for x in values):
            raise ValueError(f'Missing quote in {path} at row {i}')
        op, close, high, low, adjclose = values
        factor = adjclose / close
        rows.append({'date': datetime.fromtimestamp(timestamp, timezone.utc).date().isoformat(),
                     'open': op * factor, 'close': adjclose, 'high': high * factor, 'low': low * factor})
    return rows


data, audits = {}, {}
for ticker in ('QQQ', 'SMH', 'NVDA', 'GOOG', 'MSFT'):
    if ticker == 'QQQ':
        source = QQQ
        with source.open(encoding='utf-8-sig', newline='') as f:
            rows = [{'date': r['date'], **{k: float(r['adj_' + k]) for k in ('open', 'close', 'high', 'low')}}
                    for r in csv.DictReader(f)]
    else:
        source = OLD / 'work/smh_chart_yahoo.json' if ticker == 'SMH' else RAW / f'{ticker}_prices.json'
        rows = yahoo(source)
    assert rows and len({r['date'] for r in rows}) == len(rows)
    assert all(rows[i]['date'] < rows[i + 1]['date'] for i in range(len(rows) - 1))
    ohlc_errors = []
    for row in rows:
        assert all(math.isfinite(row[k]) and row[k] > 0 for k in ('open', 'close', 'high', 'low'))
        if row['low'] > min(row['open'], row['close']) * (1 + 1e-5) or row['high'] < max(row['open'], row['close']) * (1 - 1e-5):
            ohlc_errors.append(row['date'])
    assert not ohlc_errors, (ticker, ohlc_errors)
    returns = [rows[i]['close'] / rows[i - 1]['close'] - 1 for i in range(1, len(rows))]
    data[ticker] = rows
    audits[ticker] = {'source_path': str(source), 'source_sha256': sha(source), 'rows': len(rows),
                      'start': rows[0]['date'], 'end': rows[-1]['date'], 'duplicate_dates': 0,
                      'missing_or_nonpositive_prices': 0, 'ohlc_errors': ohlc_errors,
                      'largest_close_return': max(returns), 'smallest_close_return': min(returns),
                      'abs_close_returns_above_50pct': sum(abs(r) > .5 for r in returns)}

# Verify the exact QQQ exported cache identified in its previous manifest.
assert audits['QQQ']['source_sha256'] == 'f90b0c2fc0d21a8cb649df182c89e3bd1d5293310f9c92212c9982deaac133a8'

fundamentals, legacy_entries = {}, {}
for ticker in ('NVDA', 'GOOG', 'MSFT'):
    qp, sp = VAL / f'{ticker}_quarterly_eps_point_in_time.csv', VAL / f'{ticker}_valuation_signals.csv'
    with qp.open(encoding='utf-8-sig', newline='') as f:
        quarters = list(csv.DictReader(f))
    with sp.open(encoding='utf-8-sig', newline='') as f:
        signals = list(csv.DictReader(f))
    gaps = []
    for prior, current in zip(quarters, quarters[1:]):
        gap = (date.fromisoformat(current['period_end']) - date.fromisoformat(prior['period_end'])).days
        if gap > 125:
            gaps.append({'period_end': current['period_end'], 'days_since_previous_record': gap})
    future_count = sum(r['latest_eps_filing'] > r['month_end'] for r in signals)
    ages = [(date.fromisoformat(r['month_end']) - date.fromisoformat(r['ttm_period_end'])).days for r in signals]
    first = next(r for r in signals if 1 - float(r['x']) < .3)
    effective = first['effective_date']
    actual = next(r['date'] for r in data[ticker] if r['date'] >= effective)
    legacy_entries[ticker] = {'signal_date': first['month_end'], 'execution_date': actual,
                              'expensive_percentile_proxy': 1 - float(first['x']),
                              'status': 'legacy PE proxy, not verified consecutive-quarter TTM'}
    fundamentals[ticker] = {'quarter_file_sha256': sha(qp), 'signal_file_sha256': sha(sp),
                            'quarter_records': len(quarters), 'quarter_gaps_over_125_days': gaps,
                            'maximum_report_period_age_days': max(ages),
                            'future_filing_signal_count': future_count,
                            'cached_x_convention': 'cheapness percentile; expensive percentile = 1 - x'}

(HERE / 'prices.json').write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
audit = {'price_sources': audits, 'fundamental_cache_audit': fundamentals, 'legacy_proxy_entries': legacy_entries,
         'normalized_prices_sha256': sha(HERE / 'prices.json'),
         'candidate_spec_sha256': sha(HERE.parent / 'candidates.json'),
         'protocol_sha256': sha(HERE / 'protocol.json'),
         'fresh_downloads': False, 'source_files_modified': False}
(HERE / 'data-audit.json').write_text(json.dumps(audit, indent=2, ensure_ascii=False), encoding='utf-8')
print(json.dumps({t: {k: audits[t][k] for k in ('rows', 'start', 'end')} for t in audits}, indent=2))
print('Legacy proxy entry dates:', {t: d['execution_date'] for t, d in legacy_entries.items()})
