'use strict';

const ExcelJS = require('exceljs');
const { solveOptimalCombination, evaluateBundleVerdicts, listingCost, shopPartCost } = require('../public/js/calc');

async function buildExcelWorkbook(state) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Car Parts Price Optimizer';
  wb.lastModifiedBy = 'Car Parts Price Optimizer';
  wb.created = new Date();
  wb.modified = new Date();

  const settings = state?.settings || {};
  const taxRate = Number(settings.taxRate) || 0.06625;
  const parts = state?.parts || [];
  const listings = state?.listings || [];

  const partsMap = new Map();
  parts.forEach(p => partsMap.set(p.id, p));

  const solution = solveOptimalCombination(state);
  const verdicts = evaluateBundleVerdicts(state, solution);

  const headerFill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E293B' } // Slate 800
  };
  const headerFont = {
    name: 'Calibri',
    size: 11,
    bold: true,
    color: { argb: 'FFFFFFFF' }
  };
  const totalRowFont = {
    name: 'Calibri',
    size: 11,
    bold: true
  };

  // ----------------------------------------------------
  // SHEET 1: Cheapest Plan (Optimal Cart)
  // ----------------------------------------------------
  const wsPlan = wb.addWorksheet('Cheapest Plan');
  wsPlan.columns = [
    { header: 'Item / Purchase Option', key: 'title', width: 36 },
    { header: 'Type', key: 'type', width: 14 },
    { header: 'Parts Covered', key: 'parts', width: 40 },
    { header: 'Seller / Source', key: 'seller', width: 22 },
    { header: 'Price ($)', key: 'price', width: 14 },
    { header: 'Shipping ($)', key: 'shipping', width: 14 },
    { header: 'Tax ($)', key: 'tax', width: 14 },
    { header: 'Total ($)', key: 'total', width: 16 },
    { header: 'Direct Purchase Link', key: 'url', width: 45 }
  ];

  const planHeader = wsPlan.getRow(1);
  planHeader.height = 24;
  planHeader.eachCell(cell => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  const cart = solution.bestCart || [];
  cart.forEach(opt => {
    if (opt.type === 'listing') {
      const l = opt.listing;
      const c = listingCost(l, settings);
      const coveredNames = (l.partIds || [])
        .map(pid => partsMap.get(pid)?.name || pid)
        .join('; ');

      const isPurchased = l.state === 'purchased';
      const titleSuffix = isPurchased
        ? ` [PURCHASED${c.hasFinalCost ? ': $' + c.total.toFixed(2) : ''}]`
        : '';

      const row = wsPlan.addRow({
        title: l.title + titleSuffix,
        type: (l.partIds || []).length > 1 ? 'Bundle' : 'Individual',
        parts: coveredNames,
        seller: l.seller || 'eBay',
        price: c.price,
        shipping: c.shipping,
        tax: c.tax,
        total: c.total,
        url: l.url || ''
      });

      row.getCell(5).numFmt = '$#,##0.00';
      row.getCell(6).numFmt = '$#,##0.00';
      row.getCell(7).numFmt = '$#,##0.00';
      row.getCell(8).numFmt = '$#,##0.00';
    } else if (opt.type === 'shop') {
      const p = opt.part;
      const c = shopPartCost(p, taxRate);
      const row = wsPlan.addRow({
        title: `Shop / OEM New: ${p.name}`,
        type: 'Shop Quote',
        parts: p.name,
        seller: 'Shop / Dealer',
        price: c.price,
        shipping: 0,
        tax: c.tax,
        total: c.total,
        url: ''
      });

      row.getCell(5).numFmt = '$#,##0.00';
      row.getCell(6).numFmt = '$#,##0.00';
      row.getCell(7).numFmt = '$#,##0.00';
      row.getCell(8).numFmt = '$#,##0.00';
    }
  });

  // Total summary row using live Excel SUM formula
  const cartRowCount = cart.length;
  if (cartRowCount > 0) {
    const totalRow = wsPlan.addRow({
      title: 'TOTAL CHEAPEST CART',
      type: '',
      parts: `${cartRowCount} items`,
      seller: '',
      price: { formula: `SUM(E2:E${cartRowCount + 1})` },
      shipping: { formula: `SUM(F2:F${cartRowCount + 1})` },
      tax: { formula: `SUM(G2:G${cartRowCount + 1})` },
      total: { formula: `SUM(H2:H${cartRowCount + 1})` },
      url: ''
    });
    totalRow.height = 22;
    totalRow.font = totalRowFont;
    totalRow.getCell(5).numFmt = '$#,##0.00';
    totalRow.getCell(6).numFmt = '$#,##0.00';
    totalRow.getCell(7).numFmt = '$#,##0.00';
    totalRow.getCell(8).numFmt = '$#,##0.00';
  }

  // ----------------------------------------------------
  // SHEET 2: Parts List
  // ----------------------------------------------------
  const wsParts = wb.addWorksheet('Parts List');
  wsParts.columns = [
    { header: 'Part Name', key: 'name', width: 36 },
    { header: 'Part Number(s) / Interchange', key: 'pn', width: 32 },
    { header: 'Shop Price Pre-Tax ($)', key: 'shopPreTax', width: 22 },
    { header: 'Taxable?', key: 'taxable', width: 12 },
    { header: 'Shop Total w/ Tax ($)', key: 'shopTotal', width: 22 },
    { header: 'Best Found Source', key: 'winner', width: 36 },
    { header: 'Notes', key: 'notes', width: 40 }
  ];

  const partsHeader = wsParts.getRow(1);
  partsHeader.height = 24;
  partsHeader.eachCell(cell => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  parts.forEach((p, idx) => {
    const rIdx = idx + 2;
    // Determine winning source
    let winner = 'None';
    solution.bestCart.forEach(opt => {
      if (opt.type === 'shop' && opt.part.id === p.id) {
        winner = 'Shop Quote Baseline';
      } else if (opt.type === 'listing' && (opt.listing.partIds || []).includes(p.id)) {
        winner = opt.listing.title;
      }
    });

    const row = wsParts.addRow({
      name: p.name,
      pn: (p.partNumbers || []).join(', '),
      shopPreTax: p.shopPrice,
      taxable: p.shopTaxable ? 'Yes' : 'No',
      shopTotal: { formula: p.shopTaxable ? `ROUND(C${rIdx}*(1+${taxRate}), 2)` : `C${rIdx}` },
      winner,
      notes: p.notes || ''
    });

    row.getCell(3).numFmt = '$#,##0.00';
    row.getCell(5).numFmt = '$#,##0.00';
  });

  // ----------------------------------------------------
  // SHEET 3: All Listings & Bundles
  // ----------------------------------------------------
  const wsListings = wb.addWorksheet('All Listings');
  wsListings.columns = [
    { header: 'Listing Title', key: 'title', width: 36 },
    { header: 'Type', key: 'type', width: 14 },
    { header: 'Seller', key: 'seller', width: 20 },
    { header: 'Price ($)', key: 'price', width: 14 },
    { header: 'Shipping ($)', key: 'shipping', width: 14 },
    { header: 'Tax ($)', key: 'tax', width: 14 },
    { header: 'Total ($)', key: 'total', width: 16 },
    { header: 'Status', key: 'state', width: 14 },
    { header: 'Bundle vs. Individual Verdict', key: 'verdict', width: 44 },
    { header: 'Included Parts', key: 'parts', width: 36 },
    { header: 'URL', key: 'url', width: 45 }
  ];

  const listingsHeader = wsListings.getRow(1);
  listingsHeader.height = 24;
  listingsHeader.eachCell(cell => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  listings.forEach(l => {
    const c = listingCost(l, settings);
    const v = verdicts.get(l.id);
    const coveredNames = (l.partIds || [])
      .map(pid => partsMap.get(pid)?.name || pid)
      .join('; ');

    let stateText = l.state;
    if (l.state === 'purchased') {
      stateText = c.hasFinalCost ? `Purchased ($${c.total.toFixed(2)})` : 'Purchased';
      if (c.savingsOnOffer > 0) {
        stateText += ` - Saved $${c.savingsOnOffer.toFixed(2)} on offer`;
      }
    }

    const row = wsListings.addRow({
      title: l.title,
      type: (l.partIds || []).length > 1 ? 'Bundle' : 'Individual',
      seller: l.seller || '',
      price: c.price,
      shipping: c.shipping,
      tax: c.tax,
      total: c.total,
      state: stateText,
      verdict: v?.badgeText || '',
      parts: coveredNames,
      url: l.url || ''
    });

    row.getCell(4).numFmt = '$#,##0.00';
    row.getCell(5).numFmt = '$#,##0.00';
    row.getCell(6).numFmt = '$#,##0.00';
    row.getCell(7).numFmt = '$#,##0.00';
  });

  return wb;
}

module.exports = { buildExcelWorkbook };
