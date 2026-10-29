import { describe, it, expect } from 'vitest';
import { solveBundleOptimization } from '../src/shared/solver.js';
import { DEMO_BRAKE_PROJECT, DEMO_PC_PROJECT } from '../src/shared/demoData.js';
import type { Part, Offering, BundleMapping, VendorProfile } from '../src/shared/types.js';

describe('Bundle Solver — Minimum-Cost Integer Set Cover', () => {
  it('handles empty parts list gracefully', () => {
    const res = solveBundleOptimization({
      parts: [],
      offerings: [],
      bundle_mappings: [],
      vendor_profiles: [],
      default_tax_bps: 0,
    });
    expect(res.status).toBe('empty');
    expect(res.grand_total_cents).toBe(0);
    expect(res.vendor_orders).toHaveLength(0);
  });

  it('chooses overlapping bundles over disjoint parts when over-coverage is cheaper (Spec 5.1)', () => {
    // Spec 5.1 example:
    // Part 1: Rotors (qty 1), Part 2: Pads (qty 1), Part 3: Fluid (qty 1)
    // Bundle A [Rotors+Pads = $80] + Bundle B [Pads+Fluid = $25] = $105 with 1 spare Pad set
    // vs buying Fluid separately ($35) -> $80 + $35 = $115
    const parts: Part[] = [
      { id: 'rotors', name: 'Rotors', part_number: '', category_tag: '', required_qty: 1, sort_order: 0 },
      { id: 'pads', name: 'Pads', part_number: '', category_tag: '', required_qty: 1, sort_order: 1 },
      { id: 'fluid', name: 'Fluid', part_number: '', category_tag: '', required_qty: 1, sort_order: 2 },
    ];

    const offerings: Offering[] = [
      {
        id: 'bundle-a',
        vendor_name: 'VendorX',
        title: 'Bundle A (Rotors + Pads)',
        part_number: '',
        reference_url: '',
        price_cents: 8000,
        shipping_cents: 0,
        discount_cents: 0,
        max_purchasable_qty: 1,
        in_stock: true,
        notes: '',
      },
      {
        id: 'bundle-b',
        vendor_name: 'VendorX',
        title: 'Bundle B (Pads + Fluid)',
        part_number: '',
        reference_url: '',
        price_cents: 2500,
        shipping_cents: 0,
        discount_cents: 0,
        max_purchasable_qty: 1,
        in_stock: true,
        notes: '',
      },
      {
        id: 'fluid-single',
        vendor_name: 'VendorX',
        title: 'Fluid Single',
        part_number: '',
        reference_url: '',
        price_cents: 3500,
        shipping_cents: 0,
        discount_cents: 0,
        max_purchasable_qty: 5,
        in_stock: true,
        notes: '',
      },
    ];

    const bundle_mappings: BundleMapping[] = [
      { offering_id: 'bundle-a', part_id: 'rotors', yield_qty: 1 },
      { offering_id: 'bundle-a', part_id: 'pads', yield_qty: 1 },
      { offering_id: 'bundle-b', part_id: 'pads', yield_qty: 1 },
      { offering_id: 'bundle-b', part_id: 'fluid', yield_qty: 1 },
      { offering_id: 'fluid-single', part_id: 'fluid', yield_qty: 1 },
    ];

    const res = solveBundleOptimization({
      parts,
      offerings,
      bundle_mappings,
      vendor_profiles: [],
      default_tax_bps: 0,
    });

    expect(res.status).toBe('optimal');
    expect(res.grand_total_cents).toBe(10500); // $105.00
    expect(res.spare_parts).toHaveLength(1);
    expect(res.spare_parts[0].part_id).toBe('pads');
    expect(res.spare_parts[0].surplus_qty).toBe(1);
  });

  it('respects yield_qty for multi-packs (e.g. 4-pack spark plugs covering required_qty 4)', () => {
    const res = solveBundleOptimization({
      parts: DEMO_BRAKE_PROJECT.parts,
      offerings: DEMO_BRAKE_PROJECT.offerings,
      bundle_mappings: DEMO_BRAKE_PROJECT.bundle_mappings,
      vendor_profiles: DEMO_BRAKE_PROJECT.vendor_profiles,
      default_tax_bps: DEMO_BRAKE_PROJECT.default_tax_bps,
    });

    expect(res.status).toBe('optimal');
    expect(res.uncovered_part_ids).toHaveLength(0);
    expect(res.savings_vs_baseline_cents).toBeGreaterThan(0);
  });

  it('respects max_purchasable_qty limits and falls back to secondary offering for remaining deficit', () => {
    const parts: Part[] = [
      { id: 'gpu', name: 'GPU', part_number: '', category_tag: '', required_qty: 2, sort_order: 0 },
    ];
    const offerings: Offering[] = [
      {
        id: 'used-deal',
        vendor_name: 'eBay',
        title: 'Open Box GPU (Only 1 in stock)',
        part_number: '',
        reference_url: '',
        price_cents: 40000,
        shipping_cents: 0,
        discount_cents: 0,
        max_purchasable_qty: 1,
        in_stock: true,
        notes: '',
      },
      {
        id: 'retail-gpu',
        vendor_name: 'Newegg',
        title: 'Retail GPU',
        part_number: '',
        reference_url: '',
        price_cents: 55000,
        shipping_cents: 0,
        discount_cents: 0,
        max_purchasable_qty: 5,
        in_stock: true,
        notes: '',
      },
    ];
    const bundle_mappings: BundleMapping[] = [
      { offering_id: 'used-deal', part_id: 'gpu', yield_qty: 1 },
      { offering_id: 'retail-gpu', part_id: 'gpu', yield_qty: 1 },
    ];

    const res = solveBundleOptimization({
      parts,
      offerings,
      bundle_mappings,
      vendor_profiles: [],
      default_tax_bps: 0,
    });

    expect(res.status).toBe('optimal');
    expect(res.grand_total_cents).toBe(95000); // 1x $400 + 1x $550
  });

  it('consolidates vendor orders to unlock free shipping threshold when cheaper overall', () => {
    // Part A and Part B
    // Vendor 1 has Part A for $30 and Part B for $25 (Total $55 >= $50 free shipping threshold, flat shipping $15 waived!) -> $55
    // Vendor 2 has Part A for $26 (no shipping) and Vendor 1 Part B ($25 + $15 flat ship = $40) -> $66
    const parts: Part[] = [
      { id: 'pa', name: 'Part A', part_number: '', category_tag: '', required_qty: 1, sort_order: 0 },
      { id: 'pb', name: 'Part B', part_number: '', category_tag: '', required_qty: 1, sort_order: 1 },
    ];
    const offerings: Offering[] = [
      {
        id: 'v1-a',
        vendor_name: 'Vendor1',
        title: 'Part A at V1',
        part_number: '',
        reference_url: '',
        price_cents: 3000,
        shipping_cents: 0,
        discount_cents: 0,
        max_purchasable_qty: null,
        in_stock: true,
        notes: '',
      },
      {
        id: 'v1-b',
        vendor_name: 'Vendor1',
        title: 'Part B at V1',
        part_number: '',
        reference_url: '',
        price_cents: 2500,
        shipping_cents: 0,
        discount_cents: 0,
        max_purchasable_qty: null,
        in_stock: true,
        notes: '',
      },
      {
        id: 'v2-a',
        vendor_name: 'Vendor2',
        title: 'Part A at V2',
        part_number: '',
        reference_url: '',
        price_cents: 2600,
        shipping_cents: 0,
        discount_cents: 0,
        max_purchasable_qty: null,
        in_stock: true,
        notes: '',
      },
    ];
    const bundle_mappings: BundleMapping[] = [
      { offering_id: 'v1-a', part_id: 'pa', yield_qty: 1 },
      { offering_id: 'v1-b', part_id: 'pb', yield_qty: 1 },
      { offering_id: 'v2-a', part_id: 'pa', yield_qty: 1 },
    ];
    const vendor_profiles: VendorProfile[] = [
      {
        vendor_name: 'Vendor1',
        flat_shipping_cents: 1500,
        free_shipping_threshold_cents: 5000,
        tax_rate_bps: 0,
      },
    ];

    const res = solveBundleOptimization({
      parts,
      offerings,
      bundle_mappings,
      vendor_profiles,
      default_tax_bps: 0,
    });

    expect(res.status).toBe('optimal');
    expect(res.grand_total_cents).toBe(5500);
    expect(res.vendor_orders).toHaveLength(1);
    expect(res.vendor_orders[0].free_shipping_applied).toBe(true);
  });

  it('identifies partial coverage when a part has no in-stock offerings', () => {
    const parts: Part[] = [
      { id: 'p1', name: 'Covered Part', part_number: '', category_tag: '', required_qty: 1, sort_order: 0 },
      { id: 'p2', name: 'Uncovered Part', part_number: '', category_tag: '', required_qty: 1, sort_order: 1 },
    ];
    const offerings: Offering[] = [
      {
        id: 'o1',
        vendor_name: 'Amazon',
        title: 'Part 1',
        part_number: '',
        reference_url: '',
        price_cents: 1000,
        shipping_cents: 0,
        discount_cents: 0,
        max_purchasable_qty: null,
        in_stock: true,
        notes: '',
      },
    ];
    const bundle_mappings: BundleMapping[] = [{ offering_id: 'o1', part_id: 'p1', yield_qty: 1 }];

    const res = solveBundleOptimization({
      parts,
      offerings,
      bundle_mappings,
      vendor_profiles: [],
      default_tax_bps: 0,
    });

    expect(res.status).toBe('partial');
    expect(res.uncovered_part_ids).toEqual(['p2']);
    expect(res.grand_total_cents).toBe(1000);
  });

  it('decomposes large 50-part independent projects into connected components and solves in <50ms', () => {
    const parts: Part[] = [];
    const offerings: Offering[] = [];
    const bundle_mappings: BundleMapping[] = [];

    for (let i = 0; i < 50; i++) {
      const pid = `p-${i}`;
      const oid = `o-${i}`;
      parts.push({
        id: pid,
        name: `Component Part ${i}`,
        part_number: `SKU-${i}`,
        category_tag: 'Bulk',
        required_qty: 2,
        sort_order: i,
      });
      offerings.push({
        id: oid,
        vendor_name: `Vendor-${i}`,
        title: `Offering ${i}`,
        part_number: `VSKU-${i}`,
        reference_url: '',
        price_cents: 1000,
        shipping_cents: 0,
        discount_cents: 0,
        max_purchasable_qty: null,
        in_stock: true,
        notes: '',
      });
      bundle_mappings.push({ offering_id: oid, part_id: pid, yield_qty: 1 });
    }

    const res = solveBundleOptimization({
      parts,
      offerings,
      bundle_mappings,
      vendor_profiles: [],
      default_tax_bps: 0,
    });

    expect(res.status).toBe('optimal');
    expect(res.components_count).toBe(50);
    expect(res.grand_total_cents).toBe(50 * 2 * 1000);
    expect(res.solve_time_ms).toBeLessThan(50);
  });

  it('solves DEMO_PC_PROJECT and picks the Micro Center CPU+Mobo+RAM bundle', () => {
    const res = solveBundleOptimization({
      parts: DEMO_PC_PROJECT.parts,
      offerings: DEMO_PC_PROJECT.offerings,
      bundle_mappings: DEMO_PC_PROJECT.bundle_mappings,
      vendor_profiles: DEMO_PC_PROJECT.vendor_profiles,
      default_tax_bps: DEMO_PC_PROJECT.default_tax_bps,
    });

    expect(res.status).toBe('optimal');
    const mcOrder = res.vendor_orders.find((vo) => vo.vendor_name === 'Micro Center');
    expect(mcOrder).toBeDefined();
    expect(mcOrder?.items[0].offering.id).toBe('pc-off-mc-combo');
  });

  it('consolidates vendor orders case-insensitively ("RockAuto" and "rockauto") to meet free-shipping threshold', () => {
    const parts: Part[] = [
      { id: 'pa', name: 'Part A', part_number: '', category_tag: '', required_qty: 1, sort_order: 0 },
      { id: 'pb', name: 'Part B', part_number: '', category_tag: '', required_qty: 1, sort_order: 1 },
    ];
    const offerings: Offering[] = [
      {
        id: 'o1',
        vendor_name: 'RockAuto',
        title: 'Part A',
        part_number: '',
        reference_url: '',
        price_cents: 3000,
        shipping_cents: 0,
        discount_cents: 0,
        max_purchasable_qty: null,
        in_stock: true,
        notes: '',
      },
      {
        id: 'o2',
        vendor_name: 'rockauto',
        title: 'Part B',
        part_number: '',
        reference_url: '',
        price_cents: 2500,
        shipping_cents: 0,
        discount_cents: 0,
        max_purchasable_qty: null,
        in_stock: true,
        notes: '',
      },
    ];
    const bundle_mappings: BundleMapping[] = [
      { offering_id: 'o1', part_id: 'pa', yield_qty: 1 },
      { offering_id: 'o2', part_id: 'pb', yield_qty: 1 },
    ];
    const vendor_profiles: VendorProfile[] = [
      {
        vendor_name: 'RockAuto',
        flat_shipping_cents: 1000,
        free_shipping_threshold_cents: 5000,
        tax_rate_bps: 0,
      },
    ];

    const res = solveBundleOptimization({
      parts,
      offerings,
      bundle_mappings,
      vendor_profiles,
      default_tax_bps: 0,
    });

    expect(res.status).toBe('optimal');
    expect(res.vendor_orders).toHaveLength(1);
    expect(res.vendor_orders[0].vendor_name).toBe('RockAuto');
    expect(res.vendor_orders[0].free_shipping_applied).toBe(true);
    expect(res.grand_total_cents).toBe(5500);
  });

  it('includes vendor flat_shipping_cents when selecting single-item baseline so non-bundle projects report 0 fake savings', () => {
    const parts: Part[] = [
      { id: 'pa', name: 'Part A', part_number: '', category_tag: '', required_qty: 1, sort_order: 0 },
    ];
    const offerings: Offering[] = [
      {
        id: 'v1-a',
        vendor_name: 'Vendor1',
        title: 'Part A with High Flat Shipping',
        part_number: '',
        reference_url: '',
        price_cents: 3000,
        shipping_cents: 0,
        discount_cents: 0,
        max_purchasable_qty: null,
        in_stock: true,
        notes: '',
      },
      {
        id: 'v2-a',
        vendor_name: 'Vendor2',
        title: 'Part A with Free Shipping',
        part_number: '',
        reference_url: '',
        price_cents: 3200,
        shipping_cents: 0,
        discount_cents: 0,
        max_purchasable_qty: null,
        in_stock: true,
        notes: '',
      },
    ];
    const bundle_mappings: BundleMapping[] = [
      { offering_id: 'v1-a', part_id: 'pa', yield_qty: 1 },
      { offering_id: 'v2-a', part_id: 'pa', yield_qty: 1 },
    ];
    const vendor_profiles: VendorProfile[] = [
      { vendor_name: 'Vendor1', flat_shipping_cents: 2000, free_shipping_threshold_cents: null, tax_rate_bps: 0 },
      { vendor_name: 'Vendor2', flat_shipping_cents: 0, free_shipping_threshold_cents: null, tax_rate_bps: 0 },
    ];

    const res = solveBundleOptimization({
      parts,
      offerings,
      bundle_mappings,
      vendor_profiles,
      default_tax_bps: 0,
    });

    expect(res.grand_total_cents).toBe(3200);
    expect(res.baseline_single_item_cents).toBe(3200);
    expect(res.savings_vs_baseline_cents).toBe(0);
  });
});
