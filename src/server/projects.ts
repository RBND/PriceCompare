import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ProjectPayload,
  GuestMigrationPayload,
  Part,
  Offering,
  BundleMapping,
  VendorProfile,
  PurchaseRecord,
} from '../shared/types.js';
import { generateShareToken } from './auth.js';

export interface ProjectSummary {
  id: string;
  name: string;
  category: string;
  currency: string;
  parts_count: number;
  offerings_count: number;
  version: number;
  updated_at: number;
}

export function loadFullProject(db: Database.Database, projectId: string): (ProjectPayload & { share_token?: string | null }) | null {
  const proj = db
    .prepare(
      `SELECT id, user_id, client_project_uuid, name, category, currency, default_tax_bps, version, created_at, updated_at
       FROM projects WHERE id = ?`
    )
    .get(projectId) as
    | {
        id: string;
        user_id: string;
        client_project_uuid: string | null;
        name: string;
        category: string | null;
        currency: string;
        default_tax_bps: number;
        version: number;
        created_at: number;
        updated_at: number;
      }
    | undefined;

  if (!proj) return null;

  const parts = db
    .prepare(
      `SELECT id, name, part_number, category_tag, required_qty, sort_order
       FROM parts WHERE project_id = ? ORDER BY sort_order ASC, rowid ASC`
    )
    .all(projectId) as Part[];

  const rawOfferings = db
    .prepare(
      `SELECT id, vendor_name, title, part_number, reference_url, price_cents, shipping_cents, discount_cents, max_purchasable_qty, in_stock, notes, updated_at
       FROM offerings WHERE project_id = ? ORDER BY rowid ASC`
    )
    .all(projectId) as Array<Offering & { in_stock: number }>;

  const offerings: Offering[] = rawOfferings.map((o) => ({
    ...o,
    part_number: o.part_number || '',
    reference_url: o.reference_url || '',
    notes: o.notes || '',
    in_stock: Boolean(o.in_stock),
  }));

  const offeringIds = offerings.map((o) => o.id);
  let bundle_mappings: BundleMapping[] = [];
  if (offeringIds.length > 0) {
    const placeholders = offeringIds.map(() => '?').join(',');
    bundle_mappings = db
      .prepare(
        `SELECT offering_id, part_id, yield_qty
         FROM bundle_mappings
         WHERE offering_id IN (${placeholders})`
      )
      .all(...offeringIds) as BundleMapping[];
  }

  const vendor_profiles = db
    .prepare(
      `SELECT id, vendor_name, flat_shipping_cents, free_shipping_threshold_cents, tax_rate_bps
       FROM vendor_profiles WHERE project_id = ? ORDER BY vendor_name ASC`
    )
    .all(projectId) as VendorProfile[];

  const rawPurchases = db
    .prepare(
      `SELECT id, offering_id, offering_qty, part_id, part_qty, actual_paid_cents, order_number, notes, purchased_at
       FROM purchases WHERE project_id = ? ORDER BY purchased_at ASC, rowid ASC`
    )
    .all(projectId) as PurchaseRecord[];

  const shareRow = db
    .prepare(`SELECT share_token FROM project_shares WHERE project_id = ? AND is_active = 1`)
    .get(projectId) as { share_token: string } | undefined;

  return {
    id: proj.id,
    client_project_uuid: proj.client_project_uuid,
    name: proj.name,
    category: proj.category || 'General',
    currency: proj.currency || 'USD',
    default_tax_bps: proj.default_tax_bps || 0,
    version: proj.version,
    parts: parts.map((p) => ({
      ...p,
      part_number: p.part_number || '',
      category_tag: p.category_tag || '',
    })),
    offerings,
    bundle_mappings,
    vendor_profiles,
    purchases: rawPurchases.map((pr) => ({
      ...pr,
      order_number: pr.order_number || '',
      notes: pr.notes || '',
    })),
    share_token: shareRow?.share_token || null,
  };
}

/**
 * Replaces the child entities (parts, offerings, bundle_mappings, vendor_profiles) inside a transaction.
 * Because multiple projects might reuse client-side IDs like 'part-1', we namespace or ensure unique IDs per project if needed,
 * OR if an ID collides with another project's part/offering ID, we scope IDs cleanly.
 */
function scopeEntityId(projectId: string, rawId: string): string {
  const prefix = `${projectId}__`;
  return rawId.startsWith(prefix) ? rawId : `${prefix}${rawId}`;
}

function unscopeEntityId(projectId: string, scopedId: string): string {
  const prefix = `${projectId}__`;
  if (scopedId.startsWith(prefix)) {
    return scopedId.slice(prefix.length);
  }
  const legacyPrefix = `${projectId.slice(0, 8)}__`;
  return scopedId.startsWith(legacyPrefix) ? scopedId.slice(legacyPrefix.length) : scopedId;
}

export function loadFullProjectUnscoped(
  db: Database.Database,
  projectId: string
): (ProjectPayload & { share_token?: string | null }) | null {
  const loaded = loadFullProject(db, projectId);
  if (!loaded) return null;

  return {
    ...loaded,
    parts: loaded.parts.map((p) => ({
      ...p,
      id: unscopeEntityId(projectId, p.id),
    })),
    offerings: loaded.offerings.map((o) => ({
      ...o,
      id: unscopeEntityId(projectId, o.id),
    })),
    bundle_mappings: loaded.bundle_mappings.map((bm) => ({
      offering_id: unscopeEntityId(projectId, bm.offering_id),
      part_id: unscopeEntityId(projectId, bm.part_id),
      yield_qty: bm.yield_qty,
    })),
    vendor_profiles: loaded.vendor_profiles.map((vp) => ({
      ...vp,
      id: vp.id ? unscopeEntityId(projectId, vp.id) : undefined,
    })),
    purchases: (loaded.purchases || []).map((pr) => ({
      ...pr,
      offering_id: pr.offering_id ? unscopeEntityId(projectId, pr.offering_id) : undefined,
      part_id: pr.part_id ? unscopeEntityId(projectId, pr.part_id) : undefined,
    })),
  };
}

export function saveProjectGraph(
  db: Database.Database,
  userId: string,
  projectId: string,
  payload: ProjectPayload,
  isNew: boolean
): { version: number } {
  const now = Date.now();

  const tx = db.transaction(() => {
    let nextVersion = 1;

    if (isNew) {
      db.prepare(
        `INSERT INTO projects (id, user_id, client_project_uuid, name, category, currency, default_tax_bps, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(
        projectId,
        userId,
        payload.client_project_uuid || null,
        payload.name,
        payload.category || 'General',
        payload.currency || 'USD',
        payload.default_tax_bps || 0,
        now,
        now
      );
    } else {
      const existing = db
        .prepare(`SELECT version FROM projects WHERE id = ? AND user_id = ?`)
        .get(projectId, userId) as { version: number } | undefined;

      if (!existing) {
        throw new Error('NOT_FOUND');
      }

      if (payload.version !== undefined && payload.version !== existing.version) {
        const err = new Error('VERSION_CONFLICT') as Error & { currentVersion?: number };
        err.currentVersion = existing.version;
        throw err;
      }

      nextVersion = existing.version + 1;
      db.prepare(
        `UPDATE projects
         SET name = ?, category = ?, currency = ?, default_tax_bps = ?, version = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`
      ).run(
        payload.name,
        payload.category || 'General',
        payload.currency || 'USD',
        payload.default_tax_bps || 0,
        nextVersion,
        now,
        projectId,
        userId
      );

      // Clear existing children (cascades bundle_mappings)
      db.prepare(`DELETE FROM offerings WHERE project_id = ?`).run(projectId);
      db.prepare(`DELETE FROM parts WHERE project_id = ?`).run(projectId);
      db.prepare(`DELETE FROM vendor_profiles WHERE project_id = ?`).run(projectId);
      db.prepare(`DELETE FROM purchases WHERE project_id = ?`).run(projectId);
    }

    const insertPart = db.prepare(
      `INSERT OR REPLACE INTO parts (id, project_id, name, part_number, category_tag, required_qty, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const validPartScopedIds = new Set<string>();
    for (let i = 0; i < payload.parts.length; i++) {
      const p = payload.parts[i];
      const sId = scopeEntityId(projectId, p.id);
      validPartScopedIds.add(sId);
      insertPart.run(
        sId,
        projectId,
        p.name,
        p.part_number || null,
        p.category_tag || null,
        p.required_qty,
        p.sort_order ?? i
      );
    }

    const insertOffering = db.prepare(
      `INSERT OR REPLACE INTO offerings (id, project_id, vendor_name, title, part_number, reference_url, price_cents, shipping_cents, discount_cents, max_purchasable_qty, in_stock, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const validOfferingScopedIds = new Set<string>();
    for (const o of payload.offerings) {
      const sId = scopeEntityId(projectId, o.id);
      validOfferingScopedIds.add(sId);
      insertOffering.run(
        sId,
        projectId,
        o.vendor_name,
        o.title,
        o.part_number || null,
        o.reference_url || null,
        o.price_cents,
        o.shipping_cents || 0,
        o.discount_cents || 0,
        o.max_purchasable_qty ?? null,
        o.in_stock === false || o.in_stock === 0 ? 0 : 1,
        o.notes || null,
        now
      );
    }

    const insertMapping = db.prepare(
      `INSERT OR REPLACE INTO bundle_mappings (offering_id, part_id, yield_qty)
       VALUES (?, ?, ?)`
    );

    for (const bm of payload.bundle_mappings) {
      const sOff = scopeEntityId(projectId, bm.offering_id);
      const sPart = scopeEntityId(projectId, bm.part_id);
      if (validOfferingScopedIds.has(sOff) && validPartScopedIds.has(sPart) && bm.yield_qty >= 1) {
        insertMapping.run(sOff, sPart, bm.yield_qty);
      }
    }

    const insertVendorProfile = db.prepare(
      `INSERT OR REPLACE INTO vendor_profiles (id, project_id, vendor_name, flat_shipping_cents, free_shipping_threshold_cents, tax_rate_bps)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    // Deduplicate vendor profiles case-insensitively by vendor_name
    const dedupedProfiles = new Map<string, VendorProfile>();
    for (const vp of payload.vendor_profiles || []) {
      dedupedProfiles.set(vp.vendor_name.trim().toLowerCase(), vp);
    }

    for (const [vKey, vp] of dedupedProfiles.entries()) {
      const nameHash = crypto.createHash('sha256').update(vKey).digest('hex').slice(0, 12);
      const vpId = scopeEntityId(projectId, vp.id || `vp-${nameHash}`);
      insertVendorProfile.run(
        vpId,
        projectId,
        vp.vendor_name.trim(),
        vp.flat_shipping_cents || 0,
        vp.free_shipping_threshold_cents ?? null,
        vp.tax_rate_bps ?? null
      );
    }

    const insertPurchase = db.prepare(
      `INSERT OR REPLACE INTO purchases (id, project_id, offering_id, offering_qty, part_id, part_qty, actual_paid_cents, order_number, notes, purchased_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const pr of payload.purchases || []) {
      const pId = scopeEntityId(projectId, pr.id || crypto.randomUUID());
      const sOff = pr.offering_id ? scopeEntityId(projectId, pr.offering_id) : null;
      const sPart = pr.part_id ? scopeEntityId(projectId, pr.part_id) : null;
      insertPurchase.run(
        pId,
        projectId,
        sOff,
        pr.offering_qty ?? null,
        sPart,
        pr.part_qty ?? null,
        pr.actual_paid_cents || 0,
        pr.order_number || null,
        pr.notes || null,
        pr.purchased_at || now
      );
    }

    return { version: nextVersion };
  });

  return tx();
}

/**
 * Idempotent Guest Migration:
 * When a guest signs up or logs in, if `is_dirty === true && parts.length > 0`,
 * the project is migrated once (`ON CONFLICT(user_id, client_project_uuid) DO NOTHING`).
 */
export function migrateGuestProjectIfDirty(
  db: Database.Database,
  userId: string,
  migration?: GuestMigrationPayload
): string | null {
  if (!migration) return null;
  if (!migration.is_dirty || migration.project.parts.length === 0) {
    return null;
  }

  const existing = db
    .prepare(`SELECT id FROM projects WHERE user_id = ? AND client_project_uuid = ?`)
    .get(userId, migration.client_project_uuid) as { id: string } | undefined;

  if (existing) {
    return existing.id;
  }

  const newProjectId = crypto.randomUUID();
  const payloadWithUuid: ProjectPayload = {
    ...migration.project,
    client_project_uuid: migration.client_project_uuid,
  };

  saveProjectGraph(db, userId, newProjectId, payloadWithUuid, true);
  return newProjectId;
}

export function listUserProjects(db: Database.Database, userId: string): ProjectSummary[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.category, p.currency, p.version, p.updated_at,
              (SELECT COUNT(*) FROM parts WHERE project_id = p.id) AS parts_count,
              (SELECT COUNT(*) FROM offerings WHERE project_id = p.id) AS offerings_count
       FROM projects p
       WHERE p.user_id = ?
       ORDER BY p.updated_at DESC`
    )
    .all(userId) as ProjectSummary[];

  return rows;
}

export function createOrGetShareToken(db: Database.Database, userId: string, projectId: string): string | null {
  const owned = db
    .prepare(`SELECT id FROM projects WHERE id = ? AND user_id = ?`)
    .get(projectId, userId) as { id: string } | undefined;

  if (!owned) return null;

  const existing = db
    .prepare(`SELECT share_token, is_active FROM project_shares WHERE project_id = ?`)
    .get(projectId) as { share_token: string; is_active: number } | undefined;

  if (existing) {
    if (!existing.is_active) {
      db.prepare(`UPDATE project_shares SET is_active = 1 WHERE project_id = ?`).run(projectId);
    }
    return existing.share_token;
  }

  const token = generateShareToken();
  db.prepare(
    `INSERT INTO project_shares (share_token, project_id, is_active, created_at)
     VALUES (?, ?, 1, ?)`
  ).run(token, projectId, Date.now());

  return token;
}

export function revokeShareToken(db: Database.Database, userId: string, projectId: string): boolean {
  const owned = db
    .prepare(`SELECT id FROM projects WHERE id = ? AND user_id = ?`)
    .get(projectId, userId) as { id: string } | undefined;

  if (!owned) return false;

  db.prepare(`DELETE FROM project_shares WHERE project_id = ?`).run(projectId);
  return true;
}
