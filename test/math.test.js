'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_STATE } = require('../src/defaultData');
const { evaluateState, computeOptionCost } = require('../public/js/calc');
const { buildExcelWorkbook } = require('../src/excelExporter');

test('Baseline DND Auto Body Quote #31065854 exact totals match PDF', () => {
  const result = evaluateState(DEFAULT_STATE);
  const s = result.summary;

  // All 16 replaceable items (13 OEM parts + 2 tires + mount/balance) = $6,988.48 pre-tax
  assert.equal(s.replaceableCount, 16);
  assert.equal(s.oemPartsPreTax, 6988.48);
  assert.equal(s.oemPartsTax, 462.99);
  assert.equal(s.oemPartsTotal, 7451.47);

  // Fixed Labor ($4,459.59) + Paint Materials ($552.32) = $5,011.91
  assert.equal(s.baseLaborTotal, 4459.59);
  assert.equal(s.basePaintTotal, 552.32);
  assert.equal(s.baseFixedShopTotal, 5011.91);

  // Grand total = $12,463.38
  assert.equal(s.originalEstimateGrandTotal, 12463.38);
  assert.equal(s.projectedGrandTotal, 12463.38);
  assert.equal(s.totalProjectedSavings, 0);
});

test('Toggling off Tires and Labor/Paint isolates the 13 OEM Car Parts ($6,038.48 pre-tax)', () => {
  const customState = JSON.parse(JSON.stringify(DEFAULT_STATE));
  customState.settings.includeTiresInTotals = false;
  customState.settings.includeLaborAndPaint = false;

  const result = evaluateState(customState);
  const s = result.summary;

  assert.equal(s.replaceableCount, 13); // 13 OEM parts (excl 3 tire lines: 36, 37, 38)
  assert.equal(s.oemPartsPreTax, 6038.48);
  assert.equal(s.oemPartsTax, 400.05);
  assert.equal(s.oemPartsTotal, 6438.53);
  assert.equal(s.originalEstimateGrandTotal, 6438.53);
});

test('Proportional Bundle Allocation divides used price, shipping & tax by exact OEM % weights', () => {
  const state = JSON.parse(JSON.stringify(DEFAULT_STATE));

  // Create a bundle for Right Rear Suspension (Lines 16, 17, 18, 19)
  // OEM Pre-Tax: #16 ($204.93) + #17 ($156.06) + #18 ($211.73) + #19 ($887.11) = $1,459.83
  const bundleId = 'bnd-rear-susp';
  state.bundles.push({
    id: bundleId,
    name: 'Right Rear Suspension Knee Assembly',
    lineNumbers: [16, 17, 18, 19],
    activeOptionId: 'opt-1',
    options: [
      {
        id: 'opt-1',
        vendor: 'eBay - C7Parts',
        price: 500.00,
        shipping: 100.00,
        taxMode: 'none',
        manualTax: 0,
        status: 'Ordered'
      }
    ]
  });

  [16, 17, 18, 19].forEach((ln) => {
    const item = state.lineItems.find((l) => l.lineNumber === ln);
    item.sourcingMode = 'bundle';
    item.activeBundleId = bundleId;
  });

  const evaluated = evaluateState(state);
  const b = evaluated.evaluatedBundles[0];

  assert.equal(b.oemBundlePreTax, 1459.83);
  assert.equal(b.activeOption.computed.total, 600.00);

  // Check proportional weights (~14.04%, ~10.69%, ~14.50%, ~60.77%)
  const alloc16 = b.memberAllocations[16];
  const alloc19 = b.memberAllocations[19];

  assert.equal(alloc16.weightPct, 14.04);
  assert.equal(alloc19.weightPct, 60.77);

  // Sum of allocated totals is close to $600.00
  const allocSum =
    b.memberAllocations[16].allocatedTotal +
    b.memberAllocations[17].allocatedTotal +
    b.memberAllocations[18].allocatedTotal +
    b.memberAllocations[19].allocatedTotal;

  assert.ok(Math.abs(allocSum - 600.0) <= 0.02);
  assert.equal(evaluated.summary.sourcedCount, 4);
});

test('Excel workbook generator produces valid 4-sheet .xlsx buffer with live formulas', async () => {
  const wb = await buildExcelWorkbook(DEFAULT_STATE);
  assert.equal(wb.worksheets.length, 4);
  const buffer = await wb.xlsx.writeBuffer();
  assert.ok(buffer.byteLength > 5000);
});
