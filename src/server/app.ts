import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import {
  AuthRegisterSchema,
  AuthLoginSchema,
  OAuthSimulateSchema,
  UpdateProfileSchema,
  ChangeEmailRequestSchema,
  VerifyEmailTokenSchema,
  ChangePasswordSchema,
  RemovePasswordSchema,
  OAuthLinkSchema,
  PasskeyRenameSchema,
  DeleteAccountSchema,
  ProjectPayloadSchema,
  GuestMigrationPayloadSchema,
  type AccountSecurityState,
  type UserPublic,
  type AdminUserPublic,
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
  getCurrentSessionHash,
  countUserLoginMethods,
  sendVerificationEmail,
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
import { solveBundleOptimization } from '../shared/solver.js';
import { formatCentsToDollars } from '../shared/export.js';
import { renderOgCardPng, escapeXml } from './ogCard.js';

export function createApp(db: Database.Database, rateLimiter = new AuthRateLimiter()): express.Express {
  const app = express();

  // Security Controls & Hardening Checklist (Section 7.6)
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  function getClientIp(req?: express.Request): string {
    if (!req) return '127.0.0.1';
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp && typeof cfIp === 'string') {
      return cfIp.trim().slice(0, 100);
    }
    const realIp = req.headers['x-real-ip'];
    if (realIp && typeof realIp === 'string') {
      return realIp.trim().slice(0, 100);
    }
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded && typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim().slice(0, 100);
    }
    return (req.ip || '127.0.0.1').slice(0, 100);
  }

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

  // eBay Buy Browse API OAuth token cache & item lookup endpoint
  let ebayTokenCache: { token: string; expiresAt: number } | null = null;

  async function getEbayAccessToken(): Promise<string | null> {
    const clientId = process.env.EBAY_CLIENT_ID?.trim();
    const clientSecret = process.env.EBAY_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) return null;

    if (ebayTokenCache && Date.now() < ebayTokenCache.expiresAt) {
      return ebayTokenCache.token;
    }

    const isSandbox = (process.env.EBAY_ENV || 'production').toLowerCase() === 'sandbox';
    const tokenUrl = isSandbox
      ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
      : 'https://api.ebay.com/identity/v1/oauth2/token';
    const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    });
    if (!resp.ok) return null;

    const data = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;

    ebayTokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(60, (data.expires_in || 7200) - 60) * 1000,
    };
    return ebayTokenCache.token;
  }

  app.get('/api/sourcing/ebay-item', async (req, res) => {
    try {
      const rawUrl = String(req.query.url || '').trim();
      const rawItemId = String(req.query.itemId || '').trim();
      const rawTitle = String(req.query.title || '').trim();
      const rawHintPn = String(req.query.hintPn || '').trim();

      const token = await getEbayAccessToken();
      if (!token) {
        res.status(503).json({ error: 'eBay API credentials not configured' });
        return;
      }

      const isSandbox = (process.env.EBAY_ENV || 'production').toLowerCase() === 'sandbox';
      const baseHost = isSandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
      const baseUrl = `${baseHost}/buy/browse/v1/item`;

      const isInvalidPn = (v?: string | null) =>
        !v ||
        /^(does not apply|n\/a|none|not applicable|see description|unbranded)$/i.test(v.trim()) ||
        /^B0[A-Z0-9]{8}$/i.test(v.trim());

      const priorityLabels = [
        /^Manufacturer Part Number$/i,
        /^OE\/OEM Part Number$/i,
        /^MPN$/i,
        /^Part Number$/i,
        /^Superseded Part Number$/i,
        /^Interchange Part Number$/i,
      ];

      type EbayItemResponse = {
        title?: string;
        mpn?: string | null;
        brand?: string | null;
        price?: { value?: string; currency?: string };
        shippingOptions?: Array<{ shippingCost?: { value?: string } }>;
        localizedAspects?: Array<{ name?: string; value?: string }>;
      };

      const extractMpnFromItem = (item: EbayItemResponse) => {
        let partNumber = !isInvalidPn(item.mpn) ? item.mpn!.trim() : '';
        let brand = item.brand?.trim() || '';
        const aspects = item.localizedAspects || [];

        if (!partNumber) {
          for (const pattern of priorityLabels) {
            const found = aspects.find((a) => a.name && pattern.test(a.name.trim()) && !isInvalidPn(a.value));
            if (found && found.value) {
              partNumber = found.value.trim();
              break;
            }
          }
        }

        if (!brand) {
          const brandAspect = aspects.find((a) => a.name && /^Brand$/i.test(a.name.trim()) && !isInvalidPn(a.value));
          if (brandAspect?.value) {
            brand = brandAspect.value.trim();
          }
        }
        return { partNumber, brand };
      };

      const match = rawUrl.match(/\/itm\/(?:[^/?#]+\/)?(\d{10,14})/) || rawItemId.match(/^(\d{10,14})$/);
      if (match) {
        const itemId = match[1];
        const itemResp = await fetch(`${baseUrl}/v1|${itemId}|0`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          },
        });
        if (!itemResp.ok) {
          res.status(itemResp.status).json({ error: 'Failed to fetch item from eBay Browse API' });
          return;
        }

        const item = (await itemResp.json()) as EbayItemResponse;
        const { partNumber, brand } = extractMpnFromItem(item);
        const parsedPrice = item.price?.value ? parseFloat(item.price.value) : null;
        const rawShip = item.shippingOptions?.[0]?.shippingCost?.value;
        const parsedShipping = rawShip !== undefined ? parseFloat(rawShip) : null;

        res.json({
          itemId,
          title: item.title || '',
          partNumber,
          brand,
          price: parsedPrice !== null && isFinite(parsedPrice) ? parsedPrice : null,
          shippingCost: parsedShipping !== null && isFinite(parsedShipping) ? parsedShipping : null,
        });
        return;
      }

      // Fallback catalog MPN lookup by title / hintPn (e.g., for Amazon URLs where ASIN is in the URL instead of MPN)
      const searchQuery = (rawTitle || rawHintPn)
        .replace(/[^\w\s-]/g, ' ')
        .replace(/\b(Desktop|Processor|unlocked|retail|box|with|without|cooler)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);

      if (!searchQuery) {
        res.status(400).json({ error: 'Valid eBay item URL, item ID, or search title required' });
        return;
      }

      const searchResp = await fetch(
        `${baseHost}/buy/browse/v1/item_summary/search?q=${encodeURIComponent(searchQuery)}&limit=3`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          },
        }
      );

      if (!searchResp.ok) {
        res.status(searchResp.status).json({ error: 'Failed to search eBay catalog' });
        return;
      }

      const searchData = (await searchResp.json()) as {
        itemSummaries?: Array<{ itemId?: string; title?: string }>;
      };

      for (const summary of searchData.itemSummaries || []) {
        if (!summary.itemId) continue;
        if (
          rawHintPn &&
          summary.title &&
          !summary.title.toUpperCase().includes(rawHintPn.toUpperCase())
        ) {
          continue;
        }
        const detailResp = await fetch(`${baseUrl}/${encodeURIComponent(summary.itemId)}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          },
        });
        if (!detailResp.ok) continue;
        const detailItem = (await detailResp.json()) as EbayItemResponse;
        const { partNumber, brand } = extractMpnFromItem(detailItem);
        if (partNumber) {
          res.json({
            itemId: summary.itemId,
            title: detailItem.title || rawTitle,
            partNumber,
            brand,
            price: null,
            shippingCost: null,
          });
          return;
        }
      }

      res.json({
        itemId: '',
        title: rawTitle,
        partNumber: rawHintPn || '',
        brand: '',
        price: null,
        shippingCost: null,
      });
    } catch {
      res.status(500).json({ error: 'eBay lookup failed' });
    }
  });

  // Apply CSRF & Origin validation to all /api routes
  app.use('/api', csrfProtectionMiddleware);

  function createSessionForUser(userId: string, res: express.Response, req?: express.Request): void {
    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    const now = Date.now();
    const sessionUid = crypto.randomUUID();
    const ip = getClientIp(req);
    const userAgent = req ? String(req.headers['user-agent'] || 'Browser').slice(0, 255) : 'Browser';

    db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now);
    db.prepare(
      `INSERT INTO sessions (id, session_uid, user_id, ip_address, user_agent, last_active_at, reauthenticated_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(tokenHash, sessionUid, userId, ip, userAgent, now, now, now + SESSION_TTL_MS, now);
    setSessionCookie(res, rawToken);
  }

  // GET current session user + Configured OAuth providers
  app.get('/api/auth/me', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    res.json({
      user,
      oauth_providers: ['google', 'facebook'],
    });
  });

  function getPublicOrigin(req: express.Request): string {
    const hostHeader = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost:28085') as string;
    const host = String(hostHeader).split(',')[0].trim();
    const hostname = host.split(':')[0].toLowerCase();
    const protoHeader = (req.headers['x-forwarded-proto'] || req.protocol || 'http') as string;
    const rawProto = String(protoHeader).split(',')[0].trim().toLowerCase();
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
    const proto = !isLocal ? 'https' : rawProto;
    return `${proto}://${host}`;
  }

  function getOAuthProviderConfig(prov: 'google' | 'facebook'): {
    clientId: string;
    clientSecret: string;
    enabled: boolean;
  } {
    const rows = db
      .prepare(`SELECT key, value FROM system_settings WHERE key IN (?, ?, ?)`)
      .all(`oauth_${prov}_client_id`, `oauth_${prov}_client_secret`, `oauth_${prov}_enabled`) as Array<{
      key: string;
      value: string;
    }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const clientId = (map.get(`oauth_${prov}_client_id`) || process.env[`${prov.toUpperCase()}_CLIENT_ID`] || '').trim();
    const clientSecret = (
      map.get(`oauth_${prov}_client_secret`) ||
      process.env[`${prov.toUpperCase()}_CLIENT_SECRET`] ||
      ''
    ).trim();
    const enabled = map.get(`oauth_${prov}_enabled`) !== 'false';
    return { clientId, clientSecret, enabled };
  }

  const OAUTH_STATE_COOKIE = 'priceit_oauth_state';

  // GET /api/auth/oauth/:provider/start (Initiates real OAuth 2.0 Authorization Code flow for Google & Facebook)
  app.get('/api/auth/oauth/:provider/start', (req, res) => {
    const provider = String(req.params.provider || '').toLowerCase();
    if (provider !== 'google' && provider !== 'facebook') {
      res.redirect(`/?oauth_error=${encodeURIComponent(`Unsupported OAuth provider: ${provider}`)}`);
      return;
    }

    const mode = req.query.mode === 'link' ? 'link' : 'login';
    const rawReturnTo = String(req.query.return_to || '/');
    const returnTo = rawReturnTo === '/admin' ? '/admin' : '/';

    const currentUser = getAuthenticatedUser(db, req);
    if (mode === 'link' && !currentUser) {
      res.redirect(`${returnTo}?oauth_error=${encodeURIComponent('Please sign in first before linking an OAuth account.')}`);
      return;
    }

    const config = getOAuthProviderConfig(provider);
    if (!config.enabled) {
      res.redirect(
        `${returnTo}?oauth_error=${encodeURIComponent(`${provider.toUpperCase()} sign-in is currently disabled by the administrator.`)}`
      );
      return;
    }

    if (!config.clientId || !config.clientSecret) {
      res.redirect(
        `${returnTo}?oauth_error=${encodeURIComponent(`${provider.toUpperCase()} OAuth Client ID and Secret are not configured. Configure them in /admin.`)}`
      );
      return;
    }

    const stateNonce = crypto.randomBytes(24).toString('base64url');
    const statePayload = JSON.stringify({
      nonce: stateNonce,
      provider,
      mode,
      returnTo,
      userId: mode === 'link' && currentUser ? currentUser.id : null,
    });

    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(OAUTH_STATE_COOKIE, statePayload, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000,
    });

    const redirectUri = `${getPublicOrigin(req)}/api/auth/oauth/${provider}/callback`;

    if (provider === 'google') {
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', config.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'openid email profile');
      authUrl.searchParams.set('state', stateNonce);
      authUrl.searchParams.set('prompt', 'select_account');
      res.redirect(authUrl.toString());
      return;
    }

    const authUrl = new URL('https://www.facebook.com/v19.0/dialog/oauth');
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'public_profile');
    authUrl.searchParams.set('state', stateNonce);
    res.redirect(authUrl.toString());
  });

  // Shared handler for real OAuth 2.0 GET callback from Google or Facebook
  async function handleOAuthGetCallback(req: express.Request, res: express.Response) {
    const provider = String(req.params.provider || '').toLowerCase();
    const isProd = process.env.NODE_ENV === 'production';

    let savedState: {
      nonce?: string;
      provider?: string;
      mode?: 'login' | 'link';
      returnTo?: string;
      userId?: string | null;
    } | null = null;

    try {
      const rawCookie = req.cookies?.[OAUTH_STATE_COOKIE];
      if (rawCookie && typeof rawCookie === 'string') {
        savedState = JSON.parse(rawCookie);
      }
    } catch {}

    res.clearCookie(OAUTH_STATE_COOKIE, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
    });

    const returnTo = savedState?.returnTo === '/admin' ? '/admin' : '/';

    if (provider !== 'google' && provider !== 'facebook') {
      res.redirect(`${returnTo}?oauth_error=${encodeURIComponent(`Unsupported OAuth provider: ${provider}`)}`);
      return;
    }

    const providerError = String(req.query.error_description || req.query.error || '').trim();
    if (providerError) {
      res.redirect(`${returnTo}?oauth_error=${encodeURIComponent(`${provider.toUpperCase()} login cancelled or failed: ${providerError}`)}`);
      return;
    }

    const code = String(req.query.code || '').trim();
    const state = String(req.query.state || '').trim();

    if (!code || !state || !savedState || savedState.nonce !== state || savedState.provider !== provider) {
      res.redirect(
        `${returnTo}?oauth_error=${encodeURIComponent('OAuth security state verification failed or expired. Please try signing in again.')}`
      );
      return;
    }

    const config = getOAuthProviderConfig(provider);
    if (!config.clientId || !config.clientSecret || !config.enabled) {
      res.redirect(
        `${returnTo}?oauth_error=${encodeURIComponent(`${provider.toUpperCase()} OAuth credentials are not configured or enabled.`)}`
      );
      return;
    }

    const redirectUri = `${getPublicOrigin(req)}/api/auth/oauth/${provider}/callback`;

    try {
      let providerAccountId = '';
      let email = '';
      let displayName = '';

      if (provider === 'google') {
        const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }).toString(),
        });

        const tokenData = (await tokenResp.json().catch(() => ({}))) as {
          access_token?: string;
          error?: string;
          error_description?: string;
        };

        if (!tokenResp.ok || !tokenData.access_token) {
          const msg = tokenData.error_description || tokenData.error || 'Failed to exchange Google authorization code';
          res.redirect(`${returnTo}?oauth_error=${encodeURIComponent(`Google OAuth error: ${msg}`)}`);
          return;
        }

        const profileResp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const profile = (await profileResp.json().catch(() => ({}))) as {
          sub?: string;
          id?: string;
          email?: string;
          name?: string;
          given_name?: string;
        };

        if (!profileResp.ok || (!profile.sub && !profile.id)) {
          res.redirect(`${returnTo}?oauth_error=${encodeURIComponent('Failed to retrieve Google user profile.')}`);
          return;
        }

        providerAccountId = String(profile.sub || profile.id);
        email = String(profile.email || '').trim().toLowerCase() || `google_${providerAccountId}@google.oauth.priceit`;
        displayName = String(profile.name || profile.given_name || email.split('@')[0] || 'Google User').trim();
      } else {
        const tokenUrl = new URL('https://graph.facebook.com/v19.0/oauth/access_token');
        tokenUrl.searchParams.set('client_id', config.clientId);
        tokenUrl.searchParams.set('redirect_uri', redirectUri);
        tokenUrl.searchParams.set('client_secret', config.clientSecret);
        tokenUrl.searchParams.set('code', code);

        const tokenResp = await fetch(tokenUrl.toString());
        const tokenData = (await tokenResp.json().catch(() => ({}))) as {
          access_token?: string;
          error?: { message?: string };
        };

        if (!tokenResp.ok || !tokenData.access_token) {
          const msg = tokenData.error?.message || 'Failed to exchange Facebook authorization code';
          res.redirect(`${returnTo}?oauth_error=${encodeURIComponent(`Facebook OAuth error: ${msg}`)}`);
          return;
        }

        const profileUrl = new URL('https://graph.facebook.com/me');
        profileUrl.searchParams.set('fields', 'id,name,email');
        profileUrl.searchParams.set('access_token', tokenData.access_token);

        const profileResp = await fetch(profileUrl.toString());
        const profile = (await profileResp.json().catch(() => ({}))) as {
          id?: string;
          name?: string;
          email?: string;
        };

        if (!profileResp.ok || !profile.id) {
          res.redirect(`${returnTo}?oauth_error=${encodeURIComponent('Failed to retrieve Facebook user profile.')}`);
          return;
        }

        providerAccountId = String(profile.id);
        email = String(profile.email || '').trim().toLowerCase() || `fb_${providerAccountId}@facebook.oauth.priceit`;
        displayName = String(profile.name || email.split('@')[0] || 'Facebook User').trim();
      }

      const now = Date.now();

      // Mode 1: Account Linking for an already signed-in user
      if (savedState.mode === 'link') {
        const currentUser = getAuthenticatedUser(db, req);
        const targetUserId = currentUser?.id || savedState.userId;
        if (!targetUserId) {
          res.redirect(`${returnTo}?oauth_error=${encodeURIComponent('Session expired while linking OAuth account.')}`);
          return;
        }

        const currentSessionHash = getCurrentSessionHash(req);
        let conflict = false;

        db.transaction(() => {
          const existing = db
            .prepare(`SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_account_id = ?`)
            .get(provider, providerAccountId) as { user_id: string } | undefined;

          if (existing && existing.user_id !== targetUserId) {
            conflict = true;
            return;
          }

          const alreadyLinked = db
            .prepare(`SELECT id FROM oauth_accounts WHERE user_id = ? AND provider = ?`)
            .get(targetUserId, provider) as { id: string } | undefined;

          if (alreadyLinked) {
            db.prepare(`UPDATE oauth_accounts SET provider_account_id = ? WHERE id = ?`).run(
              providerAccountId,
              alreadyLinked.id
            );
          } else {
            db.prepare(
              `INSERT INTO oauth_accounts (id, user_id, provider, provider_account_id, created_at)
               VALUES (?, ?, ?, ?, ?)`
            ).run(crypto.randomUUID(), targetUserId, provider, providerAccountId, now);
          }

          if (currentSessionHash) {
            db.prepare(`UPDATE sessions SET reauthenticated_at = ? WHERE id = ?`).run(now, currentSessionHash);
          }
        })();

        if (conflict) {
          res.redirect(
            `${returnTo}?oauth_error=${encodeURIComponent(`This ${provider.toUpperCase()} account is already linked to a different PriceIt user.`)}`
          );
          return;
        }

        res.redirect(`${returnTo}?oauth_linked=${encodeURIComponent(provider)}`);
        return;
      }

      // Mode 2: Sign-in or Registration via OAuth
      const adminEmails = [
        'myke.endrodi@gmail.com',
        'mykehype@gmail.com',
        'admin@priceit.rbnd.cc',
        process.env.ADMIN_EMAIL?.toLowerCase(),
      ].filter(Boolean);
      const shouldBeAdmin = adminEmails.includes(email) ? 1 : 0;

      let userId = '';
      let isBanned = false;
      let banReason: string | null = null;

      db.transaction(() => {
        const existingOAuth = db
          .prepare(`SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_account_id = ?`)
          .get(provider, providerAccountId) as { user_id: string } | undefined;

        if (existingOAuth) {
          userId = existingOAuth.user_id;
          const u = db
            .prepare(`SELECT id, is_banned, ban_reason, is_admin FROM users WHERE id = ?`)
            .get(userId) as { id: string; is_banned?: number; ban_reason?: string | null; is_admin?: number } | undefined;
          if (!u) {
            // Orphaned oauth_accounts row; recreate user
            userId = crypto.randomUUID();
            db.prepare(
              `INSERT INTO users (id, email, password_hash, email_verified, display_name, is_admin, created_at, updated_at)
               VALUES (?, ?, NULL, 1, ?, ?, ?, ?)`
            ).run(userId, email, displayName, shouldBeAdmin, now, now);
            db.prepare(`UPDATE oauth_accounts SET user_id = ? WHERE provider = ? AND provider_account_id = ?`).run(
              userId,
              provider,
              providerAccountId
            );
            return;
          }
          if (u.is_banned === 1) {
            isBanned = true;
            banReason = u.ban_reason || null;
            return;
          }
          if (shouldBeAdmin && !u.is_admin) {
            db.prepare(`UPDATE users SET is_admin = 1, updated_at = ? WHERE id = ?`).run(now, userId);
          }
        } else {
          const existingUser = db
            .prepare(`SELECT id, email, email_verified, display_name, is_banned, ban_reason, is_admin FROM users WHERE email = ?`)
            .get(email) as
            | {
                id: string;
                email: string;
                email_verified: number;
                display_name: string | null;
                is_banned?: number;
                ban_reason?: string | null;
                is_admin?: number;
              }
            | undefined;

          if (existingUser) {
            if (existingUser.is_banned === 1) {
              isBanned = true;
              banReason = existingUser.ban_reason || null;
              return;
            }
            userId = existingUser.id;
            const nextAdmin = shouldBeAdmin || existingUser.is_admin ? 1 : 0;
            db.prepare(
              `UPDATE users SET email_verified = 1, is_admin = ?, display_name = COALESCE(NULLIF(display_name, ''), ?), updated_at = ? WHERE id = ?`
            ).run(nextAdmin, displayName, now, userId);
          } else {
            userId = crypto.randomUUID();
            db.prepare(
              `INSERT INTO users (id, email, password_hash, email_verified, display_name, is_admin, created_at, updated_at)
               VALUES (?, ?, NULL, 1, ?, ?, ?, ?)`
            ).run(userId, email, displayName, shouldBeAdmin, now, now);
          }

          const alreadyProviderForUser = db
            .prepare(`SELECT id FROM oauth_accounts WHERE user_id = ? AND provider = ?`)
            .get(userId, provider) as { id: string } | undefined;

          if (alreadyProviderForUser) {
            db.prepare(`UPDATE oauth_accounts SET provider_account_id = ? WHERE id = ?`).run(
              providerAccountId,
              alreadyProviderForUser.id
            );
          } else {
            db.prepare(
              `INSERT INTO oauth_accounts (id, user_id, provider, provider_account_id, created_at)
               VALUES (?, ?, ?, ?, ?)`
            ).run(crypto.randomUUID(), userId, provider, providerAccountId, now);
          }
        }
      })();

      if (isBanned) {
        res.redirect(
          `${returnTo}?oauth_error=${encodeURIComponent(`Account suspended${banReason ? `: ${banReason}` : '.'}`)}`
        );
        return;
      }

      createSessionForUser(userId, res, req);
      res.redirect(`${returnTo}?oauth_login=${encodeURIComponent(provider)}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unexpected OAuth callback error';
      res.redirect(`${returnTo}?oauth_error=${encodeURIComponent(msg)}`);
    }
  }

  app.get('/api/auth/oauth/:provider/callback', handleOAuthGetCallback);
  app.get('/api/auth/callback/:provider', handleOAuthGetCallback);

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
    const ip = getClientIp(req);

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

    const adminEmails = ['myke.endrodi@gmail.com', 'mykehype@gmail.com', 'admin@priceit.rbnd.cc', process.env.ADMIN_EMAIL?.toLowerCase()].filter(Boolean);
    const isAdmin = adminEmails.includes(normalizedEmail) ? 1 : 0;

    db.prepare(
      `INSERT INTO users (id, email, password_hash, email_verified, display_name, is_admin, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
    ).run(userId, normalizedEmail, passwordHash, finalName, isAdmin, now, now);

    const migratedProjectId = migrateGuestProjectIfDirty(db, userId, guest_migration);

    createSessionForUser(userId, res, req);

    res.status(201).json({
      user: {
        id: userId,
        email: normalizedEmail,
        display_name: finalName,
        email_verified: false,
        is_admin: Boolean(isAdmin),
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
    const ip = getClientIp(req);

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
        `SELECT id, email, password_hash, email_verified, display_name, is_banned, ban_reason
         FROM users WHERE email = ?`
      )
      .get(normalizedEmail) as
      | {
          id: string;
          email: string;
          password_hash: string | null;
          email_verified: number;
          display_name: string | null;
          is_banned?: number;
          ban_reason?: string | null;
        }
      | undefined;

    if (!userRow || !userRow.password_hash) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    if (userRow.is_banned === 1) {
      res.status(403).json({
        error: 'This account has been suspended by an administrator.',
        reason: userRow.ban_reason || null,
      });
      return;
    }

    const valid = await verifyPassword(password, userRow.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const migratedProjectId = migrateGuestProjectIfDirty(db, userRow.id, guest_migration);
    createSessionForUser(userRow.id, res, req);

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
    const ip = getClientIp(req);

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

    let isBanned = false;
    let banReason: string | null = null;

    const tx = db.transaction(() => {
      const existingOAuth = db
        .prepare(
          `SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_account_id = ?`
        )
        .get(provider, provider_account_id) as { user_id: string } | undefined;

      if (existingOAuth) {
        userId = existingOAuth.user_id;
        const u = db
          .prepare(`SELECT display_name, email, is_banned, ban_reason FROM users WHERE id = ?`)
          .get(userId) as { display_name: string | null; email: string; is_banned?: number; ban_reason?: string | null };
        if (u.is_banned === 1) {
          isBanned = true;
          banReason = u.ban_reason || null;
          return;
        }
        finalEmail = u.email;
        finalDisplayName = u.display_name || u.email.split('@')[0];
      } else {
        const existingUser = db
          .prepare(
            `SELECT id, email, password_hash, email_verified, display_name, is_banned, ban_reason
             FROM users WHERE email = ?`
          )
          .get(normalizedEmail) as
          | {
              id: string;
              email: string;
              password_hash: string | null;
              email_verified: number;
              display_name: string | null;
              is_banned?: number;
              ban_reason?: string | null;
            }
          | undefined;

        if (existingUser) {
          if (existingUser.is_banned === 1) {
            isBanned = true;
            banReason = existingUser.ban_reason || null;
            return;
          }
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

    if (isBanned) {
      res.status(403).json({
        error: 'This account has been suspended by an administrator.',
        reason: banReason,
      });
      return;
    }

    const migratedProjectId = migrateGuestProjectIfDirty(db, userId!, guest_migration);
    createSessionForUser(userId!, res, req);

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

  // WebAuthn Relying Party & AAGUID Resolution Helper
  function getRpConfig(req: express.Request): { rpID: string; rpName: string; origin: string } {
    const hostHeader = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost') as string;
    const host = String(hostHeader).split(',')[0].trim();
    const hostname = host.split(':')[0];
    const protoHeader = (req.headers['x-forwarded-proto'] || req.protocol || 'http') as string;
    const proto = String(protoHeader).split(',')[0].trim();
    const origin = req.headers.origin || `${proto}://${host}`;
    return {
      rpID: process.env.WEBAUTHN_RP_ID || (hostname === 'localhost' || hostname === '127.0.0.1' ? 'localhost' : hostname),
      rpName: 'PriceIt Workshop',
      origin,
    };
  }

  const AAGUID_MAP: Record<string, { name: string }> = {
    'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': { name: 'Google Password Manager' },
    'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': { name: 'iCloud Keychain' },
    'adce0002-35bc-c60a-648b-0b25f1f05503': { name: 'Chrome on Mac' },
    '08987058-cadc-4b81-b6e1-30de50dcbe96': { name: 'Windows Hello' },
    'bada5566-a7aa-401f-bd96-45619a55120d': { name: '1Password' },
    'd548826e-79b4-db40-a3d8-11116f7e8349': { name: 'Bitwarden' },
    '6028b017-b1d4-4202-9b56-492e6633ee1a': { name: 'Dashlane' },
  };

  function resolveAaguidName(aaguid: string): string {
    if (!aaguid || aaguid === '00000000-0000-0000-0000-000000000000') {
      return 'Passkey';
    }
    return AAGUID_MAP[aaguid]?.name || 'Passkey';
  }

  // GET /api/auth/account (Comprehensive security & account state)
  app.get('/api/auth/account', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const currentSessionHash = getCurrentSessionHash(req);
    const now = Date.now();

    const userRow = db
      .prepare(`SELECT password_hash, is_passwordless FROM users WHERE id = ?`)
      .get(user.id) as { password_hash: string | null; is_passwordless: number } | undefined;

    const pendingEmailRow = db
      .prepare(`SELECT new_email FROM email_verifications WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1`)
      .get(user.id, now) as { new_email: string } | undefined;

    const oauthRows = db
      .prepare(`SELECT id, provider, provider_account_id, created_at FROM oauth_accounts WHERE user_id = ? ORDER BY created_at ASC`)
      .all(user.id) as Array<{ id: string; provider: string; provider_account_id: string; created_at: number }>;

    const passkeyRows = db
      .prepare(`SELECT id, name, aaguid, provider_icon, device_type, backed_up, transports, registered_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY registered_at DESC`)
      .all(user.id) as Array<{
        id: string;
        name: string;
        aaguid: string;
        provider_icon: string | null;
        device_type: 'singleDevice' | 'multiDevice';
        backed_up: number;
        transports: string;
        registered_at: number;
        last_used_at: number | null;
      }>;

    const sessionRows = db
      .prepare(`SELECT id, session_uid, ip_address, user_agent, created_at, last_active_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_active_at DESC`)
      .all(user.id, now) as Array<{
        id: string;
        session_uid: string | null;
        ip_address: string;
        user_agent: string;
        created_at: number;
        last_active_at: number;
      }>;

    const state: AccountSecurityState = {
      has_password: Boolean(userRow && userRow.password_hash !== null),
      is_passwordless: Boolean(userRow && (userRow.is_passwordless || userRow.password_hash === null)),
      pending_email: pendingEmailRow ? pendingEmailRow.new_email : null,
      oauth_accounts: oauthRows,
      passkeys: passkeyRows.map((p) => {
        let parsedTransports: string[] = [];
        try {
          parsedTransports = JSON.parse(p.transports || '[]');
        } catch {}
        return {
          id: p.id,
          name: p.name,
          aaguid: p.aaguid,
          provider_icon: p.provider_icon || undefined,
          device_type: p.device_type,
          backed_up: Boolean(p.backed_up),
          transports: parsedTransports,
          registered_at: p.registered_at,
          last_used_at: p.last_used_at,
        };
      }),
      sessions: sessionRows.map((s) => ({
        session_uid: s.session_uid || s.id.slice(0, 16),
        ip_address: s.ip_address || '127.0.0.1',
        user_agent: s.user_agent || 'Browser',
        created_at: s.created_at,
        last_active_at: s.last_active_at || s.created_at,
        is_current: s.id === currentSessionHash,
      })),
    };

    res.json(state);
  });

  // PUT /api/auth/profile
  app.put('/api/auth/profile', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = UpdateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid profile data', details: parsed.error.flatten() });
      return;
    }

    const now = Date.now();
    db.prepare(`UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?`).run(
      parsed.data.display_name,
      now,
      user.id
    );

    res.json({
      user: {
        ...user,
        display_name: parsed.data.display_name,
      },
    });
  });

  // POST /api/auth/email/request
  app.post('/api/auth/email/request', async (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = ChangeEmailRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid email payload', details: parsed.error.flatten() });
      return;
    }

    const normalizedNew = parsed.data.new_email.toLowerCase();
    if (normalizedNew === user.email.toLowerCase()) {
      res.status(400).json({ error: 'New email must be different from current email.' });
      return;
    }

    const currentSessionHash = getCurrentSessionHash(req);
    const now = Date.now();

    const sessionRow = db
      .prepare(`SELECT reauthenticated_at FROM sessions WHERE id = ?`)
      .get(currentSessionHash) as { reauthenticated_at: number | null } | undefined;

    const userRow = db
      .prepare(`SELECT password_hash FROM users WHERE id = ?`)
      .get(user.id) as { password_hash: string | null } | undefined;

    const isReauthenticated = sessionRow && sessionRow.reauthenticated_at && now - sessionRow.reauthenticated_at <= 5 * 60 * 1000;

    if (userRow?.password_hash !== null) {
      if (!parsed.data.current_password && !isReauthenticated) {
        res.status(401).json({ error: 'Current password is required to change email.' });
        return;
      }
      if (parsed.data.current_password) {
        const valid = await verifyPassword(parsed.data.current_password, userRow!.password_hash!);
        if (!valid) {
          res.status(401).json({ error: 'Incorrect current password.' });
          return;
        }
      }
    } else {
      if (!isReauthenticated) {
        res.status(401).json({
          error: 'Please re-authenticate with your passkey first to verify account ownership.',
          code: 'REAUTH_REQUIRED',
        });
        return;
      }
    }

    const existingUser = db.prepare(`SELECT id FROM users WHERE email = ?`).get(normalizedNew);
    if (existingUser) {
      res.status(409).json({ error: 'An account with that email already exists.' });
      return;
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashSessionToken(rawToken);

    db.transaction(() => {
      db.prepare(`DELETE FROM email_verifications WHERE user_id = ?`).run(user.id);
      db.prepare(
        `INSERT INTO email_verifications (token_hash, user_id, new_email, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(tokenHash, user.id, normalizedNew, now + 30 * 60 * 1000, now);
    })();

    const mailRes = await sendVerificationEmail(normalizedNew, rawToken);

    res.json({
      ok: true,
      pending_email: normalizedNew,
      dev_token: mailRes.dev_token,
    });
  });

  // POST /api/auth/email/verify
  app.post('/api/auth/email/verify', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = VerifyEmailTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid verification token payload', details: parsed.error.flatten() });
      return;
    }

    const tokenHash = hashSessionToken(parsed.data.token);
    const now = Date.now();
    const currentSessionHash = getCurrentSessionHash(req);

    const record = db
      .prepare(`SELECT new_email, expires_at FROM email_verifications WHERE token_hash = ? AND user_id = ?`)
      .get(tokenHash, user.id) as { new_email: string; expires_at: number } | undefined;

    if (!record) {
      res.status(400).json({ error: 'Invalid or already consumed verification token.' });
      return;
    }

    if (record.expires_at <= now) {
      db.prepare(`DELETE FROM email_verifications WHERE token_hash = ?`).run(tokenHash);
      res.status(400).json({ error: 'Verification token has expired. Please request a new one.' });
      return;
    }

    const existingConflict = db.prepare(`SELECT id FROM users WHERE email = ? AND id != ?`).get(record.new_email, user.id);
    if (existingConflict) {
      res.status(409).json({ error: 'An account with that email has already been registered.' });
      return;
    }

    db.transaction(() => {
      db.prepare(`UPDATE users SET email = ?, email_verified = 1, updated_at = ? WHERE id = ?`).run(
        record.new_email,
        now,
        user.id
      );
      db.prepare(`DELETE FROM email_verifications WHERE user_id = ?`).run(user.id);
      // Revoke all other sessions on email change
      if (currentSessionHash) {
        db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id != ?`).run(user.id, currentSessionHash);
      }
    })();

    res.json({
      ok: true,
      user: {
        ...user,
        email: record.new_email,
        email_verified: true,
      },
    });
  });

  // POST /api/auth/password/change
  app.post('/api/auth/password/change', async (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = ChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid password payload', details: parsed.error.flatten() });
      return;
    }

    const userRow = db
      .prepare(`SELECT password_hash, is_passwordless FROM users WHERE id = ?`)
      .get(user.id) as { password_hash: string | null; is_passwordless: number } | undefined;

    if (!userRow || userRow.password_hash === null || userRow.is_passwordless === 1) {
      res.status(400).json({
        error: 'This account has switched to passwordless mode. It is secured exclusively via Passkeys or OAuth.',
      });
      return;
    }

    const valid = await verifyPassword(parsed.data.current_password, userRow.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Current password does not match.' });
      return;
    }

    const newHash = await hashPassword(parsed.data.new_password);
    const now = Date.now();
    const currentSessionHash = getCurrentSessionHash(req);

    db.transaction(() => {
      db.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`).run(newHash, now, user.id);
      // Auto-revoke all other sessions upon password change
      if (currentSessionHash) {
        db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id != ?`).run(user.id, currentSessionHash);
      }
    })();

    res.json({ ok: true, revoked_other_sessions: true });
  });

  // POST /api/auth/password/set (Allows OAuth-only or passwordless accounts to create a password)
  app.post('/api/auth/password/set', async (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : '';
    if (newPassword.length < 8 || newPassword.length > 128) {
      res.status(400).json({ error: 'Password must be between 8 and 128 characters.' });
      return;
    }

    const userRow = db
      .prepare(`SELECT password_hash FROM users WHERE id = ?`)
      .get(user.id) as { password_hash: string | null } | undefined;

    if (userRow?.password_hash !== null) {
      res.status(400).json({ error: 'Account already has a password. Use password change instead.' });
      return;
    }

    const newHash = await hashPassword(newPassword);
    const now = Date.now();
    db.prepare(`UPDATE users SET password_hash = ?, is_passwordless = 0, updated_at = ? WHERE id = ?`).run(
      newHash,
      now,
      user.id
    );

    res.json({ ok: true, has_password: true, is_passwordless: false });
  });

  // POST /api/auth/password/remove (Switch to 100% Passwordless Account)
  app.post('/api/auth/password/remove', async (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userRow = db
      .prepare(`SELECT password_hash, is_passwordless FROM users WHERE id = ?`)
      .get(user.id) as { password_hash: string | null; is_passwordless: number } | undefined;

    if (!userRow || userRow.password_hash === null) {
      res.json({ ok: true, is_passwordless: true });
      return;
    }

    const currentSessionHash = getCurrentSessionHash(req);
    const now = Date.now();
    const sessionRow = db
      .prepare(`SELECT reauthenticated_at FROM sessions WHERE id = ?`)
      .get(currentSessionHash) as { reauthenticated_at: number | null } | undefined;

    const isReauthenticated = sessionRow && sessionRow.reauthenticated_at && now - sessionRow.reauthenticated_at <= 5 * 60 * 1000;

    const parsed = RemovePasswordSchema.safeParse(req.body);
    if (parsed.success && parsed.data.current_password) {
      const valid = await verifyPassword(parsed.data.current_password, userRow.password_hash);
      if (!valid) {
        res.status(401).json({ error: 'Current password does not match.' });
        return;
      }
    } else if (!isReauthenticated) {
      res.status(401).json({ error: 'Re-authentication required to switch to passwordless mode.', code: 'REAUTH_REQUIRED' });
      return;
    }

    const counts = countUserLoginMethods(db, user.id);
    if (counts.passkeyCount + counts.oauthCount < 1) {
      res.status(400).json({
        error: 'You must add at least one Passkey or connect an OAuth account before removing your password.',
      });
      return;
    }

    db.transaction(() => {
      db.prepare(`UPDATE users SET password_hash = NULL, is_passwordless = 1, updated_at = ? WHERE id = ?`).run(
        now,
        user.id
      );
      if (currentSessionHash) {
        db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id != ?`).run(user.id, currentSessionHash);
      }
    })();

    res.json({ ok: true, is_passwordless: true });
  });

  // POST /api/auth/oauth/link
  app.post('/api/auth/oauth/link', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = OAuthLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid OAuth link payload', details: parsed.error.flatten() });
      return;
    }

    const { provider } = parsed.data;
    const providerAccountId = parsed.data.provider_account_id || `oauth-${provider}-${user.id}`;
    const now = Date.now();
    const currentSessionHash = getCurrentSessionHash(req);

    let conflict = false;
    db.transaction(() => {
      const existing = db
        .prepare(`SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_account_id = ?`)
        .get(provider, providerAccountId) as { user_id: string } | undefined;

      if (existing && existing.user_id !== user.id) {
        conflict = true;
        return;
      }

      const alreadyLinked = db
        .prepare(`SELECT id FROM oauth_accounts WHERE user_id = ? AND provider = ?`)
        .get(user.id, provider);

      if (!alreadyLinked) {
        db.prepare(
          `INSERT INTO oauth_accounts (id, user_id, provider, provider_account_id, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(crypto.randomUUID(), user.id, provider, providerAccountId, now);
      }

      if (currentSessionHash) {
        db.prepare(`UPDATE sessions SET reauthenticated_at = ? WHERE id = ?`).run(now, currentSessionHash);
      }
    })();

    if (conflict) {
      res.status(409).json({ error: 'This OAuth account is already linked to a different PriceIt user.' });
      return;
    }

    const oauthAccounts = db
      .prepare(`SELECT id, provider, provider_account_id, created_at FROM oauth_accounts WHERE user_id = ?`)
      .all(user.id);

    res.json({ ok: true, oauth_accounts: oauthAccounts });
  });

  // DELETE /api/auth/oauth/:provider
  app.delete('/api/auth/oauth/:provider', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const provider = req.params.provider;
    let errorMsg: string | null = null;

    db.transaction(() => {
      const existing = db
        .prepare(`SELECT id FROM oauth_accounts WHERE user_id = ? AND provider = ?`)
        .get(user.id, provider);

      if (!existing) {
        errorMsg = 'OAuth provider is not connected.';
        return;
      }

      const counts = countUserLoginMethods(db, user.id);
      if (counts.total <= 1) {
        errorMsg = 'Cannot disconnect your only remaining sign-in method.';
        return;
      }

      db.prepare(`DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?`).run(user.id, provider);
    })();

    if (errorMsg) {
      res.status(400).json({ error: errorMsg });
      return;
    }

    res.json({ ok: true });
  });

  // POST /api/auth/passkeys/register/options
  app.post('/api/auth/passkeys/register/options', async (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { rpID, rpName } = getRpConfig(req);
    const existingPasskeys = db
      .prepare(`SELECT id, transports FROM passkeys WHERE user_id = ?`)
      .all(user.id) as Array<{ id: string; transports: string }>;

    const excludeCredentials = existingPasskeys.map((p) => {
      let tr: any[] = [];
      try {
        tr = JSON.parse(p.transports || '[]');
      } catch {}
      return {
        id: p.id,
        transports: tr,
      };
    });

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new Uint8Array(Buffer.from(user.id)),
      userName: user.email,
      userDisplayName: user.display_name,
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
    });

    const now = Date.now();
    const challengeId = crypto.randomUUID();
    const currentSessionHash = getCurrentSessionHash(req);

    db.prepare(
      `INSERT INTO webauthn_challenges (id, user_id, session_hash, challenge, purpose, expected_uv, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'register', 'preferred', ?, ?)`
    ).run(challengeId, user.id, currentSessionHash, options.challenge, now + 5 * 60 * 1000, now);

    res.json({
      options,
      challengeId,
      rpId: rpID,
      userIdBase64Url: Buffer.from(user.id).toString('base64url'),
    });
  });

  // POST /api/auth/passkeys/register/verify
  app.post('/api/auth/passkeys/register/verify', async (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { challengeId, custom_name, mock_passkey } = req.body;
    const credResponse = (req.body.response?.clientDataJSON ? req.body : req.body.response) || req.body;
    const now = Date.now();
    const currentSessionHash = getCurrentSessionHash(req);

    // Dev/Test Mock Passkey Bypass (enabled strictly for non-production Vitest execution)
    if (process.env.NODE_ENV !== 'production' && mock_passkey) {
      const mockId = req.body?.id || credResponse?.id || `mock-passkey-${crypto.randomUUID()}`;
      const mockName = custom_name || 'Mock Security Key';
      db.prepare(
        `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, transports, aaguid, provider_icon, name, registered_at, last_used_at)
         VALUES (?, ?, ?, 0, 'singleDevice', 0, '["internal"]', '00000000-0000-0000-0000-000000000000', NULL, ?, ?, ?)`
      ).run(mockId, user.id, 'mock-public-key', mockName, now, now);

      if (currentSessionHash) {
        db.prepare(`UPDATE sessions SET reauthenticated_at = ? WHERE id = ?`).run(now, currentSessionHash);
      }

      res.json({
        verified: true,
        passkey: {
          id: mockId,
          name: mockName,
          registered_at: now,
        },
        can_switch_passwordless: user.has_password,
      });
      return;
    }

    let challengeRow = challengeId
      ? (db
          .prepare(
            `SELECT id, challenge, expected_uv, expires_at FROM webauthn_challenges WHERE id = ? AND user_id = ? AND purpose = 'register'`
          )
          .get(challengeId, user.id) as { id: string; challenge: string; expected_uv: string; expires_at: number } | undefined)
      : undefined;

    if (!challengeRow) {
      challengeRow = db
        .prepare(
          `SELECT id, challenge, expected_uv, expires_at FROM webauthn_challenges WHERE user_id = ? AND purpose = 'register' AND expires_at > ? ORDER BY created_at DESC LIMIT 1`
        )
        .get(user.id, now) as { id: string; challenge: string; expected_uv: string; expires_at: number } | undefined;
    }

    if (!challengeRow || challengeRow.expires_at <= now) {
      res.status(400).json({ error: 'WebAuthn challenge expired or invalid.' });
      return;
    }

    db.prepare(`DELETE FROM webauthn_challenges WHERE id = ?`).run(challengeRow.id);

    const { rpID, origin } = getRpConfig(req);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: credResponse,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: challengeRow.expected_uv === 'required',
      });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message || 'WebAuthn verification failed' });
      return;
    }

    if (!verification.verified || !verification.registrationInfo) {
      res.status(400).json({ error: 'Passkey registration verification failed.' });
      return;
    }

    const { credential, credentialDeviceType, credentialBackedUp, aaguid } = verification.registrationInfo;
    const finalName = custom_name?.trim() || resolveAaguidName(aaguid);
    const pubKeyBase64 = Buffer.from(credential.publicKey).toString('base64url');
    const transportsJson = JSON.stringify(credResponse.response?.transports || []);

    db.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, transports, aaguid, provider_icon, name, registered_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
    ).run(
      credential.id,
      user.id,
      pubKeyBase64,
      credential.counter,
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      transportsJson,
      aaguid || '00000000-0000-0000-0000-000000000000',
      finalName,
      now,
      now
    );

    if (currentSessionHash) {
      db.prepare(`UPDATE sessions SET reauthenticated_at = ? WHERE id = ?`).run(now, currentSessionHash);
    }

    res.json({
      verified: true,
      passkey: {
        id: credential.id,
        name: finalName,
        registered_at: now,
      },
      can_switch_passwordless: user.has_password,
    });
  });

  // POST /api/auth/passkeys/login/options
  app.post('/api/auth/passkeys/login/options', async (req, res) => {
    const { rpID } = getRpConfig(req);
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: [],
      userVerification: 'preferred',
    });

    const now = Date.now();
    const challengeId = crypto.randomUUID();

    db.prepare(
      `INSERT INTO webauthn_challenges (id, user_id, session_hash, challenge, purpose, expected_uv, expires_at, created_at)
       VALUES (?, NULL, NULL, ?, 'login', 'preferred', ?, ?)`
    ).run(challengeId, options.challenge, now + 5 * 60 * 1000, now);

    res.json({
      options,
      challengeId,
      rpId: rpID,
    });
  });

  // POST /api/auth/passkeys/login/verify
  app.post('/api/auth/passkeys/login/verify', async (req, res) => {
    const { challengeId } = req.body;
    const credResponse = (req.body.response?.clientDataJSON ? req.body : req.body.response) || req.body;
    const now = Date.now();

    const passkeyRow = db
      .prepare(`SELECT id, user_id, public_key, counter FROM passkeys WHERE id = ?`)
      .get(credResponse?.id) as { id: string; user_id: string; public_key: string; counter: number } | undefined;

    // Per modern-web-guidance: return HTTP 404 so client calls signalUnknownCredential
    if (!passkeyRow) {
      res.status(404).json({ error: 'Passkey credential not found.' });
      return;
    }

    const userAccount = db.prepare(`SELECT is_banned FROM users WHERE id = ?`).get(passkeyRow.user_id) as any;
    if (userAccount && userAccount.is_banned === 1) {
      res.status(403).json({ error: 'This account has been suspended by an administrator.' });
      return;
    }

    let challengeRow = challengeId
      ? (db
          .prepare(
            `SELECT id, challenge, expected_uv, expires_at FROM webauthn_challenges WHERE id = ? AND purpose = 'login'`
          )
          .get(challengeId) as { id: string; challenge: string; expected_uv: string; expires_at: number } | undefined)
      : undefined;

    if (!challengeRow) {
      challengeRow = db
        .prepare(
          `SELECT id, challenge, expected_uv, expires_at FROM webauthn_challenges WHERE purpose = 'login' AND expires_at > ? ORDER BY created_at DESC LIMIT 1`
        )
        .get(now) as { id: string; challenge: string; expected_uv: string; expires_at: number } | undefined;
    }

    if (!challengeRow || challengeRow.expires_at <= now) {
      res.status(400).json({ error: 'WebAuthn login challenge expired or invalid.' });
      return;
    }

    db.prepare(`DELETE FROM webauthn_challenges WHERE id = ?`).run(challengeRow.id);

    const { rpID, origin } = getRpConfig(req);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: credResponse,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: passkeyRow.id,
          publicKey: new Uint8Array(Buffer.from(passkeyRow.public_key, 'base64url')),
          counter: passkeyRow.counter,
        },
        requireUserVerification: challengeRow.expected_uv === 'required',
      });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message || 'Authentication assertion verification failed.' });
      return;
    }

    if (!verification.verified) {
      res.status(400).json({ error: 'Passkey authentication failed.' });
      return;
    }

    db.prepare(`UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?`).run(
      verification.authenticationInfo.newCounter,
      now,
      passkeyRow.id
    );

    const userRow = db
      .prepare(`SELECT id, email, display_name, email_verified FROM users WHERE id = ?`)
      .get(passkeyRow.user_id) as { id: string; email: string; display_name: string | null; email_verified: number };

    createSessionForUser(userRow.id, res, req);

    res.json({
      user: {
        id: userRow.id,
        email: userRow.email,
        display_name: userRow.display_name || userRow.email.split('@')[0],
        email_verified: Boolean(userRow.email_verified),
      },
    });
  });

  // POST /api/auth/reauth/options (Step-Up Reauthentication for logged in user)
  app.post('/api/auth/reauth/options', async (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { rpID } = getRpConfig(req);
    const userPasskeys = db
      .prepare(`SELECT id, transports FROM passkeys WHERE user_id = ?`)
      .all(user.id) as Array<{ id: string; transports: string }>;

    const allowCredentials = userPasskeys.map((p) => {
      let tr: any[] = [];
      try {
        tr = JSON.parse(p.transports || '[]');
      } catch {}
      return {
        id: p.id,
        transports: tr,
      };
    });

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification: 'preferred',
    });

    const now = Date.now();
    const challengeId = crypto.randomUUID();
    const currentSessionHash = getCurrentSessionHash(req);

    db.prepare(
      `INSERT INTO webauthn_challenges (id, user_id, session_hash, challenge, purpose, expected_uv, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'reauth', 'preferred', ?, ?)`
    ).run(challengeId, user.id, currentSessionHash, options.challenge, now + 5 * 60 * 1000, now);

    res.json({
      options,
      challengeId,
      rpId: rpID,
      hasPasskeys: userPasskeys.length > 0,
    });
  });

  // POST /api/auth/reauth/verify
  app.post('/api/auth/reauth/verify', async (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { challengeId, response: credResponse } = req.body;
    const now = Date.now();
    const currentSessionHash = getCurrentSessionHash(req);

    const passkeyRow = db
      .prepare(`SELECT id, user_id, public_key, counter FROM passkeys WHERE id = ?`)
      .get(credResponse?.id) as { id: string; user_id: string; public_key: string; counter: number } | undefined;

    if (!passkeyRow || passkeyRow.user_id !== user.id) {
      res.status(404).json({ error: 'Matching user passkey not found.' });
      return;
    }

    const challengeRow = db
      .prepare(`SELECT challenge, expected_uv, expires_at FROM webauthn_challenges WHERE id = ? AND user_id = ? AND purpose = 'reauth'`)
      .get(challengeId, user.id) as { challenge: string; expected_uv: string; expires_at: number } | undefined;

    if (!challengeRow || challengeRow.expires_at <= now) {
      res.status(400).json({ error: 'Re-authentication challenge expired.' });
      return;
    }

    db.prepare(`DELETE FROM webauthn_challenges WHERE id = ?`).run(challengeId);

    const { rpID, origin } = getRpConfig(req);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: credResponse,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: passkeyRow.id,
          publicKey: new Uint8Array(Buffer.from(passkeyRow.public_key, 'base64url')),
          counter: passkeyRow.counter,
        },
        requireUserVerification: challengeRow.expected_uv === 'required',
      });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message || 'Re-authentication verification failed.' });
      return;
    }

    if (!verification.verified) {
      res.status(400).json({ error: 'Passkey re-authentication failed.' });
      return;
    }

    db.prepare(`UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?`).run(
      verification.authenticationInfo.newCounter,
      now,
      passkeyRow.id
    );

    if (currentSessionHash) {
      db.prepare(`UPDATE sessions SET reauthenticated_at = ? WHERE id = ?`).run(now, currentSessionHash);
    }

    res.json({ verified: true });
  });

  // POST /api/auth/reauth/password
  app.post('/api/auth/reauth/password', async (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { current_password } = req.body;
    const userRow = db
      .prepare(`SELECT password_hash FROM users WHERE id = ?`)
      .get(user.id) as { password_hash: string | null } | undefined;

    if (!userRow || userRow.password_hash === null) {
      res.status(400).json({ error: 'Account has no password set.' });
      return;
    }

    const valid = await verifyPassword(current_password || '', userRow.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Incorrect current password.' });
      return;
    }

    const currentSessionHash = getCurrentSessionHash(req);
    const now = Date.now();
    if (currentSessionHash) {
      db.prepare(`UPDATE sessions SET reauthenticated_at = ? WHERE id = ?`).run(now, currentSessionHash);
    }

    res.json({ verified: true });
  });

  // PUT /api/auth/passkeys/:id
  app.put('/api/auth/passkeys/:id', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = PasskeyRenameSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid name payload', details: parsed.error.flatten() });
      return;
    }

    const info = db
      .prepare(`UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?`)
      .run(parsed.data.name, req.params.id, user.id);

    if (info.changes === 0) {
      res.status(404).json({ error: 'Passkey not found.' });
      return;
    }

    res.json({ ok: true, name: parsed.data.name, passkey: { id: req.params.id, name: parsed.data.name } });
  });

  // DELETE /api/auth/passkeys/:id
  app.delete('/api/auth/passkeys/:id', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    let errorMsg: string | null = null;
    let remainingIds: string[] = [];

    db.transaction(() => {
      const existing = db.prepare(`SELECT id FROM passkeys WHERE id = ? AND user_id = ?`).get(req.params.id, user.id);
      if (!existing) {
        errorMsg = 'Passkey not found.';
        return;
      }

      const counts = countUserLoginMethods(db, user.id);
      if (counts.total <= 1) {
        errorMsg = 'Cannot revoke your last remaining sign-in method.';
        return;
      }

      db.prepare(`DELETE FROM passkeys WHERE id = ? AND user_id = ?`).run(req.params.id, user.id);
      const remaining = db.prepare(`SELECT id FROM passkeys WHERE user_id = ?`).all(user.id) as Array<{ id: string }>;
      remainingIds = remaining.map((r) => r.id);
    })();

    if (errorMsg) {
      res.status(400).json({ error: errorMsg });
      return;
    }

    res.json({
      ok: true,
      remaining_credential_ids: remainingIds,
      rpId: getRpConfig(req).rpID,
      userIdBase64Url: Buffer.from(user.id).toString('base64url'),
    });
  });

  // POST /api/auth/sessions/revoke-others
  app.post('/api/auth/sessions/revoke-others', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const currentSessionHash = getCurrentSessionHash(req);
    if (!currentSessionHash) {
      res.status(400).json({ error: 'Session not identified.' });
      return;
    }

    const info = db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id != ?`).run(user.id, currentSessionHash);
    res.json({ ok: true, revoked_count: info.changes });
  });

  // DELETE /api/auth/sessions/:sessionUid
  app.delete('/api/auth/sessions/:sessionUid', (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const sessionUid = req.params.sessionUid;
    const currentSessionHash = getCurrentSessionHash(req);

    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND (session_uid = ? OR id = ?) AND id != ?`).run(
      user.id,
      sessionUid,
      sessionUid,
      currentSessionHash || ''
    );

    res.json({ ok: true });
  });

  // POST /api/auth/account/delete
  app.post('/api/auth/account/delete', async (req, res) => {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = DeleteAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Confirmation must strictly equal 'DELETE'.", details: parsed.error.flatten() });
      return;
    }

    const userRow = db
      .prepare(`SELECT password_hash FROM users WHERE id = ?`)
      .get(user.id) as { password_hash: string | null } | undefined;

    const currentSessionHash = getCurrentSessionHash(req);
    const now = Date.now();
    const sessionRow = db
      .prepare(`SELECT reauthenticated_at FROM sessions WHERE id = ?`)
      .get(currentSessionHash) as { reauthenticated_at: number | null } | undefined;

    const isReauthenticated = sessionRow && sessionRow.reauthenticated_at && now - sessionRow.reauthenticated_at <= 5 * 60 * 1000;

    if (userRow?.password_hash !== null) {
      if (!parsed.data.current_password && !isReauthenticated) {
        res.status(401).json({ error: 'Current password is required to delete your account.' });
        return;
      }
      if (parsed.data.current_password) {
        const valid = await verifyPassword(parsed.data.current_password, userRow!.password_hash!);
        if (!valid) {
          res.status(401).json({ error: 'Incorrect current password.' });
          return;
        }
      }
    } else {
      if (!isReauthenticated) {
        res.status(401).json({ error: 'Re-authentication required to delete account.', code: 'REAUTH_REQUIRED' });
        return;
      }
    }

    const { rpID } = getRpConfig(req);
    const userIdBase64Url = Buffer.from(user.id).toString('base64url');

    db.transaction(() => {
      db.prepare(`DELETE FROM users WHERE id = ?`).run(user.id);
    })();

    clearSessionCookie(res);
    res.json({
      ok: true,
      rpId: rpID,
      userIdBase64Url,
    });
  });

  // Admin Verification Middleware Helper
  function requireAdmin(req: express.Request, res: express.Response): UserPublic | null {
    const user = getAuthenticatedUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    if (!user.is_admin) {
      res.status(403).json({ error: 'Administrator privileges required.' });
      return null;
    }
    return user;
  }

  // GET /api/admin/users (List all registered accounts with moderation metadata)
  app.get('/api/admin/users', (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const rows = db.prepare(`
      SELECT u.id, u.email, u.display_name, u.email_verified, u.is_admin, u.is_banned, u.ban_reason,
             u.password_reset_required, u.is_passwordless, u.created_at,
             (SELECT MAX(last_active_at) FROM sessions WHERE user_id = u.id) as last_active_at,
             (SELECT COUNT(*) FROM sessions WHERE user_id = u.id) as active_sessions_count,
             (SELECT COUNT(*) FROM projects WHERE user_id = u.id) as projects_count
      FROM users u
      ORDER BY u.created_at DESC
    `).all() as any[];

    const users: AdminUserPublic[] = rows.map((r) => ({
      id: r.id,
      email: r.email,
      display_name: r.display_name || r.email.split('@')[0],
      email_verified: Boolean(r.email_verified),
      is_admin: Boolean(r.is_admin),
      is_banned: Boolean(r.is_banned),
      ban_reason: r.ban_reason || null,
      password_reset_required: Boolean(r.password_reset_required),
      is_passwordless: Boolean(r.is_passwordless),
      created_at: r.created_at,
      last_active_at: r.last_active_at || null,
      active_sessions_count: r.active_sessions_count || 0,
      projects_count: r.projects_count || 0,
    }));

    res.json({ users });
  });

  // POST /api/admin/users/:id/ban (Ban or unban user, immediately purges sessions if banned)
  app.post('/api/admin/users/:id/ban', (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const targetId = req.params.id;
    if (targetId === admin.id) {
      res.status(400).json({ error: 'Cannot ban your own administrator account.' });
      return;
    }

    const { banned, reason } = req.body;
    const isBanned = Boolean(banned);
    const banReason = isBanned ? String(reason || 'Suspended by administrator').slice(0, 500) : null;

    db.transaction(() => {
      db.prepare(`UPDATE users SET is_banned = ?, ban_reason = ? WHERE id = ?`).run(
        isBanned ? 1 : 0,
        banReason,
        targetId
      );
      if (isBanned) {
        db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(targetId);
      }
    })();

    res.json({ ok: true, is_banned: isBanned });
  });

  // POST /api/admin/users/:id/reset-password (Lock account, purge sessions, issue reset token)
  app.post('/api/admin/users/:id/reset-password', async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const targetId = req.params.id;
    const targetUser = db.prepare(`SELECT id, email, display_name FROM users WHERE id = ?`).get(targetId) as any;
    if (!targetUser) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    const resetToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashSessionToken(resetToken);
    const now = Date.now();

    db.transaction(() => {
      db.prepare(`UPDATE users SET password_reset_required = 1 WHERE id = ?`).run(targetId);
      db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(targetId);
      db.prepare(`DELETE FROM email_verifications WHERE user_id = ?`).run(targetId);
      db.prepare(
        `INSERT INTO email_verifications (token_hash, user_id, new_email, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(tokenHash, targetId, targetUser.email, now + 60 * 60 * 1000, now);
    })();

    await sendVerificationEmail(targetUser.email, resetToken);

    res.json({
      ok: true,
      locked: true,
      reset_token: process.env.NODE_ENV !== 'production' ? resetToken : undefined,
    });
  });

  // POST /api/admin/users/:id/promote (Toggle administrator rights)
  app.post('/api/admin/users/:id/promote', (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const targetId = req.params.id;
    if (targetId === admin.id) {
      res.status(400).json({ error: 'Cannot modify your own administrative rank.' });
      return;
    }

    const { is_admin } = req.body;
    db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`).run(is_admin ? 1 : 0, targetId);
    res.json({ ok: true, is_admin: Boolean(is_admin) });
  });

  // DELETE /api/admin/users/:id (Permanently delete user and cascade projects)
  app.delete('/api/admin/users/:id', (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const targetId = req.params.id;
    if (targetId === admin.id) {
      res.status(400).json({ error: 'Cannot delete your own administrator account.' });
      return;
    }

    db.prepare(`DELETE FROM users WHERE id = ?`).run(targetId);
    res.json({ ok: true });
  });

  // GET /api/admin/oauth (Fetch current OAuth credentials configuration)
  app.get('/api/admin/oauth', (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const settings = db.prepare(`SELECT key, value FROM system_settings WHERE key LIKE 'oauth_%'`).all() as Array<{ key: string; value: string }>;
    const settingsMap = new Map(settings.map((s) => [s.key, s.value]));

    const providers = ['google', 'facebook'];
    const publicOrigin = getPublicOrigin(req);
    const configs = providers.map((prov) => {
      const clientId = settingsMap.get(`oauth_${prov}_client_id`) || process.env[`${prov.toUpperCase()}_CLIENT_ID`] || '';
      const secret = settingsMap.get(`oauth_${prov}_client_secret`) || process.env[`${prov.toUpperCase()}_CLIENT_SECRET`] || '';
      const enabled = settingsMap.get(`oauth_${prov}_enabled`) !== 'false';
      return {
        provider: prov,
        client_id: clientId,
        is_secret_set: Boolean(secret),
        enabled,
        redirect_uri: `${publicOrigin}/api/auth/oauth/${prov}/callback`,
      };
    });

    res.json({ configs });
  });

  // PUT /api/admin/oauth (Save OAuth credentials configuration)
  app.put('/api/admin/oauth', (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const { provider, client_id, client_secret, enabled } = req.body;
    if (!provider) {
      res.status(400).json({ error: 'Provider is required.' });
      return;
    }

    const now = Date.now();
    db.transaction(() => {
      if (typeof client_id === 'string') {
        db.prepare(
          `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run(`oauth_${provider}_client_id`, client_id.trim(), now);
      }
      if (client_secret && typeof client_secret === 'string' && client_secret.trim()) {
        db.prepare(
          `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run(`oauth_${provider}_client_secret`, client_secret.trim(), now);
      }
      if (typeof enabled === 'boolean') {
        db.prepare(
          `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run(`oauth_${provider}_enabled`, String(enabled), now);
      }
    })();

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

  // Rate limiter for public OpenGraph image rendering (DoS protection)
  const ogRateLimits = new Map<string, { count: number; resetAt: number }>();
  function checkOgRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = ogRateLimits.get(ip);
    if (!entry || now > entry.resetAt) {
      ogRateLimits.set(ip, { count: 1, resetAt: now + 60000 });
      return true;
    }
    if (entry.count >= 60) {
      return false;
    }
    entry.count++;
    return true;
  }

  // GET /api/og/:token (Dynamic OpenGraph 1200x630 preview card PNG)
  app.get('/api/og/:token', (req, res) => {
    const ip = getClientIp(req);
    if (!checkOgRateLimit(ip)) {
      res.status(429).json({ error: 'Too many requests for OpenGraph previews. Please try again shortly.' });
      return;
    }

    let token = req.params.token;
    if (token.endsWith('.png')) {
      token = token.slice(0, -4);
    }

    const shareRow = db
      .prepare(`SELECT project_id FROM project_shares WHERE share_token = ? AND is_active = 1`)
      .get(token) as { project_id: string } | undefined;

    if (!shareRow) {
      res.status(404).json({ error: 'Share link not found or revoked' });
      return;
    }

    const project = loadFullProjectUnscoped(db, shareRow.project_id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    try {
      const solverResult = solveBundleOptimization(project);
      const theme = req.query.theme === 'light' ? 'light' : 'dark';
      const pngBuffer = renderOgCardPng(project, solverResult, theme);

      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
      res.send(pngBuffer);
    } catch (err: unknown) {
      console.error('Failed to render OG card:', err);
      res.status(500).json({ error: 'Failed to generate preview image' });
    }
  });

  // GET /share/:token (Clean public route with OpenGraph meta injection)
  app.get('/share/:token', (req, res) => {
    let token = req.params.token;
    if (token.endsWith('/')) token = token.slice(0, -1);

    const shareRow = db
      .prepare(`SELECT project_id FROM project_shares WHERE share_token = ? AND is_active = 1`)
      .get(token) as { project_id: string } | undefined;

    let indexPath = path.join(process.cwd(), 'dist', 'client', 'index.html');
    if (!fs.existsSync(indexPath)) {
      indexPath = path.join(process.cwd(), 'index.html');
    }

    if (!fs.existsSync(indexPath)) {
      res.status(404).send('Not Found');
      return;
    }

    let html = fs.readFileSync(indexPath, 'utf-8');

    if (!shareRow) {
      res.type('html').send(html);
      return;
    }

    const project = loadFullProjectUnscoped(db, shareRow.project_id);
    if (!project) {
      res.type('html').send(html);
      return;
    }

    const solverResult = solveBundleOptimization(project);
    const theme = req.query.theme === 'light' ? 'light' : 'dark';
    const title = `PriceIt — ${escapeXml(project.name)}`;
    const costStr = `$${formatCentsToDollars(solverResult.grand_total_cents)}`;
    const savingsStr =
      solverResult.savings_vs_baseline_cents > 0
        ? ` (Save $${formatCentsToDollars(solverResult.savings_vs_baseline_cents)})`
        : '';
    const desc = `Total: ${costStr}${savingsStr} across ${solverResult.vendor_orders.length} vendor${
      solverResult.vendor_orders.length === 1 ? '' : 's'
    }. Optimal Bill of Materials solved with PriceIt.`;
    const ogImageUrl = `https://priceit.rbnd.cc/api/og/${encodeURIComponent(token)}.png?theme=${theme}`;
    const pageUrl = `https://priceit.rbnd.cc/share/${encodeURIComponent(token)}`;

    const ogTags = `
    <base href="/" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${pageUrl}" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${desc}" />
    <meta property="og:image" content="${ogImageUrl}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${desc}" />
    <meta name="twitter:image" content="${ogImageUrl}" />
`;

    html = html.replace('<head>', `<head>\n${ogTags}`);
    res.type('html').send(html);
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
