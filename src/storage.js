'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_STATE, createBlankState } = require('./defaultData');

class StorageEngine {
  constructor(dataDir = null) {
    this.dataDir = dataDir || path.join(__dirname, '..', 'data');
    this.projectsDir = path.join(this.dataDir, 'projects');
    this.backupsDir = path.join(this.dataDir, 'backups');
    this.stateFile = path.join(this.dataDir, 'state.json'); // Legacy state file
    this.ensureDirs();
  }

  ensureDirs() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.projectsDir)) {
      fs.mkdirSync(this.projectsDir, { recursive: true });
    }
    if (!fs.existsSync(this.backupsDir)) {
      fs.mkdirSync(this.backupsDir, { recursive: true });
    }
    this.autoMigrateIfEmpty();
  }

  isValidProjectId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
  }

  getProjectFilePath(id) {
    if (!this.isValidProjectId(id)) {
      throw new Error(`Invalid project identifier: "${id}". Must be 1-64 alphanumeric characters, underscores, or hyphens.`);
    }
    const resolved = path.resolve(this.projectsDir, `${id}.json`);
    const resolvedProjectsDir = path.resolve(this.projectsDir);
    if (!resolved.startsWith(resolvedProjectsDir + path.sep)) {
      throw new Error('Security Error: Directory traversal detected');
    }
    return resolved;
  }

  autoMigrateIfEmpty() {
    try {
      const existingProjectFiles = fs.readdirSync(this.projectsDir).filter(f => f.endsWith('.json'));
      if (existingProjectFiles.length > 0) {
        return; // Already initialized
      }

      console.log('[Storage] Initializing projects directory...');
      let initialState = null;

      // Migrate existing state.json if present
      if (fs.existsSync(this.stateFile)) {
        try {
          let content = fs.readFileSync(this.stateFile, 'utf8');
          if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
          }
          const raw = JSON.parse(content);
          initialState = this.validateAndNormalize(raw);
          console.log('[Storage] Successfully migrated legacy data/state.json into multi-project format.');
        } catch (e) {
          console.warn('[Storage] Could not parse existing state.json, using default template:', e.message);
        }
      }

      if (!initialState) {
        initialState = JSON.parse(JSON.stringify(DEFAULT_STATE));
      }

      const initialId = 'corvette-z51';
      const targetFile = path.join(this.projectsDir, `${initialId}.json`);
      fs.writeFileSync(targetFile, JSON.stringify(initialState, null, 2), 'utf8');
      console.log(`[Storage] Created default project at data/projects/${initialId}.json`);
    } catch (err) {
      console.error('[Storage] Error during project auto-migration:', err);
    }
  }

  validateAndNormalize(rawState) {
    if (!rawState || typeof rawState !== 'object') {
      return JSON.parse(JSON.stringify(DEFAULT_STATE));
    }

    // Migrate from v1 if detected
    if (rawState.version === 1 || rawState.lineItems) {
      console.log('[Storage] Migrating legacy v1 state to v2 default state...');
      return JSON.parse(JSON.stringify(DEFAULT_STATE));
    }

    const settings = rawState.settings || {};
    const taxRate = typeof settings.taxRate === 'number' ? settings.taxRate : 0.06625;
    const zipCode = String(settings.zipCode || '08879').trim();
    const sellerShipping = settings.sellerShipping && typeof settings.sellerShipping === 'object'
      ? settings.sellerShipping
      : {};

    const rawParts = Array.isArray(rawState.parts) ? rawState.parts : [];
    const parts = rawParts.map((p, idx) => ({
      id: String(p.id || 'part-' + idx),
      name: String(p.name || 'Unnamed Part').trim(),
      partNumbers: Array.isArray(p.partNumbers)
        ? p.partNumbers.map(n => String(n).trim()).filter(Boolean)
        : [],
      shopPrice: Math.max(0, Number(p.shopPrice) || 0),
      shopTaxable: p.shopTaxable !== false,
      notes: String(p.notes || '').trim()
    }));

    const validPartIds = new Set(parts.map(p => p.id));

    const rawListings = Array.isArray(rawState.listings) ? rawState.listings : [];
    const validStates = new Set(['normal', 'must', 'purchased', 'excluded']);
    const validTaxModes = new Set(['rate', 'none', 'manual']);
    const validShippingModes = new Set(['free', 'amount', 'unknown']);

    const listings = rawListings.map((l, idx) => {
      // Filter out partIds that no longer exist
      const partIds = Array.isArray(l.partIds)
        ? l.partIds.filter(pid => validPartIds.has(pid))
        : [];

      const shippingMode = validShippingModes.has(l.shippingMode)
        ? l.shippingMode
        : (l.freeShipping ? 'free' : 'amount');

      return {
        id: String(l.id || 'listing-' + idx),
        title: String(l.title || 'Untitled Listing').trim(),
        seller: String(l.seller || '').trim(),
        url: String(l.url || '').trim(),
        ebayItemId: l.ebayItemId ? String(l.ebayItemId).trim() : null,
        condition: String(l.condition || 'Used').trim(),
        partIds,
        price: Math.max(0, Number(l.price) || 0),
        shippingMode,
        freeShipping: shippingMode === 'free',
        shipping: shippingMode === 'amount' ? Math.max(0, Number(l.shipping) || 0) : 0,
        taxMode: validTaxModes.has(l.taxMode) ? l.taxMode : 'rate',
        manualTax: Math.max(0, Number(l.manualTax) || 0),
        state: validStates.has(l.state) ? l.state : 'normal',
        finalCost: (l.finalCost !== undefined && l.finalCost !== null && l.finalCost !== '' && !isNaN(Number(l.finalCost)))
          ? Math.max(0, Number(l.finalCost))
          : null,
        finalPrice: (l.finalPrice !== undefined && l.finalPrice !== null && l.finalPrice !== '' && !isNaN(Number(l.finalPrice)))
          ? Math.max(0, Number(l.finalPrice))
          : null,
        finalShipping: (l.finalShipping !== undefined && l.finalShipping !== null && l.finalShipping !== '' && !isNaN(Number(l.finalShipping)))
          ? Math.max(0, Number(l.finalShipping))
          : null,
        finalTax: (l.finalTax !== undefined && l.finalTax !== null && l.finalTax !== '' && !isNaN(Number(l.finalTax)))
          ? Math.max(0, Number(l.finalTax))
          : null,
        purchaseNotes: String(l.purchaseNotes || '').trim(),
        notes: String(l.notes || '').trim(),
        lastFetchedAt: l.lastFetchedAt || null,
        fetchStatus: l.fetchStatus || null
      };
    });

    return {
      version: 2,
      updatedAt: rawState.updatedAt || new Date().toISOString(),
      settings: {
        projectName: String(settings.projectName || 'Car Parts Price Optimizer').trim(),
        taxRate,
        zipCode,
        sellerShipping
      },
      parts,
      listings
    };
  }

  listProjects() {
    try {
      const files = fs.readdirSync(this.projectsDir).filter(f => f.endsWith('.json') && !f.includes('.tmp.'));
      const projects = [];

      for (const file of files) {
        const id = file.slice(0, -5);
        try {
          const filePath = path.join(this.projectsDir, file);
          let content = fs.readFileSync(filePath, 'utf8');
          if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
          const raw = JSON.parse(content);
          projects.push({
            id,
            name: raw.settings?.projectName || id,
            updatedAt: raw.updatedAt || new Date().toISOString(),
            partsCount: Array.isArray(raw.parts) ? raw.parts.length : 0,
            listingsCount: Array.isArray(raw.listings) ? raw.listings.length : 0
          });
        } catch (e) {
          console.warn(`[Storage] Skipping invalid project file ${file}:`, e.message);
        }
      }

      // Sort by updatedAt descending
      return projects.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    } catch (err) {
      console.error('[Storage] Error listing projects:', err);
      return [];
    }
  }

  getDefaultProjectId() {
    const list = this.listProjects();
    if (list.length > 0) {
      return list[0].id;
    }
    return 'corvette-z51';
  }

  getProject(id) {
    const safeId = id || this.getDefaultProjectId();
    const filePath = this.getProjectFilePath(safeId);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      let content = fs.readFileSync(filePath, 'utf8');
      if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
      const raw = JSON.parse(content);
      return this.validateAndNormalize(raw);
    } catch (err) {
      console.error(`[Storage] Error reading project ${safeId}:`, err.message);
      return null;
    }
  }

  saveProject(id, incomingState, createSnapshot = true) {
    const safeId = id || this.getDefaultProjectId();
    const filePath = this.getProjectFilePath(safeId);

    const normalized = this.validateAndNormalize(incomingState);
    normalized.updatedAt = new Date().toISOString();

    const json = JSON.stringify(normalized, null, 2);
    const tempFile = path.join(this.projectsDir, `${safeId}.tmp.${Date.now()}`);

    // Atomic write-ahead: write temp -> fsync -> rename
    const fd = fs.openSync(tempFile, 'w');
    fs.writeSync(fd, json, 0, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    fs.renameSync(tempFile, filePath);

    if (createSnapshot) {
      this.createSnapshot(safeId, json);
    }

    return normalized;
  }

  createProject(name, template = 'blank') {
    const cleanName = String(name || 'New Project').trim();
    let baseSlug = cleanName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';

    // Ensure unique ID
    let finalId = baseSlug;
    let counter = 1;
    while (fs.existsSync(path.join(this.projectsDir, `${finalId}.json`))) {
      counter++;
      finalId = `${baseSlug}-${counter}`;
    }

    let newState;
    if (template === 'default') {
      newState = JSON.parse(JSON.stringify(DEFAULT_STATE));
      newState.settings.projectName = cleanName;
    } else {
      newState = createBlankState(cleanName);
    }

    const saved = this.saveProject(finalId, newState, false);
    return { id: finalId, state: saved };
  }

  duplicateProject(sourceId, newName = null) {
    const sourceState = this.getProject(sourceId);
    if (!sourceState) {
      throw new Error(`Source project not found: ${sourceId}`);
    }

    const cleanName = String(newName || `${sourceState.settings.projectName} (Copy)`).trim();
    let baseSlug = cleanName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project-copy';

    let finalId = baseSlug;
    let counter = 1;
    while (fs.existsSync(path.join(this.projectsDir, `${finalId}.json`))) {
      counter++;
      finalId = `${baseSlug}-${counter}`;
    }

    const clonedState = JSON.parse(JSON.stringify(sourceState));
    clonedState.settings.projectName = cleanName;
    clonedState.updatedAt = new Date().toISOString();

    const saved = this.saveProject(finalId, clonedState, true);
    return { id: finalId, state: saved };
  }

  renameProject(id, newName) {
    const state = this.getProject(id);
    if (!state) {
      throw new Error(`Project not found: ${id}`);
    }
    state.settings.projectName = String(newName || state.settings.projectName).trim();
    return this.saveProject(id, state, false);
  }

  deleteProject(id) {
    const projects = this.listProjects();
    if (projects.length <= 1) {
      throw new Error('Cannot delete the only remaining project.');
    }

    const filePath = this.getProjectFilePath(id);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Project not found: ${id}`);
    }

    fs.unlinkSync(filePath);

    // Prune backups associated with this project
    try {
      const files = fs.readdirSync(this.backupsDir).filter(f => f.startsWith(`${id}-state-`));
      files.forEach(f => {
        try { fs.unlinkSync(path.join(this.backupsDir, f)); } catch {}
      });
    } catch {}

    return { ok: true, deletedId: id };
  }

  createSnapshot(projectId, jsonContent) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const snapFile = path.join(this.backupsDir, `${projectId}-state-${timestamp}.json`);
      fs.writeFileSync(snapFile, jsonContent, 'utf8');
      this.pruneSnapshots(projectId, 30);
    } catch (err) {
      console.warn('[Storage] Snapshot creation warning:', err.message);
    }
  }

  pruneSnapshots(projectId, keepCount = 30) {
    try {
      const prefix = `${projectId}-state-`;
      const files = fs
        .readdirSync(this.backupsDir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
        .map(f => ({
          filename: f,
          path: path.join(this.backupsDir, f),
          time: fs.statSync(path.join(this.backupsDir, f)).mtimeMs
        }))
        .sort((a, b) => b.time - a.time);

      if (files.length > keepCount) {
        files.slice(keepCount).forEach(f => {
          try {
            fs.unlinkSync(f.path);
          } catch {}
        });
      }
    } catch (err) {
      console.warn('[Storage] Prune snapshots warning:', err.message);
    }
  }

  listBackups(projectId = null) {
    try {
      const prefix = projectId ? `${projectId}-state-` : '';
      return fs
        .readdirSync(this.backupsDir)
        .filter(f => f.endsWith('.json') && (!prefix || f.startsWith(prefix) || (projectId === 'corvette-z51' && f.startsWith('state-'))))
        .map(f => {
          const p = path.join(this.backupsDir, f);
          const stat = fs.statSync(p);
          return {
            filename: f,
            size: stat.size,
            updatedAt: new Date(stat.mtimeMs).toISOString(),
            projectId: projectId || (f.startsWith('state-') ? 'legacy' : f.split('-state-')[0])
          };
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  restoreBackup(projectId, filename) {
    const safeName = path.basename(filename);
    const target = path.join(this.backupsDir, safeName);
    if (!fs.existsSync(target)) {
      throw new Error('Backup file not found: ' + safeName);
    }
    let content = fs.readFileSync(target, 'utf8');
    if (content.charCodeAt(0) === 0xFEFF) {
      content = content.slice(1);
    }
    const parsed = JSON.parse(content);
    return this.saveProject(projectId, parsed, true);
  }

  // --- Legacy Compatibility Methods ---
  resetToDefault() {
    const id = this.getDefaultProjectId();
    const fresh = JSON.parse(JSON.stringify(DEFAULT_STATE));
    return this.saveProject(id, fresh, true);
  }

  getState() {
    return this.getProject(this.getDefaultProjectId());
  }

  saveState(incomingState, createSnapshot = true) {
    return this.saveProject(this.getDefaultProjectId(), incomingState, createSnapshot);
  }
}

module.exports = { StorageEngine };
