import { z } from 'zod';

export function isValidHttpUrl(urlStr: string): boolean {
  if (!urlStr) return true;
  try {
    const parsed = new URL(urlStr);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function extractVendorFromUrl(urlStr: string): string {
  if (!urlStr) return '';
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    if (host.startsWith('m.')) host = host.slice(2);
    if (host.startsWith('smile.')) host = host.slice(6);

    const knownMap: Record<string, string> = {
      'rockauto.com': 'RockAuto',
      'amazon.com': 'Amazon',
      'ebay.com': 'eBay',
      'newegg.com': 'Newegg',
      'microcenter.com': 'Micro Center',
      'bhphotovideo.com': 'B&H Photo',
      'bestbuy.com': 'Best Buy',
      'homedepot.com': 'Home Depot',
      'lowes.com': "Lowe's",
      'mcmaster.com': 'McMaster-Carr',
      'digikey.com': 'DigiKey',
      'mouser.com': 'Mouser',
      'fcpeuro.com': 'FCP Euro',
      'ecstuning.com': 'ECS Tuning',
      'summitracing.com': 'Summit Racing',
      'autozone.com': 'AutoZone',
      'oreillyauto.com': "O'Reilly Auto",
      'advanceautoparts.com': 'Advance Auto',
      'walmart.com': 'Walmart',
      'aliexpress.com': 'AliExpress',
      'adafruit.com': 'Adafruit',
      'sparkfun.com': 'SparkFun',
    };

    if (knownMap[host]) return knownMap[host];
    const base = host.split('.')[0];
    if (!base) return '';
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return '';
  }
}

export const PartSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  part_number: z.string().trim().max(100).nullable().optional().default(''),
  category_tag: z.string().trim().max(100).nullable().optional().default(''),
  required_qty: z.number().int().min(1).max(10000).default(1),
  sort_order: z.number().int().min(0).max(10000).default(0),
});

export const BundleMappingSchema = z.object({
  offering_id: z.string().min(1).max(64),
  part_id: z.string().min(1).max(64),
  yield_qty: z.number().int().min(1).max(10000).default(1),
});

export const OfferingSchema = z.object({
  id: z.string().min(1).max(64),
  vendor_name: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(300),
  part_number: z.string().trim().max(100).nullable().optional().default(''),
  reference_url: z
    .string()
    .trim()
    .max(2048)
    .nullable()
    .optional()
    .default('')
    .refine((val) => !val || isValidHttpUrl(val), {
      message: 'reference_url must use http: or https: protocol',
    }),
  price_cents: z.number().int().min(0).max(1_000_000_000),
  shipping_cents: z.number().int().min(0).max(100_000_000).default(0),
  discount_cents: z.number().int().min(0).max(1_000_000_000).default(0),
  max_purchasable_qty: z.number().int().min(1).max(100000).nullable().optional().default(null),
  in_stock: z.boolean().or(z.number().int().min(0).max(1)).default(true),
  notes: z.string().trim().max(500).nullable().optional().default(''),
  updated_at: z.number().int().optional(),
});

export const VendorProfileSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  vendor_name: z.string().trim().min(1).max(120),
  flat_shipping_cents: z.number().int().min(0).max(100_000_000).default(0),
  free_shipping_threshold_cents: z.number().int().min(0).max(1_000_000_000).nullable().optional().default(null),
  tax_rate_bps: z.number().int().min(0).max(10000).nullable().optional().default(null),
});

export const PurchaseRecordSchema = z.object({
  id: z.string().min(1).max(64),
  purchased_at: z.number().int(),
  actual_paid_cents: z.number().int().min(0).max(1_000_000_000),
  order_number: z.string().trim().max(100).nullable().optional().default(''),
  notes: z.string().trim().max(500).nullable().optional().default(''),
  offering_id: z.string().max(64).nullable().optional(),
  offering_qty: z.number().int().min(1).max(10000).nullable().optional(),
  part_id: z.string().max(64).nullable().optional(),
  part_qty: z.number().int().min(1).max(10000).nullable().optional(),
});

export const ProjectPayloadSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  client_project_uuid: z.string().min(1).max(64).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(100).nullable().optional().default('General'),
  currency: z.string().trim().min(3).max(3).default('USD'),
  default_tax_bps: z.number().int().min(0).max(10000).default(0),
  version: z.number().int().min(1).optional(),
  parts: z.array(PartSchema).max(200),
  offerings: z.array(OfferingSchema).max(500),
  bundle_mappings: z.array(BundleMappingSchema).max(5000),
  vendor_profiles: z.array(VendorProfileSchema).max(200).optional().default([]),
  purchases: z.array(PurchaseRecordSchema).max(500).optional().default([]),
});

export const GuestMigrationPayloadSchema = z.object({
  client_project_uuid: z.string().min(1).max(64),
  is_dirty: z.boolean(),
  project: ProjectPayloadSchema.extend({
    parts: z.array(PartSchema).max(10),
  }),
});

export const AuthRegisterSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(128),
  display_name: z.string().trim().min(1).max(100).optional(),
  guest_migration: GuestMigrationPayloadSchema.optional(),
});

export const AuthLoginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(128),
  guest_migration: GuestMigrationPayloadSchema.optional(),
});

export const OAuthSimulateSchema = z.object({
  provider: z.enum(['google', 'microsoft', 'reddit', 'meta']),
  provider_account_id: z.string().trim().min(1).max(255),
  email: z.string().trim().email().max(255),
  display_name: z.string().trim().min(1).max(100).optional(),
  guest_migration: GuestMigrationPayloadSchema.optional(),
});

export type Part = z.infer<typeof PartSchema>;
export type BundleMapping = z.infer<typeof BundleMappingSchema>;
export type Offering = z.infer<typeof OfferingSchema>;
export type VendorProfile = z.infer<typeof VendorProfileSchema>;
export type PurchaseRecord = z.infer<typeof PurchaseRecordSchema>;
export type ProjectPayload = z.infer<typeof ProjectPayloadSchema>;
export type GuestMigrationPayload = z.infer<typeof GuestMigrationPayloadSchema>;

export interface UserPublic {
  id: string;
  email: string;
  display_name: string;
  email_verified: boolean;
}
