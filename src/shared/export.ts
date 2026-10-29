import type { ProjectPayload } from './types.js';
import type { SolverResult } from './solver.js';

const FORMULA_INJECTION_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r', '\n']);

/**
 * Sanitizes string values against CSV/Excel formula injection (DDE/Formula attacks).
 * Any value starting with =, +, -, @, \t, \r, \n (or after leading whitespace) is prefixed with a single quote (').
 */
export function sanitizeSpreadsheetCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.length === 0) return '';

  const firstChar = str[0];
  const trimmedFirstChar = str.trimStart()[0];

  if (
    FORMULA_INJECTION_PREFIXES.has(firstChar) ||
    (trimmedFirstChar && FORMULA_INJECTION_PREFIXES.has(trimmedFirstChar))
  ) {
    return `'${str}`;
  }
  return str;
}

export function escapeCsvCell(value: string | number | null | undefined): string {
  const safe = sanitizeSpreadsheetCell(value);
  if (safe.includes('"') || safe.includes(',') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function formatCentsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function generateProjectCsv(project: ProjectPayload, solverResult: SolverResult): string {
  const rows: string[][] = [];

  rows.push(['PROJECT BILL OF MATERIALS & OPTIMAL PURCHASE PLAN']);
  rows.push(['Project Name', project.name, 'Category', project.category || 'General', 'Currency', project.currency || 'USD']);
  rows.push([]);

  // Section 1: Optimal Purchase Plan
  rows.push(['OPTIMAL PURCHASE ORDERS']);
  rows.push([
    'Vendor',
    'Offering Title',
    'SKU / Part #',
    'Qty to Buy',
    'Unit Net Price ($)',
    'Line Subtotal ($)',
    'Parts Covered (Yield)',
    'Reference URL',
  ]);

  for (const order of solverResult.vendor_orders) {
    for (const item of order.items) {
      const coveredStr = item.parts_covered
        .map((c) => `${c.part_name} (x${c.total_yield})`)
        .join('; ');
      rows.push([
        order.vendor_name,
        item.offering.title,
        item.offering.part_number || '',
        String(item.qty),
        formatCentsToDollars(item.unit_net_price_cents),
        formatCentsToDollars(item.line_subtotal_cents),
        coveredStr,
        item.offering.reference_url || '',
      ]);
    }
    rows.push([
      `${order.vendor_name} Order Summary`,
      `Subtotal: $${formatCentsToDollars(order.subtotal_cents)}`,
      `Shipping: $${formatCentsToDollars(order.shipping_cents)}${order.free_shipping_applied ? ' (FREE)' : ''}`,
      `Tax: $${formatCentsToDollars(order.tax_cents)}`,
      `Vendor Total: $${formatCentsToDollars(order.total_cents)}`,
      '',
      '',
      '',
    ]);
  }

  rows.push([]);
  rows.push([
    'GRAND TOTAL SUMMARY',
    `Subtotal: $${formatCentsToDollars(solverResult.total_subtotal_cents)}`,
    `Shipping: $${formatCentsToDollars(solverResult.total_shipping_cents)}`,
    `Tax: $${formatCentsToDollars(solverResult.total_tax_cents)}`,
    `Grand Total: $${formatCentsToDollars(solverResult.grand_total_cents)}`,
    solverResult.savings_vs_baseline_cents > 0
      ? `Bundle Savings: $${formatCentsToDollars(solverResult.savings_vs_baseline_cents)}`
      : '',
  ]);

  rows.push([]);
  // Section 2: Required Parts BOM
  rows.push(['BILL OF MATERIALS (REQUIRED PARTS)']);
  rows.push(['Part Name', 'Part Number / SKU', 'Category Tag', 'Required Qty', 'Status']);

  const uncoveredSet = new Set(solverResult.uncovered_part_ids);
  for (const part of project.parts) {
    rows.push([
      part.name,
      part.part_number || '',
      part.category_tag || '',
      String(part.required_qty),
      uncoveredSet.has(part.id) ? 'UNCOVERED' : 'COVERED',
    ]);
  }

  if (solverResult.spare_parts.length > 0) {
    rows.push([]);
    rows.push(['BONUS / SPARE PARTS FROM OVERLAPPING BUNDLES']);
    rows.push(['Part Name', 'Required Qty', 'Provided Qty', 'Bonus Surplus Qty']);
    for (const sp of solverResult.spare_parts) {
      rows.push([
        sp.part_name,
        String(sp.required_qty),
        String(sp.provided_qty),
        `+${sp.surplus_qty}`,
      ]);
    }
  }

  return rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(',')).join('\r\n');
}

export function generateProjectExcelTsv(project: ProjectPayload, solverResult: SolverResult): string {
  const csvLines = generateProjectCsv(project, solverResult);
  // Also provide TSV format for direct Excel clipboard / .xls tab-delimited open with strict sanitization
  return csvLines;
}

export function escapeMarkdownTableCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .trim();
}

export function generateProjectMarkdown(
  project: ProjectPayload,
  solverResult: SolverResult,
  mode: 'summary' | 'full' = 'full',
  shareUrl = 'https://priceit.rbnd.cc'
): string {
  const lines: string[] = [];

  lines.push(`# ${project.name || 'Untitled Project'} — Bill of Materials`);
  lines.push('');
  lines.push(`- **Category**: ${project.category || 'General'}`);
  lines.push(`- **Total Cost**: **$${formatCentsToDollars(solverResult.grand_total_cents)}**`);
  if (solverResult.savings_vs_baseline_cents > 0) {
    lines.push(`- **Net Savings**: **$${formatCentsToDollars(solverResult.savings_vs_baseline_cents)}** (vs. unbundled baseline)`);
  }
  lines.push(`- **Vendors**: ${solverResult.vendor_orders.length} order(s)`);
  lines.push(`- **Parts Covered**: ${project.parts.length - solverResult.uncovered_part_ids.length} of ${project.parts.length}`);
  lines.push('');

  // Parts Selection Table
  lines.push('### Required Parts & Optimal Selections');
  lines.push('');
  lines.push('| Part | Selected Offering | Vendor | Qty | Unit Price | Total |');
  lines.push('|:---|:---|:---|:---:|---:|---:|');

  const partMap = new Map(project.parts.map((p) => [p.id, p]));
  const uncoveredSet = new Set(solverResult.uncovered_part_ids);

  // Group items by part
  for (const part of project.parts) {
    if (uncoveredSet.has(part.id)) {
      lines.push(
        `| ${escapeMarkdownTableCell(part.name)} | *No in-stock offering found* | — | ${part.required_qty} | — | **UNCOVERED** |`
      );
      continue;
    }

    // Find items covering this part
    let covered = false;
    for (const order of solverResult.vendor_orders) {
      for (const item of order.items) {
        const coversThisPart = item.parts_covered.some((c) => c.part_id === part.id);
        if (coversThisPart) {
          covered = true;
          const title = item.offering.reference_url
            ? `[${escapeMarkdownTableCell(item.offering.title)}](${item.offering.reference_url})`
            : escapeMarkdownTableCell(item.offering.title);
          lines.push(
            `| ${escapeMarkdownTableCell(part.name)} | ${title} | ${escapeMarkdownTableCell(order.vendor_name)} | ${item.qty} | $${formatCentsToDollars(item.unit_net_price_cents)} | $${formatCentsToDollars(item.line_subtotal_cents)} |`
          );
        }
      }
    }
    if (!covered) {
      lines.push(
        `| ${escapeMarkdownTableCell(part.name)} | — | — | ${part.required_qty} | — | Covered by bundle |`
      );
    }
  }

  lines.push('');

  if (mode === 'full') {
    lines.push('### Vendor Purchase Orders');
    lines.push('');
    for (const order of solverResult.vendor_orders) {
      lines.push(`#### ${escapeMarkdownTableCell(order.vendor_name)}`);
      for (const item of order.items) {
        const itemLink = item.offering.reference_url
          ? `[${escapeMarkdownTableCell(item.offering.title)}](${item.offering.reference_url})`
          : escapeMarkdownTableCell(item.offering.title);
        lines.push(
          `- **${item.qty}x** ${itemLink} — $${formatCentsToDollars(item.unit_net_price_cents)} each ($${formatCentsToDollars(item.line_subtotal_cents)})`
        );
      }
      lines.push(
        `  - *Subtotal*: $${formatCentsToDollars(order.subtotal_cents)} | *Shipping*: $${formatCentsToDollars(order.shipping_cents)}${order.free_shipping_applied ? ' (FREE)' : ''} | *Tax*: $${formatCentsToDollars(order.tax_cents)} | **Order Total: $${formatCentsToDollars(order.total_cents)}**`
      );
      lines.push('');
    }

    if (solverResult.spare_parts.length > 0) {
      lines.push('### Bonus / Surplus Spare Parts from Bundles');
      lines.push('');
      for (const sp of solverResult.spare_parts) {
        lines.push(`- **${escapeMarkdownTableCell(sp.part_name)}**: Required ${sp.required_qty}, received ${sp.provided_qty} (**+${sp.surplus_qty} extra**)`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`*Generated with [PriceIt](${shareUrl}) — Combinatorial Bill of Materials Price Optimizer*`);

  return lines.join('\n');
}

export function generateProjectRedditMarkdown(
  project: ProjectPayload,
  solverResult: SolverResult,
  mode: 'summary' | 'full' = 'full',
  shareUrl = 'https://priceit.rbnd.cc'
): string {
  const lines: string[] = [];

  lines.push(`**[PriceIt BOM] ${project.name || 'Project'}**`);
  lines.push('');

  // Reddit Table
  lines.push('| Part | Item / Selection | Vendor | Price |');
  lines.push('|:---|:---|:---|---:|');

  const uncoveredSet = new Set(solverResult.uncovered_part_ids);

  for (const part of project.parts) {
    if (uncoveredSet.has(part.id)) {
      lines.push(`| ${escapeMarkdownTableCell(part.name)} | *Not Found / Out of Stock* | - | **UNCOVERED** |`);
      continue;
    }

    let itemFound = false;
    for (const order of solverResult.vendor_orders) {
      for (const item of order.items) {
        if (item.parts_covered.some((c) => c.part_id === part.id)) {
          itemFound = true;
          const itemText = item.offering.reference_url
            ? `[${escapeMarkdownTableCell(item.offering.title)}](${item.offering.reference_url})`
            : escapeMarkdownTableCell(item.offering.title);
          lines.push(
            `| ${escapeMarkdownTableCell(part.name)} | ${itemText} | ${escapeMarkdownTableCell(order.vendor_name)} | $${formatCentsToDollars(item.line_subtotal_cents)} |`
          );
        }
      }
    }
    if (!itemFound) {
      lines.push(`| ${escapeMarkdownTableCell(part.name)} | Covered by multi-part bundle | - | (Included) |`);
    }
  }

  lines.push('');
  lines.push(`| **Grand Total** | | | **$${formatCentsToDollars(solverResult.grand_total_cents)}** |`);
  if (solverResult.savings_vs_baseline_cents > 0) {
    lines.push(`| **Total Savings** | | | **$${formatCentsToDollars(solverResult.savings_vs_baseline_cents)}** |`);
  }

  if (mode === 'full') {
    lines.push('');
    lines.push('**Vendor Orders:**');
    for (const order of solverResult.vendor_orders) {
      lines.push(
        `* **${escapeMarkdownTableCell(order.vendor_name)}** (${order.items.length} items): $${formatCentsToDollars(order.subtotal_cents)} + $${formatCentsToDollars(order.shipping_cents)} ship + $${formatCentsToDollars(order.tax_cents)} tax = **$${formatCentsToDollars(order.total_cents)}**`
      );
    }
  }

  lines.push('');
  lines.push(`[View interactive BOM on PriceIt](${shareUrl})`);

  return lines.join('\n');
}
