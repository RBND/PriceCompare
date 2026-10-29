import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
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

export function getAuthenticatedUser(db: Database.Database, req: Request): UserPublic | null {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token || typeof token !== 'string') return null;

  const sessionHash = hashSessionToken(token);
  const now = Date.now();

  const row = db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.email_verified, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(sessionHash) as
    | { id: string; email: string; display_name: string | null; email_verified: number; expires_at: number }
    | undefined;

  if (!row) return null;
  if (row.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionHash);
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name || row.email.split('@')[0],
    email_verified: Boolean(row.email_verified),
  };
}
