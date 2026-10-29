import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath =
    dbPath ||
    process.env.DATABASE_PATH ||
    path.join(process.cwd(), 'data', 'priceit.db');

  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(resolvedPath);

  // Required SQLite PRAGMAs from Specification Section 6
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      email_verified INTEGER DEFAULT 0,
      display_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(provider, provider_account_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_project_uuid TEXT,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'General',
      currency TEXT DEFAULT 'USD',
      default_tax_bps INTEGER DEFAULT 0,
      version INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, client_project_uuid)
    );

    CREATE TABLE IF NOT EXISTS vendor_profiles (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      vendor_name TEXT NOT NULL,
      flat_shipping_cents INTEGER DEFAULT 0,
      free_shipping_threshold_cents INTEGER,
      tax_rate_bps INTEGER,
      UNIQUE(project_id, vendor_name)
    );

    CREATE TABLE IF NOT EXISTS parts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      part_number TEXT,
      category_tag TEXT,
      required_qty INTEGER NOT NULL DEFAULT 1 CHECK(required_qty >= 1 AND required_qty <= 10000),
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS offerings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      vendor_name TEXT NOT NULL,
      title TEXT NOT NULL,
      part_number TEXT,
      reference_url TEXT,
      price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
      shipping_cents INTEGER NOT NULL DEFAULT 0 CHECK(shipping_cents >= 0),
      discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(discount_cents >= 0),
      max_purchasable_qty INTEGER CHECK(max_purchasable_qty IS NULL OR max_purchasable_qty >= 1),
      in_stock INTEGER DEFAULT 1,
      notes TEXT,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS bundle_mappings (
      offering_id TEXT NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
      part_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
      yield_qty INTEGER NOT NULL DEFAULT 1 CHECK(yield_qty >= 1),
      PRIMARY KEY (offering_id, part_id)
    );

    CREATE TABLE IF NOT EXISTS project_shares (
      share_token TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      offering_id TEXT,
      offering_qty INTEGER,
      part_id TEXT,
      part_qty INTEGER,
      actual_paid_cents INTEGER NOT NULL DEFAULT 0,
      order_number TEXT,
      notes TEXT,
      purchased_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
    CREATE INDEX IF NOT EXISTS idx_parts_project_id ON parts(project_id);
    CREATE INDEX IF NOT EXISTS idx_offerings_project_id ON offerings(project_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_project_id ON purchases(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  `);

  return db;
}
