import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import {
  AuthRegisterSchema,
  AuthLoginSchema,
  OAuthSimulateSchema,
  ProjectPayloadSchema,
  GuestMigrationPayloadSchema,
} from '../shared/types.js';
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  hashSessionToken,
  setSessionCookie,
  clearSessionCookie,
  csrfProtectionMiddleware,
  AuthRateLimiter,
  getAuthenticatedUser,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from './auth.js';
import {
  loadFullProjectUnscoped,
  saveProjectGraph,
  migrateGuestProjectIfDirty,
  listUserProjects,
  createOrGetShareToken,
  revokeShareToken,
} from './projects.js';

export function createApp(db: Database.Database, rateLimiter = new AuthRateLimiter()): express.Express {
  const app = express();

  // Security Controls & Hardening Checklist (Section 7.6)
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Healthcheck (GET - exempt from CSRF)
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'priceit',
      timestamp: Date.now(),
    });
  });

  // Apply CSRF & Origin validation to all /api routes
  app.use('/api', csrfProtectionMiddleware);

  function createSessionForUser(userId: string, res: express.Response): void {
    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    const now = Date.now();
    db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now);
    db.prepare(
      `INSERT INTO sessions (id, user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(tokenHash, userId, now + SESSION_TTL_MS, now);
    setSessionCookie(res, rawToken);
  }

  // GET current session user + Configured OAuth providers
  app.get('/api/auth/me', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    res.json({
      user,
      oauth_providers: ['google', 'microsoft', 'reddit', 'meta'],
    });
  });

  // POST /api/auth/register
  app.post('/api/auth/register', async (req, res) => {
    const parsed = AuthRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
      return;
    }

    const { email, password, display_name, guest_migration } = parsed.data;
    const normalizedEmail = email.toLowerCase();
    const ip = req.ip || '127.0.0.1';

    const rate = rateLimiter.check(ip, normalizedEmail);
    if (!rate.allowed) {
      res.status(429).json({
        error: 'Too many authentication attempts. Please try again later.',
        retry_after_sec: rate.retryAfterSec,
      });
      return;
    }

    const existing = db
      .prepare(`SELECT id FROM users WHERE email = ?`)
      .get(normalizedEmail) as { id: string } | undefined;

    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists' });
      return;
    }

    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();
    const now = Date.now();
    const finalName = display_name || normalizedEmail.split('@')[0];

    db.prepare(
      `INSERT INTO users (id, email, password_hash, email_verified, display_name, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`
    ).run(userId, normalizedEmail, passwordHash, finalName, now, now);

    const migratedProjectId = migrateGuestProjectIfDirty(db, userId, guest_migration);

    createSessionForUser(userId, res);

    res.status(201).json({
      user: {
        id: userId,
        email: normalizedEmail,
        display_name: finalName,
        email_verified: false,
      },
      migrated_project_id: migratedProjectId,
    });
  });

  // POST /api/auth/login
  app.post('/api/auth/login', async (req, res) => {
    const parsed = AuthLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
      return;
    }

    const { email, password, guest_migration } = parsed.data;
    const normalizedEmail = email.toLowerCase();
    const ip = req.ip || '127.0.0.1';

    const rate = rateLimiter.check(ip, normalizedEmail);
    if (!rate.allowed) {
      res.status(429).json({
        error: 'Too many authentication attempts. Please try again later.',
        retry_after_sec: rate.retryAfterSec,
      });
      return;
    }

    const userRow = db
      .prepare(
        `SELECT id, email, password_hash, email_verified, display_name
         FROM users WHERE email = ?`
      )
      .get(normalizedEmail) as
      | {
          id: string;
          email: string;
          password_hash: string | null;
          email_verified: number;
          display_name: string | null;
        }
      | undefined;

    if (!userRow || !userRow.password_hash) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const valid = await verifyPassword(password, userRow.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const migratedProjectId = migrateGuestProjectIfDirty(db, userRow.id, guest_migration);
    createSessionForUser(userRow.id, res);

    res.json({
      user: {
        id: userRow.id,
        email: userRow.email,
        display_name: userRow.display_name || userRow.email.split('@')[0],
        email_verified: Boolean(userRow.email_verified),
      },
      migrated_project_id: migratedProjectId,
    });
  });

  // POST /api/auth/oauth/callback (Supports Google, Microsoft, Reddit, Meta with Section 7.3 Pre-Account Takeover Hardening)
  app.post('/api/auth/oauth/callback', (req, res) => {
    const parsed = OAuthSimulateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid OAuth payload',
        details: parsed.error.flatten(),
      });
      return;
    }

    const { provider, provider_account_id, email, display_name, guest_migration } = parsed.data;
    const normalizedEmail = email.toLowerCase();
    const ip = req.ip || '127.0.0.1';

    const rate = rateLimiter.check(ip, normalizedEmail);
    if (!rate.allowed) {
      res.status(429).json({
        error: 'Too many authentication attempts. Please try again later.',
        retry_after_sec: rate.retryAfterSec,
      });
      return;
    }

    const now = Date.now();
    let userId: string;
    let finalEmail = normalizedEmail;
    let finalDisplayName: string;

    const tx = db.transaction(() => {
      const existingOAuth = db
        .prepare(
          `SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_account_id = ?`
        )
        .get(provider, provider_account_id) as { user_id: string } | undefined;

      if (existingOAuth) {
        userId = existingOAuth.user_id;
        const u = db
          .prepare(`SELECT display_name, email FROM users WHERE id = ?`)
          .get(userId) as { display_name: string | null; email: string };
        finalEmail = u.email;
        finalDisplayName = u.display_name || u.email.split('@')[0];
      } else {
        const existingUser = db
          .prepare(
            `SELECT id, email, password_hash, email_verified, display_name
             FROM users WHERE email = ?`
          )
          .get(normalizedEmail) as
          | {
              id: string;
              email: string;
              password_hash: string | null;
              email_verified: number;
              display_name: string | null;
            }
          | undefined;

        if (existingUser) {
          userId = existingUser.id;
          finalEmail = existingUser.email;
          finalDisplayName = existingUser.display_name || display_name || normalizedEmail.split('@')[0];

          // Section 7.3 OAuth Account Linking Safety:
          // When an OAuth login matches an existing email address in users, if email_verified === 0 and password_hash IS NOT NULL,
          // clear password_hash = NULL, invalidate all prior sessions for that user_id, and mark email_verified = 1
          if (existingUser.email_verified === 0 && existingUser.password_hash !== null) {
            db.prepare(
              `UPDATE users SET password_hash = NULL, email_verified = 1, updated_at = ? WHERE id = ?`
            ).run(now, userId);
            db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
          } else if (existingUser.email_verified === 0) {
            db.prepare(`UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`).run(
              now,
              userId
            );
          }
        } else {
          userId = crypto.randomUUID();
          finalDisplayName = display_name || normalizedEmail.split('@')[0];
          db.prepare(
            `INSERT INTO users (id, email, password_hash, email_verified, display_name, created_at, updated_at)
             VALUES (?, ?, NULL, 1, ?, ?, ?)`
          ).run(userId, normalizedEmail, finalDisplayName, now, now);
        }

        db.prepare(
          `INSERT INTO oauth_accounts (id, user_id, provider, provider_account_id, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(crypto.randomUUID(), userId, provider, provider_account_id, now);
      }
    });

    tx();

    const migratedProjectId = migrateGuestProjectIfDirty(db, userId!, guest_migration);
    createSessionForUser(userId!, res);

    res.json({
      user: {
        id: userId!,
        email: finalEmail,
        display_name: finalDisplayName!,
        email_verified: true,
      },
      migrated_project_id: migratedProjectId,
    });
  });

  // POST /api/auth/logout
  app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    if (token && typeof token === 'string') {
      const sessionHash = hashSessionToken(token);
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionHash);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // POST /api/projects/migrate-guest
  app.post('/api/projects/migrate-guest', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = GuestMigrationPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid migration payload', details: parsed.error.flatten() });
      return;
    }

    const migratedId = migrateGuestProjectIfDirty(db, user.id, parsed.data);
    res.json({
      migrated_project_id: migratedId,
    });
  });

  // GET /api/projects
  app.get('/api/projects', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const projects = listUserProjects(db, user.id);
    res.json({ projects });
  });

  // POST /api/projects
  app.post('/api/projects', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = ProjectPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    try {
      // If client_project_uuid is provided, check idempotency
      if (parsed.data.client_project_uuid) {
        const existing = db
          .prepare(`SELECT id FROM projects WHERE user_id = ? AND client_project_uuid = ?`)
          .get(user.id, parsed.data.client_project_uuid) as { id: string } | undefined;
        if (existing) {
          const project = loadFullProjectUnscoped(db, existing.id);
          res.status(200).json({ project });
          return;
        }
      }

      const projectId = crypto.randomUUID();
      saveProjectGraph(db, user.id, projectId, parsed.data, true);
      const project = loadFullProjectUnscoped(db, projectId);
      res.status(201).json({ project });
    } catch {
      res.status(500).json({ error: 'Failed to create project' });
    }
  });

  // GET /api/projects/:id
  app.get('/api/projects/:id', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const owned = db
      .prepare(`SELECT id FROM projects WHERE id = ? AND user_id = ?`)
      .get(req.params.id, user.id) as { id: string } | undefined;

    if (!owned) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const project = loadFullProjectUnscoped(db, req.params.id);
    res.json({ project });
  });

  // PUT /api/projects/:id
  app.put('/api/projects/:id', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = ProjectPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    try {
      saveProjectGraph(db, user.id, req.params.id, parsed.data, false);
      const updated = loadFullProjectUnscoped(db, req.params.id);
      res.json({ project: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'NOT_FOUND') {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      if (msg === 'VERSION_CONFLICT') {
        const currentVersion = (err as { currentVersion?: number }).currentVersion;
        res.status(409).json({
          error: 'Version conflict: project was modified in another session. Please reload.',
          current_version: currentVersion,
        });
        return;
      }
      res.status(500).json({ error: 'Failed to save project' });
    }
  });

  // DELETE /api/projects/:id
  app.delete('/api/projects/:id', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const info = db
      .prepare(`DELETE FROM projects WHERE id = ? AND user_id = ?`)
      .run(req.params.id, user.id);

    if (info.changes === 0) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    res.json({ ok: true });
  });

  // POST /api/projects/:id/share (Create or activate 128-bit cryptographic share token)
  app.post('/api/projects/:id/share', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const token = createOrGetShareToken(db, user.id, req.params.id);
    if (!token) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    res.json({ share_token: token });
  });

  // DELETE /api/projects/:id/share (Revoke share link)
  app.delete('/api/projects/:id/share', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const ok = revokeShareToken(db, user.id, req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    res.json({ ok: true });
  });

  // GET /api/shares/:token (Public read-only access to shared project)
  app.get('/api/shares/:token', (req, res) => {
    const shareRow = db
      .prepare(
        `SELECT project_id FROM project_shares WHERE share_token = ? AND is_active = 1`
      )
      .get(req.params.token) as { project_id: string } | undefined;

    if (!shareRow) {
      res.status(404).json({ error: 'Shared project link not found or revoked' });
      return;
    }

    const project = loadFullProjectUnscoped(db, shareRow.project_id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    res.json({
      project,
      read_only: true,
    });
  });

  // Serve static frontend in production
  const clientDistDir = path.join(process.cwd(), 'dist', 'client');
  if (fs.existsSync(clientDistDir)) {
    app.use(express.static(clientDistDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      res.sendFile(path.join(clientDistDir, 'index.html'));
    });
  }

  return app;
}
