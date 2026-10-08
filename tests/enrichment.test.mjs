import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyData,
  normalizeValuation,
  normalizeHolding,
  normalizeQuote,
  normalizeFxRate,
  normalizeJob,
  validateBackup,
  mergeValuations,
  monthEnd
} from '../src/model.js';
import {
  calculatePortfolio,
  aggregateWeightedResults,
  getFxRate,
  buildMonthlyScores,
  computePreview
} from '../src/preview.js';
import { computeTechValuation, INPUT_FIELDS } from '../src/valuation.js';
import { checkAgyConfig, enforceCostProtection, enrichHistoricalValuations, startServer, getHelperToken, parseJsonFromAgyResponse } from '../scripts/helper.mjs';

// Helper to generate 60-month history for a symbol
const generateHistory = (symbol, baseScore = 50, trend = 0.5) => {
  return Array.from({ length: 60 }, (_, i) => {
    const y = 2020 + Math.floor(i / 12);
    const m = (i % 12) + 1;
    const date = monthEnd(`${y}-${String(m).padStart(2, '0')}`);
    return normalizeValuation({
      id: `${symbol}-${i}`,
      symbol,
      valuation_date: date,
      s_tech: baseScore + i * trend,
      source_code: 'synthetic-test',
      status: 'valid'
    });
  });
};

// ---------------------------------------------------------
// Acceptance Criteria 12.A: Weights & Strategy
// ---------------------------------------------------------

test('12.A.1: Market value mode: AAA=300, BBB=100 -> weights 75%, 25%, leverage 1.3x', () => {
  // Test via aggregateWeightedResults directly
  const rows = [
    { market_value: 300, percentile: 0.2, target_leverage: 1.2 },
    { market_value: 100, percentile: 0.8, target_leverage: 1.6 }
  ];
  const agg = aggregateWeightedResults(rows);
  assert.equal(agg.market_value, 400);
  assert.equal(agg.percentile, 0.75 * 0.2 + 0.25 * 0.8);
  assert.ok(Math.abs(agg.target_leverage - 1.3) < 1e-9);

  // Test via calculatePortfolio with mock valuation histories
  const hAAA = generateHistory('AAA', 20, 0.5); // 60 months
  const hBBB = generateHistory('BBB', 30, 0.2); // 60 months
  const valuations = [...hAAA, ...hBBB];
  const holdings = [
    { id: '1', symbol: 'AAA', market_value: 300, input_mode: 'market_value', currency: 'USD' },
    { id: '2', symbol: 'BBB', market_value: 100, input_mode: 'market_value', currency: 'USD' }
  ];

  const res = calculatePortfolio(holdings, valuations, '2025-01-01');
  assert.equal(res.status, 'ready');
  assert.equal(res.positions[0].symbol, 'AAA');
  assert.equal(res.positions[0].holding_weight, 0.75);
  assert.equal(res.positions[1].symbol, 'BBB');
  assert.equal(res.positions[1].holding_weight, 0.25);

  const expectedL = 0.75 * res.positions[0].target_leverage + 0.25 * res.positions[1].target_leverage;
  assert.ok(Math.abs(res.target_leverage - expectedL) < 1e-9);
});

test('12.A.2: Shares mode with quotes: AAA 10 shares @ 30, BBB 5 shares @ 20 -> same weights 75%, 25%', () => {
  const hAAA = generateHistory('AAA', 20, 0.5);
  const hBBB = generateHistory('BBB', 30, 0.2);
  const valuations = [...hAAA, ...hBBB];

  const holdings = [
    { id: '1', symbol: 'AAA', quantity: 10, input_mode: 'shares', currency: 'USD' },
    { id: '2', symbol: 'BBB', quantity: 5, input_mode: 'shares', currency: 'USD' }
  ];
  const quotes = {
    AAA: { symbol: 'AAA', price: 30, currency: 'USD' },
    BBB: { symbol: 'BBB', price: 20, currency: 'USD' }
  };

  const res = calculatePortfolio(holdings, valuations, '2025-01-01', { quotes });
  assert.equal(res.status, 'ready');
  assert.equal(res.positions[0].holding_weight, 0.75);
  assert.equal(res.positions[1].holding_weight, 0.25);
  assert.equal(res.positions[0].market_value, 300);
  assert.equal(res.positions[1].market_value, 100);
});

test('12.A.3: Proportional invariance: scaling all market values preserves weights and leverage', () => {
  const hAAA = generateHistory('AAA', 20, 0.5);
  const hBBB = generateHistory('BBB', 30, 0.2);
  const valuations = [...hAAA, ...hBBB];

  const baseHoldings = [
    { id: '1', symbol: 'AAA', market_value: 300, input_mode: 'market_value', currency: 'USD' },
    { id: '2', symbol: 'BBB', market_value: 100, input_mode: 'market_value', currency: 'USD' }
  ];
  const res1 = calculatePortfolio(baseHoldings, valuations, '2025-01-01');

  // Scale 2x
  const scaled2x = [
    { id: '1', symbol: 'AAA', market_value: 600, input_mode: 'market_value', currency: 'USD' },
    { id: '2', symbol: 'BBB', market_value: 200, input_mode: 'market_value', currency: 'USD' }
  ];
  const res2 = calculatePortfolio(scaled2x, valuations, '2025-01-01');

  // Scale 10x
  const scaled10x = [
    { id: '1', symbol: 'AAA', market_value: 3000, input_mode: 'market_value', currency: 'USD' },
    { id: '2', symbol: 'BBB', market_value: 1000, input_mode: 'market_value', currency: 'USD' }
  ];
  const res3 = calculatePortfolio(scaled10x, valuations, '2025-01-01');

  assert.equal(res1.status, 'ready');
  assert.equal(res2.status, 'ready');
  assert.equal(res3.status, 'ready');
  assert.equal(res1.target_leverage, res2.target_leverage);
  assert.equal(res1.target_leverage, res3.target_leverage);
  assert.equal(res1.positions[0].holding_weight, res2.positions[0].holding_weight);
  assert.equal(res1.positions[0].holding_weight, res3.positions[0].holding_weight);
});

test('12.A.4: Multi-currency FX conversion & blocking on missing fx/quote/valuation', () => {
  const fxRates = {
    'EUR/USD': { pair: 'EUR/USD', rate: 1.2 }
  };
  assert.equal(getFxRate('USD', 'USD', fxRates), 1.0);
  assert.equal(getFxRate('EUR', 'USD', fxRates), 1.2);
  assert.ok(Math.abs(getFxRate('USD', 'EUR', fxRates) - (1 / 1.2)) < 1e-9);
  assert.equal(getFxRate('GBP', 'USD', fxRates), null);

  const hAAA = generateHistory('AAA', 20, 0.5);
  const hBBB = generateHistory('BBB', 30, 0.2);
  const valuations = [...hAAA, ...hBBB];

  // AAA in USD (300), BBB in EUR (100) -> BBB converted to 120 USD. Total = 420 USD.
  const multiCurrHoldings = [
    { id: '1', symbol: 'AAA', market_value: 300, currency: 'USD', input_mode: 'market_value' },
    { id: '2', symbol: 'BBB', market_value: 100, currency: 'EUR', input_mode: 'market_value' }
  ];
  const res = calculatePortfolio(multiCurrHoldings, valuations, '2025-01-01', { fxRates, referenceCurrency: 'USD' });
  assert.equal(res.status, 'ready');
  assert.ok(Math.abs(res.positions[0].holding_weight - (300 / 420)) < 1e-9);
  assert.ok(Math.abs(res.positions[1].holding_weight - (120 / 420)) < 1e-9);

  // Missing FX rate blocks entire portfolio without silently omitting BBB
  const resMissingFx = calculatePortfolio(multiCurrHoldings, valuations, '2025-01-01', { fxRates: {}, referenceCurrency: 'USD' });
  assert.equal(resMissingFx.status, 'blocked');
  assert.equal(resMissingFx.target_leverage, null);
  assert.ok(resMissingFx.message.includes('缺少 EUR 到 USD 的换汇汇率'));

  // Missing quote in shares mode blocks entire portfolio
  const sharesHoldings = [
    { id: '1', symbol: 'AAA', market_value: 300, currency: 'USD', input_mode: 'market_value' },
    { id: '2', symbol: 'BBB', quantity: 10, currency: 'USD', input_mode: 'shares' }
  ];
  const resMissingQuote = calculatePortfolio(sharesHoldings, valuations, '2025-01-01', { quotes: {} });
  assert.equal(resMissingQuote.status, 'blocked');
  assert.ok(resMissingQuote.message.includes('缺少 BBB 的有效最新报价'));

  // Missing valuation history blocks entire portfolio
  const resMissingHistory = calculatePortfolio(multiCurrHoldings, hAAA /* BBB has no valuations */, '2025-01-01', { fxRates });
  assert.equal(resMissingHistory.status, 'blocked');
  assert.ok(resMissingHistory.message.includes('BBB'));
});

test('12.A.5: Separate path-dependent controllers for each symbol before weighted aggregation', () => {
  // Symbol AAA has an increasing score trend (valuation becoming higher/cheaper)
  // Symbol BBB has a fluctuating or different trend
  const hAAA = generateHistory('AAA', 30, 0.4);
  const hBBB = generateHistory('BBB', 60, -0.3);
  const valuations = [...hAAA, ...hBBB];

  const holdings = [
    { id: '1', symbol: 'AAA', market_value: 300, currency: 'USD', input_mode: 'market_value' },
    { id: '2', symbol: 'BBB', market_value: 100, currency: 'USD', input_mode: 'market_value' }
  ];

  const res = calculatePortfolio(holdings, valuations, '2025-01-01');
  assert.equal(res.status, 'ready');

  // Verify that individual controllers evaluated independently
  const { coverage: covA, scores: sA } = buildMonthlyScores(hAAA, { symbol: 'AAA', asOf: '2025-01-01' });
  const { coverage: covB, scores: sB } = buildMonthlyScores(hBBB, { symbol: 'BBB', asOf: '2025-01-01' });
  const pA = computePreview(covA, sA);
  const pB = computePreview(covB, sB);

  assert.equal(res.positions[0].target_leverage, pA.latest.target_leverage);
  assert.equal(res.positions[1].target_leverage, pB.latest.target_leverage);
  assert.notEqual(pA.latest.target_leverage, pB.latest.target_leverage);

  const weightedTarget = 0.75 * pA.latest.target_leverage + 0.25 * pB.latest.target_leverage;
  assert.ok(Math.abs(res.target_leverage - weightedTarget) < 1e-9);
});

// ---------------------------------------------------------
// Acceptance Criteria 12.B: Auto Enrichment & Truthfulness
// ---------------------------------------------------------

test('12.B.6 & 12.B.9: Formula calculation and rejection of incomplete inputs', () => {
  const completeInputs = {
    price: 150,
    eps_ttm: 5,
    eps_ntm: 6.5,
    eps_ntm_90d: 6.0,
    revenue_ttm: 1000,
    revenue_ntm: 1200,
    g_revenue_2: 0.15,
    g_eps_2: 0.18,
    fcf_ttm: 120,
    sbc_ttm: 20,
    ni_ttm: 100
  };

  const val = computeTechValuation(completeInputs);
  assert.equal(val.status, 'valid');
  assert.ok(Number.isFinite(val.s_tech));
  assert.ok(val.s_tech > 0);

  // Incomplete inputs (e.g. missing eps_ntm_90d) throws an error
  const incomplete = { ...completeInputs, eps_ntm_90d: null };
  assert.throws(() => computeTechValuation(incomplete), /eps_ntm_90d 必须是有限数值/);

  // Negative eps_ntm (PE_F <= 0) returns na
  const negPe = { ...completeInputs, eps_ntm: -1 };
  const valNeg = computeTechValuation(negPe);
  assert.equal(valNeg.status, 'na');
});

test('12.B.7 & 12.B.8: Enrichment evidence preservation and schema roundtrip', () => {
  const recordWithEvidence = normalizeValuation({
    symbol: 'NVDA',
    valuation_date: '2024-12-31',
    s_tech: 45.2,
    source_code: 'agy-auto-enrichment',
    source_institution: 'SEC EDGAR',
    as_of_period: 'Q3-2024',
    evidence_summary: '10-Q filing dated Nov 20, 2024; Bloomberg consensus consensus 90d',
    source_url: 'https://sec.gov/edgar/data/nvda-10q',
    retrieved_at: '2026-10-08T12:00:00Z',
    status: 'valid'
  });

  assert.equal(recordWithEvidence.source_institution, 'SEC EDGAR');
  assert.equal(recordWithEvidence.as_of_period, 'Q3-2024');
  assert.equal(recordWithEvidence.evidence_summary, '10-Q filing dated Nov 20, 2024; Bloomberg consensus consensus 90d');
  assert.equal(recordWithEvidence.retrieved_at, '2026-10-08T12:00:00Z');

  // Verify backup export/restore roundtrip preserves all evidence fields
  const backup = {
    schemaVersion: 2,
    algorithm: 'finite-rational-60-rho0.9',
    referenceCurrency: 'USD',
    holdings: [
      { id: 'h1', symbol: 'NVDA', market_value: 500, input_mode: 'market_value', currency: 'USD' }
    ],
    valuations: [recordWithEvidence],
    quotes: {
      NVDA: { symbol: 'NVDA', price: 125.5, currency: 'USD', as_of: '2026-10-08' }
    },
    fxRates: {},
    enrichmentJobs: [
      { id: 'j1', symbol: 'NVDA', status: 'completed', missing_months: [] }
    ],
    formalEvents: []
  };

  const restored = validateBackup(backup);
  assert.equal(restored.valuations[0].source_institution, 'SEC EDGAR');
  assert.equal(restored.valuations[0].evidence_summary, recordWithEvidence.evidence_summary);
  assert.equal(restored.valuations[0].source_url, 'https://sec.gov/edgar/data/nvda-10q');
  assert.equal(restored.quotes.NVDA.price, 125.5);
  assert.equal(restored.enrichmentJobs[0].id, 'j1');
});

// ---------------------------------------------------------
// Acceptance Criteria 12.C: Cost, Runtime & Migration
// ---------------------------------------------------------

test('12.C.10: Cost protection enforces useG1Credits: false', () => {
  enforceCostProtection();
  const configBefore = checkAgyConfig();
  assert.equal(configBefore.useG1Credits, false);
  assert.equal(configBefore.costProtectionActive, true);
  assert.equal(configBefore.permissionsOk, true);

  enforceCostProtection();
  const configAfter = checkAgyConfig();
  assert.equal(configAfter.useG1Credits, false);
  assert.equal(configAfter.costProtectionActive, true);
  assert.equal(configAfter.permissionsOk, true);
});

test('12.C.12: v1 to schema 3 migration compatibility', () => {
  // Legacy v1 backup structure
  const legacyV1 = {
    schemaVersion: 1,
    algorithm: 'finite-rational-60-rho0.9',
    account: { currency: 'EUR', financing: -500 },
    holdings: [
      { id: 'h1', symbol: 'AAA', quantity: 10, market_value: 1000, sec_type: 'STK', currency: 'EUR' }
    ],
    valuations: generateHistory('AAA', 25, 0.3),
    formalEvents: []
  };

  const migrated = validateBackup(legacyV1);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.referenceCurrency, 'EUR');
  assert.equal(migrated.holdings[0].symbol, 'AAA');
  assert.equal(migrated.holdings[0].market_value, 1000);
  assert.equal(migrated.holdings[0].input_mode, 'market_value');
  assert.equal(migrated.valuations.length, 60);
});

test('12.C.13: Idempotent merge: duplicate results do not create duplicate revisions', () => {
  const d = emptyData();
  const row = normalizeValuation({
    symbol: 'AAA',
    valuation_date: '2025-01-31',
    s_tech: 50,
    source_code: 'agy-auto-enrichment',
    raw_inputs: { price: 100 }
  });

  const m1 = mergeValuations(d, [row]);
  assert.equal(m1.added, 1);
  assert.equal(m1.skipped, 0);
  assert.equal(m1.data.valuations.length, 1);

  // Merging the exact same valuation again skips
  const m2 = mergeValuations(m1.data, [row]);
  assert.equal(m2.added, 0);
  assert.equal(m2.skipped, 1);
  assert.equal(m2.data.valuations.length, 1);

  // Merging an updated valuation creates revision 2, archiving the old one
  const updatedRow = { ...row, s_tech: 52 };
  const m3 = mergeValuations(m1.data, [updatedRow]);
  assert.equal(m3.added, 1);
  assert.equal(m3.skipped, 0);
  assert.equal(m3.data.valuations.length, 2);
  assert.equal(m3.data.valuations[0].is_current, false);
  assert.equal(m3.data.valuations[1].is_current, true);
  assert.equal(m3.data.valuations[1].revision, 2);
});

test('12.A: Direct ratio mode & rejection of mixed ratio/monetary combinations', () => {
  const hAAA = generateHistory('AAA', 20, 0.5);
  const hBBB = generateHistory('BBB', 30, 0.2);
  const valuations = [...hAAA, ...hBBB];

  // Ratio mode: AAA=75, BBB=25 -> normalized weights 75%, 25%
  const ratioHoldings = [
    { id: '1', symbol: 'AAA', ratio: 75, input_mode: 'ratio' },
    { id: '2', symbol: 'BBB', ratio: 25, input_mode: 'ratio' }
  ];
  const res = calculatePortfolio(ratioHoldings, valuations, '2025-01-01');
  assert.equal(res.status, 'ready');
  assert.equal(res.positions[0].holding_weight, 0.75);
  assert.equal(res.positions[1].holding_weight, 0.25);

  // Ratio mode scaled: AAA=150, BBB=50 -> same normalized weights
  const scaledRatio = [
    { id: '1', symbol: 'AAA', ratio: 150, input_mode: 'ratio' },
    { id: '2', symbol: 'BBB', ratio: 50, input_mode: 'ratio' }
  ];
  const resScaled = calculatePortfolio(scaledRatio, valuations, '2025-01-01');
  assert.equal(resScaled.status, 'ready');
  assert.equal(resScaled.positions[0].holding_weight, 0.75);
  assert.equal(resScaled.positions[1].holding_weight, 0.25);

  // Mixing ratio and market_value/shares must block the entire portfolio
  const mixedHoldings = [
    { id: '1', symbol: 'AAA', ratio: 75, input_mode: 'ratio' },
    { id: '2', symbol: 'BBB', market_value: 1000, input_mode: 'market_value', currency: 'USD' }
  ];
  const resMixed = calculatePortfolio(mixedHoldings, valuations, '2025-01-01');
  assert.equal(resMixed.status, 'blocked');
  assert.ok(resMixed.message.includes('不能将无单位比例与货币金额混在同一组合中'));
});

test('12.C.11: Helper server status, auth, origin restriction, and path traversal protection', async () => {
  const testPort = 8798;
  const { server } = await startServer({ port: testPort });

  try {
    // 1. Normal status check (does not leak token)
    const resStatus = await fetch(`http://127.0.0.1:${testPort}/api/status`);
    assert.equal(resStatus.status, 200);
    const dataStatus = await resStatus.json();
    assert.equal(dataStatus.ok, true);
    assert.equal(dataStatus.costProtection, true);
    assert.equal(dataStatus.useG1Credits, false);
    assert.equal(dataStatus.token, undefined); // Token is not leaked

    // 2. Untrusted Origin is rejected with 403 Forbidden
    const resUntrusted = await fetch(`http://127.0.0.1:${testPort}/api/status`, {
      headers: { Origin: 'https://untrusted.example' }
    });
    assert.equal(resUntrusted.status, 403);

    // 3. Mutating request without token is rejected with 401 Unauthorized
    const resNoToken = await fetch(`http://127.0.0.1:${testPort}/api/protect-cost`, { method: 'POST' });
    assert.equal(resNoToken.status, 401);

    // 4. Mutating request with valid token succeeds
    const token = getHelperToken();
    const resProtect = await fetch(`http://127.0.0.1:${testPort}/api/protect-cost`, {
      method: 'POST',
      headers: { 'X-Helper-Token': token }
    });
    assert.equal(resProtect.status, 200);
    const dataProtect = await resProtect.json();
    assert.equal(dataProtect.ok, true);

    // 5. Path traversal protection: drive letter and ../ outside dist must return 403 Forbidden
    const resDriveLetter = await fetch(`http://127.0.0.1:${testPort}/cycle-algorithm/D:/Documents/GitHub/cycle-algorithm/package.json`);
    assert.equal(resDriveLetter.status, 403);

    const resTraversal = await fetch(`http://127.0.0.1:${testPort}/cycle-algorithm/..%2F..%2Fpackage.json`);
    assert.equal(resTraversal.status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Review Issue 1: v2 reload and validation does NOT block on legacy EUR account', () => {
  const base = emptyData();

  // Mode 1: USD market value without account
  const dMv = {
    ...base,
    referenceCurrency: 'USD',
    holdings: [{ id: '1', symbol: 'NVDA', market_value: 15000, input_mode: 'market_value', currency: 'USD' }]
  };
  const validatedMv = validateBackup(dMv);
  assert.equal(validatedMv.referenceCurrency, 'USD');
  assert.equal(validatedMv.holdings[0].symbol, 'NVDA');

  // Mode 2: USD shares without market value
  const dShares = {
    ...base,
    referenceCurrency: 'USD',
    holdings: [{ id: '2', symbol: 'AAPL', quantity: 100, input_mode: 'shares', currency: 'USD' }]
  };
  const validatedShares = validateBackup(dShares);
  assert.equal(validatedShares.holdings[0].symbol, 'AAPL');

  // Mode 3: Ratio mode
  const dRatio = {
    ...base,
    holdings: [{ id: '3', symbol: 'MSFT', ratio: 75, input_mode: 'ratio' }]
  };
  const validatedRatio = validateBackup(dRatio);
  assert.equal(validatedRatio.holdings[0].symbol, 'MSFT');
});

test('Review Issue 3: parseJsonFromAgyResponse correctly parses pure arrays and fenced output', () => {
  // Pure JSON array
  const rawArray = '[{"valuation_date":"2026-09-30","inputs":{"price":100},"source_url":"https://sec.gov"}]';
  const parsedArray = parseJsonFromAgyResponse(rawArray);
  assert.ok(Array.isArray(parsedArray));
  assert.equal(parsedArray.length, 1);
  assert.equal(parsedArray[0].valuation_date, '2026-09-30');

  // Markdown fence array
  const fenced = 'Here are results:\n```json\n[{"valuation_date":"2026-08-31","inputs":{"price":95},"source_url":"https://ir.corp"}]\n```';
  const parsedFenced = parseJsonFromAgyResponse(fenced);
  assert.ok(Array.isArray(parsedFenced));
  assert.equal(parsedFenced[0].valuation_date, '2026-08-31');

  // Markdown fence object
  const fencedObj = '```json\n{"symbol":"AAPL","price":220}\n```';
  const parsedObj = parseJsonFromAgyResponse(fencedObj);
  assert.equal(parsedObj.symbol, 'AAPL');
});

test('Review Issue 8 & 9: Strict evidence requirement and URL retention in normalizeValuation', () => {
  // 1. normalizeValuation retains source_url
  const valWithUrl = normalizeValuation({
    symbol: 'TEST',
    valuation_date: '2025-01-31',
    s_tech: 50,
    source_url: 'https://example.org/report'
  });
  assert.equal(valWithUrl.source_url, 'https://example.org/report');

  // 2. normalizeValuation without source_url sets it to null
  const valWithoutUrl = normalizeValuation({
    symbol: 'TEST',
    valuation_date: '2025-01-31',
    s_tech: 50
  });
  assert.equal(valWithoutUrl.source_url, null);
});



