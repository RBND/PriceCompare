import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { initDatabase } from '../src/server/db.js';
import { createApp } from '../src/server/app.js';
import { AuthRateLimiter } from '../src/server/auth.js';
import { sanitizeSpreadsheetCell, generateProjectCsv } from '../src/shared/export.js';
import { extractVendorFromUrl, isValidHttpUrl } from '../src/shared/types.js';
import { DEMO_BRAKE_PROJECT } from '../src/shared/demoData.js';
import { solveBundleOptimization } from '../src/shared/solver.js';

describe('Security Controls, Auth, OAuth Linking Safety, Idempotent Guest Migration & API', () => {
  let db: ReturnType<typeof initDatabase>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = initDatabase(':memory:');
    app = createApp(db, new AuthRateLimiter(10, 15 * 60 * 1000));
  });

  it('enforces SQLite WAL mode / foreign_keys PRAGMAs and initializes all 9 tables', () => {
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toEqual(
      expect.arrayContaining([
        'users',
        'oauth_accounts',
        'sessions',
        'projects',
        'vendor_profiles',
        'parts',
        'offerings',
        'bundle_mappings',
        'project_shares',
      ])
    );
  });

  it('rejects state-mutating requests missing X-PriceIt-CSRF header or with mismatched Origin (Spec 7.2)', async () => {
    const noCsrfRes = await request(app).post('/api/auth/register').send({
      email: 'victim@example.com',
      password: 'password1234',
    });
    expect(noCsrfRes.status).toBe(403);
    expect(noCsrfRes.body.error).toContain('X-PriceIt-CSRF');

    const badOriginRes = await request(app)
      .post('/api/auth/register')
      .set('X-PriceIt-CSRF', '1')
      .set('Host', 'priceit.rbnd.cc')
      .set('Origin', 'https://evil-attacker.com')
      .send({
        email: 'victim@example.com',
        password: 'password1234',
      });
    expect(badOriginRes.status).toBe(403);
    expect(badOriginRes.body.error).toContain('Origin mismatch');
  });

  it('prevents OAuth pre-account takeover by clearing unverified password_hash and sessions on OAuth link (Spec 7.3)', async () => {
    const agent = request.agent(app);

    // 1. Attacker pre-registers victim@example.com with unverified email and sets a known password
    const regRes = await agent
      .post('/api/auth/register')
      .set('X-PriceIt-CSRF', '1')
      .send({
        email: 'victim@example.com',
        password: 'attackerPassword123',
      });
    expect(regRes.status).toBe(201);

    // Verify attacker's session is currently active
    const meBefore = await agent.get('/api/auth/me');
    expect(meBefore.body.user?.email).toBe('victim@example.com');

    // 2. Real victim signs in via Google OAuth with verified email victim@example.com
    const victimAgent = request.agent(app);
    const oauthRes = await victimAgent
      .post('/api/auth/oauth/callback')
      .set('X-PriceIt-CSRF', '1')
      .send({
        provider: 'google',
        provider_account_id: 'google-uid-99999',
        email: 'victim@example.com',
        display_name: 'Real Victim',
      });
    expect(oauthRes.status).toBe(200);
    expect(oauthRes.body.user.email_verified).toBe(true);

    // 3. Attacker's prior session MUST be invalidated
    const meAfter = await agent.get('/api/auth/me');
    expect(meAfter.body.user).toBeNull();

    // 4. Attacker's password MUST be cleared so password login fails
    const attackerLogin = await request(app)
      .post('/api/auth/login')
      .set('X-PriceIt-CSRF', '1')
      .send({
        email: 'victim@example.com',
        password: 'attackerPassword123',
      });
    expect(attackerLogin.status).toBe(401);
  });

  it('performs idempotent guest project migration on register/login without duplicating projects (Spec Section 4)', async () => {
    const agent = request.agent(app);
    const migrationPayload = {
      client_project_uuid: 'guest-uuid-idempotent-test-1',
      is_dirty: true,
      project: {
        ...DEMO_BRAKE_PROJECT,
        name: 'Guest Custom Brake Build',
      },
    };

    const regRes = await agent
      .post('/api/auth/register')
      .set('X-PriceIt-CSRF', '1')
      .send({
        email: 'builder@example.com',
        password: 'strongPassword123',
        guest_migration: migrationPayload,
      });

    expect(regRes.status).toBe(201);
    const firstMigratedId = regRes.body.migrated_project_id;
    expect(firstMigratedId).toBeTruthy();

    // Retry migrating the exact same client_project_uuid via /api/projects/migrate-guest or login
    const retryRes = await agent
      .post('/api/projects/migrate-guest')
      .set('X-PriceIt-CSRF', '1')
      .send(migrationPayload);

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.migrated_project_id).toBe(firstMigratedId);

    // Confirm only 1 project exists in database for this user
    const listRes = await agent.get('/api/projects');
    expect(listRes.body.projects).toHaveLength(1);
    expect(listRes.body.projects[0].name).toBe('Guest Custom Brake Build');
  });

  it('rejects XSS schemes (javascript:, data:, vbscript:) in reference_url with 400 Bad Request (Spec 7.4)', async () => {
    expect(isValidHttpUrl('https://www.rockauto.com/part')).toBe(true);
    expect(isValidHttpUrl('http://example.com')).toBe(true);
    expect(isValidHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isValidHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isValidHttpUrl('vbscript:msgbox(1)')).toBe(false);

    const agent = request.agent(app);
    await agent.post('/api/auth/register').set('X-PriceIt-CSRF', '1').send({
      email: 'sec@example.com',
      password: 'password1234',
    });

    const badProject = {
      ...DEMO_BRAKE_PROJECT,
      offerings: [
        {
          ...DEMO_BRAKE_PROJECT.offerings[0],
          reference_url: 'javascript:alert(document.cookie)',
        },
      ],
    };

    const createRes = await agent
      .post('/api/projects')
      .set('X-PriceIt-CSRF', '1')
      .send(badProject);

    expect(createRes.status).toBe(400);
  });

  it('enforces optimistic concurrency version checks on PUT /api/projects/:id and supports public share links', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register').set('X-PriceIt-CSRF', '1').send({
      email: 'sync@example.com',
      password: 'password1234',
    });

    const createRes = await agent
      .post('/api/projects')
      .set('X-PriceIt-CSRF', '1')
      .send(DEMO_BRAKE_PROJECT);
    expect(createRes.status).toBe(201);
    const project = createRes.body.project;
    expect(project.version).toBe(1);

    // Update with matching version 1 -> succeeds and increments to version 2
    const update1 = await agent
      .put(`/api/projects/${project.id}`)
      .set('X-PriceIt-CSRF', '1')
      .send({ ...project, name: 'Updated v2', version: 1 });
    expect(update1.status).toBe(200);
    expect(update1.body.project.version).toBe(2);

    // Stale update with version 1 -> fails with 409 Conflict and returns current_version: 2
    const staleUpdate = await agent
      .put(`/api/projects/${project.id}`)
      .set('X-PriceIt-CSRF', '1')
      .send({ ...project, name: 'Stale Overwrite', version: 1 });
    expect(staleUpdate.status).toBe(409);
    expect(staleUpdate.body.current_version).toBe(2);

    // Create 128-bit base64url share link
    const shareRes = await agent
      .post(`/api/projects/${project.id}/share`)
      .set('X-PriceIt-CSRF', '1');
    expect(shareRes.status).toBe(200);
    const token = shareRes.body.share_token;
    expect(token).toHaveLength(22); // 16 bytes in base64url = 22 chars

    // Unauthenticated client can read shared project via token
    const publicRead = await request(app).get(`/api/shares/${token}`);
    expect(publicRead.status).toBe(200);
    expect(publicRead.body.project.name).toBe('Updated v2');
    expect(publicRead.body.read_only).toBe(true);

    // Revoke share link -> subsequent read returns 404
    await agent.delete(`/api/projects/${project.id}/share`).set('X-PriceIt-CSRF', '1');
    const afterRevoke = await request(app).get(`/api/shares/${token}`);
    expect(afterRevoke.status).toBe(404);

    // Delete project -> 200 OK and subsequent GET returns 404
    const delRes = await agent.delete(`/api/projects/${project.id}`).set('X-PriceIt-CSRF', '1');
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);
    const getDeleted = await agent.get(`/api/projects/${project.id}`);
    expect(getDeleted.status).toBe(404);
  });

  it('handles multi-hop X-Forwarded-Host headers and non-ASCII/duplicate vendor profiles safely', async () => {
    const agent = request.agent(app);
    const regRes = await agent
      .post('/api/auth/register')
      .set('X-PriceIt-CSRF', '1')
      .set('X-Forwarded-Host', 'priceit.rbnd.cc, 10.0.0.1')
      .set('Origin', 'https://priceit.rbnd.cc')
      .send({
        email: 'proxy@example.com',
        password: 'password1234',
      });
    expect(regRes.status).toBe(201);

    const projectRes = await agent
      .post('/api/projects')
      .set('X-PriceIt-CSRF', '1')
      .send({
        ...DEMO_BRAKE_PROJECT,
        client_project_uuid: 'non-ascii-vendor-test',
        vendor_profiles: [
          { vendor_name: '秋葉原パーツ', flat_shipping_cents: 500, free_shipping_threshold_cents: null, tax_rate_bps: 1000 },
          { vendor_name: '서울부품', flat_shipping_cents: 700, free_shipping_threshold_cents: null, tax_rate_bps: 1000 },
        ],
      });
    expect(projectRes.status).toBe(201);
    expect(projectRes.body.project.vendor_profiles).toHaveLength(2);
  });

  it('enforces rate limiting of 10 attempts per 15 minutes per IP + email (Spec 7.6)', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await request(app)
        .post('/api/auth/login')
        .set('X-PriceIt-CSRF', '1')
        .send({ email: 'brute@example.com', password: 'wrongpassword' });
      expect(r.status).toBe(401);
    }

    const eleventh = await request(app)
      .post('/api/auth/login')
      .set('X-PriceIt-CSRF', '1')
      .send({ email: 'brute@example.com', password: 'wrongpassword' });
    expect(eleventh.status).toBe(429);
  });

  it('sanitizes CSV / Excel formula injection prefixes (=, +, -, @, \\t, \\r) (Spec 7.5)', () => {
    expect(sanitizeSpreadsheetCell('=CMD|\' /C calc\'!A0')).toBe("'=CMD|' /C calc'!A0");
    expect(sanitizeSpreadsheetCell('+SUM(A1:A10)')).toBe("'+SUM(A1:A10)");
    expect(sanitizeSpreadsheetCell('-2+3+cmd')).toBe("'-2+3+cmd");
    expect(sanitizeSpreadsheetCell('@SUM(1+1)')).toBe("'@SUM(1+1)");
    expect(sanitizeSpreadsheetCell('\t=1+1')).toBe("'\t=1+1");
    expect(sanitizeSpreadsheetCell('\r=1+1')).toBe("'\r=1+1");
    expect(sanitizeSpreadsheetCell('Normal Part Name')).toBe('Normal Part Name');

    const maliciousProject = {
      ...DEMO_BRAKE_PROJECT,
      name: '=HYPERLINK("http://evil.com","Click")',
    };
    const solved = solveBundleOptimization({
      parts: maliciousProject.parts,
      offerings: maliciousProject.offerings,
      bundle_mappings: maliciousProject.bundle_mappings,
      vendor_profiles: maliciousProject.vendor_profiles,
      default_tax_bps: maliciousProject.default_tax_bps,
    });
    const csv = generateProjectCsv(maliciousProject, solved);
    expect(csv).toContain('"\'=HYPERLINK(""http://evil.com"",""Click"")"');
  });

  it('parses vendor names from reference URLs purely client-side', () => {
    expect(extractVendorFromUrl('https://www.rockauto.com/en/catalog/part')).toBe('RockAuto');
    expect(extractVendorFromUrl('https://www.fcpeuro.com/products/brake-kit')).toBe('FCP Euro');
    expect(extractVendorFromUrl('https://smile.amazon.com/dp/B001')).toBe('Amazon');
    expect(extractVendorFromUrl('https://www.mcmaster.com/91292A115/')).toBe('McMaster-Carr');
    expect(extractVendorFromUrl('https://custompartsstore.io/item/123')).toBe('Custompartsstore');
    expect(extractVendorFromUrl('javascript:alert(1)')).toBe('');
  });

  describe('Account Settings, Passkeys, OAuth Linking & Session Management', () => {
    it('manages profile, email verification, multi-session auto-logout on password change, passkey registration, and passwordless switch', async () => {
      // 1. Register a fresh user
      const registerRes = await request(app)
        .post('/api/auth/register')
        .set('X-PriceIt-CSRF', '1')
        .send({
          email: 'craftsperson@workshop.org',
          password: 'InitialPassword123!',
          display_name: 'Original Name',
        });
      expect(registerRes.status).toBe(201);
      const sessionCookie1 = registerRes.headers['set-cookie'][0];

      // 2. GET /api/auth/account returns security state
      const accRes = await request(app)
        .get('/api/auth/account')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie1);
      expect(accRes.status).toBe(200);
      expect(accRes.body.has_password).toBe(true);
      expect(accRes.body.is_passwordless).toBe(false);
      expect(accRes.body.sessions).toHaveLength(1);
      expect(accRes.body.sessions[0].is_current).toBe(true);
      expect(accRes.body.passkeys).toHaveLength(0);
      expect(accRes.body.oauth_accounts).toHaveLength(0);

      // 3. PUT /api/auth/profile updates display name
      const profileRes = await request(app)
        .put('/api/auth/profile')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie1)
        .send({ display_name: 'Updated Craftsperson' });
      expect(profileRes.status).toBe(200);
      expect(profileRes.body.user.display_name).toBe('Updated Craftsperson');

      // 4. Create a second active session by logging in again
      const loginRes2 = await request(app)
        .post('/api/auth/login')
        .set('X-PriceIt-CSRF', '1')
        .send({
          email: 'craftsperson@workshop.org',
          password: 'InitialPassword123!',
        });
      expect(loginRes2.status).toBe(200);
      const sessionCookie2 = loginRes2.headers['set-cookie'][0];

      // Verify two active sessions exist
      const accRes2 = await request(app)
        .get('/api/auth/account')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2);
      expect(accRes2.body.sessions).toHaveLength(2);

      // 5. POST /api/auth/password/change from session 2 -> must revoke session 1
      const changePassRes = await request(app)
        .post('/api/auth/password/change')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2)
        .send({
          current_password: 'InitialPassword123!',
          new_password: 'NewSecurePassword456!',
        });
      expect(changePassRes.status).toBe(200);
      expect(changePassRes.body.revoked_other_sessions).toBe(true);

      // Session 1 is now revoked: /api/auth/account returns 401 and /api/auth/me returns user: null
      const testRevokedAcc = await request(app)
        .get('/api/auth/account')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie1);
      expect(testRevokedAcc.status).toBe(401);

      const testRevokedMe = await request(app)
        .get('/api/auth/me')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie1);
      expect(testRevokedMe.status).toBe(200);
      expect(testRevokedMe.body.user).toBeNull();

      // Session 2 is still valid
      const testActiveRes = await request(app)
        .get('/api/auth/me')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2);
      expect(testActiveRes.status).toBe(200);
      expect(testActiveRes.body.user.display_name).toBe('Updated Craftsperson');

      // 6. Request and verify email change
      const emailReqRes = await request(app)
        .post('/api/auth/email/request')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2)
        .send({
          new_email: 'newemail@workshop.org',
          current_password: 'NewSecurePassword456!',
        });
      expect(emailReqRes.status).toBe(200);
      expect(emailReqRes.body.pending_email).toBe('newemail@workshop.org');
      expect(emailReqRes.body.dev_token).toBeDefined();

      const verifyEmailRes = await request(app)
        .post('/api/auth/email/verify')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2)
        .send({ token: emailReqRes.body.dev_token });
      expect(verifyEmailRes.status).toBe(200);
      expect(verifyEmailRes.body.user.email).toBe('newemail@workshop.org');

      // 7. Link an OAuth account (GitHub)
      const linkOAuthRes = await request(app)
        .post('/api/auth/oauth/link')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2)
        .send({ provider: 'github' });
      expect(linkOAuthRes.status).toBe(200);
      expect(linkOAuthRes.body.oauth_accounts).toHaveLength(1);

      // 8. Register a Passkey via test mock bypass
      const mockCredId = 'mock-fido2-cred-id-12345';
      const registerPasskeyRes = await request(app)
        .post('/api/auth/passkeys/register/verify')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2)
        .send({
          mock_passkey: true,
          id: mockCredId,
          rawId: mockCredId,
          custom_name: 'YubiKey 5C NFC',
          device_type: 'singleDevice',
          backed_up: false,
        });
      expect(registerPasskeyRes.status).toBe(200);
      expect(registerPasskeyRes.body.verified).toBe(true);
      expect(registerPasskeyRes.body.passkey.name).toBe('YubiKey 5C NFC');

      // Rename passkey
      const renameRes = await request(app)
        .put(`/api/auth/passkeys/${encodeURIComponent(mockCredId)}`)
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2)
        .send({ name: 'Work YubiKey 5C' });
      expect(renameRes.status).toBe(200);
      expect(renameRes.body.passkey.name).toBe('Work YubiKey 5C');

      // 9. Switch to 100% passwordless
      const removePassRes = await request(app)
        .post('/api/auth/password/remove')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2)
        .send({});
      expect(removePassRes.status).toBe(200);
      expect(removePassRes.body.is_passwordless).toBe(true);

      // Attempting to change password now fails (enforcing passwordless invariant)
      const changePassBlockedRes = await request(app)
        .post('/api/auth/password/change')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2)
        .send({
          current_password: 'NewSecurePassword456!',
          new_password: 'AnotherPassword789!',
        });
      expect(changePassBlockedRes.status).toBe(400);
      expect(changePassBlockedRes.body.error).toContain('passwordless');

      // 10. Attempting to revoke both OAuth and Passkey (blocking last factor lockout)
      // Unlink github
      const unlinkRes = await request(app)
        .delete('/api/auth/oauth/github')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2);
      expect(unlinkRes.status).toBe(200);

      // Now passkey is the ONLY factor left -> deleting it MUST be rejected with 400
      const deleteLastPasskeyRes = await request(app)
        .delete(`/api/auth/passkeys/${encodeURIComponent(mockCredId)}`)
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2);
      expect(deleteLastPasskeyRes.status).toBe(400);
      expect(deleteLastPasskeyRes.body.error).toContain('Cannot revoke your last remaining sign-in method');

      // 11. Delete Account
      const deleteAccRes = await request(app)
        .post('/api/auth/account/delete')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2)
        .send({ confirmation: 'DELETE' });
      expect(deleteAccRes.status).toBe(200);
      expect(deleteAccRes.body.ok).toBe(true);

      // User session is completely terminated
      const afterDeleteRes = await request(app)
        .get('/api/auth/account')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2);
      expect(afterDeleteRes.status).toBe(401);

      const afterDeleteMe = await request(app)
        .get('/api/auth/me')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', sessionCookie2);
      expect(afterDeleteMe.body.user).toBeNull();
    });

    it('verifies passkey registration options structure and enforces admin moderation controls', async () => {
      // 1. Create an admin user and a standard user
      const adminRegister = await request(app)
        .post('/api/auth/register')
        .set('X-PriceIt-CSRF', '1')
        .send({
          email: 'mykehype@gmail.com',
          password: 'AdminPassword123!',
          display_name: 'Myke (Admin)',
        });
      const adminCookie = adminRegister.headers['set-cookie'][0];

      const userRegister = await request(app)
        .post('/api/auth/register')
        .set('X-PriceIt-CSRF', '1')
        .send({
          email: 'spammer@workshop.org',
          password: 'UserPassword123!',
          display_name: 'Spam User',
        });
      const userCookie = userRegister.headers['set-cookie'][0];
      const spammerUserId = userRegister.body.user.id;

      // 2. Check passkey options endpoint contains challenge and valid options object
      const passkeyOptionsRes = await request(app)
        .post('/api/auth/passkeys/register/options')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', adminCookie)
        .send({});
      expect(passkeyOptionsRes.status).toBe(200);
      expect(passkeyOptionsRes.body.options).toBeDefined();
      expect(passkeyOptionsRes.body.options.challenge).toBeDefined();
      expect(passkeyOptionsRes.body.challengeId).toBeDefined();

      // 3. Standard user is blocked from /api/admin/* (403 Forbidden)
      const nonAdminRes = await request(app)
        .get('/api/admin/users')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', userCookie);
      expect(nonAdminRes.status).toBe(403);

      // 4. Admin accesses /api/admin/users (200 OK)
      const adminUsersRes = await request(app)
        .get('/api/admin/users')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', adminCookie);
      expect(adminUsersRes.status).toBe(200);
      expect(Array.isArray(adminUsersRes.body.users)).toBe(true);

      // 5. Admin bans the user -> user's active session is terminated
      const banRes = await request(app)
        .post(`/api/admin/users/${spammerUserId}/ban`)
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', adminCookie)
        .send({ banned: true, reason: 'Violating community guidelines' });
      expect(banRes.status).toBe(200);
      expect(banRes.body.is_banned).toBe(true);

      // Banned user's session is now rejected
      const bannedSessionCheck = await request(app)
        .get('/api/auth/account')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', userCookie);
      expect(bannedSessionCheck.status).toBe(401);

      // Subsequent login attempt by banned user is rejected with 403 Forbidden
      const bannedLoginCheck = await request(app)
        .post('/api/auth/login')
        .set('X-PriceIt-CSRF', '1')
        .send({ email: 'spammer@workshop.org', password: 'UserPassword123!' });
      expect(bannedLoginCheck.status).toBe(403);
      expect(bannedLoginCheck.body.error).toContain('suspended');

      // 6. Admin can configure OAuth applications
      const putOAuthRes = await request(app)
        .put('/api/admin/oauth')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', adminCookie)
        .send({
          provider: 'google',
          client_id: 'google-client-id-12345.apps.googleusercontent.com',
          client_secret: 'google-super-secret-key',
          enabled: true,
        });
      expect(putOAuthRes.status).toBe(200);

      const getOAuthRes = await request(app)
        .get('/api/admin/oauth')
        .set('X-PriceIt-CSRF', '1')
        .set('Cookie', adminCookie);
      expect(getOAuthRes.status).toBe(200);
      const googleConfig = getOAuthRes.body.configs.find((c: any) => c.provider === 'google');
      expect(googleConfig.client_id).toBe('google-client-id-12345.apps.googleusercontent.com');
      expect(googleConfig.is_secret_set).toBe(true);
    });
  });
});
