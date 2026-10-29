import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import type { UserPublic } from '../shared/types.js';

// Bounded concurrency semaphore (max 2 concurrent password hashes)
let activeHashes = 0;
const hashQueue: Array<() => void> = [];

async function withHashSemaphore<T>(fn: () => Promise<T>): Promise<T> {
  if (activeHashes >= 2) {
    await new Promise<void>((resolve) => hashQueue.push(resolve));
  }
  activeHashes++;
  try {
    return await fn();
  } finally {
    activeHashes--;
    const next = hashQueue.shift();
    if (next) next();
  }
}

export async function hashPassword(password: string): Promise<string> {
  return withHashSemaphore(() => bcrypt.hash(password, 11));
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return withHashSemaphore(() => bcrypt.compare(password, hash));
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateShareToken(): string {
  // 128-bit cryptographic token in base64url
  return crypto.randomBytes(16).toString('base64url');
}

export const SESSION_COOKIE_NAME = 'priceit_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function setSessionCookie(res: Response, token: string): void {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(res: Response): void {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
  });
}

/**
 * CSRF & Origin verification middleware for state-mutating requests.
 * Enforces custom X-PriceIt-CSRF: 1 header and Origin matching if Origin is present.
 */
export function csrfProtectionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }

  const csrfHeader = req.headers['x-priceit-csrf'];
  if (csrfHeader !== '1') {
    res.status(403).json({ error: 'CSRF check failed: missing or invalid X-PriceIt-CSRF header' });
    return;
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
      const rawHost = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
      const expectedHost = rawHost ? rawHost.split(',')[0].trim() : undefined;
      if (expectedHost && originUrl.host !== expectedHost) {
        res.status(403).json({ error: 'CSRF check failed: Origin mismatch' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'CSRF check failed: malformed Origin header' });
      return;
    }
  }

  next();
}

/**
 * In-memory sliding window rate limiter for auth endpoints (10 attempts / 15 minutes per IP + email).
 */
interface RateBucket {
  count: number;
  resetAt: number;
}

export class AuthRateLimiter {
  private buckets = new Map<string, RateBucket>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(maxAttempts = 10, windowMs = 15 * 60 * 1000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  public check(ip: string, email: string): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    if (this.buckets.size > 500) {
      for (const [k, v] of this.buckets.entries()) {
        if (now >= v.resetAt) this.buckets.delete(k);
      }
    }

    const normalizedEmail = (email || '').trim().toLowerCase();
    const key = `${ip}::${normalizedEmail}`;

    const entry = this.buckets.get(key);
    if (!entry || now >= entry.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSec: 0 };
    }

    if (entry.count >= this.maxAttempts) {
      return {
        allowed: false,
        retryAfterSec: Math.ceil((entry.resetAt - now) / 1000),
      };
    }

    entry.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  public reset(): void {
    this.buckets.clear();
  }
}

export function getCurrentSessionHash(req: Request): string | null {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token || typeof token !== 'string') return null;
  return hashSessionToken(token);
}

export function countUserLoginMethods(
  db: Database.Database,
  userId: string
): {
  hasPassword: boolean;
  passkeyCount: number;
  oauthCount: number;
  total: number;
} {
  const userRow = db
    .prepare(`SELECT password_hash FROM users WHERE id = ?`)
    .get(userId) as { password_hash: string | null } | undefined;
  const hasPassword = Boolean(userRow && userRow.password_hash !== null);
  const passkeyCount = (
    db.prepare(`SELECT COUNT(*) as cnt FROM passkeys WHERE user_id = ?`).get(userId) as { cnt: number }
  ).cnt;
  const oauthCount = (
    db.prepare(`SELECT COUNT(*) as cnt FROM oauth_accounts WHERE user_id = ?`).get(userId) as { cnt: number }
  ).cnt;
  return {
    hasPassword,
    passkeyCount,
    oauthCount,
    total: (hasPassword ? 1 : 0) + passkeyCount + oauthCount,
  };
}

export async function sendVerificationEmail(
  newEmail: string,
  token: string
): Promise<{ sent: boolean; dev_token?: string }> {
  const sanitizedEmail = newEmail.replace(/[\r\n]/g, '').trim();
  const smtpHost = process.env.SMTP_HOST;

  if (smtpHost) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER || '',
          pass: process.env.SMTP_PASS || '',
        },
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 8000,
      });

      const verifyUrl = `${process.env.APP_ORIGIN || 'https://priceit.rbnd.cc'}/?verify_email=${encodeURIComponent(token)}`;

      await transporter.sendMail({
        from: process.env.SMTP_FROM || '"PriceIt Security" <no-reply@priceit.rbnd.cc>',
        to: sanitizedEmail,
        subject: 'Confirm your new PriceIt account email',
        text: `Hello,\n\nPlease confirm your new email address by using this verification token:\n${token}\n\nOr click here: ${verifyUrl}\n\nThis token expires in 30 minutes.\nIf you did not request this, please review your account settings immediately.`,
      });
      return { sent: true };
    } catch (err) {
      console.error('[PriceIt SMTP Error]', err);
    }
  }

  // Fallback dev console logger when SMTP is not configured
  console.log(`[PriceIt Mailer] Verification token for ${sanitizedEmail}: ${token}`);
  return {
    sent: true,
    dev_token: process.env.NODE_ENV === 'production' ? undefined : token,
  };
}

export function getAuthenticatedUser(db: Database.Database, req: Request): UserPublic | null {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token || typeof token !== 'string') return null;

  const sessionHash = hashSessionToken(token);
  const now = Date.now();

  const row = db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.email_verified, u.password_hash, u.is_passwordless,
              s.expires_at, s.last_active_at, s.reauthenticated_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(sessionHash) as
    | {
        id: string;
        email: string;
        display_name: string | null;
        email_verified: number;
        password_hash: string | null;
        is_passwordless: number;
        expires_at: number;
        last_active_at: number | null;
        reauthenticated_at: number | null;
      }
    | undefined;

  if (!row) return null;
  if (row.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionHash);
    return null;
  }

  // Throttled last_active_at update (at most once every 5 minutes per session)
  if (!row.last_active_at || now - row.last_active_at > 5 * 60 * 1000) {
    try {
      db.prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`).run(now, sessionHash);
    } catch {}
  }

  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name || row.email.split('@')[0],
    email_verified: Boolean(row.email_verified),
    has_password: row.password_hash !== null,
    is_passwordless: Boolean(row.is_passwordless || row.password_hash === null),
  };
}
