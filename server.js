'use strict';

const path = require('path');
const fs = require('fs');

// Auto-load .env file if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envPath);
    } catch (e) {
      console.warn('[Env] Failed to load .env via process.loadEnvFile:', e.message);
    }
  } else {
    try {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          const k = trimmed.slice(0, idx).trim();
          const v = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
          if (!process.env[k]) process.env[k] = v;
        }
      }
    } catch {
      // Ignore manual parse error
    }
  }
}

const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const { StorageEngine } = require('./src/storage');
const { evaluateState } = require('./public/js/calc');
const { buildExcelWorkbook } = require('./src/excelExporter');
const { fetchListingMetadata, checkEbayApiCredentials } = require('./src/ebayService');
const { importParts } = require('./src/importer');

const PORT = Number(process.env.PORT) || 28085;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const storage = new StorageEngine();

// Gzip compression & strict payload limit
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// Strict Same-Origin & Fetch Metadata protection (No external CORS holes)
app.use((req, res, next) => {
  res.setHeader('Vary', 'Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), geolocation=(), microphone=(), focus-without-user-activation=()'
  );

  const site = req.get('Sec-Fetch-Site');
  const mode = req.get('Sec-Fetch-Mode');
  const dest = req.get('Sec-Fetch-Dest');

  if (site && !['same-origin', 'same-site', 'none'].includes(site)) {
    const isSafeNav =
      site === 'cross-site' &&
      mode === 'navigate' &&
      req.method === 'GET' &&
      !['object', 'embed'].includes(dest);
    if (!isSafeNav) {
      return res.status(403).json({ error: 'Forbidden cross-site request' });
    }
  }
  next();
});

// Helper for extracting and validating projectId from request
function getSafeProjectId(req) {
  const rawId = req.params.id || req.query.project || storage.getDefaultProjectId();
  if (!storage.isValidProjectId(rawId)) {
    const err = new Error(`Invalid project identifier: "${rawId}". Must be 1-64 alphanumeric characters, underscores, or hyphens.`);
    err.status = 400;
    throw err;
  }
  return rawId;
}

// Serve index.html with cryptographic CSP nonce
const indexHtmlPath = path.join(__dirname, 'public', 'index.html');
function getIndexTemplate() {
  return fs.readFileSync(indexHtmlPath, 'utf8');
}

app.get(['/', '/index.html'], (req, res) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = [
    `default-src 'self'`,
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'report-sample'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https:`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `frame-ancestors 'self'`,
    `form-action 'self'`
  ].join('; ');

  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const html = getIndexTemplate().replace(/__CSP_NONCE__/g, nonce);
  res.send(html);
});

// Static files (CSS, JS) - Zero-cache for immediate instant updates
app.use(
  express.static(path.join(__dirname, 'public'), {
    index: false,
    maxAge: 0
  })
);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    projectsCount: storage.listProjects().length
  });
});

// ----------------------------------------------------
// RESTful Multi-Project API (/api/projects)
// ----------------------------------------------------

// List all projects with metadata
app.get('/api/projects', (req, res) => {
  try {
    const projects = storage.listProjects();
    res.json({
      projects,
      defaultProjectId: storage.getDefaultProjectId()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new project (blank by default)
app.post('/api/projects', (req, res) => {
  try {
    const { name, template } = req.body || {};
    const created = storage.createProject(name, template || 'blank');
    const evaluated = evaluateState(created.state);
    res.status(201).json({
      ok: true,
      id: created.id,
      state: created.state,
      evaluated
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get state + evaluated solver metrics for a specific project
app.get(['/api/projects/:id', '/api/state'], (req, res) => {
  try {
    const id = getSafeProjectId(req);
    const state = storage.getProject(id);
    if (!state) {
      return res.status(404).json({ error: `Project not found: ${id}` });
    }
    const evaluated = evaluateState(state);
    res.json({
      id,
      state,
      evaluated,
      backupsCount: storage.listBackups(id).length
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Save updated state for a specific project
app.put(['/api/projects/:id', '/api/state'], (req, res) => {
  try {
    const id = getSafeProjectId(req);
    const incoming = req.body?.state || req.body;
    const createSnapshot = req.body?.createSnapshot !== false;
    const saved = storage.saveProject(id, incoming, createSnapshot);
    const evaluated = evaluateState(saved);
    res.json({
      ok: true,
      id,
      state: saved,
      evaluated,
      backupsCount: storage.listBackups(id).length
    });
  } catch (err) {
    console.error(`[API] Failed to save project:`, err);
    res.status(err.status || 400).json({ error: err.message || 'Invalid state payload' });
  }
});

// Duplicate project
app.post('/api/projects/:id/duplicate', (req, res) => {
  try {
    const id = getSafeProjectId(req);
    const { name } = req.body || {};
    const dup = storage.duplicateProject(id, name);
    const evaluated = evaluateState(dup.state);
    res.status(201).json({
      ok: true,
      id: dup.id,
      state: dup.state,
      evaluated
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Rename project
app.patch('/api/projects/:id/rename', (req, res) => {
  try {
    const id = getSafeProjectId(req);
    const { name } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    const saved = storage.renameProject(id, name);
    const evaluated = evaluateState(saved);
    res.json({
      ok: true,
      id,
      state: saved,
      evaluated
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Delete project
app.delete('/api/projects/:id', (req, res) => {
  try {
    const id = getSafeProjectId(req);
    const result = storage.deleteProject(id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// eBay Integration & Metadata Services
// ----------------------------------------------------

// Check eBay API configuration and credential health
app.get('/api/ebay/status', async (req, res) => {
  try {
    const status = await checkEbayApiCredentials();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-fill listing metadata from eBay URL, Item ID, or vendor URL
app.post(['/api/projects/:id/listings/fetch', '/api/listings/fetch'], async (req, res) => {
  try {
    const { urlOrId } = req.body || {};
    if (!urlOrId) {
      return res.status(400).json({ error: 'urlOrId is required' });
    }
    const id = getSafeProjectId(req);
    const state = storage.getProject(id);
    const zipCode = state?.settings?.zipCode || '08879';

    const result = await fetchListingMetadata(urlOrId, zipCode);
    res.json(result);
  } catch (err) {
    console.error('[API] Error fetching listing metadata:', err);
    res.status(500).json({ error: err.message });
  }
});

// Refresh live prices for all saved eBay listings (rate-limited)
app.post(['/api/projects/:id/listings/refresh', '/api/listings/refresh'], async (req, res) => {
  try {
    const id = getSafeProjectId(req);
    const state = storage.getProject(id);
    if (!state) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const listings = state.listings || [];
    const zipCode = state?.settings?.zipCode || '08879';

    const updatedListings = [];
    let updatedCount = 0;
    let endedCount = 0;

    for (const l of listings) {
      const identifier = l.ebayItemId || l.url;
      if (identifier && (l.ebayItemId || l.url.includes('ebay.com'))) {
        try {
          const meta = await fetchListingMetadata(identifier, zipCode);
          if (meta && meta.ok) {
            const updated = {
              ...l,
              lastFetchedAt: new Date().toISOString(),
              fetchStatus: meta.ended ? 'ended' : 'ok'
            };

            if (meta.ended) {
              updated.state = 'excluded'; // auto-exclude ended listings
              endedCount++;
            } else if (meta.price > 0) {
              updated.price = meta.price;
              if (meta.shippingMode) {
                updated.shippingMode = meta.shippingMode;
                updated.freeShipping = meta.freeShipping;
                updated.shipping = meta.shipping;
              }
              if (meta.title && !l.title) updated.title = meta.title;
              if (meta.seller && !l.seller) updated.seller = meta.seller;
            }
            updatedListings.push(updated);
            updatedCount++;
          } else {
            updatedListings.push({
              ...l,
              lastFetchedAt: new Date().toISOString(),
              fetchStatus: 'failed'
            });
          }
        } catch {
          updatedListings.push(l);
        }
        // Rate-limit delay between requests: 800ms
        await new Promise(r => setTimeout(r, 800));
      } else {
        updatedListings.push(l);
      }
    }

    state.listings = updatedListings;
    const saved = storage.saveProject(id, state, true);
    const evaluated = evaluateState(saved);

    res.json({
      ok: true,
      id,
      updatedCount,
      endedCount,
      state: saved,
      evaluated
    });
  } catch (err) {
    console.error('[API] Error refreshing eBay listings:', err);
    res.status(500).json({ error: err.message });
  }
});

// Import parts list from CSV or JSON into a project
app.post(['/api/projects/:id/parts/import', '/api/parts/import'], (req, res) => {
  try {
    const { format, content, mode } = req.body || {};
    if (!format || !content) {
      return res.status(400).json({ error: 'format and content are required' });
    }

    const id = getSafeProjectId(req);
    const state = storage.getProject(id);
    if (!state) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const importRes = importParts(format, content, mode || 'append', state.parts);

    if (!importRes.ok) {
      return res.status(400).json({ error: importRes.error });
    }

    state.parts = importRes.parts;
    const saved = storage.saveProject(id, state, true);
    const evaluated = evaluateState(saved);

    res.json({
      ok: true,
      id,
      addedCount: importRes.addedCount,
      skippedCount: importRes.skippedCount,
      errors: importRes.errors,
      state: saved,
      evaluated
    });
  } catch (err) {
    console.error('[API] Parts import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// Project Backups API
// ----------------------------------------------------

app.get(['/api/projects/:id/backups', '/api/backups'], (req, res) => {
  try {
    const id = getSafeProjectId(req);
    res.json({ backups: storage.listBackups(id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/projects/:id/backups/restore', '/api/backups/restore'], (req, res) => {
  try {
    const id = getSafeProjectId(req);
    const { filename } = req.body || {};
    const restored = storage.restoreBackup(id, filename);
    const evaluated = evaluateState(restored);
    res.json({
      ok: true,
      id,
      state: restored,
      evaluated,
      backupsCount: storage.listBackups(id).length
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not restore backup' });
  }
});

// Reset project to default C7 parts
app.post(['/api/projects/:id/reset', '/api/reset'], (req, res) => {
  try {
    const id = getSafeProjectId(req);
    const fresh = storage.resetToDefault();
    const evaluated = evaluateState(fresh);
    res.json({
      ok: true,
      id,
      state: fresh,
      evaluated,
      backupsCount: storage.listBackups(id).length
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// Export JSON and Excel
// ----------------------------------------------------

app.get(['/api/projects/:id/export/json', '/api/export/json'], (req, res) => {
  try {
    const id = getSafeProjectId(req);
    const state = storage.getProject(id);
    if (!state) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const safeTitle = (state.settings?.projectName || id).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeTitle}-${stamp}.json"`
    );
    res.send(JSON.stringify(state, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(['/api/projects/:id/export/xlsx', '/api/export/xlsx'], async (req, res) => {
  try {
    const id = getSafeProjectId(req);
    const state = storage.getProject(id);
    if (!state) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const workbook = await buildExcelWorkbook(state);
    const stamp = new Date().toISOString().slice(0, 10);
    const safeTitle = (state.settings?.projectName || id).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeTitle}-${stamp}.xlsx"`
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[API] Excel export error:', err);
    res.status(500).json({ error: 'Failed to generate Excel workbook' });
  }
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`[Parts Price Optimizer] Server running on http://${HOST}:${PORT}`);
    if (process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET) {
      console.log('[eBay API] Official Browse API credentials detected (EBAY_CLIENT_ID set).');
    } else {
      console.log('[eBay API] No credentials found in environment or .env; running in zero-key fallback mode.');
    }
  });
}

module.exports = { app, storage };
