'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_STATE } = require('./defaultData');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BACKUPS = 30;

function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function sanitizeString(val, maxLen = 2000) {
  if (val === null || val === undefined) return '';
  return String(val).slice(0, maxLen);
}

function sanitizeNumber(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Validates and normalizes incoming state against canonical schema,
 * ensuring all 38 baseline line items exist while preserving user quotes/bundles/settings.
 */
function normalizeState(raw) {
  const base = deepClone(DEFAULT_STATE);
  if (!raw || typeof raw !== 'object') {
    return base;
  }

  // Merge settings safely
  if (raw.settings && typeof raw.settings === 'object') {
    const allowedScopes = ['all_new', 'oem_only', 'full_38'];
    base.settings.viewScope = allowedScopes.includes(raw.settings.viewScope)
      ? raw.settings.viewScope
      : 'all_new';
    base.settings.includeLaborAndPaint = raw.settings.includeLaborAndPaint !== false;
    base.settings.includeTiresInTotals = raw.settings.includeTiresInTotals !== false;
    base.settings.searchQuery = sanitizeString(raw.settings.searchQuery, 200);
    base.settings.categoryFilter = sanitizeString(raw.settings.categoryFilter || 'ALL', 100);
    base.settings.statusFilter = sanitizeString(raw.settings.statusFilter || 'ALL', 100);
  }

  // Merge user-editable properties on the 38 line items
  if (Array.isArray(raw.lineItems)) {
    const incomingByLine = new Map();
    raw.lineItems.forEach((item) => {
      if (item && Number.isInteger(Number(item.lineNumber))) {
        incomingByLine.set(Number(item.lineNumber), item);
      }
    });

    base.lineItems = base.lineItems.map((defaultItem) => {
      const inc = incomingByLine.get(defaultItem.lineNumber);
      if (!inc) return defaultItem;

      const allowedModes = ['shop_new', 'standalone', 'bundle'];
      return {
        ...defaultItem,
        skipRepaint: Boolean(inc.skipRepaint),
        sourcingMode: allowedModes.includes(inc.sourcingMode)
          ? inc.sourcingMode
          : defaultItem.sourcingMode,
        activeQuoteId: inc.activeQuoteId ? sanitizeString(inc.activeQuoteId, 100) : null,
        activeBundleId: inc.activeBundleId ? sanitizeString(inc.activeBundleId, 100) : null,
        status: sanitizeString(inc.status || defaultItem.status, 80),
        notes: sanitizeString(
          inc.notes !== undefined ? inc.notes : defaultItem.notes,
          2000
        )
      };
    });
  }

  // Normalize standalone partQuotes
  if (Array.isArray(raw.partQuotes)) {
    base.partQuotes = raw.partQuotes
      .filter((q) => q && Number.isInteger(Number(q.lineNumber)))
      .slice(0, 500)
      .map((q) => ({
        id: sanitizeString(q.id || crypto.randomUUID(), 100),
        lineNumber: Number(q.lineNumber),
        vendor: sanitizeString(q.vendor, 200),
        listingUrl: sanitizeString(q.listingUrl, 2000),
        price: Math.max(0, sanitizeNumber(q.price, 0)),
        shipping: Math.max(0, sanitizeNumber(q.shipping, 0)),
        taxMode: ['none', 'rate', 'price_only_rate', 'manual'].includes(q.taxMode)
          ? q.taxMode
          : 'none',
        manualTax: Math.max(0, sanitizeNumber(q.manualTax, 0)),
        carrier: sanitizeString(q.carrier, 60),
        trackingNumber: sanitizeString(q.trackingNumber, 150),
        status: sanitizeString(q.status || 'Watching / Quoted', 80),
        notes: sanitizeString(q.notes, 2000),
        createdAt: sanitizeString(q.createdAt || new Date().toISOString(), 60)
      }));
  }

  // Normalize bundles
  if (Array.isArray(raw.bundles)) {
    base.bundles = raw.bundles
      .filter((b) => b && typeof b === 'object')
      .slice(0, 100)
      .map((b) => {
        const id = sanitizeString(b.id || crypto.randomUUID(), 100);
        const lineNumbers = Array.isArray(b.lineNumbers)
          ? Array.from(
              new Set(
                b.lineNumbers
                  .map((n) => Number(n))
                  .filter((n) => Number.isInteger(n) && n >= 1 && n <= 38)
              )
            )
          : [];
        const options = Array.isArray(b.options)
          ? b.options.slice(0, 100).map((opt) => ({
              id: sanitizeString(opt.id || crypto.randomUUID(), 100),
              vendor: sanitizeString(opt.vendor, 200),
              listingUrl: sanitizeString(opt.listingUrl, 2000),
              price: Math.max(0, sanitizeNumber(opt.price, 0)),
              shipping: Math.max(0, sanitizeNumber(opt.shipping, 0)),
              taxMode: ['none', 'rate', 'price_only_rate', 'manual'].includes(opt.taxMode)
                ? opt.taxMode
                : 'none',
              manualTax: Math.max(0, sanitizeNumber(opt.manualTax, 0)),
              carrier: sanitizeString(opt.carrier, 60),
              trackingNumber: sanitizeString(opt.trackingNumber, 150),
              status: sanitizeString(opt.status || 'Watching / Quoted', 80),
              notes: sanitizeString(opt.notes, 2000),
              createdAt: sanitizeString(opt.createdAt || new Date().toISOString(), 60)
            }))
          : [];

        return {
          id,
          name: sanitizeString(b.name || 'Unnamed Bundle', 200),
          lineNumbers,
          activeOptionId: b.activeOptionId
            ? sanitizeString(b.activeOptionId, 100)
            : options[0]?.id || null,
          options
        };
      });
  }

  base.updatedAt = new Date().toISOString();
  return base;
}

class StorageEngine {
  constructor() {
    ensureDirectories();
    this.state = this.loadFromDisk();
  }

  loadFromDisk() {
    ensureDirectories();
    if (fs.existsSync(STATE_FILE)) {
      try {
        const content = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(content);
        return normalizeState(parsed);
      } catch (err) {
        console.error('[Storage] Failed to parse state.json, checking backups:', err.message);
      }
    }
    const initial = normalizeState(DEFAULT_STATE);
    this.writeAtomically(initial, false);
    return initial;
  }

  writeAtomically(stateObj, createSnapshot = true) {
    ensureDirectories();
    const payload = JSON.stringify(stateObj, null, 2);
    const tmpFile = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;

    // Write + flush to temporary file first, then atomic rename
    const fd = fs.openSync(tmpFile, 'w');
    try {
      fs.writeFileSync(fd, payload, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpFile, STATE_FILE);

    if (createSnapshot) {
      this.createBackupSnapshot(payload);
    }
  }

  createBackupSnapshot(payloadString) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(BACKUP_DIR, `state-${stamp}.json`);
      fs.writeFileSync(backupFile, payloadString, 'utf8');

      // Prune older snapshots beyond MAX_BACKUPS
      const files = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('state-') && f.endsWith('.json'))
        .sort();

      if (files.length > MAX_BACKUPS) {
        const toDelete = files.slice(0, files.length - MAX_BACKUPS);
        toDelete.forEach((f) => {
          try {
            fs.unlinkSync(path.join(BACKUP_DIR, f));
          } catch (_) {}
        });
      }
    } catch (err) {
      console.error('[Storage] Snapshot warning:', err.message);
    }
  }

  getState() {
    return this.state;
  }

  saveState(incomingState, createSnapshot = true) {
    const normalized = normalizeState(incomingState);
    this.writeAtomically(normalized, createSnapshot);
    this.state = normalized;
    return this.state;
  }

  resetToDefault() {
    // Take a snapshot of current state before resetting
    this.createBackupSnapshot(JSON.stringify(this.state, null, 2));
    const fresh = normalizeState(DEFAULT_STATE);
    this.writeAtomically(fresh, true);
    this.state = fresh;
    return this.state;
  }

  listBackups() {
    ensureDirectories();
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('state-') && f.endsWith('.json'))
      .sort()
      .reverse();

    return files.map((filename) => {
      const fullPath = path.join(BACKUP_DIR, filename);
      const stat = fs.statSync(fullPath);
      return {
        filename,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString()
      };
    });
  }

  restoreBackup(filename) {
    const safeName = path.basename(String(filename || ''));
    const fullPath = path.join(BACKUP_DIR, safeName);
    if (!fs.existsSync(fullPath)) {
      throw new Error('Backup file not found');
    }
    const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    return this.saveState(raw, true);
  }
}

module.exports = {
  StorageEngine,
  normalizeState
};
