import { describe, it, expect } from 'vitest';
import {
  BookmarkletPayloadSchema,
  normalizePartNumber,
  scoreBomMatch,
  evaluateImportConfidence,
  applyBookmarkletImportToProject,
  buildBookmarkletHref,
  VENDOR_SHIPPING_PRESETS,
  type BookmarkletPayload,
  type VerifiedBookmarkletCommit,
} from '../src/shared/bookmarklet.js';
import type { Part, ProjectPayload } from '../src/shared/types.js';

describe('Feature 2: Universal Part & Price Capture Bookmarklet & Confidence-Scored Receiver', () => {
  describe('Zod Schema & Security Validation', () => {
    it('validates a well-formed extracted payload', () => {
      const validPayload = {
        url: 'https://www.amazon.com/dp/B08N5WRWNW',
        canonicalUrl: 'https://www.amazon.com/dp/B08N5WRWNW',
        vendorHost: 'amazon.com',
        partName: 'Bosch Spark Plug',
        partNumber: 'FGR7DQP',
        price: 8.99,
        packageYield: 1,
      };

      const result = BookmarkletPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.currency).toBe('USD');
        expect(result.data.inStock).toBe(true);
        expect(result.data.packageYield).toBe(1);
      }
    });

    it('rejects protocol smuggling (javascript: or data: URLs)', () => {
      const malicious = {
        url: 'javascript:alert(document.cookie)',
        vendorHost: 'evil.com',
        partName: 'Malicious Item',
        price: 10,
      };

      const result = BookmarkletPayloadSchema.safeParse(malicious);
      expect(result.success).toBe(false);
    });
  });

  describe('Part Number Normalization & BOM Match Scoring', () => {
    it('normalizes part numbers by stripping hyphens, spaces, and case differences', () => {
      expect(normalizePartNumber('br-900-a')).toBe('BR900A');
      expect(normalizePartNumber(' FGR 7 DQP ')).toBe('FGR7DQP');
      expect(normalizePartNumber(null)).toBe('');
    });

    const sampleBomPart: Part = {
      id: 'part_spark',
      name: 'Platinum Spark Plug',
      part_number: 'FGR7DQP',
      category_tag: 'Ignition',
      required_qty: 4,
      sort_order: 0,
    };

    it('scores exact normalized MPN matches with 1.0', () => {
      const incoming: BookmarkletPayload = {
        url: 'https://fcpeuro.com/products/123',
        canonicalUrl: 'https://fcpeuro.com/products/123',
        vendorHost: 'fcpeuro.com',
        partName: 'Bosch Spark Plug (FGR-7-DQP)',
        partNumber: 'FGR-7-DQP',
        vendorSku: '',
        brand: 'Bosch',
        price: 9.5,
        currency: 'USD',
        packageYield: 1,
        bundleKeywordsFound: [],
        isLikelyBundleOrPack: false,
        shippingCost: 0,
        freeShippingDetected: true,
        shippingNote: '',
        inStock: true,
        extractionSource: ['adapter:fcpeuro'],
        capturedAt: Date.now(),
        installKey: 'key_123',
      };

      const score = scoreBomMatch(incoming, sampleBomPart);
      expect(score).toBe(1.0);
    });
  });

  describe('Confidence Evaluation Logic', () => {
    const existingParts: Part[] = [
      {
        id: 'p_spark',
        name: 'Spark Plug',
        part_number: '4417',
        category_tag: 'Ignition',
        required_qty: 4,
        sort_order: 0,
      },
    ];

    it('triggers AUTO_ADD_TO_EXISTING on exact MPN match with valid price', () => {
      const incoming: BookmarkletPayload = {
        url: 'https://amazon.com/dp/B123',
        canonicalUrl: 'https://amazon.com/dp/B123',
        vendorHost: 'amazon.com',
        partName: 'Bosch 4417 Spark Plug',
        partNumber: '4417',
        vendorSku: 'B123',
        brand: 'Bosch',
        price: 7.99,
        currency: 'USD',
        packageYield: 1,
        bundleKeywordsFound: [],
        isLikelyBundleOrPack: false,
        shippingCost: null,
        freeShippingDetected: false,
        shippingNote: '',
        inStock: true,
        extractionSource: [],
        capturedAt: Date.now(),
        installKey: 'test_key',
      };

      const evalResult = evaluateImportConfidence(
        incoming,
        existingParts,
        null,
        false,
        true,
        false
      );

      expect(evalResult.decision).toBe('AUTO_ADD_TO_EXISTING');
      expect(evalResult.targetBomPart?.id).toBe('p_spark');
      expect(evalResult.reasonsToConfirm.length).toBe(0);
    });

    it('triggers AUTO_ADD_TO_EXISTING when a BOM part is explicitly pinned', () => {
      const incoming: BookmarkletPayload = {
        url: 'https://rockauto.com/part1',
        canonicalUrl: 'https://rockauto.com/part1',
        vendorHost: 'rockauto.com',
        partName: 'Alternative Spark Plug',
        partNumber: 'DIFF-PN-99',
        vendorSku: '',
        brand: 'NGK',
        price: 6.5,
        currency: 'USD',
        packageYield: 1,
        bundleKeywordsFound: [],
        isLikelyBundleOrPack: false,
        shippingCost: 8.99,
        freeShippingDetected: false,
        shippingNote: '',
        inStock: true,
        extractionSource: [],
        capturedAt: Date.now(),
        installKey: 'test_key',
      };

      const evalResult = evaluateImportConfidence(
        incoming,
        existingParts,
        'p_spark', // Pinned part ID
        false,
        true,
        false
      );

      expect(evalResult.decision).toBe('AUTO_ADD_TO_EXISTING');
      expect(evalResult.targetBomPart?.id).toBe('p_spark');
    });

    it('requires confirmation when bundle or pack keywords are found', () => {
      const incoming: BookmarkletPayload = {
        url: 'https://amazon.com/dp/B4PK',
        canonicalUrl: 'https://amazon.com/dp/B4PK',
        vendorHost: 'amazon.com',
        partName: 'Spark Plug Pack of 4 Kit',
        partNumber: '4417',
        vendorSku: 'B4PK',
        brand: 'Bosch',
        price: 28.0,
        currency: 'USD',
        packageYield: 4,
        bundleKeywordsFound: ['pack of 4', 'Kit'],
        isLikelyBundleOrPack: true,
        shippingCost: 0,
        freeShippingDetected: true,
        shippingNote: '',
        inStock: true,
        extractionSource: [],
        capturedAt: Date.now(),
        installKey: 'test_key',
      };

      const evalResult = evaluateImportConfidence(
        incoming,
        existingParts,
        null,
        false,
        true,
        false
      );

      expect(evalResult.decision).toBe('NEEDS_CONFIRMATION');
      expect(evalResult.reasonsToConfirm.some((r) => r.includes('bundle/pack'))).toBe(true);
    });

    it('requires confirmation when price is missing', () => {
      const incoming: BookmarkletPayload = {
        url: 'https://mcmaster.com/1234',
        canonicalUrl: 'https://mcmaster.com/1234',
        vendorHost: 'mcmaster.com',
        partName: 'Hex Screw',
        partNumber: '1234',
        vendorSku: '1234',
        brand: 'McMaster',
        price: null,
        currency: 'USD',
        packageYield: 100,
        bundleKeywordsFound: [],
        isLikelyBundleOrPack: false,
        shippingCost: null,
        freeShippingDetected: false,
        shippingNote: '',
        inStock: true,
        extractionSource: [],
        capturedAt: Date.now(),
        installKey: 'test_key',
      };

      const evalResult = evaluateImportConfidence(
        incoming,
        existingParts,
        null,
        false,
        true,
        false
      );

      expect(evalResult.decision).toBe('NEEDS_CONFIRMATION');
      expect(evalResult.reasonsToConfirm.some((r) => r.includes('Price'))).toBe(true);
    });
  });

  describe('Project Mutation Reducer (applyBookmarkletImportToProject)', () => {
    const baseProject: ProjectPayload = {
      name: 'Tune-Up Project',
      parts: [
        {
          id: 'part_rotor',
          name: 'Brake Rotor',
          part_number: 'BR-100',
          category_tag: 'Brakes',
          required_qty: 2,
          sort_order: 0,
        },
      ],
      offerings: [],
      bundle_mappings: [],
      vendor_profiles: [],
      currency: 'USD',
      default_tax_bps: 650,
    };

    it('attaches offering to existing part and converts float dollars to integer cents', () => {
      const commit: VerifiedBookmarkletCommit = {
        bomAction: 'ATTACH_EXISTING',
        targetBomPartId: 'part_rotor',
        partName: 'Centric Premium Rotor',
        partNumber: 'BR-100',
        price: 34.5,
        packageYield: 1,
        shippingCost: 7.99,
        vendorName: 'RockAuto',
        referenceUrl: 'https://rockauto.com/rotor',
      };

      const updated = applyBookmarkletImportToProject(baseProject, commit);

      // Parts length unchanged
      expect(updated.parts.length).toBe(1);
      // Offering created with cents
      expect(updated.offerings.length).toBe(1);
      expect(updated.offerings[0].price_cents).toBe(3450);
      expect(updated.offerings[0].shipping_cents).toBe(799);
      expect(updated.offerings[0].vendor_name).toBe('RockAuto');

      // BundleMapping created linking offering to target part
      expect(updated.bundle_mappings.length).toBe(1);
      expect(updated.bundle_mappings[0].offering_id).toBe(updated.offerings[0].id);
      expect(updated.bundle_mappings[0].part_id).toBe('part_rotor');
      expect(updated.bundle_mappings[0].yield_qty).toBe(1);

      // Vendor profile upserted with RockAuto preset
      expect(updated.vendor_profiles?.some((vp) => vp.vendor_name === 'RockAuto')).toBe(true);
    });

    it('creates a new BOM part when bomAction is CREATE_NEW', () => {
      const commit: VerifiedBookmarkletCommit = {
        bomAction: 'CREATE_NEW',
        targetBomPartId: null,
        partName: 'Oil Filter',
        partNumber: 'OF-55',
        price: 11.99,
        packageYield: 1,
        shippingCost: 0,
        vendorName: 'Amazon',
        referenceUrl: 'https://amazon.com/dp/OF55',
      };

      const updated = applyBookmarkletImportToProject(baseProject, commit);

      expect(updated.parts.length).toBe(2);
      const newPart = updated.parts.find((p) => p.name === 'Oil Filter');
      expect(newPart).toBeDefined();
      expect(newPart?.part_number).toBe('OF-55');

      const newOffering = updated.offerings.find((o) => o.part_number === 'OF-55');
      expect(newOffering?.price_cents).toBe(1199);

      const mapping = updated.bundle_mappings.find((bm) => bm.offering_id === newOffering?.id);
      expect(mapping?.part_id).toBe(newPart?.id);
    });
  });

  describe('Bookmarklet Code Generation', () => {
    it('generates self-contained javascript: URI with origin, hash transport, and installKey', () => {
      const href = buildBookmarkletHref('user_install_key_abc');
      expect(href.startsWith('javascript:(function()')).toBe(true);
      expect(href).toContain('https://priceit.rbnd.cc');
      expect(href).toContain('#import_part=');
      expect(href).toContain('user_install_key_abc');
      expect(href).toContain('priceit_capture_window');
      // Verify no open-redirect or dangerous target
      expect(href).not.toContain('noopener=no');
    });

    it('parses as valid JavaScript without syntax errors or breaking single-line comments', () => {
      const href = buildBookmarkletHref('user_install_key_xyz123');
      const jsCode = href.replace(/^javascript:/, '');
      // Must compile cleanly with Function constructor without throwing SyntaxError
      expect(() => new Function(jsCode)).not.toThrow();
      // Ensure no single-line comments remain that could swallow syntax
      expect(jsCode).not.toContain('// 1. JSON-LD');
      expect(jsCode).not.toContain('// 2. Domain Adapters');
    });
  });
});
