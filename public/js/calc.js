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

  function normalizeSeller(seller) {
    return String(seller || '').trim().toLowerCase();
  }

  /**
   * Computes the standalone landed cost for a single listing (without global seller override).
   * @param {Object} listing
   * @param {Object} settings { taxRate, sellerShipping }
   */
  function listingCost(listing, settings = {}) {
    if (!listing) {
      return { price: 0, shipping: 0, tax: 0, total: 0, isUnknownShipping: false };
    }

    const isPurchased = listing.state === 'purchased';
    const hasFinalCost = isPurchased && listing.finalCost !== undefined && listing.finalCost !== null && listing.finalCost !== '' && !isNaN(Number(listing.finalCost));
    const originalPrice = Math.max(0, Number(listing.price) || 0);

    if (hasFinalCost) {
      const finalTotal = round2(Math.max(0, Number(listing.finalCost)));
      let fPrice = finalTotal;
      let fShipping = 0;
      let fTax = 0;

      if (listing.finalPrice !== undefined && listing.finalPrice !== null && listing.finalPrice !== '' && !isNaN(Number(listing.finalPrice))) {
        fPrice = round2(Math.max(0, Number(listing.finalPrice)));
        fShipping = (listing.finalShipping !== undefined && listing.finalShipping !== null && listing.finalShipping !== '' && !isNaN(Number(listing.finalShipping)))
          ? round2(Math.max(0, Number(listing.finalShipping)))
          : 0;
        fTax = round2(Math.max(0, finalTotal - fPrice - fShipping));
      }

      return {
        price: fPrice,
        shipping: fShipping,
        tax: fTax,
        total: finalTotal,
        originalPrice: round2(originalPrice),
        isPurchased: true,
        hasFinalCost: true,
        finalCost: finalTotal,
        savingsOnOffer: round2(originalPrice - fPrice),
        shippingMode: listing.shippingMode || 'free',
        isUnknownShipping: false
      };
    }

    const taxRate = Number(settings.taxRate) || 0.06625;
    const price = originalPrice;

    const shippingMode = listing.shippingMode || (listing.freeShipping ? 'free' : 'amount');
    const isUnknownShipping = shippingMode === 'unknown';
    const shipping = (shippingMode === 'amount' && !isUnknownShipping)
      ? Math.max(0, Number(listing.shipping) || 0)
      : 0;

    const taxMode = listing.taxMode || 'rate';
    let tax = 0;
    if (taxMode === 'rate') {
      tax = round2((price + shipping) * taxRate);
    } else if (taxMode === 'manual') {
      tax = Math.max(0, Number(listing.manualTax) || 0);
    } else {
      tax = 0;
    }

    const total = round2(price + shipping + tax);
    return {
      price: round2(price),
      shipping: round2(shipping),
      tax: round2(tax),
      total,
      originalPrice: round2(price),
      isPurchased,
      hasFinalCost: false,
      shippingMode,
      isUnknownShipping
    };
  }

  /**
   * Evaluates cost of a shop quote baseline option for a given part.
   */
  function shopPartCost(part, taxRate = 0.06625) {
    const preTax = Math.max(0, Number(part.shopPrice) || 0);
    const tax = part.shopTaxable ? round2(preTax * taxRate) : 0;
    return {
      price: round2(preTax),
      shipping: 0,
      tax: round2(tax),
      total: round2(preTax + tax)
    };
  }

  /**
   * Evaluates the total cost of a group of chosen candidate options,
   * factoring in per-seller shipping overrides.
   *
   * @param {Array} chosenOptions Array of options ({ type: 'listing'|'shop', listing, part, ... })
   * @param {Object} settings
   * @returns {Object} { itemsTotal, sellerCharges: [...], grandTotal, itemsCost }
   */
  function evaluateCartCost(chosenOptions, settings = {}) {
    const taxRate = Number(settings.taxRate) || 0.06625;
    const sellerShippingMap = settings.sellerShipping || {};

    // Group listings by normalized seller
    const listingsBySeller = new Map();
    let shopItemsTotal = 0;
    let shopItemsPreTax = 0;
    let shopItemsTax = 0;

    chosenOptions.forEach(opt => {
      if (opt.type === 'shop') {
        const sc = shopPartCost(opt.part, taxRate);
        shopItemsPreTax += sc.price;
        shopItemsTax += sc.tax;
        shopItemsTotal += sc.total;
      } else if (opt.type === 'listing') {
        const sKey = normalizeSeller(opt.listing.seller);
        if (!listingsBySeller.has(sKey)) {
          listingsBySeller.set(sKey, []);
        }
        listingsBySeller.get(sKey).push(opt.listing);
      }
    });

    let listingsPriceSum = 0;
    let listingsShippingSum = 0;
    let listingsTaxSum = 0;
    const sellerCharges = [];

    // Process listings and seller overrides
    listingsBySeller.forEach((sellerListings, sKey) => {
      // Separate already-purchased listings from unpurchased listings
      const purchasedSellerListings = sellerListings.filter(l => l.state === 'purchased');
      const unpurchasedSellerListings = sellerListings.filter(l => l.state !== 'purchased');

      // Purchased listings always add their own fixed cost (including finalCost if set)
      purchasedSellerListings.forEach(l => {
        const cost = listingCost(l, settings);
        listingsPriceSum += cost.price;
        listingsShippingSum += cost.shipping;
        listingsTaxSum += cost.tax;
      });

      // Find if an override exists for this seller
      let override = null;
      if (sKey && sellerShippingMap) {
        for (const [key, ovr] of Object.entries(sellerShippingMap)) {
          if (normalizeSeller(key) === sKey && ovr) {
            override = ovr;
            break;
          }
        }
      }

      if (override && unpurchasedSellerListings.length > 0) {
        // Seller override applies to unpurchased listings!
        const overrideMode = override.mode || (override.free ? 'free' : 'flat');
        const flatAmount = overrideMode === 'free' ? 0 : Math.max(0, Number(override.amount) || 0);
        const overrideTaxable = override.taxable !== false;

        let sellerPriceTotal = 0;
        let sellerManualTaxTotal = 0;
        let anyRateTax = false;

        unpurchasedSellerListings.forEach(l => {
          const p = Math.max(0, Number(l.price) || 0);
          sellerPriceTotal += p;
          if (l.taxMode === 'manual') {
            sellerManualTaxTotal += Math.max(0, Number(l.manualTax) || 0);
          } else if (l.taxMode === 'rate') {
            anyRateTax = true;
          }
        });

        // Tax calculation with override:
        let sellerTax = round2(sellerManualTaxTotal);
        if (anyRateTax) {
          const taxableBase = sellerPriceTotal + (overrideTaxable ? flatAmount : 0);
          sellerTax = round2(sellerTax + taxableBase * taxRate);
        }

        listingsPriceSum += round2(sellerPriceTotal);
        listingsShippingSum += round2(flatAmount);
        listingsTaxSum += sellerTax;

        sellerCharges.push({
          seller: unpurchasedSellerListings[0].seller || sKey,
          sellerKey: sKey,
          isOverride: true,
          mode: overrideMode,
          shipping: round2(flatAmount),
          taxable: overrideTaxable,
          itemsCount: unpurchasedSellerListings.length
        });
      } else {
        // No override (or no unpurchased listings): each unpurchased listing charges its own shipping & tax
        unpurchasedSellerListings.forEach(l => {
          const cost = listingCost(l, settings);
          listingsPriceSum += cost.price;
          listingsShippingSum += cost.shipping;
          listingsTaxSum += cost.tax;
        });
      }
    });

    const totalPrice = round2(shopItemsPreTax + listingsPriceSum);
    const totalShipping = round2(listingsShippingSum);
    const totalTax = round2(shopItemsTax + listingsTaxSum);
    const grandTotal = round2(totalPrice + totalShipping + totalTax);

    return {
      price: totalPrice,
      shipping: totalShipping,
      tax: totalTax,
      total: grandTotal,
      sellerCharges
    };
  }

  /**
   * Solves for the optimal (cheapest) combination of options covering required parts.
   *
   * @param {Object} state { parts, listings, settings }
   * @returns {Object} Solution containing winning cart, uncovered parts, and summary.
   */
  function solveOptimalCombination(state) {
    const parts = state?.parts || [];
    const listings = state?.listings || [];
    const settings = state?.settings || {};
    const taxRate = Number(settings.taxRate) || 0.06625;

    const partsMap = new Map();
    parts.forEach((p, idx) => {
      partsMap.set(p.id, { ...p, index: idx });
    });
    const numParts = parts.length;

    // Filter candidate listings
    const activeListings = listings.filter(l => {
      if (l.state === 'excluded') return false;
      const validParts = (l.partIds || []).filter(pid => partsMap.has(pid));
      return validParts.length > 0;
    });

    // Forced listings (must or purchased)
    const forcedListings = activeListings.filter(l => l.state === 'must' || l.state === 'purchased');
    const selectableListings = activeListings.filter(l => l.state !== 'must' && l.state !== 'purchased');

    // Candidate options list
    // An option can be:
    // 1. { type: 'listing', listing, mask, id: listing.id }
    // 2. { type: 'shop', part, mask, id: 'shop-' + part.id }
    function getListingMask(l) {
      let mask = 0;
      (l.partIds || []).forEach(pid => {
        const p = partsMap.get(pid);
        if (p) mask |= (1 << p.index);
      });
      return mask;
    }

    let initialCoveredMask = 0;
    forcedListings.forEach(l => {
      initialCoveredMask |= getListingMask(l);
    });

    // Parts covered by shop quotes
    const shopOptions = [];
    parts.forEach((p, idx) => {
      if (Number(p.shopPrice) > 0) {
        shopOptions.push({
          type: 'shop',
          part: p,
          mask: (1 << idx),
          id: 'shop-' + p.id
        });
      }
    });

    const listingOptions = selectableListings.map(l => ({
      type: 'listing',
      listing: l,
      mask: getListingMask(l),
      id: l.id
    }));

    const allSelectableOptions = [...listingOptions, ...shopOptions];

    // Determine target mask
    // Parts that can possibly be covered
    let possibleMask = initialCoveredMask;
    allSelectableOptions.forEach(opt => {
      possibleMask |= opt.mask;
    });

    const uncoverableParts = [];
    parts.forEach((p, idx) => {
      const bit = 1 << idx;
      if ((possibleMask & bit) === 0) {
        uncoverableParts.push(p);
      }
    });

    // Target mask to cover is all parts that CAN be covered
    const fullTargetMask = (1 << numParts) - 1;
    const targetMask = possibleMask;

    // Check if seller overrides are present in selectable listings
    const sellerShippingMap = settings.sellerShipping || {};
    const relevantOverrideSellers = new Set();

    if (sellerShippingMap && Object.keys(sellerShippingMap).length > 0) {
      allSelectableOptions.forEach(opt => {
        if (opt.type === 'listing' && opt.listing.seller) {
          const sKey = normalizeSeller(opt.listing.seller);
          for (const key of Object.keys(sellerShippingMap)) {
            if (normalizeSeller(key) === sKey) {
              relevantOverrideSellers.add(sKey);
              break;
            }
          }
        }
      });
    }

    let bestCart = null;
    let bestCartCost = null;

    // Core Bitmask DP helper for a given pricing configuration
    // numParts up to 22 is exact bitmask DP
    const useExactDP = numParts <= 22;

    function runExactDP(effectiveOptions, forcedOpts) {
      const dpCost = new Float64Array(1 << numParts);
      const dpParent = new Int32Array(1 << numParts);
      const dpChoice = new Int32Array(1 << numParts);
      dpCost.fill(Infinity);
      dpParent.fill(-1);
      dpChoice.fill(-1);

      // Pre-evaluate standalone option cost for fast DP transitions
      const optCosts = effectiveOptions.map(opt => {
        if (opt.type === 'shop') {
          return shopPartCost(opt.part, taxRate).total;
        } else {
          return opt.effectiveCost !== undefined ? opt.effectiveCost : listingCost(opt.listing, settings).total;
        }
      });

      dpCost[initialCoveredMask] = 0;

      for (let mask = 0; mask <= targetMask; mask++) {
        const curCost = dpCost[mask];
        if (!Number.isFinite(curCost)) continue;

        for (let i = 0; i < effectiveOptions.length; i++) {
          const opt = effectiveOptions[i];
          const nextMask = mask | opt.mask;
          if (nextMask === mask) continue; // doesn't cover anything new

          const nextCost = curCost + optCosts[i];
          if (nextCost < dpCost[nextMask]) {
            dpCost[nextMask] = nextCost;
            dpParent[nextMask] = mask;
            dpChoice[nextMask] = i;
          }
        }
      }

      if (!Number.isFinite(dpCost[targetMask])) {
        // Fallback: take highest covered mask
        return null;
      }

      // Reconstruct chosen selectable options
      const chosen = [...forcedOpts];
      let curr = targetMask;
      while (curr !== initialCoveredMask && dpChoice[curr] !== -1) {
        const optIdx = dpChoice[curr];
        chosen.push(effectiveOptions[optIdx]);
        curr = dpParent[curr];
      }

      return chosen;
    }

    // Greedy fallback if numParts > 22
    function runGreedy(effectiveOptions, forcedOpts) {
      const chosen = [...forcedOpts];
      let covered = initialCoveredMask;

      while ((covered & targetMask) !== targetMask) {
        let bestOpt = null;
        let bestEfficiency = Infinity;

        for (const opt of effectiveOptions) {
          const newBits = (opt.mask & ~covered) & targetMask;
          if (newBits === 0) continue;

          let count = 0;
          for (let b = 0; b < numParts; b++) {
            if ((newBits & (1 << b)) !== 0) count++;
          }

          const cost = opt.type === 'shop'
            ? shopPartCost(opt.part, taxRate).total
            : listingCost(opt.listing, settings).total;

          const efficiency = cost / count;
          if (efficiency < bestEfficiency) {
            bestEfficiency = efficiency;
            bestOpt = opt;
          }
        }

        if (!bestOpt) break;
        chosen.push(bestOpt);
        covered |= bestOpt.mask;
      }

      return chosen;
    }

    const forcedOpts = forcedListings.map(l => ({
      type: 'listing',
      listing: l,
      mask: getListingMask(l),
      id: l.id
    }));

    if (relevantOverrideSellers.size === 0 || relevantOverrideSellers.size > 8) {
      // Direct solve
      const chosen = useExactDP
        ? (runExactDP(allSelectableOptions, forcedOpts) || runGreedy(allSelectableOptions, forcedOpts))
        : runGreedy(allSelectableOptions, forcedOpts);

      bestCart = chosen || forcedOpts;
      bestCartCost = evaluateCartCost(bestCart, settings);
    } else {
      // Seller overrides exist: Iterate 2^k seller subsets for exact solution!
      const sellerArr = Array.from(relevantOverrideSellers);
      const numSubsets = 1 << sellerArr.length;

      for (let sMask = 0; sMask < numSubsets; sMask++) {
        const activeSellersInSubset = new Set();
        for (let b = 0; b < sellerArr.length; b++) {
          if ((sMask & (1 << b)) !== 0) {
            activeSellersInSubset.add(sellerArr[b]);
          }
        }

        // For sellers active in this subset, their listing shipping is zeroed out during DP
        // (the flat seller shipping fee is accounted for in evaluateCartCost)
        const adjustedOptions = allSelectableOptions.map(opt => {
          if (opt.type === 'listing' && opt.listing.seller) {
            const sKey = normalizeSeller(opt.listing.seller);
            if (activeSellersInSubset.has(sKey)) {
              // Strip per-listing shipping and tax on shipping for DP heuristic
              const p = Math.max(0, Number(opt.listing.price) || 0);
              const t = opt.listing.taxMode === 'rate'
                ? round2(p * taxRate)
                : (opt.listing.taxMode === 'manual' ? Number(opt.listing.manualTax) || 0 : 0);
              return {
                ...opt,
                effectiveCost: round2(p + t)
              };
            }
          }
          return opt;
        });

        const candidateCart = useExactDP
          ? (runExactDP(adjustedOptions, forcedOpts) || runGreedy(adjustedOptions, forcedOpts))
          : runGreedy(adjustedOptions, forcedOpts);

        if (candidateCart) {
          const cost = evaluateCartCost(candidateCart, settings);
          if (!bestCartCost || cost.total < bestCartCost.total) {
            bestCartCost = cost;
            bestCart = candidateCart;
          }
        }
      }
    }

    if (!bestCart) {
      bestCart = forcedOpts;
      bestCartCost = evaluateCartCost(bestCart, settings);
    }

    // Determine overlapping parts in winning cart
    const partCoverageCounts = new Map();
    parts.forEach(p => partCoverageCounts.set(p.id, 0));

    bestCart.forEach(opt => {
      if (opt.type === 'shop') {
        partCoverageCounts.set(opt.part.id, (partCoverageCounts.get(opt.part.id) || 0) + 1);
      } else {
        (opt.listing.partIds || []).forEach(pid => {
          if (partCoverageCounts.has(pid)) {
            partCoverageCounts.set(pid, partCoverageCounts.get(pid) + 1);
          }
        });
      }
    });

    const duplicatePartNames = [];
    partCoverageCounts.forEach((count, pid) => {
      if (count > 1) {
        const p = partsMap.get(pid);
        if (p) duplicatePartNames.push(p.name);
      }
    });

    // Classify winning items
    const winningListingsMap = new Map();
    const winningShopPartsMap = new Map();
    let purchasedTotal = 0;

    bestCart.forEach(opt => {
      if (opt.type === 'listing') {
        const cost = listingCost(opt.listing, settings);
        winningListingsMap.set(opt.listing.id, {
          listing: opt.listing,
          cost,
          isPurchased: opt.listing.state === 'purchased',
          isMust: opt.listing.state === 'must'
        });
        if (opt.listing.state === 'purchased') {
          purchasedTotal += cost.total;
        }
      } else if (opt.type === 'shop') {
        const cost = shopPartCost(opt.part, taxRate);
        winningShopPartsMap.set(opt.part.id, {
          part: opt.part,
          cost
        });
      }
    });

    // Calculate baseline shop quote total across all coverable parts
    let shopBaselinePreTax = 0;
    let shopBaselineTax = 0;
    let shopBaselineTotal = 0;

    parts.forEach(p => {
      if (Number(p.shopPrice) > 0) {
        const sc = shopPartCost(p, taxRate);
        shopBaselinePreTax += sc.price;
        shopBaselineTax += sc.tax;
        shopBaselineTotal += sc.total;
      }
    });

    shopBaselinePreTax = round2(shopBaselinePreTax);
    shopBaselineTax = round2(shopBaselineTax);
    shopBaselineTotal = round2(shopBaselineTotal);

    const totalSavings = round2(shopBaselineTotal - bestCartCost.total);
    const savingsPct = shopBaselineTotal > 0 ? round2((totalSavings / shopBaselineTotal) * 100) : 0;
    const toBuyTotal = round2(bestCartCost.total - purchasedTotal);

    return {
      bestCart,
      bestCartCost,
      winningListingsMap,
      winningShopPartsMap,
      uncoverableParts,
      duplicatePartNames,
      isApproximate: !useExactDP,
      summary: {
        shopBaselinePreTax,
        shopBaselineTax,
        shopBaselineTotal,
        optimalPreTax: bestCartCost.price,
        optimalShipping: bestCartCost.shipping,
        optimalTax: bestCartCost.tax,
        optimalTotal: bestCartCost.total,
        totalSavings,
        savingsPct,
        purchasedTotal: round2(purchasedTotal),
        toBuyTotal: Math.max(0, toBuyTotal),
        sellerCharges: bestCartCost.sellerCharges
      }
    };
  }

  /**
   * Evaluates each multi-part bundle listing head-to-head against buying
   * those exact same parts without that bundle.
   *
   * @param {Object} state
   * @param {Object} optimalSolution (optional cached output from solveOptimalCombination)
   * @returns {Map} Map of listing.id -> bundle verdict
   */
  function evaluateBundleVerdicts(state, optimalSolution = null) {
    const parts = state?.parts || [];
    const listings = state?.listings || [];
    const settings = state?.settings || {};
    const taxRate = Number(settings.taxRate) || 0.06625;

    const partsMap = new Map();
    parts.forEach(p => partsMap.set(p.id, p));

    const solution = optimalSolution || solveOptimalCombination(state);
    const winningListings = solution.winningListingsMap;

    const verdicts = new Map();

    listings.forEach(listing => {
      const partIds = (listing.partIds || []).filter(pid => partsMap.has(pid));
      if (partIds.length < 2) {
        // Individual listing
        const inCart = winningListings.has(listing.id);
        verdicts.set(listing.id, {
          isBundle: false,
          inCart,
          verdictType: inCart ? 'in_cart' : 'not_in_cart',
          badgeText: inCart ? '✓ Selected in Best Cart' : '',
          diffAmount: 0
        });
        return;
      }

      // Bundle listing!
      const bundleCost = listingCost(listing, settings).total;
      const inCart = winningListings.has(listing.id);

      // Solve for the cheapest way to cover partIds WITHOUT this bundle listing
      const subState = {
        settings,
        parts: partIds.map(pid => partsMap.get(pid)),
        listings: listings.filter(l => l.id !== listing.id)
      };

      const altSolution = solveOptimalCombination(subState);
      const altCost = altSolution.bestCartCost.total;
      const hasAlternative = altSolution.uncoverableParts.length === 0;

      if (!hasAlternative) {
        const missingNames = altSolution.uncoverableParts.map(p => p.name).join(', ');
        verdicts.set(listing.id, {
          isBundle: true,
          inCart,
          verdictType: 'only_source',
          badgeText: `Only source for: ${missingNames}`,
          diffAmount: 0,
          bundleCost,
          altCost: null
        });
      } else {
        const diff = round2(altCost - bundleCost);
        if (diff > 0) {
          // Bundle is cheaper by $diff
          verdicts.set(listing.id, {
            isBundle: true,
            inCart,
            verdictType: 'bundle_wins',
            badgeText: `Bundle saves $${diff.toFixed(2)} vs buying individually ($${bundleCost.toFixed(2)} vs $${altCost.toFixed(2)})`,
            diffAmount: diff,
            bundleCost,
            altCost
          });
        } else if (diff < 0) {
          // Individual is cheaper by -$diff
          const absDiff = Math.abs(diff);
          verdicts.set(listing.id, {
            isBundle: true,
            inCart,
            verdictType: 'individual_wins',
            badgeText: `Buying individually is $${absDiff.toFixed(2)} cheaper than this bundle ($${altCost.toFixed(2)} vs $${bundleCost.toFixed(2)})`,
            diffAmount: diff,
            bundleCost,
            altCost
          });
        } else {
          verdicts.set(listing.id, {
            isBundle: true,
            inCart,
            verdictType: 'tie',
            badgeText: `Same price as buying individually ($${bundleCost.toFixed(2)})`,
            diffAmount: 0,
            bundleCost,
            altCost
          });
        }
      }
    });

    return verdicts;
  }

  /**
   * Full state evaluation combining solver and per-bundle verdicts.
   */
  function evaluateState(state) {
    const solution = solveOptimalCombination(state);
    const verdicts = evaluateBundleVerdicts(state, solution);

    // Convert verdicts Map to plain object for JSON serialization
    const verdictsObj = {};
    verdicts.forEach((v, k) => {
      verdictsObj[k] = v;
    });

    return {
      solution,
      verdicts: verdictsObj
    };
  }

  return {
    round2,
    normalizeSeller,
    listingCost,
    shopPartCost,
    evaluateCartCost,
    solveOptimalCombination,
    evaluateBundleVerdicts,
    evaluateState
  };
});
