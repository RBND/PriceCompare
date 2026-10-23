'use strict';

const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { StorageEngine } = require('./src/storage');
const { evaluateState } = require('./public/js/calc');
const { buildExcelWorkbook } = require('./src/excelExporter');

const PORT = Number(process.env.PORT) || 28085;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const storage = new StorageEngine();

// High-speed gzip compression & strict payload size limit
app.use(compression());
app.use(express.json({ limit: '512kb' }));

// Security Middleware: Fetch Metadata Resource Isolation & Hardened Companion Headers
app.use((req, res, next) => {
  res.setHeader('Vary', 'Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), geolocation=(), microphone=(), focus-without-user-activation=()'
  );

  // Fetch Metadata check to prevent cross-site CSRF / XS-Leaks on API endpoints
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

// Serve index.html with per-request cryptographic CSP nonce
const indexHtmlPath = path.join(__dirname, 'public', 'index.html');
let indexHtmlTemplate = '';
function getIndexTemplate() {
  if (!indexHtmlTemplate || process.env.NODE_ENV === 'development') {
    indexHtmlTemplate = fs.readFileSync(indexHtmlPath, 'utf8');
  }
  return indexHtmlTemplate;
}

app.get(['/', '/index.html'], (req, res) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = [
    `default-src 'self'`,
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'report-sample'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
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

// Static assets (CSS, JS)
app.use(
  express.static(path.join(__dirname, 'public'), {
    index: false,
    maxAge: '1h'
  })
);

// Healthcheck endpoint for Docker & monitoring
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    updatedAt: storage.getState().updatedAt
  });
});

// Get current state + evaluated metrics
app.get('/api/state', (req, res) => {
  const state = storage.getState();
  const evaluated = evaluateState(state);
  res.json({
    state,
    evaluated,
    backupsCount: storage.listBackups().length
  });
});

// Save updated state (atomic disk write + rolling snapshot)
app.put('/api/state', (req, res) => {
  try {
    const incoming = req.body?.state || req.body;
    const createSnapshot = req.body?.createSnapshot !== false;
    const saved = storage.saveState(incoming, createSnapshot);
    const evaluated = evaluateState(saved);
    res.json({
      ok: true,
      state: saved,
      evaluated,
      backupsCount: storage.listBackups().length
    });
  } catch (err) {
    console.error('[API] Failed to save state:', err);
    res.status(400).json({ error: err.message || 'Invalid state payload' });
  }
});

// List automatic rolling backups
app.get('/api/backups', (req, res) => {
  res.json({ backups: storage.listBackups() });
});

// Restore a specific backup
app.post('/api/backups/restore', (req, res) => {
  try {
    const { filename } = req.body || {};
    const restored = storage.restoreBackup(filename);
    const evaluated = evaluateState(restored);
    res.json({
      ok: true,
      state: restored,
      evaluated,
      backupsCount: storage.listBackups().length
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not restore backup' });
  }
});

// Reset to baseline DND Auto Body quote (creates safety backup first)
app.post('/api/reset', (req, res) => {
  const fresh = storage.resetToDefault();
  const evaluated = evaluateState(fresh);
  res.json({
    ok: true,
    state: fresh,
    evaluated,
    backupsCount: storage.listBackups().length
  });
});

// Export full JSON backup file download
app.get('/api/export/json', (req, res) => {
  const state = storage.getState();
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="Corvette-Z51-PriceCompare-${stamp}.json"`
  );
  res.send(JSON.stringify(state, null, 2));
});

// Export Multi-Tab Excel (.xlsx) Workbook with live formulas
app.get('/api/export/xlsx', async (req, res) => {
  try {
    const state = storage.getState();
    const workbook = await buildExcelWorkbook(state);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Corvette-Z51-Repair-Comparison-${stamp}.xlsx"`
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
    console.log(
      `[Corvette PriceCompare] Server listening on http://${HOST}:${PORT}`
    );
  });
}

module.exports = { app, storage };
