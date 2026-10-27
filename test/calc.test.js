'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  round2,
  listingCost,
  shopPartCost,
  evaluateCartCost,
  solveOptimalCombination,
  evaluateBundleVerdicts
} = require('../public/js/calc');

test('Calc: listingCost computation with tax & shipping modes', () => {
  // Free shipping + 6.625% tax
  const c1 = listingCost({
    price: 100,
    shippingMode: 'free',
    taxMode: 'rate'
  }, { taxRate: 0.06625 });
  assert.equal(c1.price, 100);
  assert.equal(c1.shipping, 0);
  assert.equal(c1.tax, 6.63);
  assert.equal(c1.total, 106.63);

  // Amount shipping + 6.625% tax on price + shipping
  const c2 = listingCost({
    price: 100,
    shippingMode: 'amount',
    shipping: 20,
    taxMode: 'rate'
  }, { taxRate: 0.06625 });
  assert.equal(c2.price, 100);
  assert.equal(c2.shipping, 20);
  assert.equal(c2.tax, 7.95); // 120 * 0.06625 = 7.95
  assert.equal(c2.total, 127.95);

  // No tax mode
  const c3 = listingCost({
    price: 100,
    shippingMode: 'amount',
    shipping: 10,
    taxMode: 'none'
  });
  assert.equal(c3.tax, 0);
  assert.equal(c3.total, 110);

  // Manual tax mode
  const c4 = listingCost({
    price: 100,
    shippingMode: 'free',
    taxMode: 'manual',
    manualTax: 5.50
  });
  assert.equal(c4.tax, 5.50);
  assert.equal(c4.total, 105.50);

  // Unknown shipping mode
  const c5 = listingCost({
    price: 100,
    shippingMode: 'unknown',
    taxMode: 'none'
  });
  assert.equal(c5.shipping, 0);
  assert.equal(c5.isUnknownShipping, true);
  assert.equal(c5.total, 100);
});

test('Scenario A: Individual listings win over more expensive bundle', () => {
  const parts = [
    { id: 'p-upper', name: 'Upper Control Arm', shopPrice: 204.93 },
    { id: 'p-lower', name: 'Lower Control Arm', shopPrice: 887.11 },
    { id: 'p-toe', name: 'Toe Link', shopPrice: 156.06 }
  ];

  const listings = [
    // Expensive bundle: $379.99
    {
      id: 'bundle-1',
      title: 'Suspension 3-Piece Bundle',
      partIds: ['p-upper', 'p-lower', 'p-toe'],
      price: 379.99,
      shippingMode: 'free',
      taxMode: 'none'
    },
    // Cheaper individual items: 71.09 + 149.00 + 59.99 = 280.08
    { id: 'ind-upper', title: 'Upper Arm', partIds: ['p-upper'], price: 71.09, shippingMode: 'free', taxMode: 'none' },
    { id: 'ind-lower', title: 'Lower Arm', partIds: ['p-lower'], price: 149.00, shippingMode: 'free', taxMode: 'none' },
    { id: 'ind-toe', title: 'Toe Link', partIds: ['p-toe'], price: 59.99, shippingMode: 'free', taxMode: 'none' }
  ];

  const state = { parts, listings, settings: { taxRate: 0 } };
  const solution = solveOptimalCombination(state);

  assert.equal(solution.bestCart.length, 3);
  const cartIds = solution.bestCart.map(opt => opt.listing.id).sort();
  assert.deepEqual(cartIds, ['ind-lower', 'ind-toe', 'ind-upper']);
  assert.equal(solution.bestCartCost.total, 280.08);

  const verdicts = evaluateBundleVerdicts(state, solution);
  const bundleVerdict = verdicts.get('bundle-1');
  assert.equal(bundleVerdict.verdictType, 'individual_wins');
  assert.equal(bundleVerdict.inCart, false);
  assert.equal(round2(bundleVerdict.diffAmount), -99.91); // individual saves 99.91
});

test('Scenario B: Bundle wins over individual listings', () => {
  const parts = [
    { id: 'p-upper', name: 'Upper Control Arm', shopPrice: 204.93 },
    { id: 'p-lower', name: 'Lower Control Arm', shopPrice: 887.11 },
    { id: 'p-toe', name: 'Toe Link', shopPrice: 156.06 }
  ];

  const listings = [
    // Discounted bundle: $220.00
    {
      id: 'bundle-1',
      title: 'Suspension Bundle Bargain',
      partIds: ['p-upper', 'p-lower', 'p-toe'],
      price: 220.00,
      shippingMode: 'free',
      taxMode: 'none'
    },
    { id: 'ind-upper', title: 'Upper Arm', partIds: ['p-upper'], price: 71.09, shippingMode: 'free', taxMode: 'none' },
    { id: 'ind-lower', title: 'Lower Arm', partIds: ['p-lower'], price: 149.00, shippingMode: 'free', taxMode: 'none' },
    { id: 'ind-toe', title: 'Toe Link', partIds: ['p-toe'], price: 59.99, shippingMode: 'free', taxMode: 'none' }
  ];

  const state = { parts, listings, settings: { taxRate: 0 } };
  const solution = solveOptimalCombination(state);

  assert.equal(solution.bestCart.length, 1);
  assert.equal(solution.bestCart[0].listing.id, 'bundle-1');
  assert.equal(solution.bestCartCost.total, 220.00);

  const verdicts = evaluateBundleVerdicts(state, solution);
  const bundleVerdict = verdicts.get('bundle-1');
  assert.equal(bundleVerdict.verdictType, 'bundle_wins');
  assert.equal(bundleVerdict.inCart, true);
  assert.equal(round2(bundleVerdict.diffAmount), 60.08); // bundle saves 60.08
});

test('Scenario C: Shop quote fallback & uncoverable parts', () => {
  const parts = [
    { id: 'p-covered', name: 'Part with listing', shopPrice: 100 },
    { id: 'p-shop-only', name: 'Part with shop quote only', shopPrice: 50 },
    { id: 'p-uncoverable', name: 'Part with no quotes anywhere', shopPrice: 0 }
  ];

  const listings = [
    { id: 'l1', title: 'Listing 1', partIds: ['p-covered'], price: 30, shippingMode: 'free', taxMode: 'none' }
  ];

  const state = { parts, listings, settings: { taxRate: 0 } };
  const solution = solveOptimalCombination(state);

  assert.equal(solution.uncoverableParts.length, 1);
  assert.equal(solution.uncoverableParts[0].id, 'p-uncoverable');

  // Best cart has l1 ($30) + shop quote for p-shop-only ($50) = $80
  assert.equal(solution.bestCartCost.total, 80.00);
});

test('Scenario D: Must, Purchased, and Excluded states', () => {
  const parts = [
    { id: 'p1', name: 'Part 1', shopPrice: 100 },
    { id: 'p2', name: 'Part 2', shopPrice: 100 }
  ];

  const listings = [
    // Cheap listing excluded
    { id: 'l1-cheap', title: 'Cheap L1', partIds: ['p1'], price: 20, shippingMode: 'free', taxMode: 'none', state: 'excluded' },
    // Alternate listing
    { id: 'l1-alt', title: 'Alt L1', partIds: ['p1'], price: 40, shippingMode: 'free', taxMode: 'none', state: 'normal' },
    // Forced expensive listing
    { id: 'l2-must', title: 'Must L2', partIds: ['p2'], price: 70, shippingMode: 'free', taxMode: 'none', state: 'must' },
    { id: 'l2-cheap', title: 'Cheap L2', partIds: ['p2'], price: 30, shippingMode: 'free', taxMode: 'none', state: 'normal' }
  ];

  const state = { parts, listings, settings: { taxRate: 0 } };
  const solution = solveOptimalCombination(state);

  const cartIds = solution.bestCart.map(opt => opt.listing.id).sort();
  assert.deepEqual(cartIds, ['l1-alt', 'l2-must']);
  assert.equal(solution.bestCartCost.total, 110.00);
});

test('Scenario E: Per-seller shipping override flips winning cart', () => {
  const parts = [
    { id: 'p1', name: 'Part 1', shopPrice: 100 },
    { id: 'p2', name: 'Part 2', shopPrice: 100 },
    { id: 'p3', name: 'Part 3', shopPrice: 100 }
  ];

  // Without override:
  // Seller A: 3 items @ $50 + $20 shipping each = $210 total
  // Seller B: 3 items @ $60 + free shipping = $180 total (Seller B wins)
  // WITH override of $30 flat shipping on Seller A:
  // Seller A: 3 items @ $50 + $30 shipping once = $180 total
  // If Seller A prices are $45 each: 3 * $45 + $30 = $165 (Seller A wins)

  const listings = [
    { id: 'a1', seller: 'Pacific Motors', partIds: ['p1'], price: 45, shippingMode: 'amount', shipping: 20, taxMode: 'none' },
    { id: 'a2', seller: 'Pacific Motors', partIds: ['p2'], price: 45, shippingMode: 'amount', shipping: 20, taxMode: 'none' },
    { id: 'a3', seller: 'Pacific Motors', partIds: ['p3'], price: 45, shippingMode: 'amount', shipping: 20, taxMode: 'none' },
    { id: 'b1', seller: 'Other Seller', partIds: ['p1'], price: 60, shippingMode: 'free', taxMode: 'none' },
    { id: 'b2', seller: 'Other Seller', partIds: ['p2'], price: 60, shippingMode: 'free', taxMode: 'none' },
    { id: 'b3', seller: 'Other Seller', partIds: ['p3'], price: 60, shippingMode: 'free', taxMode: 'none' }
  ];

  const settingsWithOverride = {
    taxRate: 0,
    sellerShipping: {
      'pacific motors': { mode: 'flat', amount: 30, taxable: false }
    }
  };

  const state = { parts, listings, settings: settingsWithOverride };
  const solution = solveOptimalCombination(state);

  const cartIds = solution.bestCart.map(opt => opt.listing.id).sort();
  assert.deepEqual(cartIds, ['a1', 'a2', 'a3']);
  assert.equal(solution.bestCartCost.total, 165.00); // 45*3 + 30
});

test('Scenario F: Overlapping bundle is chosen when cheaper overall and notes duplicate', () => {
  const parts = [
    { id: 'p1', name: 'Part 1', shopPrice: 100 },
    { id: 'p2', name: 'Part 2', shopPrice: 100 }
  ];

  const listings = [
    // Bundle covers p1 and p2 for $50
    { id: 'bundle-1', title: 'Bundle 1&2', partIds: ['p1', 'p2'], price: 50, shippingMode: 'free', taxMode: 'none' },
    // Forced item covers p1 already for $20
    { id: 'must-p1', title: 'Forced P1', partIds: ['p1'], price: 20, shippingMode: 'free', taxMode: 'none', state: 'must' },
    // Standalone p2 alone is $60
    { id: 'stand-p2', title: 'Standalone P2', partIds: ['p2'], price: 60, shippingMode: 'free', taxMode: 'none' }
  ];

  const state = { parts, listings, settings: { taxRate: 0 } };
  const solution = solveOptimalCombination(state);

  // Buying bundle-1 ($50) + must-p1 ($20) = $70
  // Buying stand-p2 ($60) + must-p1 ($20) = $80
  // Solver picks bundle-1 + must-p1 and flags Part 1 as duplicate!
  const cartIds = solution.bestCart.map(opt => opt.listing.id).sort();
  assert.deepEqual(cartIds, ['bundle-1', 'must-p1']);
  assert.equal(solution.bestCartCost.total, 70.00);
  assert.deepEqual(solution.duplicatePartNames, ['Part 1']);
});

test('Purchased items: finalCost override and accepted eBay offer calculation', () => {
  // Case 1: Simple finalCost override
  const l1 = {
    id: 'l1',
    price: 150,
    shippingMode: 'amount',
    shipping: 20,
    taxMode: 'rate',
    state: 'purchased',
    finalCost: 110.00
  };
  const c1 = listingCost(l1, { taxRate: 0.06625 });
  assert.equal(c1.isPurchased, true);
  assert.equal(c1.hasFinalCost, true);
  assert.equal(c1.finalCost, 110.00);
  assert.equal(c1.total, 110.00);
  assert.equal(c1.originalPrice, 150.00);

  // Case 2: Final cost with offer breakdown
  const l2 = {
    id: 'l2',
    price: 200,
    state: 'purchased',
    finalCost: 145.00,
    finalPrice: 120.00,
    finalShipping: 15.00,
    finalTax: 10.00
  };
  const c2 = listingCost(l2, { taxRate: 0.06625 });
  assert.equal(c2.isPurchased, true);
  assert.equal(c2.total, 145.00);
  assert.equal(c2.price, 120.00);
  assert.equal(c2.shipping, 15.00);
  assert.equal(c2.tax, 10.00);
  assert.equal(c2.savingsOnOffer, 80.00); // 200 - 120 = 80 saved on offer

  // Case 3: Solver integrates purchased item with accepted offer price
  const parts = [
    { id: 'p1', name: 'Control Arm', shopPrice: 300 },
    { id: 'p2', name: 'Toe Link', shopPrice: 150 }
  ];
  const listings = [
    // Purchased via accepted offer: listed at $180, bought for $120 final cost
    {
      id: 'l-purchased',
      title: 'Control Arm (Offer Accepted)',
      partIds: ['p1'],
      price: 180,
      state: 'purchased',
      finalCost: 120.00,
      shippingMode: 'free',
      taxMode: 'none'
    },
    // Still needs to buy p2
    {
      id: 'l-to-buy',
      title: 'Toe Link Listing',
      partIds: ['p2'],
      price: 60,
      state: 'normal',
      shippingMode: 'free',
      taxMode: 'none'
    }
  ];

  const state = { parts, listings, settings: { taxRate: 0 } };
  const solution = solveOptimalCombination(state);

  // Cart has both l-purchased and l-to-buy
  assert.equal(solution.bestCart.length, 2);
  assert.equal(solution.bestCartCost.total, 180.00); // 120 (purchased) + 60 (to buy)
  assert.equal(solution.summary.purchasedTotal, 120.00); // exactly $120 spent so far
  assert.equal(solution.summary.toBuyTotal, 60.00); // $60 remaining
  assert.equal(solution.summary.shopBaselineTotal, 450.00); // 300 + 150
  assert.equal(solution.summary.totalSavings, 270.00); // 450 - 180 = 270
});

test('Excel export: outputs purchased listings with final cost and offer savings', async () => {
  const { buildExcelWorkbook } = require('../src/excelExporter');
  const state = {
    parts: [{ id: 'p1', name: 'Arm', shopPrice: 100 }],
    listings: [{
      id: 'l1',
      title: 'Control Arm Listing',
      seller: 'Pacific Motors',
      partIds: ['p1'],
      price: 90,
      state: 'purchased',
      finalCost: 75.00,
      finalPrice: 65.00,
      finalShipping: 10.00,
      shippingMode: 'amount',
      shipping: 15,
      taxMode: 'none'
    }],
    settings: { taxRate: 0 }
  };

  const wb = await buildExcelWorkbook(state);
  assert.ok(wb);
  const planSheet = wb.getWorksheet('Cheapest Plan');
  assert.ok(planSheet);
  const titleCell = planSheet.getCell('A2').value;
  assert.ok(String(titleCell).includes('[PURCHASED: $75.00]'));

  const listingsSheet = wb.getWorksheet('All Listings');
  assert.ok(listingsSheet);
  const statusCell = listingsSheet.getCell('H2').value;
  assert.ok(String(statusCell).includes('Purchased ($75.00)'));
  assert.ok(String(statusCell).includes('Saved $25.00 on offer'));
});


