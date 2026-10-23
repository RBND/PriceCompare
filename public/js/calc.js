(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PriceCompareCalc = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function round2(n) {
    const val = Number(n);
    if (!Number.isFinite(val)) return 0;
    return Math.round((val + Number.EPSILON) * 100) / 100;
  }

  /**
   * Computes the tax and total landed cost of a single quote or bundle option.
   * @param {Object} option { price, shipping, taxMode, manualTax }
   * @param {number} defaultTaxRate e.g. 0.06625
   */
  function computeOptionCost(option, defaultTaxRate = 0.06625) {
    if (!option) {
      return { price: 0, shipping: 0, tax: 0, total: 0 };
    }
    const price = Math.max(0, Number(option.price) || 0);
    const shipping = Math.max(0, Number(option.shipping) || 0);
    const taxMode = option.taxMode || 'none';
    let tax = 0;

    if (taxMode === 'rate') {
      // Standard NJ sales tax on price + shipping
      tax = round2((price + shipping) * defaultTaxRate);
    } else if (taxMode === 'price_only_rate') {
      tax = round2(price * defaultTaxRate);
    } else if (taxMode === 'manual') {
      tax = Math.max(0, Number(option.manualTax) || 0);
    } else {
      tax = 0;
    }

    const total = round2(price + shipping + tax);
    return {
      price: round2(price),
      shipping: round2(shipping),
      tax: round2(tax),
      total
    };
  }

  /**
   * Generates a clickable carrier tracking URL if possible
   */
  function getTrackingUrl(carrier, trackingNumber) {
    const num = String(trackingNumber || '').trim();
    if (!num) return '';
    const c = String(carrier || '').toUpperCase().trim();
    if (c.includes('UPS') || /^1Z[A-Z0-9]{16}$/i.test(num)) {
      return 'https://www.ups.com/track?tracknum=' + encodeURIComponent(num);
    }
    if (c.includes('FEDEX')) {
      return 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(num);
    }
    if (c.includes('USPS')) {
      return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(num);
    }
    if (c.includes('DHL')) {
      return 'https://www.dhl.com/us-en/home/tracking.html?tracking-id=' + encodeURIComponent(num);
    }
    if (/^https?:\/\//i.test(num)) {
      return num;
    }
    return 'https://www.google.com/search?q=' + encodeURIComponent(num + ' tracking');
  }

  /**
   * Computes proportional bundle breakdown for a bundle and all its member line items.
   * For each part in the bundle:
   *   sharePct = part.oemPrice / sum(bundleParts.oemPrice)
   *   allocatedUsedTotal = bundleOption.total * sharePct
   */
  function evaluateBundle(bundle, lineItemsMap, taxRate = 0.06625) {
    const memberLines = (bundle.lineNumbers || [])
      .map((ln) => lineItemsMap.get(Number(ln)))
      .filter(Boolean);

    const oemBundlePreTax = round2(
      memberLines.reduce((acc, item) => acc + (Number(item.oemPrice) || 0), 0)
    );
    const oemBundleTax = round2(oemBundlePreTax * taxRate);
    const oemBundleTotal = round2(oemBundlePreTax + oemBundleTax);

    const evaluatedOptions = (bundle.options || []).map((opt) => {
      const cost = computeOptionCost(opt, taxRate);
      const savingsVsOem = round2(oemBundleTotal - cost.total);
      const savingsPct = oemBundleTotal > 0 ? (savingsVsOem / oemBundleTotal) * 100 : 0;
      return {
        ...opt,
        computed: {
          ...cost,
          savingsVsOem,
          savingsPct
        }
      };
    });

    const activeOption =
      evaluatedOptions.find((o) => o.id === bundle.activeOptionId) ||
      evaluatedOptions[0] ||
      null;

    // Member allocations for active option
    const memberAllocations = {};
    const count = memberLines.length;

    memberLines.forEach((item) => {
      const itemOemPreTax = round2(Number(item.oemPrice) || 0);
      const itemOemTax = item.taxable ? round2(itemOemPreTax * taxRate) : 0;
      const itemOemTotal = round2(itemOemPreTax + itemOemTax);

      // Weight percentage based on OEM pre-tax price (or equal split if OEM sum is 0)
      const weight =
        oemBundlePreTax > 0
          ? itemOemPreTax / oemBundlePreTax
          : count > 0
          ? 1 / count
          : 0;

      if (activeOption) {
        const c = activeOption.computed;
        const allocPrice = round2(c.price * weight);
        const allocShipping = round2(c.shipping * weight);
        const allocTax = round2(c.tax * weight);
        const allocTotal = round2(c.total * weight);
        const allocSavings = round2(itemOemTotal - allocTotal);
        memberAllocations[item.lineNumber] = {
          bundleId: bundle.id,
          bundleName: bundle.name,
          optionId: activeOption.id,
          vendor: activeOption.vendor || bundle.name,
          listingUrl: activeOption.listingUrl || '',
          carrier: activeOption.carrier || '',
          trackingNumber: activeOption.trackingNumber || '',
          status: activeOption.status || 'Watching / Quoted',
          notes: activeOption.notes || '',
          weight,
          weightPct: round2(weight * 100),
          oemBundlePreTax,
          oemBundleTotal,
          bundleTotal: c.total,
          allocatedPrice: allocPrice,
          allocatedShipping: allocShipping,
          allocatedTax: allocTax,
          allocatedTotal: allocTotal,
          allocatedSavings: allocSavings
        };
      } else {
        memberAllocations[item.lineNumber] = {
          bundleId: bundle.id,
          bundleName: bundle.name,
          optionId: null,
          vendor: bundle.name + ' (No quote entered)',
          listingUrl: '',
          carrier: '',
          trackingNumber: '',
          status: 'Need to Find',
          notes: '',
          weight,
          weightPct: round2(weight * 100),
          oemBundlePreTax,
          oemBundleTotal,
          bundleTotal: null,
          allocatedPrice: null,
          allocatedShipping: null,
          allocatedTax: null,
          allocatedTotal: null,
          allocatedSavings: 0
        };
      }
    });

    return {
      ...bundle,
      oemBundlePreTax,
      oemBundleTax,
      oemBundleTotal,
      evaluatedOptions,
      activeOption,
      memberAllocations
    };
  }

  /**
   * Computes complete state metrics, per-line breakdowns, bundle allocations,
   * paint/refinish savings, and overall summary cards.
   */
  function evaluateState(state) {
    const taxRate = state?.metadata?.taxRate ?? 0.06625;
    const settings = state?.settings || {};
    const includeTires = settings.includeTiresInTotals !== false;
    const includeLaborAndPaint = settings.includeLaborAndPaint !== false;

    const lineItems = state?.lineItems || [];
    const lineItemsMap = new Map();
    lineItems.forEach((item) => lineItemsMap.set(Number(item.lineNumber), item));

    // Evaluate all bundles first
    const evaluatedBundles = (state?.bundles || []).map((b) =>
      evaluateBundle(b, lineItemsMap, taxRate)
    );
    const bundlesMap = new Map();
    evaluatedBundles.forEach((b) => bundlesMap.set(b.id, b));

    // Group standalone quotes by lineNumber
    const quotesByLine = new Map();
    (state?.partQuotes || []).forEach((q) => {
      const ln = Number(q.lineNumber);
      if (!quotesByLine.has(ln)) quotesByLine.set(ln, []);
      const cost = computeOptionCost(q, taxRate);
      quotesByLine.get(ln).push({
        ...q,
        computed: cost
      });
    });

    // Evaluate each line item
    const evaluatedLines = lineItems.map((item) => {
      const oemPreTax = round2(Number(item.oemPrice) || 0);
      const oemTax = item.taxable ? round2(oemPreTax * taxRate) : 0;
      const oemTotal = round2(oemPreTax + oemTax);

      const lineQuotes = quotesByLine.get(Number(item.lineNumber)) || [];

      // Check if item is assigned to a bundle
      let activeBundle = null;
      if (item.sourcingMode === 'bundle' && item.activeBundleId) {
        activeBundle = bundlesMap.get(item.activeBundleId) || null;
      } else {
        // Also check if any bundle lists this lineNumber AND item is set to bundle mode
        const containingBundle = evaluatedBundles.find((b) =>
          (b.lineNumbers || []).includes(Number(item.lineNumber))
        );
        if (containingBundle && item.sourcingMode === 'bundle') {
          activeBundle = containingBundle;
        }
      }

      let isSourcedUsed = false;
      let activeSourceSummary = null;
      let projectedPreTax = oemPreTax;
      let projectedShipping = 0;
      let projectedTax = oemTax;
      let projectedTotal = oemTotal;
      let savingsOnItem = 0;
      let effectiveStatus = item.status || (item.isReplaceablePart ? 'Need to Find' : 'Shop / Existing');

      if (item.sourcingMode === 'bundle' && activeBundle) {
        const alloc = activeBundle.memberAllocations[item.lineNumber];
        if (alloc && alloc.allocatedTotal !== null) {
          isSourcedUsed = true;
          projectedPreTax = alloc.allocatedPrice;
          projectedShipping = alloc.allocatedShipping;
          projectedTax = alloc.allocatedTax;
          projectedTotal = alloc.allocatedTotal;
          savingsOnItem = round2(oemTotal - projectedTotal);
          effectiveStatus = alloc.status || item.status;
          activeSourceSummary = {
            type: 'bundle',
            bundleId: activeBundle.id,
            bundleName: activeBundle.name,
            vendor: alloc.vendor,
            listingUrl: alloc.listingUrl,
            carrier: alloc.carrier,
            trackingNumber: alloc.trackingNumber,
            trackingUrl: getTrackingUrl(alloc.carrier, alloc.trackingNumber),
            weightPct: alloc.weightPct,
            bundleTotal: alloc.bundleTotal,
            oemBundlePreTax: alloc.oemBundlePreTax,
            notes: alloc.notes
          };
        } else {
          // Bundle exists but has no active option price yet -> fallback to OEM New
          activeSourceSummary = {
            type: 'bundle_pending',
            bundleId: activeBundle.id,
            bundleName: activeBundle.name,
            weightPct: alloc ? alloc.weightPct : 0
          };
        }
      } else if (item.sourcingMode === 'standalone') {
        const activeQuote =
          lineQuotes.find((q) => q.id === item.activeQuoteId) ||
          lineQuotes[0] ||
          null;
        if (activeQuote) {
          isSourcedUsed = true;
          projectedPreTax = activeQuote.computed.price;
          projectedShipping = activeQuote.computed.shipping;
          projectedTax = activeQuote.computed.tax;
          projectedTotal = activeQuote.computed.total;
          savingsOnItem = round2(oemTotal - projectedTotal);
          effectiveStatus = activeQuote.status || item.status;
          activeSourceSummary = {
            type: 'standalone',
            quoteId: activeQuote.id,
            vendor: activeQuote.vendor,
            listingUrl: activeQuote.listingUrl,
            carrier: activeQuote.carrier,
            trackingNumber: activeQuote.trackingNumber,
            trackingUrl: getTrackingUrl(activeQuote.carrier, activeQuote.trackingNumber),
            notes: activeQuote.notes
          };
        }
      }

      // Potential Refinish & Paint Material savings if painted panel & skipRepaint is true
      let paintSavingsPreTax = 0;
      let paintSavingsTax = 0;
      let paintSavingsTotal = 0;
      if (item.isPaintedPanel && item.skipRepaint) {
        const refLaborRate = state?.metadata?.rates?.refinishLabor ?? 60.0;
        const paintMatRate = state?.metadata?.rates?.paintMaterials ?? 37.0;
        const refLaborSaved = round2((Number(item.refinishLaborUnits) || 0) * refLaborRate);
        const paintMatSaved = round2((Number(item.paintMaterialUnits) || 0) * paintMatRate);
        paintSavingsPreTax = round2(refLaborSaved + paintMatSaved);
        paintSavingsTax = round2(paintSavingsPreTax * taxRate);
        paintSavingsTotal = round2(paintSavingsPreTax + paintSavingsTax);
      }

      return {
        ...item,
        quotes: lineQuotes,
        oemPreTax,
        oemTax,
        oemTotal,
        isSourcedUsed,
        activeSourceSummary,
        projectedPreTax,
        projectedShipping,
        projectedTax,
        projectedTotal,
        savingsOnItem,
        effectiveStatus,
        paintSavingsPreTax,
        paintSavingsTax,
        paintSavingsTotal
      };
    });

    // Calculate Totals across active scope (with or without tires, with or without labor/paint)
    const activeReplaceableParts = evaluatedLines.filter((item) => {
      if (!item.isReplaceablePart) return false;
      if (!includeTires && item.isTireItem) return false;
      return true;
    });

    const oemPartsPreTax = round2(
      activeReplaceableParts.reduce((sum, item) => sum + item.oemPreTax, 0)
    );
    const oemPartsTax = round2(oemPartsPreTax * taxRate);
    const oemPartsTotal = round2(oemPartsPreTax + oemPartsTax);

    // Sourced vs Unsourced breakdown
    const sourcedParts = activeReplaceableParts.filter((item) => item.isSourcedUsed);
    const unsourcedParts = activeReplaceableParts.filter((item) => !item.isSourcedUsed);

    const sourcedOemPreTax = round2(
      sourcedParts.reduce((sum, item) => sum + item.oemPreTax, 0)
    );
    const sourcedOemTotal = round2(sourcedOemPreTax * (1 + taxRate));
    const sourcedUsedTotal = round2(
      sourcedParts.reduce((sum, item) => sum + item.projectedTotal, 0)
    );
    const savingsOnSourcedParts = round2(sourcedOemTotal - sourcedUsedTotal);

    const unsourcedPreTax = round2(
      unsourcedParts.reduce((sum, item) => sum + item.oemPreTax, 0)
    );
    const unsourcedFallbackTotal = round2(unsourcedPreTax * (1 + taxRate));

    const projectedPartsPreTax = round2(
      activeReplaceableParts.reduce((sum, item) => sum + item.projectedPreTax, 0)
    );
    const projectedPartsShipping = round2(
      activeReplaceableParts.reduce((sum, item) => sum + item.projectedShipping, 0)
    );
    const projectedPartsTax = round2(
      sourcedParts.reduce((sum, item) => sum + item.projectedTax, 0) +
        round2(unsourcedPreTax * taxRate)
    );
    const projectedPartsTotal = round2(sourcedUsedTotal + unsourcedFallbackTotal);

    // Labor & Paint Totals
    const estTotals = state?.metadata?.estimateTotals || {};
    const baseLaborTotal = includeLaborAndPaint ? (Number(estTotals.laborTotal) || 4459.59) : 0;
    const basePaintTotal = includeLaborAndPaint ? (Number(estTotals.paintMaterialsTotal) || 552.32) : 0;
    const baseFixedShopTotal = round2(baseLaborTotal + basePaintTotal);

    const totalPaintSavings = includeLaborAndPaint
      ? round2(
          evaluatedLines.reduce((sum, item) => sum + (item.paintSavingsTotal || 0), 0)
        )
      : 0;

    const projectedFixedShopTotal = round2(Math.max(0, baseFixedShopTotal - totalPaintSavings));

    const originalEstimateGrandTotal = round2(oemPartsTotal + baseFixedShopTotal);
    const projectedGrandTotal = round2(projectedPartsTotal + projectedFixedShopTotal);
    const totalProjectedSavings = round2(originalEstimateGrandTotal - projectedGrandTotal);
    const totalSavingsPct =
      originalEstimateGrandTotal > 0
        ? round2((totalProjectedSavings / originalEstimateGrandTotal) * 100)
        : 0;

    return {
      evaluatedLines,
      evaluatedBundles,
      summary: {
        includeTires,
        includeLaborAndPaint,
        replaceableCount: activeReplaceableParts.length,
        sourcedCount: sourcedParts.length,
        unsourcedCount: unsourcedParts.length,
        oemPartsPreTax,
        oemPartsTax,
        oemPartsTotal,
        sourcedOemTotal,
        sourcedUsedTotal,
        savingsOnSourcedParts,
        unsourcedFallbackTotal,
        projectedPartsPreTax,
        projectedPartsShipping,
        projectedPartsTax,
        projectedPartsTotal,
        baseLaborTotal,
        basePaintTotal,
        baseFixedShopTotal,
        totalPaintSavings,
        projectedFixedShopTotal,
        originalEstimateGrandTotal,
        projectedGrandTotal,
        totalProjectedSavings,
        totalSavingsPct
      }
    };
  }

  return {
    round2,
    computeOptionCost,
    getTrackingUrl,
    evaluateBundle,
    evaluateState
  };
});
