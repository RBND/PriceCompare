import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server/app.js';
import { initDatabase } from '../src/server/db.js';
import { DEMO_BRAKE_PROJECT } from '../src/shared/demoData.js';
import { solveBundleOptimization } from '../src/shared/solver.js';
import {
  escapeMarkdownTableCell,
  generateProjectMarkdown,
  generateProjectRedditMarkdown,
} from '../src/shared/export.js';
import {
  escapeXml,
  generateOgImageSvg,
  renderOgCardPng,
  getCachedOgCardPng,
} from '../src/server/ogCard.js';

describe('Feature 1: Unified Share & Export Hub, Dynamic OG Cards & Branded PDF', () => {
  const solverResult = solveBundleOptimization({
    parts: DEMO_BRAKE_PROJECT.parts,
    offerings: DEMO_BRAKE_PROJECT.offerings,
    bundle_mappings: DEMO_BRAKE_PROJECT.bundle_mappings,
    vendor_profiles: DEMO_BRAKE_PROJECT.vendor_profiles,
    default_tax_bps: DEMO_BRAKE_PROJECT.default_tax_bps,
  });

  describe('Markdown & Reddit Formatting Engines', () => {
    it('escapes pipes, brackets, and newlines in table cells', () => {
      const malicious = 'Test | Part [with link]\nand newlines';
      const escaped = escapeMarkdownTableCell(malicious);
      expect(escaped).toBe('Test \\| Part \\[with link\\] and newlines');
    });

    it('generates summary Markdown with totals and parts table', () => {
      const md = generateProjectMarkdown(
        DEMO_BRAKE_PROJECT,
        solverResult,
        'summary',
        'https://priceit.rbnd.cc/share/tok123'
      );
      expect(md).toContain(`# ${DEMO_BRAKE_PROJECT.name} — Bill of Materials`);
      expect(md).toContain('**Total Cost**');
      expect(md).toContain('| Part | Selected Offering | Vendor | Qty | Unit Price | Total |');
      expect(md).toContain('https://priceit.rbnd.cc/share/tok123');
      expect(md).not.toContain('### Vendor Purchase Orders');
    });

    it('generates full breakdown Markdown including vendor orders and savings', () => {
      const md = generateProjectMarkdown(
        DEMO_BRAKE_PROJECT,
        solverResult,
        'full',
        'https://priceit.rbnd.cc/share/tok123'
      );
      expect(md).toContain('### Vendor Purchase Orders');
      expect(md).toContain('Order Total:');
      expect(md).toContain('FCP Euro');
    });

    it('generates Reddit Markdown with compliant tables and alignment', () => {
      const reddit = generateProjectRedditMarkdown(
        DEMO_BRAKE_PROJECT,
        solverResult,
        'full',
        'https://priceit.rbnd.cc/share/tok123'
      );
      expect(reddit).toContain(`**[PriceIt BOM] ${DEMO_BRAKE_PROJECT.name}**`);
      expect(reddit).toContain('| Part | Item / Selection | Vendor | Price |');
      expect(reddit).toContain('|:---|:---|:---|---:|');
      expect(reddit).toContain('| **Grand Total** |');
      expect(reddit).toContain('[View interactive BOM on PriceIt](https://priceit.rbnd.cc/share/tok123)');
    });
  });

  describe('OpenGraph SVG & PNG Generation', () => {
    it('escapes XML special characters safely', () => {
      const raw = `<script>alert("XSS & attack '1'")</script>`;
      const escaped = escapeXml(raw);
      expect(escaped).toBe('&lt;script&gt;alert(&quot;XSS &amp; attack &apos;1&apos;&quot;)&lt;/script&gt;');
    });

    it('generates valid 1200x630 SVG with dark theme', () => {
      const svg = generateOgImageSvg(DEMO_BRAKE_PROJECT, solverResult, 'dark');
      expect(svg).toContain('viewBox="0 0 1200 630"');
      expect(svg).toContain('PRICEIT');
      expect(svg).toContain('Front &amp; Rear Brake Overhaul');
      expect(svg).toContain('#090d16');
    });

    it('generates valid 1200x630 SVG with light theme', () => {
      const svg = generateOgImageSvg(DEMO_BRAKE_PROJECT, solverResult, 'light');
      expect(svg).toContain('#f8fafc');
    });

    it('renders real PNG buffer with PNG magic bytes and caches result', () => {
      const png = renderOgCardPng(DEMO_BRAKE_PROJECT, solverResult, 'dark');
      expect(png).toBeInstanceOf(Buffer);
      expect(png.length).toBeGreaterThan(1000);
      // Verify PNG magic bytes: 0x89 0x50 0x4E 0x47
      expect(png[0]).toBe(0x89);
      expect(png[1]).toBe(0x50);
      expect(png[2]).toBe(0x4e);
      expect(png[3]).toBe(0x47);

      const cacheKey = `${DEMO_BRAKE_PROJECT.id || 'p'}:${DEMO_BRAKE_PROJECT.version || 1}:dark`;
      const cached = getCachedOgCardPng(cacheKey);
      expect(cached).not.toBeNull();
      expect(cached).toBe(png);
    });
  });

  describe('Server Endpoints: /share/:token and /api/og/:token.png', () => {
    const db = initDatabase(':memory:');
    const app = createApp(db);
    const testShareToken = 'test_token_abcdef123456';

    beforeAll(() => {
      // Seed user, test project, and share token
      db.prepare(`
        INSERT INTO users (id, email, password_hash, display_name, is_admin, email_verified, created_at, updated_at)
        VALUES ('user_1', 'og_test@example.com', 'hash', 'Test User', 0, 1, 1000, 1000)
      `).run();

      db.prepare(`
        INSERT INTO projects (id, user_id, client_project_uuid, name, category, currency, default_tax_bps, version, created_at, updated_at)
        VALUES ('proj_test_og', 'user_1', 'uuid_test', 'Brake System Overhaul', 'Automotive', 'USD', 700, 1, 1000, 1000)
      `).run();

      db.prepare(`
        INSERT INTO parts (id, project_id, name, part_number, category_tag, required_qty, sort_order)
        VALUES ('p1', 'proj_test_og', 'Front Rotors', 'BR-900', 'Brakes', 2, 0)
      `).run();

      db.prepare(`
        INSERT INTO offerings (id, project_id, vendor_name, title, part_number, reference_url, price_cents, shipping_cents, discount_cents, in_stock, updated_at)
        VALUES ('off1', 'proj_test_og', 'RockAuto', 'Centric Premium Rotor', 'BR-900', 'https://rockauto.com', 4500, 899, 0, 1, 1000)
      `).run();

      db.prepare(`
        INSERT INTO bundle_mappings (offering_id, part_id, yield_qty)
        VALUES ('off1', 'p1', 1)
      `).run();

      db.prepare(`
        INSERT INTO project_shares (share_token, project_id, is_active, created_at)
        VALUES (?, 'proj_test_og', 1, 1000)
      `).run(testShareToken);
    });

    it('GET /share/:token injects OpenGraph tags into served HTML', async () => {
      const res = await request(app)
        .get(`/share/${testShareToken}`)
        .set('User-Agent', 'Discordbot/2.0');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('<meta property="og:title"');
      expect(res.text).toContain('Brake System Overhaul');
      expect(res.text).toContain(`/api/og/${testShareToken}.png`);
      expect(res.text).toContain('twitter:card');
    });

    it('GET /api/og/:token.png serves PNG image with correct headers', async () => {
      const res = await request(app)
        .get(`/api/og/${testShareToken}.png`)
        .responseType('blob');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toContain('public');
      const buf = Buffer.from(res.body);
      expect(buf[0]).toBe(0x89);
      expect(buf[1]).toBe(0x50);
      expect(buf[2]).toBe(0x4e);
      expect(buf[3]).toBe(0x47);
    });

    it('GET /api/og/:token.png returns 404 for unknown token', async () => {
      const res = await request(app).get('/api/og/invalid_token_99999.png');
      expect(res.status).toBe(404);
    });
  });
});
