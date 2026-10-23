'use strict';

const ExcelJS = require('exceljs');
const { evaluateState } = require('../public/js/calc');

/**
 * Generates a multi-tab Excel (.xlsx) workbook with live Excel formulas
 * (`SUM`, proportional `%` formulas, tax formulas, and print-friendly layout).
 */
async function buildExcelWorkbook(state) {
  const evaluated = evaluateState(state);
  const { evaluatedLines, evaluatedBundles, summary } = evaluated;
  const meta = state.metadata || {};
  const taxRate = meta.taxRate ?? 0.06625;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Corvette Z51 PriceCompare Tracker';
  workbook.created = new Date();
  workbook.modified = new Date();

  const currencyFmt = '$#,##0.00;($#,##0.00);"-"';
  const percentFmt = '0.00%';

  // =========================================================================
  // TAB 1: Dashboard & Shop Summary
  // =========================================================================
  const wsSummary = workbook.addWorksheet('1. Summary & Shop Sheet', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 }
  });

  wsSummary.columns = [
    { header: '', key: 'colA', width: 36 },
    { header: '', key: 'colB', width: 22 },
    { header: '', key: 'colC', width: 22 },
    { header: '', key: 'colD', width: 22 },
    { header: '', key: 'colE', width: 38 }
  ];

  // Title Banner
  wsSummary.mergeCells('A1:E1');
  const titleCell = wsSummary.getCell('A1');
  titleCell.value = '2015 CHEVROLET CORVETTE STINGRAY Z51 — REPAIR QUOTE & USED PARTS COMPARISON';
  titleCell.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  wsSummary.getRow(1).height = 28;

  // Vehicle & Shop Metadata
  wsSummary.getCell('A2').value = `Shop: ${meta.shopName || 'DND Auto Body'} (Estimate #${meta.estimateId || '31065854'})`;
  wsSummary.getCell('A2').font = { bold: true };
  wsSummary.getCell('C2').value = `VIN: ${meta.vin || '1G1YJ2D72F5108806'}`;
  wsSummary.getCell('E2').value = `Owner: ${meta.owner || 'Michael Endrodi'}`;

  wsSummary.getCell('A3').value = 'NJ Sales Tax Rate:';
  wsSummary.getCell('B3').value = taxRate;
  wsSummary.getCell('B3').numFmt = '0.000%';
  wsSummary.getCell('B3').font = { bold: true, color: { argb: 'FF2563EB' } };

  wsSummary.addRow([]);

  // Table Header for Cost Comparison
  const hdrRow = wsSummary.addRow([
    'Cost Category',
    'Shop Quote (All New OEM)',
    'Projected Cost (With Used)',
    'Projected Savings ($)',
    'Notes / Calculation Basis'
  ]);
  hdrRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hdrRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  hdrRow.height = 22;

  // Determine row range on Sheet 2 for dynamic SUM formulas
  const replaceableLines = evaluatedLines.filter((l) => l.isReplaceablePart);
  const lastPartRow = 4 + replaceableLines.length; // Sheet 2 starts data at row 5

  // Row 6: Parts Total (Tax Included)
  const rParts = wsSummary.addRow([
    'Replaceable Parts (Incl. Shipping & Tax)',
    { formula: `'2. Parts Comparison'!G${lastPartRow + 1}` },
    { formula: `'2. Parts Comparison'!N${lastPartRow + 1}` },
    { formula: 'B6-C6' },
    'Live sum from Tab 2 (Unsourced parts fall back to OEM New)'
  ]);

  // Row 7: Sourced Parts Only Comparison
  const rSourcedOnly = wsSummary.addRow([
    '  ↳ Sourced Parts Only (Direct Comparison)',
    summary.sourcedOemTotal,
    summary.sourcedUsedTotal,
    { formula: 'B7-C7' },
    `${summary.sourcedCount} of ${summary.replaceableCount} replaceable items currently sourced`
  ]);
  rSourcedOnly.font = { italic: true, color: { argb: 'FF475569' } };

  // Row 8: Fixed Shop Labor (incl tax)
  const rLabor = wsSummary.addRow([
    'Shop Labor Total (60.0 hrs + 6.625% Tax)',
    meta.estimateTotals?.laborTotal || 4459.59,
    meta.estimateTotals?.laborTotal || 4459.59,
    { formula: 'B8-C8' },
    'Body (33.2h), Refinish (14.3h), Frame (1.0h), Mech (11.5h)'
  ]);

  // Row 9: Paint & Materials (incl tax)
  const rPaint = wsSummary.addRow([
    'Paint & Materials (14.0 units + 6.625% Tax)',
    meta.estimateTotals?.paintMaterialsTotal || 552.32,
    meta.estimateTotals?.paintMaterialsTotal || 552.32,
    { formula: 'B9-C9' },
    '14.0 Refinish Units @ $37.00/unit + NJ Tax'
  ]);

  // Row 10: Same-Color Paint / Refinish Credit (if any)
  const rPaintCredit = wsSummary.addRow([
    'Same-Color Painted Panel Credit (Optional)',
    0,
    -summary.totalPaintSavings,
    { formula: 'B10-C10' },
    'Refinish labor & paint material credit if used panels match paint'
  ]);

  // Row 11: Grand Total
  const rGrand = wsSummary.addRow([
    'GRAND TOTAL REPAIR COST',
    { formula: 'B6+B8+B9+B10' },
    { formula: 'C6+C8+C9+C10' },
    { formula: 'B11-C11' },
    'Complete out-the-door repair estimate comparison'
  ]);
  rGrand.font = { bold: true, size: 12 };
  rGrand.eachCell((cell, colNumber) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    if (colNumber === 4) {
      cell.font = { bold: true, size: 12, color: { argb: 'FF15803D' } };
    }
  });
  rGrand.height = 24;

  [rParts, rSourcedOnly, rLabor, rPaint, rPaintCredit, rGrand].forEach((row) => {
    [2, 3, 4].forEach((colIdx) => {
      row.getCell(colIdx).numFmt = currencyFmt;
    });
  });

  // Customer-Supplied Parts Handover Table on Summary Sheet
  wsSummary.addRow([]);
  const shopHdrTitle = wsSummary.addRow(['CUSTOMER-SUPPLIED USED PARTS HANDOVER LIST (FOR BODY SHOP)']);
  shopHdrTitle.font = { bold: true, size: 12, color: { argb: 'FF0F172A' } };

  const shopColsRow = wsSummary.addRow([
    'Estimate Line & Description',
    'OEM Part #',
    'Sourcing / Bundle / Vendor',
    'Delivery Status & Tracking',
    'Part Notes'
  ]);
  shopColsRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  shopColsRow.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
  });

  replaceableLines.forEach((line) => {
    const src = line.activeSourceSummary;
    const vendorLabel = line.isSourcedUsed
      ? src?.type === 'bundle'
        ? `[Bundle: ${src.bundleName}] ${src.vendor || ''}`
        : src?.vendor || 'Used Sourced'
      : 'Shop Supplied (OEM New)';
    const trackingLabel =
      src?.trackingNumber
        ? `${line.effectiveStatus} (${src.carrier ? src.carrier + ': ' : ''}${src.trackingNumber})`
        : line.effectiveStatus;

    wsSummary.addRow([
      `Line #${line.lineNumber}: ${line.description}`,
      line.oemPartNumber || 'N/A',
      vendorLabel,
      trackingLabel,
      line.notes || ''
    ]);
  });

  // =========================================================================
  // TAB 2: Parts Comparison (with Live Excel Formulas)
  // =========================================================================
  const wsParts = workbook.addWorksheet('2. Parts Comparison', {
    views: [{ state: 'frozen', ySplit: 4 }]
  });

  wsParts.columns = [
    { key: 'line', width: 8 },
    { key: 'category', width: 22 },
    { key: 'description', width: 32 },
    { key: 'partNum', width: 16 },
    { key: 'oemPreTax', width: 15 },
    { key: 'oemTax', width: 13 },
    { key: 'oemTotal', width: 15 },
    { key: 'mode', width: 20 },
    { key: 'vendor', width: 24 },
    { key: 'usedPrice', width: 15 },
    { key: 'usedShip', width: 14 },
    { key: 'usedTax', width: 13 },
    { key: 'usedLanded', width: 16 },
    { key: 'projectedTotal', width: 16 },
    { key: 'savings', width: 16 },
    { key: 'status', width: 18 },
    { key: 'tracking', width: 22 },
    { key: 'listingUrl', width: 28 },
    { key: 'notes', width: 38 }
  ];

  wsParts.mergeCells('A1:S1');
  const pTitle = wsParts.getCell('A1');
  pTitle.value = 'REPLACEABLE PARTS — OEM NEW vs. USED SOURCED (LIVE FORMULAS)';
  pTitle.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  pTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  wsParts.getRow(1).height = 24;

  wsParts.getCell('A2').value = 'NJ Tax Rate:';
  wsParts.getCell('B2').value = taxRate;
  wsParts.getCell('B2').numFmt = '0.000%';
  wsParts.getCell('D2').value = 'Tip: Edit columns J, K, L (Used Price, Shipping, Tax) to recalculate Projected Total & Savings live!';
  wsParts.getCell('D2').font = { italic: true, color: { argb: 'FF475569' } };

  wsParts.addRow([]);

  const pHeaders = wsParts.addRow([
    'Line #',
    'Category',
    'Part Description',
    'OEM Part #',
    'OEM Price',
    'OEM Tax',
    'OEM Total',
    'Sourcing Mode',
    'Vendor / Bundle',
    'Used Price ($)',
    'Shipping ($)',
    'Used Tax ($)',
    'Used Total ($)',
    'Projected Cost ($)',
    'Net Savings ($)',
    'Order Status',
    'Carrier & Tracking',
    'Listing URL',
    'Notes'
  ]);
  pHeaders.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  pHeaders.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  pHeaders.height = 26;

  replaceableLines.forEach((item, idx) => {
    const rIdx = 5 + idx; // Row number in Excel
    const src = item.activeSourceSummary;
    const isSourced = item.isSourcedUsed;

    const modeLabel =
      item.sourcingMode === 'bundle'
        ? `Bundle (${src?.weightPct ?? 0}% share)`
        : item.sourcingMode === 'standalone'
        ? 'Standalone Used'
        : 'Shop OEM New';

    const vendorLabel = isSourced
      ? src?.type === 'bundle'
        ? `${src.bundleName}: ${src.vendor || ''}`
        : src?.vendor || ''
      : '';

    const trackingText = src?.trackingNumber
      ? `${src.carrier ? src.carrier + ': ' : ''}${src.trackingNumber}`
      : '';

    const row = wsParts.addRow([
      item.lineNumber,
      item.category,
      item.description,
      item.oemPartNumber,
      item.oemPreTax,
      { formula: `ROUND(E${rIdx}*$B$2, 2)` },
      { formula: `E${rIdx}+F${rIdx}` },
      modeLabel,
      vendorLabel,
      isSourced ? item.projectedPreTax : null,
      isSourced ? item.projectedShipping : null,
      isSourced ? item.projectedTax : null,
      { formula: `IF(COUNT(J${rIdx}:L${rIdx})>0, SUM(J${rIdx}:L${rIdx}), "")` },
      { formula: `IF(ISNUMBER(M${rIdx}), M${rIdx}, G${rIdx})` },
      { formula: `G${rIdx}-N${rIdx}` },
      item.effectiveStatus,
      trackingText,
      src?.listingUrl || '',
      item.notes || ''
    ]);

    [5, 6, 7, 10, 11, 12, 13, 14, 15].forEach((cIdx) => {
      row.getCell(cIdx).numFmt = currencyFmt;
    });
  });

  // Totals Row on Sheet 2
  const totRowIdx = 5 + replaceableLines.length;
  const pTotRow = wsParts.addRow([
    '',
    '',
    'TOTAL REPLACEABLE PARTS',
    '',
    { formula: `SUM(E5:E${totRowIdx - 1})` },
    { formula: `SUM(F5:F${totRowIdx - 1})` },
    { formula: `SUM(G5:G${totRowIdx - 1})` },
    '',
    '',
    { formula: `SUM(J5:J${totRowIdx - 1})` },
    { formula: `SUM(K5:K${totRowIdx - 1})` },
    { formula: `SUM(L5:L${totRowIdx - 1})` },
    { formula: `SUM(M5:M${totRowIdx - 1})` },
    { formula: `SUM(N5:N${totRowIdx - 1})` },
    { formula: `SUM(O5:O${totRowIdx - 1})` },
    '',
    '',
    '',
    ''
  ]);
  pTotRow.font = { bold: true };
  pTotRow.eachCell((cell, colNumber) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    if ([5, 6, 7, 10, 11, 12, 13, 14, 15].includes(colNumber)) {
      cell.numFmt = currencyFmt;
    }
  });
  pTotRow.height = 22;

  // =========================================================================
  // TAB 3: Proportional Bundles & Assemblies Calculator
  // =========================================================================
  const wsBundles = workbook.addWorksheet('3. Bundles & Proportional Split', {
    views: [{ state: 'frozen', ySplit: 3 }]
  });

  wsBundles.columns = [
    { width: 26 },
    { width: 10 },
    { width: 32 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 28 }
  ];

  wsBundles.mergeCells('A1:L1');
  const bTitle = wsBundles.getCell('A1');
  bTitle.value = 'PROPORTIONAL BUNDLE ALLOCATION CALCULATOR (NEW OEM WEIGHT % × USED BUNDLE COST)';
  bTitle.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  bTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  wsBundles.getRow(1).height = 24;

  wsBundles.addRow([
    'Formula Rule: Each part in a bundle is weighted by (Part OEM New Price ÷ Total Bundle OEM New Price). That exact % is multiplied by the Used Bundle Price, Shipping, and Tax.'
  ]);

  const bHdr = wsBundles.addRow([
    'Bundle Name & Vendor',
    'Line #',
    'Included Part Description',
    'Part OEM New ($)',
    'Bundle OEM Sum ($)',
    'OEM Weight (%)',
    'Bundle Used Total ($)',
    'Allocated Price ($)',
    'Allocated Ship ($)',
    'Allocated Tax ($)',
    'Allocated Total ($)',
    'Part Savings vs OEM ($)'
  ]);
  bHdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  bHdr.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  bHdr.height = 26;

  let currentBundleRow = 4;
  if (evaluatedBundles.length === 0) {
    wsBundles.addRow([
      'No bundles created yet. Create a bundle in the web app (e.g., Right Rear Suspension Knee Assembly) or enter rows here!'
    ]);
  } else {
    evaluatedBundles.forEach((bundle) => {
      const activeOpt = bundle.activeOption;
      const bundleUsedPrice = activeOpt ? activeOpt.computed.price : 0;
      const bundleUsedShip = activeOpt ? activeOpt.computed.shipping : 0;
      const bundleUsedTax = activeOpt ? activeOpt.computed.tax : 0;
      const bundleUsedTotal = activeOpt ? activeOpt.computed.total : 0;

      const memberLines = (bundle.lineNumbers || [])
        .map((ln) => evaluatedLines.find((l) => l.lineNumber === Number(ln)))
        .filter(Boolean);

      const startRow = currentBundleRow;
      const endRow = startRow + memberLines.length - 1;

      memberLines.forEach((line) => {
        const r = currentBundleRow;
        const row = wsBundles.addRow([
          `${bundle.name} (${activeOpt?.vendor || 'No Quote'})`,
          line.lineNumber,
          line.description,
          line.oemPreTax,
          { formula: `SUM($D$${startRow}:$D$${endRow})` },
          { formula: `IF(E${r}>0, D${r}/E${r}, 0)` },
          bundleUsedTotal,
          { formula: `ROUND(${bundleUsedPrice}*F${r}, 2)` },
          { formula: `ROUND(${bundleUsedShip}*F${r}, 2)` },
          { formula: `ROUND(${bundleUsedTax}*F${r}, 2)` },
          { formula: `ROUND(G${r}*F${r}, 2)` },
          { formula: `ROUND(D${r}*(1+${taxRate}), 2)-K${r}` }
        ]);
        [4, 5, 7, 8, 9, 10, 11, 12].forEach((cIdx) => {
          row.getCell(cIdx).numFmt = currencyFmt;
        });
        row.getCell(6).numFmt = percentFmt;
        currentBundleRow++;
      });

      // Blank separator row
      wsBundles.addRow([]);
      currentBundleRow++;
    });
  }

  // =========================================================================
  // TAB 4: Full 38-Line Original Shop Estimate Reference
  // =========================================================================
  const wsFull = workbook.addWorksheet('4. Full 38-Line Shop Quote');
  wsFull.columns = [
    { header: 'Line #', width: 9 },
    { header: 'Code', width: 12 },
    { header: 'Section', width: 24 },
    { header: 'Description', width: 34 },
    { header: 'Operation', width: 20 },
    { header: 'Labor Type', width: 14 },
    { header: 'Labor Hrs', width: 12 },
    { header: 'Part Type', width: 12 },
    { header: 'OEM Part #', width: 16 },
    { header: 'Qty', width: 8 },
    { header: 'OEM Price ($)', width: 16 },
    { header: 'Taxable', width: 10 },
    { header: 'Notes', width: 42 }
  ];

  const fHdr = wsFull.getRow(1);
  fHdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  fHdr.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
  });

  evaluatedLines.forEach((l) => {
    const r = wsFull.addRow([
      l.lineNumber,
      l.partCode,
      l.category,
      l.description,
      l.operation,
      l.laborType,
      l.laborUnits,
      l.partType,
      l.oemPartNumber,
      l.qty || '',
      l.oemPreTax || '',
      l.taxable ? 'Yes' : 'No',
      l.notes || ''
    ]);
    r.getCell(11).numFmt = currencyFmt;
  });

  return workbook;
}

module.exports = { buildExcelWorkbook };
