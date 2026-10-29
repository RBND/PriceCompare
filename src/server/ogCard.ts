import { Resvg } from '@resvg/resvg-js';
import type { ProjectPayload } from '../shared/types.js';
import type { SolverResult } from '../shared/solver.js';
import { formatCentsToDollars } from '../shared/export.js';

export function escapeXml(unsafe: string | number | null | undefined): string {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

export function generateOgImageSvg(
  project: ProjectPayload,
  solverResult: SolverResult,
  theme: 'dark' | 'light' = 'dark'
): string {
  const isDark = theme === 'dark';

  const bgColor1 = isDark ? '#090d16' : '#f8fafc';
  const bgColor2 = isDark ? '#0f172a' : '#f1f5f9';
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.04)';
  const borderColor = isDark ? '#1e293b' : '#cbd5e1';
  const textPrimary = isDark ? '#f8fafc' : '#0f172a';
  const textSecondary = isDark ? '#94a3b8' : '#64748b';
  const textMuted = isDark ? '#64748b' : '#94a3b8';
  const cardBg = isDark ? '#131c31' : '#ffffff';
  const cardBorder = isDark ? '#23324d' : '#e2e8f0';
  const accentEmerald = isDark ? '#10b981' : '#059669';
  const accentSky = isDark ? '#38bdf8' : '#0284c7';

  const projectName = project.name ? project.name.trim() : 'Bill of Materials Project';
  const truncatedProjectName =
    projectName.length > 40 ? projectName.slice(0, 38) + '...' : projectName;

  const grandTotal = `$${formatCentsToDollars(solverResult.grand_total_cents)}`;
  const hasSavings = solverResult.savings_vs_baseline_cents > 0;
  const savingsText = hasSavings
    ? `SAVE $${formatCentsToDollars(solverResult.savings_vs_baseline_cents)}`
    : 'OPTIMAL COMBINATORIAL COVER';

  const vendorCount = solverResult.vendor_orders.length;
  const coveredParts = project.parts.length - solverResult.uncovered_part_ids.length;
  const totalParts = project.parts.length;

  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${bgColor1}" />
      <stop offset="100%" stop-color="${bgColor2}" />
    </linearGradient>
    <pattern id="gridPattern" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="${gridColor}" stroke-width="1" />
    </pattern>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bgGrad)" />
  <rect width="1200" height="630" fill="url(#gridPattern)" />

  <!-- Outer Frame Border -->
  <rect x="30" y="30" width="1140" height="570" rx="16" fill="none" stroke="${borderColor}" stroke-width="2" />

  <!-- Top Header Bar -->
  <g transform="translate(70, 75)">
    <!-- Brand Tag -->
    <rect x="0" y="0" width="120" height="34" rx="6" fill="${isDark ? '#064e3b' : '#d1fae5'}" stroke="${accentEmerald}" stroke-width="1.5" />
    <text x="60" y="22" font-family="monospace, monospace" font-size="14" font-weight="bold" fill="${accentEmerald}" text-anchor="middle" letter-spacing="2">PRICEIT</text>

    <!-- Subtitle / Architecture Tag -->
    <text x="140" y="22" font-family="sans-serif" font-size="14" font-weight="600" fill="${textMuted}" letter-spacing="1.5">OPTIMIZED BILL OF MATERIALS</text>

    <!-- Category Pill -->
    <rect x="910" y="0" width="120" height="34" rx="6" fill="${cardBg}" stroke="${cardBorder}" stroke-width="1" />
    <text x="970" y="22" font-family="sans-serif" font-size="13" font-weight="600" fill="${textSecondary}" text-anchor="middle">${escapeXml(project.category || 'General')}</text>
  </g>

  <!-- Project Name -->
  <g transform="translate(70, 165)">
    <text font-family="sans-serif" font-size="44" font-weight="800" fill="${textPrimary}">
      ${escapeXml(truncatedProjectName)}
    </text>
    <text y="38" font-family="sans-serif" font-size="18" fill="${textSecondary}">
      Consolidated purchase plan solved across ${vendorCount} vendor${vendorCount === 1 ? '' : 's'}
    </text>
  </g>

  <!-- Main Highlight Cards Grid -->
  <g transform="translate(70, 260)">
    <!-- Card 1: Total Price -->
    <rect x="0" y="0" width="330" height="190" rx="12" fill="${cardBg}" stroke="${cardBorder}" stroke-width="1.5" />
    <text x="28" y="42" font-family="monospace, monospace" font-size="13" font-weight="600" fill="${textMuted}" letter-spacing="1">TOTAL OUT-OF-POCKET</text>
    <text x="28" y="112" font-family="monospace, monospace" font-size="52" font-weight="800" fill="${accentSky}">${grandTotal}</text>
    <text x="28" y="152" font-family="sans-serif" font-size="14" fill="${textSecondary}">Includes items, shipping &amp; tax</text>

    <!-- Card 2: Savings or Status Badge -->
    <rect x="360" y="0" width="340" height="190" rx="12" fill="${cardBg}" stroke="${cardBorder}" stroke-width="1.5" />
    <text x="388" y="42" font-family="monospace, monospace" font-size="13" font-weight="600" fill="${textMuted}" letter-spacing="1">BUNDLE SAVINGS</text>
    <rect x="388" y="70" width="280" height="52" rx="8" fill="${hasSavings ? (isDark ? 'rgba(16, 185, 129, 0.18)' : '#d1fae5') : (isDark ? 'rgba(56, 189, 248, 0.15)' : '#e0f2fe')}" stroke="${hasSavings ? accentEmerald : accentSky}" stroke-width="1.5" />
    <text x="528" y="104" font-family="monospace, monospace" font-size="22" font-weight="800" fill="${hasSavings ? accentEmerald : accentSky}" text-anchor="middle" letter-spacing="0.5">${escapeXml(savingsText)}</text>
    <text x="388" y="152" font-family="sans-serif" font-size="14" fill="${textSecondary}">${hasSavings ? 'Saved vs separate item purchases' : 'Zero overpayment detected'}</text>

    <!-- Card 3: Metrics (Vendors & Parts) -->
    <rect x="730" y="0" width="300" height="190" rx="12" fill="${cardBg}" stroke="${cardBorder}" stroke-width="1.5" />
    <text x="758" y="42" font-family="monospace, monospace" font-size="13" font-weight="600" fill="${textMuted}" letter-spacing="1">BOM COVERAGE</text>
    
    <text x="758" y="90" font-family="monospace, monospace" font-size="28" font-weight="700" fill="${textPrimary}">
      ${coveredParts} / ${totalParts} <tspan font-size="16" fill="${textSecondary}">Parts</tspan>
    </text>
    
    <text x="758" y="135" font-family="monospace, monospace" font-size="28" font-weight="700" fill="${textPrimary}">
      ${vendorCount} <tspan font-size="16" fill="${textSecondary}">Vendor${vendorCount === 1 ? '' : 's'}</tspan>
    </text>
    <text x="758" y="165" font-family="sans-serif" font-size="13" fill="${accentEmerald}">Order consolidated &amp; optimized</text>
  </g>

  <!-- Bottom Footer Watermark -->
  <g transform="translate(70, 530)">
    <text x="0" y="24" font-family="monospace, monospace" font-size="15" font-weight="bold" fill="${textPrimary}">priceit.rbnd.cc</text>
    <text x="170" y="24" font-family="sans-serif" font-size="14" fill="${textMuted}">• Combinatorial Bill of Materials &amp; Shipping Optimizer</text>
    <text x="1030" y="24" font-family="monospace, monospace" font-size="13" fill="${textMuted}" text-anchor="end">Live Interactive Datasheet</text>
  </g>
</svg>`;
}

// In-Memory LRU Cache for rendered PNG buffers (max 200 items)
const MAX_CACHE_ENTRIES = 200;
const ogImageCache = new Map<string, { buffer: Buffer; timestamp: number }>();

export function getCachedOgCardPng(cacheKey: string): Buffer | null {
  const item = ogImageCache.get(cacheKey);
  if (!item) return null;
  // Touch key to preserve LRU
  ogImageCache.delete(cacheKey);
  ogImageCache.set(cacheKey, item);
  return item.buffer;
}

export function setCachedOgCardPng(cacheKey: string, buffer: Buffer): void {
  if (ogImageCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = ogImageCache.keys().next().value;
    if (oldestKey) ogImageCache.delete(oldestKey);
  }
  ogImageCache.set(cacheKey, { buffer, timestamp: Date.now() });
}

export function renderOgCardPng(
  project: ProjectPayload,
  solverResult: SolverResult,
  theme: 'dark' | 'light' = 'dark'
): Buffer {
  const cacheKey = `${project.id || 'p'}:${project.version || 1}:${theme}`;
  const cached = getCachedOgCardPng(cacheKey);
  if (cached) return cached;

  const svg = generateOgImageSvg(project, solverResult, theme);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    font: {
      defaultFontFamily: 'sans-serif',
      loadSystemFonts: true,
    },
  });

  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  setCachedOgCardPng(cacheKey, pngBuffer);
  return pngBuffer;
}
