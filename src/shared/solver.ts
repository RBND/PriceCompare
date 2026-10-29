import type { Part, Offering, BundleMapping, VendorProfile } from './types.js';

export interface SelectedOfferingPlan {
  offering: Offering;
  qty: number;
  unit_net_price_cents: number;
  line_subtotal_cents: number;
  line_item_shipping_cents: number;
  parts_covered: Array<{
    part_id: string;
    part_name: string;
    yield_per_unit: number;
    total_yield: number;
  }>;
}

export interface VendorOrderPlan {
  vendor_name: string;
  items: SelectedOfferingPlan[];
  subtotal_cents: number;
  shipping_cents: number;
  free_shipping_applied: boolean;
  free_shipping_threshold_cents: number | null;
  tax_rate_bps: number;
  tax_cents: number;
  total_cents: number;
}

export interface SparePartYield {
  part_id: string;
  part_name: string;
  required_qty: number;
  provided_qty: number;
  surplus_qty: number;
}

export interface SolverInput {
  parts: Part[];
  offerings: Offering[];
  bundle_mappings: BundleMapping[];
  vendor_profiles: VendorProfile[];
  default_tax_bps: number;
}

export interface SolverResult {
  status: 'optimal' | 'partial' | 'empty';
  uncovered_part_ids: string[];
  vendor_orders: VendorOrderPlan[];
  total_subtotal_cents: number;
  total_shipping_cents: number;
  total_tax_cents: number;
  grand_total_cents: number;
  baseline_single_item_cents: number | null;
  savings_vs_baseline_cents: number;
  spare_parts: SparePartYield[];
  components_count: number;
  solve_time_ms: number;
}

function getEffectiveUnitPrice(o: Offering): number {
  return Math.max(0, o.price_cents - (o.discount_cents || 0));
}

function isInStock(o: Offering): boolean {
  return o.in_stock === true || o.in_stock === 1;
}

function computePlanCost(
  counts: Int32Array,
  compOfferings: Offering[],
  vendorProfilesMap: Map<string, VendorProfile>,
  defaultTaxBps: number
): number {
  // Group by normalized (case-insensitive) vendor key
  const vendorSubtotals = new Map<string, number>();
  const vendorItemShipping = new Map<string, number>();

  for (let i = 0; i < compOfferings.length; i++) {
    const qty = counts[i];
    if (qty <= 0) continue;
    const o = compOfferings[i];
    const vKey = o.vendor_name.trim().toLowerCase();
    const netPrice = getEffectiveUnitPrice(o);
    vendorSubtotals.set(vKey, (vendorSubtotals.get(vKey) || 0) + qty * netPrice);
    vendorItemShipping.set(vKey, (vendorItemShipping.get(vKey) || 0) + qty * (o.shipping_cents || 0));
  }

  let totalCost = 0;
  for (const [vKey, subtotal] of vendorSubtotals.entries()) {
    const profile = vendorProfilesMap.get(vKey);
    const itemShip = vendorItemShipping.get(vKey) || 0;
    const flatShip = profile?.flat_shipping_cents || 0;
    const threshold = profile?.free_shipping_threshold_cents ?? null;

    let shipping = flatShip + itemShip;
    if (threshold !== null && threshold >= 0 && subtotal >= threshold) {
      shipping = 0;
    }

    const taxBps = profile?.tax_rate_bps ?? defaultTaxBps ?? 0;
    const tax = Math.round((subtotal * taxBps) / 10000);
    totalCost += subtotal + shipping + tax;
  }

  return totalCost;
}

/**
 * Solves a single connected component of parts & offerings using Branch-and-Bound
 * with greedy upper-bound initialization and lower-bound pruning, plus a 100ms timeout cap
 * with greedy + 2-opt local search fallback.
 */
function solveComponent(
  compParts: Part[],
  compOfferings: Offering[],
  yieldMatrix: number[][], // [offeringIdx][partIdx]
  vendorProfilesMap: Map<string, VendorProfile>,
  defaultTaxBps: number
): Int32Array {
  const numOfferings = compOfferings.length;
  const numParts = compParts.length;
  const required = new Int32Array(numParts);
  for (let p = 0; p < numParts; p++) {
    required[p] = compParts[p].required_qty;
  }

  // Max purchasable bound for each offering
  const maxBounds = new Int32Array(numOfferings);
  for (let i = 0; i < numOfferings; i++) {
    const o = compOfferings[i];
    let neededMax = 0;
    for (let p = 0; p < numParts; p++) {
      const y = yieldMatrix[i][p];
      if (y > 0) {
        const ceilNeed = Math.ceil(required[p] / y);
        if (ceilNeed > neededMax) neededMax = ceilNeed;
      }
    }
    if (o.max_purchasable_qty !== null && o.max_purchasable_qty !== undefined) {
      maxBounds[i] = Math.min(o.max_purchasable_qty, neededMax);
    } else {
      maxBounds[i] = neededMax;
    }
  }

  // Precompute optimistic minimum cost per unit of each part for lower-bound pruning
  const minCostPerUnitPart = new Float64Array(numParts);
  minCostPerUnitPart.fill(Infinity);
  for (let p = 0; p < numParts; p++) {
    for (let i = 0; i < numOfferings; i++) {
      const y = yieldMatrix[i][p];
      if (y > 0 && maxBounds[i] > 0) {
        // Optimistic unit cost: net price / total yield across parts
        const net = getEffectiveUnitPrice(compOfferings[i]);
        let totalYields = 0;
        for (let q = 0; q < numParts; q++) {
          totalYields += yieldMatrix[i][q];
        }
        const unitOptimistic = net / Math.max(y, totalYields);
        if (unitOptimistic < minCostPerUnitPart[p]) {
          minCostPerUnitPart[p] = unitOptimistic;
        }
      }
    }
    if (!Number.isFinite(minCostPerUnitPart[p])) {
      minCostPerUnitPart[p] = 0;
    }
  }

  // Greedy heuristic to establish initial upper bound
  const greedyCounts = new Int32Array(numOfferings);
  const greedyDeficit = new Int32Array(required);

  while (true) {
    let anyDeficit = false;
    for (let p = 0; p < numParts; p++) {
      if (greedyDeficit[p] > 0) {
        anyDeficit = true;
        break;
      }
    }
    if (!anyDeficit) break;

    let bestIdx = -1;
    let bestScore = Infinity;

    for (let i = 0; i < numOfferings; i++) {
      if (greedyCounts[i] >= maxBounds[i]) continue;
      let usefulYield = 0;
      for (let p = 0; p < numParts; p++) {
        if (greedyDeficit[p] > 0 && yieldMatrix[i][p] > 0) {
          usefulYield += Math.min(greedyDeficit[p], yieldMatrix[i][p]);
        }
      }
      if (usefulYield <= 0) continue;

      greedyCounts[i]++;
      const newCost = computePlanCost(greedyCounts, compOfferings, vendorProfilesMap, defaultTaxBps);
      greedyCounts[i]--;

      const score = newCost / usefulYield;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;
    greedyCounts[bestIdx]++;
    for (let p = 0; p < numParts; p++) {
      greedyDeficit[p] = Math.max(0, greedyDeficit[p] - yieldMatrix[bestIdx][p]);
    }
  }

  // 2-opt local search refinement on greedy solution (prune redundant items or swap 1-for-1)
  let greedyComplete = true;
  for (let p = 0; p < numParts; p++) {
    if (greedyDeficit[p] > 0) {
      greedyComplete = false;
      break;
    }
  }

  let bestCounts = new Int32Array(greedyCounts);
  let bestCost = greedyComplete
    ? computePlanCost(bestCounts, compOfferings, vendorProfilesMap, defaultTaxBps)
    : Infinity;

  if (greedyComplete) {
    // Prune any superfluous units in bestCounts
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < numOfferings; i++) {
        if (bestCounts[i] > 0) {
          bestCounts[i]--;
          let stillValid = true;
          for (let p = 0; p < numParts; p++) {
            let cov = 0;
            for (let j = 0; j < numOfferings; j++) cov += bestCounts[j] * yieldMatrix[j][p];
            if (cov < required[p]) {
              stillValid = false;
              break;
            }
          }
          if (stillValid) {
            const c = computePlanCost(bestCounts, compOfferings, vendorProfilesMap, defaultTaxBps);
            if (c <= bestCost) {
              bestCost = c;
              improved = true;
              continue;
            }
          }
          bestCounts[i]++;
        }
      }
    }
  }

  // Precompute suffix max capacity: can offerings [idx..numOfferings-1] cover remaining deficit?
  // Instead of static order, we branch by picking the first uncovered part and branching on offerings that cover it!
  const startTime = performance.now();
  const TIMEOUT_MS = 100;
  let timedOut = false;
  let nodesVisited = 0;

  const currentCounts = new Int32Array(numOfferings);
  const currentCovered = new Int32Array(numParts);

  // For each part, list offerings that have yield > 0 for that part, sorted by cost efficiency
  const partCandidateOfferings: number[][] = [];
  for (let p = 0; p < numParts; p++) {
    const candidates: number[] = [];
    for (let i = 0; i < numOfferings; i++) {
      if (yieldMatrix[i][p] > 0 && maxBounds[i] > 0) {
        candidates.push(i);
      }
    }
    candidates.sort((a, b) => {
      const costA = getEffectiveUnitPrice(compOfferings[a]) / yieldMatrix[a][p];
      const costB = getEffectiveUnitPrice(compOfferings[b]) / yieldMatrix[b][p];
      return costA - costB;
    });
    partCandidateOfferings.push(candidates);
  }

  function dfs(lastTargetPart: number, minCandidateIdxForSamePart: number) {
    if (timedOut) return;
    nodesVisited++;
    if ((nodesVisited & 127) === 0) {
      if (performance.now() - startTime > TIMEOUT_MS) {
        timedOut = true;
        return;
      }
    }

    // Find the most constrained uncovered part (fewest candidate offerings)
    let targetPart = -1;
    let minCandidates = Infinity;
    let optimisticRemainingLb = 0;

    for (let p = 0; p < numParts; p++) {
      const rem = required[p] - currentCovered[p];
      if (rem > 0) {
        optimisticRemainingLb += rem * minCostPerUnitPart[p];
        const cLen = partCandidateOfferings[p].length;
        if (cLen < minCandidates) {
          minCandidates = cLen;
          targetPart = p;
        }
      }
    }

    // Current base subtotal (without shipping/tax thresholds that might drop)
    let currentNetSubtotal = 0;
    for (let i = 0; i < numOfferings; i++) {
      if (currentCounts[i] > 0) {
        currentNetSubtotal += currentCounts[i] * getEffectiveUnitPrice(compOfferings[i]);
      }
    }

    if (targetPart === -1) {
      // All parts covered! Compute full exact vendor cost (with shipping thresholds & tax)
      const fullCost = computePlanCost(currentCounts, compOfferings, vendorProfilesMap, defaultTaxBps);
      if (fullCost < bestCost) {
        bestCost = fullCost;
        bestCounts.set(currentCounts);
      }
      return;
    }

    // Lower bound prune: net subtotal + optimistic remaining net cost cannot exceed bestCost
    if (currentNetSubtotal + optimisticRemainingLb >= bestCost) {
      return;
    }

    const candidates = partCandidateOfferings[targetPart];
    const startC = targetPart === lastTargetPart ? minCandidateIdxForSamePart : 0;

    for (let c = startC; c < candidates.length; c++) {
      const offIdx = candidates[c];
      if (currentCounts[offIdx] >= maxBounds[offIdx]) continue;

      currentCounts[offIdx]++;
      for (let p = 0; p < numParts; p++) {
        currentCovered[p] += yieldMatrix[offIdx][p];
      }

      dfs(targetPart, c);

      for (let p = 0; p < numParts; p++) {
        currentCovered[p] -= yieldMatrix[offIdx][p];
      }
      currentCounts[offIdx]--;

      if (timedOut) return;
    }
  }

  dfs(-1, 0);

  return bestCounts;
}

export function solveBundleOptimization(input: SolverInput): SolverResult {
  const startTime = performance.now();
  const { parts, offerings, bundle_mappings, vendor_profiles, default_tax_bps } = input;

  if (parts.length === 0) {
    return {
      status: 'empty',
      uncovered_part_ids: [],
      vendor_orders: [],
      total_subtotal_cents: 0,
      total_shipping_cents: 0,
      total_tax_cents: 0,
      grand_total_cents: 0,
      baseline_single_item_cents: null,
      savings_vs_baseline_cents: 0,
      spare_parts: [],
      components_count: 0,
      solve_time_ms: 0,
    };
  }

  const vendorProfilesMap = new Map<string, VendorProfile>();
  for (const vp of vendor_profiles || []) {
    vendorProfilesMap.set(vp.vendor_name.trim().toLowerCase(), vp);
  }

  const activeOfferings = offerings.filter(isInStock);

  // Map offering_id -> Map<part_id, yield_qty>
  const offeringYieldMap = new Map<string, Map<string, number>>();
  for (const bm of bundle_mappings) {
    if (bm.yield_qty <= 0) continue;
    let pMap = offeringYieldMap.get(bm.offering_id);
    if (!pMap) {
      pMap = new Map();
      offeringYieldMap.set(bm.offering_id, pMap);
    }
    pMap.set(bm.part_id, bm.yield_qty);
  }

  // Step 1: Identify coverable vs uncovered parts
  const coverableParts: Part[] = [];
  const uncoveredPartIds: string[] = [];

  for (const part of parts) {
    let totalMaxYield = 0;
    for (const off of activeOfferings) {
      const y = offeringYieldMap.get(off.id)?.get(part.id) || 0;
      if (y > 0) {
        if (off.max_purchasable_qty !== null && off.max_purchasable_qty !== undefined) {
          totalMaxYield += off.max_purchasable_qty * y;
        } else {
          totalMaxYield += part.required_qty;
        }
      }
    }
    if (totalMaxYield >= part.required_qty) {
      coverableParts.push(part);
    } else {
      uncoveredPartIds.push(part.id);
    }
  }

  if (coverableParts.length === 0) {
    return {
      status: 'partial',
      uncovered_part_ids: uncoveredPartIds,
      vendor_orders: [],
      total_subtotal_cents: 0,
      total_shipping_cents: 0,
      total_tax_cents: 0,
      grand_total_cents: 0,
      baseline_single_item_cents: null,
      savings_vs_baseline_cents: 0,
      spare_parts: [],
      components_count: 0,
      solve_time_ms: Number((performance.now() - startTime).toFixed(2)),
    };
  }

  const coverablePartIds = new Set(coverableParts.map((p) => p.id));
  const relevantOfferings = activeOfferings.filter((off) => {
    const pMap = offeringYieldMap.get(off.id);
    if (!pMap) return false;
    for (const pid of pMap.keys()) {
      if (coverablePartIds.has(pid)) return true;
    }
    return false;
  });

  // Step 2: Connected-Component Decomposition
  // Two parts p1, p2 are connected if:
  // a) They share a multi-part bundle offering
  // b) They have offerings from the same vendor AND that vendor has a joint shipping rule (flat_shipping_cents > 0 or free_shipping_threshold_cents !== null)
  const parent = new Map<string, string>();
  for (const p of coverableParts) parent.set(p.id, p.id);

  function find(id: string): string {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    let curr = id;
    while (curr !== root) {
      const nxt = parent.get(curr)!;
      parent.set(curr, root);
      curr = nxt;
    }
    return root;
  }

  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // (a) Multi-part bundle connections
  for (const off of relevantOfferings) {
    const pMap = offeringYieldMap.get(off.id);
    if (!pMap) continue;
    const pids = Array.from(pMap.keys()).filter((id) => coverablePartIds.has(id));
    for (let i = 1; i < pids.length; i++) {
      union(pids[0], pids[i]);
    }
  }

  // (b) Joint vendor shipping connections
  const vendorToParts = new Map<string, string[]>();
  for (const off of relevantOfferings) {
    const vKey = off.vendor_name.trim().toLowerCase();
    const profile = vendorProfilesMap.get(vKey);
    const hasJointShipping =
      (profile?.flat_shipping_cents && profile.flat_shipping_cents > 0) ||
      (profile?.free_shipping_threshold_cents !== null && profile?.free_shipping_threshold_cents !== undefined);

    if (hasJointShipping) {
      const pMap = offeringYieldMap.get(off.id);
      if (!pMap) continue;
      const list = vendorToParts.get(vKey) || [];
      for (const pid of pMap.keys()) {
        if (coverablePartIds.has(pid)) list.push(pid);
      }
      vendorToParts.set(vKey, list);
    }
  }

  for (const pids of vendorToParts.values()) {
    for (let i = 1; i < pids.length; i++) {
      union(pids[0], pids[i]);
    }
  }

  // Group parts and offerings by connected component root
  const componentPartsMap = new Map<string, Part[]>();
  for (const p of coverableParts) {
    const r = find(p.id);
    const arr = componentPartsMap.get(r) || [];
    arr.push(p);
    componentPartsMap.set(r, arr);
  }

  const globalSelectedQty = new Map<string, number>();

  for (const compParts of componentPartsMap.values()) {
    const compPartIdSet = new Set(compParts.map((p) => p.id));
    const compOfferings = relevantOfferings.filter((off) => {
      const pMap = offeringYieldMap.get(off.id);
      if (!pMap) return false;
      for (const pid of pMap.keys()) {
        if (compPartIdSet.has(pid)) return true;
      }
      return false;
    });

    const yieldMatrix: number[][] = compOfferings.map((off) => {
      const pMap = offeringYieldMap.get(off.id);
      return compParts.map((p) => pMap?.get(p.id) || 0);
    });

    const counts = solveComponent(compParts, compOfferings, yieldMatrix, vendorProfilesMap, default_tax_bps);
    for (let i = 0; i < compOfferings.length; i++) {
      if (counts[i] > 0) {
        globalSelectedQty.set(compOfferings[i].id, counts[i]);
      }
    }
  }

  // Step 3: Build VendorOrderPlans and Totals (grouped case-insensitively by vendor name)
  const vendorGroups = new Map<string, { displayName: string; offerings: Offering[] }>();
  for (const off of relevantOfferings) {
    const qty = globalSelectedQty.get(off.id) || 0;
    if (qty <= 0) continue;
    const trimmed = off.vendor_name.trim();
    const vKey = trimmed.toLowerCase();
    const profile = vendorProfilesMap.get(vKey);
    const existing = vendorGroups.get(vKey);
    if (existing) {
      existing.offerings.push(off);
    } else {
      vendorGroups.set(vKey, {
        displayName: profile?.vendor_name.trim() || trimmed,
        offerings: [off],
      });
    }
  }

  const partMap = new Map<string, Part>(parts.map((p) => [p.id, p]));
  const vendorOrders: VendorOrderPlan[] = [];
  let totalSubtotalCents = 0;
  let totalShippingCents = 0;
  let totalTaxCents = 0;
  let grandTotalCents = 0;

  for (const [vKey, group] of vendorGroups.entries()) {
    const vName = group.displayName;
    const vOfferings = group.offerings;
    const profile = vendorProfilesMap.get(vKey);
    let subtotalCents = 0;
    let itemShippingCents = 0;

    const items: SelectedOfferingPlan[] = vOfferings.map((off) => {
      const qty = globalSelectedQty.get(off.id)!;
      const unitNet = getEffectiveUnitPrice(off);
      const lineSub = qty * unitNet;
      const lineShip = qty * (off.shipping_cents || 0);
      subtotalCents += lineSub;
      itemShippingCents += lineShip;

      const pMap = offeringYieldMap.get(off.id) || new Map();
      const partsCovered = Array.from(pMap.entries())
        .filter(([, y]) => y > 0)
        .map(([pid, y]) => ({
          part_id: pid,
          part_name: partMap.get(pid)?.name || pid,
          yield_per_unit: y,
          total_yield: y * qty,
        }));

      return {
        offering: off,
        qty,
        unit_net_price_cents: unitNet,
        line_subtotal_cents: lineSub,
        line_item_shipping_cents: lineShip,
        parts_covered: partsCovered,
      };
    });

    const flatShip = profile?.flat_shipping_cents || 0;
    const threshold = profile?.free_shipping_threshold_cents ?? null;
    const freeShippingApplied = threshold !== null && threshold >= 0 && subtotalCents >= threshold;
    const shippingCents = freeShippingApplied ? 0 : flatShip + itemShippingCents;
    const taxRateBps = profile?.tax_rate_bps ?? default_tax_bps ?? 0;
    const taxCents = Math.round((subtotalCents * taxRateBps) / 10000);
    const totalCents = subtotalCents + shippingCents + taxCents;

    vendorOrders.push({
      vendor_name: vName,
      items,
      subtotal_cents: subtotalCents,
      shipping_cents: shippingCents,
      free_shipping_applied: freeShippingApplied,
      free_shipping_threshold_cents: threshold,
      tax_rate_bps: taxRateBps,
      tax_cents: taxCents,
      total_cents: totalCents,
    });

    totalSubtotalCents += subtotalCents;
    totalShippingCents += shippingCents;
    totalTaxCents += taxCents;
    grandTotalCents += totalCents;
  }

  vendorOrders.sort((a, b) => b.total_cents - a.total_cents);

  // Step 4: Calculate Spare / Bonus Parts Included
  const spareParts: SparePartYield[] = [];
  for (const part of coverableParts) {
    let provided = 0;
    for (const [offId, qty] of globalSelectedQty.entries()) {
      const y = offeringYieldMap.get(offId)?.get(part.id) || 0;
      provided += qty * y;
    }
    if (provided > part.required_qty) {
      spareParts.push({
        part_id: part.id,
        part_name: part.name,
        required_qty: part.required_qty,
        provided_qty: provided,
        surplus_qty: provided - part.required_qty,
      });
    }
  }

  // Step 5: Compute Single-Item Baseline (cheapest standalone single-part offerings, preferring yield_qty = 1)
  const singleCounts = new Int32Array(relevantOfferings.length);
  let allCoveredBySingles = true;

  for (const part of coverableParts) {
    // Check if there are strict individual single-unit offerings (yield_qty === 1 for this part only)
    let hasUnitSingle = false;
    for (let i = 0; i < relevantOfferings.length; i++) {
      const off = relevantOfferings[i];
      const pMap = offeringYieldMap.get(off.id);
      if (!pMap || pMap.size !== 1) continue;
      const y = pMap.get(part.id) || 0;
      if (y === 1) {
        const needQty = part.required_qty;
        if (off.max_purchasable_qty === null || off.max_purchasable_qty === undefined || needQty <= off.max_purchasable_qty) {
          hasUnitSingle = true;
          break;
        }
      }
    }

    let bestIdx = -1;
    let bestStandaloneCost = Infinity;
    let bestNeedQty = 0;

    for (let i = 0; i < relevantOfferings.length; i++) {
      const off = relevantOfferings[i];
      const pMap = offeringYieldMap.get(off.id);
      if (!pMap || pMap.size !== 1) continue;
      const y = pMap.get(part.id) || 0;
      if (y <= 0) continue;
      if (hasUnitSingle && y !== 1) continue;

      const needQty = Math.ceil(part.required_qty / y);
      if (off.max_purchasable_qty !== null && off.max_purchasable_qty !== undefined && needQty > off.max_purchasable_qty) {
        continue;
      }

      const vKey = off.vendor_name.trim().toLowerCase();
      const profile = vendorProfilesMap.get(vKey);
      const sub = needQty * getEffectiveUnitPrice(off);
      const itemShip = needQty * (off.shipping_cents || 0);
      const flatShip = profile?.flat_shipping_cents || 0;
      const threshold = profile?.free_shipping_threshold_cents ?? null;
      const ship = threshold !== null && threshold >= 0 && sub >= threshold ? 0 : flatShip + itemShip;
      const taxBps = profile?.tax_rate_bps ?? default_tax_bps ?? 0;
      const tax = Math.round((sub * taxBps) / 10000);
      const standaloneCost = sub + ship + tax;

      if (standaloneCost < bestStandaloneCost) {
        bestStandaloneCost = standaloneCost;
        bestIdx = i;
        bestNeedQty = needQty;
      }
    }

    if (bestIdx === -1) {
      allCoveredBySingles = false;
      break;
    }
    singleCounts[bestIdx] += bestNeedQty;
  }

  let baselineSingleItemCents: number | null = null;
  if (allCoveredBySingles) {
    baselineSingleItemCents = computePlanCost(singleCounts, relevantOfferings, vendorProfilesMap, default_tax_bps);
  }

  const savingsVsBaselineCents =
    baselineSingleItemCents !== null && baselineSingleItemCents > grandTotalCents
      ? baselineSingleItemCents - grandTotalCents
      : 0;

  return {
    status: uncoveredPartIds.length === 0 ? 'optimal' : 'partial',
    uncovered_part_ids: uncoveredPartIds,
    vendor_orders: vendorOrders,
    total_subtotal_cents: totalSubtotalCents,
    total_shipping_cents: totalShippingCents,
    total_tax_cents: totalTaxCents,
    grand_total_cents: grandTotalCents,
    baseline_single_item_cents: baselineSingleItemCents,
    savings_vs_baseline_cents: savingsVsBaselineCents,
    spare_parts: spareParts,
    components_count: componentPartsMap.size,
    solve_time_ms: Number((performance.now() - startTime).toFixed(2)),
  };
}
