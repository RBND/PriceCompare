import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { App } from '../src/client/App.js';

describe('Tabbed Workspace UI — WAI-ARIA Tabs, Live Badges & Print Datasheet', () => {
  beforeEach(() => {
    // Provide minimal window/document/localStorage globals for SSR rendering if not present
    if (typeof globalThis.window === 'undefined') {
      (globalThis as unknown as Record<string, unknown>).window = {
        location: { search: '', origin: 'http://localhost:28085', pathname: '/' },
        matchMedia: () => ({ matches: false }),
        print: () => {},
      };
    }
  });

  it('renders 3 WAI-ARIA workflow tabs with live count and savings badges', () => {
    const html = renderToStaticMarkup(React.createElement(App));

    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="tab-bom"');
    expect(html).toContain('id="tab-matrix"');
    expect(html).toContain('id="tab-plan"');

    // Tab labels
    expect(html).toContain('1. Parts List (BOM)');
    expect(html).toContain('2. Vendor Listings &amp; Prices');
    expect(html).toContain('3. Optimal Purchase Plan');

    // Default active tab is Tab 1 (BOM)
    expect(html).toMatch(/id="tab-bom"[^>]*role="tab"[^>]*aria-selected="true"/);
    expect(html).toMatch(/id="tab-matrix"[^>]*role="tab"[^>]*aria-selected="false"/);
    expect(html).toMatch(/id="tab-plan"[^>]*role="tab"[^>]*aria-selected="false"/);

    // Live badge on Tab 3 shows optimal total and savings for DEMO_BRAKE_PROJECT
    expect(html).toContain('• Save $');
  });

  it('places the Add Offering form at the top of Tab 2 above the matrix and includes the collapsible Vendor Shipping panel below', () => {
    const html = renderToStaticMarkup(React.createElement(App));

    const addOfferingIdx = html.indexOf('+ Add Vendor Offering or Multi-Part Bundle Kit');
    const matrixRegionIdx = html.indexOf('aria-label="Parts to Offerings Coverage Matrix"');
    const vendorRulesIdx = html.indexOf('Vendor Shipping, Free-Shipping Minimums &amp; Tax Rules');

    expect(addOfferingIdx).toBeGreaterThan(-1);
    expect(matrixRegionIdx).toBeGreaterThan(addOfferingIdx);
    expect(vendorRulesIdx).toBeGreaterThan(matrixRegionIdx);
  });

  it('renders Tab 1 inline editable BOM fields and Tab 3 2-column checkout layout with Open Vendor Link buttons', () => {
    const html = renderToStaticMarkup(React.createElement(App));

    // Tab 1 inline editable inputs for Part Name, SKU, Category, and Required Qty
    expect(html).toContain('aria-label="Part name for row 1"');
    expect(html).toContain('aria-label="Part number or SKU for');
    expect(html).toContain('aria-label="Category for');
    expect(html).toContain('2. Vendor Listings &amp; Prices →');

    // Tab 3 checkout-ready 2-column layout with Open Vendor Link ↗ and Financial Summary Ledger
    expect(html).toContain('Open Vendor Link ↗');
    expect(html).toContain('Financial Summary Ledger');
    expect(html).toContain('Share / Export');
  });

  it('renders Tab 2 inline editable inputs, Tab 3 Mark Purchased actions, and Purchase Record modal', () => {
    const html = renderToStaticMarkup(React.createElement(App));

    // Tab 2 inline editing for Vendor, Title, SKU, Price, Discount, and Shipping
    expect(html).toContain('aria-label="Vendor name for');
    expect(html).toContain('aria-label="Vendor SKU for');
    expect(html).toContain('aria-label="Price for');
    expect(html).toContain('aria-label="Discount for');
    expect(html).toContain('aria-label="Shipping for');

    // Tab 3 Mark Purchased buttons and Financial Summary Ledger split
    expect(html).toContain('Mark Purchased');
    expect(html).toContain('Actual Spent So Far:');
    expect(html).toContain('Remaining to Spend (Solver):');
    expect(html).toContain('PROJECTED GRAND TOTAL:');

    // Purchase Record Modal dialog
    expect(html).toContain('Record Procurement / Purchase');
    expect(html).toContain('Actual Final Paid Amount ($)');

    // Top-bar buttons with uniform 26px height
    expect(html).toContain('style="height:26px;width:28px;box-sizing:border-box;');

    // Account Settings Modal and Passwordless Promo Modal dialogs
    expect(html).toContain('id="account-settings-dialog-title"');
    expect(html).toContain('Account Settings &amp; Security');
    expect(html).toContain('Profile &amp; Email');
    expect(html).toContain('Password &amp; Security');
    expect(html).toContain('OAuth Logins');
    expect(html).toContain('Passkeys');
    expect(html).toContain('Sessions &amp; Danger');
    expect(html).toContain('id="passwordless-promo-title"');
    expect(html).toContain('Switch to 100% Passwordless?');
  });

  it('configures @media print datasheet rules so both BOM (Tab 1) and Optimal Plan (Tab 3) print regardless of active tab', () => {
    const html = renderToStaticMarkup(React.createElement(App));
    const cssPath = path.resolve(process.cwd(), 'src/client/styles.css');
    const css = fs.readFileSync(cssPath, 'utf8');

    // Both panel-bom and panel-plan carry print-datasheet-panel
    expect(html).toMatch(/id="panel-bom"[^>]*class="[^"]*print-datasheet-panel/);
    expect(html).toMatch(/id="panel-plan"[^>]*class="[^"]*print-datasheet-panel/);

    // CSS forces inactive print-datasheet-panel to display: block !important in @media print
    expect(css).toContain('.tab-panel-inactive.print-datasheet-panel');
    expect(css).toContain('display: block !important');
    expect(css).toContain('inset-block-start: calc(anchor(bottom) - 3px)');
  });

  it('supports interactive WAI-ARIA keyboard navigation (ArrowRight, ArrowLeft, Home, End), header readout jump, and in-panel focus management', () => {
    // Stateful hook harness using React 19 dispatcher to drive interactive re-renders of App()
    const internals = (React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
    }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

    const states: unknown[] = [];
    const refs: Array<{ current: unknown }> = [];
    let stateCursor = 0;
    let refCursor = 0;

    function renderInteractiveApp(): React.ReactElement {
      stateCursor = 0;
      refCursor = 0;
      const pendingEffects: Array<() => void> = [];
      const prevH = internals.H;
      internals.H = {
        useState(init: unknown) {
          const idx = stateCursor++;
          if (!(idx in states)) {
            states[idx] = typeof init === 'function' ? (init as () => unknown)() : init;
          }
          const setState = (updater: unknown) => {
            states[idx] =
              typeof updater === 'function' ? (updater as (prev: unknown) => unknown)(states[idx]) : updater;
          };
          return [states[idx], setState];
        },
        useRef(init: unknown) {
          const idx = refCursor++;
          if (!refs[idx]) {
            refs[idx] = { current: init };
          }
          return refs[idx];
        },
        useMemo(fn: () => unknown) {
          return fn();
        },
        useEffect(fn: () => void, deps?: unknown[]) {
          if (deps && deps.length > 0) {
            pendingEffects.push(fn);
          }
        },
      };
      try {
        const vnode = App();
        for (const eff of pendingEffects) {
          eff();
        }
        return vnode;
      } finally {
        internals.H = prevH;
      }
    }

    function findNode(node: unknown, predicate: (el: React.ReactElement<Record<string, unknown>>) => boolean): React.ReactElement<Record<string, unknown>> | null {
      if (!node || typeof node !== 'object') return null;
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = findNode(child, predicate);
          if (found) return found;
        }
        return null;
      }
      const el = node as React.ReactElement<Record<string, unknown>>;
      if (el.props && predicate(el)) return el;
      if (el.props && el.props.children) {
        return findNode(el.props.children, predicate);
      }
      return null;
    }

    let tree = renderInteractiveApp();

    // Attach mock focus spies to the 3 tab button refs via React 19 el.props.ref
    let lastFocusedTabId: string | null = null;
    const tabBomEl = findNode(tree, (el) => el.props.id === 'tab-bom')!;
    const tabMatrixEl = findNode(tree, (el) => el.props.id === 'tab-matrix')!;
    const tabPlanEl = findNode(tree, (el) => el.props.id === 'tab-plan')!;
    (tabBomEl.props.ref as { current: unknown }).current = {
      focus: () => {
        lastFocusedTabId = 'tab-bom';
      },
    };
    (tabMatrixEl.props.ref as { current: unknown }).current = {
      focus: () => {
        lastFocusedTabId = 'tab-matrix';
      },
    };
    (tabPlanEl.props.ref as { current: unknown }).current = {
      focus: () => {
        lastFocusedTabId = 'tab-plan';
      },
    };

    const tablist = findNode(tree, (el) => el.props.role === 'tablist')!;
    const onKeyDown = tablist.props.onKeyDown as (e: { key: string; preventDefault: () => void }) => void;

    // 1. ArrowRight from Tab 1 (bom) -> Tab 2 (matrix)
    onKeyDown({ key: 'ArrowRight', preventDefault: () => {} });
    tree = renderInteractiveApp();
    expect(lastFocusedTabId).toBe('tab-matrix');
    expect(findNode(tree, (el) => el.props.id === 'tab-matrix')!.props['aria-selected']).toBe(true);
    expect(findNode(tree, (el) => el.props.id === 'tab-matrix')!.props.tabIndex).toBe(0);
    expect(findNode(tree, (el) => el.props.id === 'tab-bom')!.props.tabIndex).toBe(-1);
    expect(findNode(tree, (el) => el.props.id === 'panel-matrix')!.props.className).not.toContain('tab-panel-inactive');
    expect(findNode(tree, (el) => el.props.id === 'panel-bom')!.props.className).toContain('tab-panel-inactive');

    // 2. ArrowLeft from Tab 2 (matrix) -> Tab 1 (bom), then ArrowLeft wraps -> Tab 3 (plan)
    const tablist2 = findNode(tree, (el) => el.props.role === 'tablist')!;
    (tablist2.props.onKeyDown as (e: { key: string; preventDefault: () => void }) => void)({
      key: 'ArrowLeft',
      preventDefault: () => {},
    });
    tree = renderInteractiveApp();
    expect(lastFocusedTabId).toBe('tab-bom');

    const tablist3 = findNode(tree, (el) => el.props.role === 'tablist')!;
    (tablist3.props.onKeyDown as (e: { key: string; preventDefault: () => void }) => void)({
      key: 'ArrowLeft',
      preventDefault: () => {},
    });
    tree = renderInteractiveApp();
    expect(lastFocusedTabId).toBe('tab-plan');
    expect(findNode(tree, (el) => el.props.id === 'tab-plan')!.props['aria-selected']).toBe(true);

    // 3. Home key -> Tab 1 (bom); End key -> Tab 3 (plan)
    const tablist4 = findNode(tree, (el) => el.props.role === 'tablist')!;
    (tablist4.props.onKeyDown as (e: { key: string; preventDefault: () => void }) => void)({
      key: 'Home',
      preventDefault: () => {},
    });
    tree = renderInteractiveApp();
    expect(lastFocusedTabId).toBe('tab-bom');

    const tablist5 = findNode(tree, (el) => el.props.role === 'tablist')!;
    (tablist5.props.onKeyDown as (e: { key: string; preventDefault: () => void }) => void)({
      key: 'End',
      preventDefault: () => {},
    });
    tree = renderInteractiveApp();
    expect(lastFocusedTabId).toBe('tab-plan');

    // 4. Switch back to Tab 1, then click in-panel footer "2. Vendor Listings & Prices →" and verify focus moves to tab-matrix
    (findNode(tree, (el) => el.props.id === 'tab-bom')!.props.onClick as () => void)();
    tree = renderInteractiveApp();
    const nextStepBtn = findNode(
      tree,
      (el) => el.type === 'button' && JSON.stringify(el.props.children).includes('2. Vendor Listings & Prices →')
    )!;
    (nextStepBtn.props.onClick as () => void)();
    tree = renderInteractiveApp();
    expect(lastFocusedTabId).toBe('tab-matrix');
    expect(findNode(tree, (el) => el.props.id === 'tab-matrix')!.props['aria-selected']).toBe(true);

    // 5. Click top header "OPTIMAL OUT-OF-POCKET TOTAL ↗" readout box to jump directly to Tab 3
    (findNode(tree, (el) => el.props.id === 'tab-bom')!.props.onClick as () => void)();
    tree = renderInteractiveApp();
    const headerJumpBtn = findNode(
      tree,
      (el) => el.type === 'button' && el.props.title === 'Jump to 3. Optimal Purchase Plan'
    )!;
    (headerJumpBtn.props.onClick as () => void)();
    tree = renderInteractiveApp();
    expect(findNode(tree, (el) => el.props.id === 'tab-plan')!.props['aria-selected']).toBe(true);

    // 6. Inline edit BOM Part 1 name to empty string and trigger onBlur -> restores fallback "Part 1"
    const part1Input = findNode(
      tree,
      (el) => el.type === 'input' && el.props['aria-label'] === 'Part name for row 1'
    )!;
    (part1Input.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '   ' } });
    tree = renderInteractiveApp();
    const part1InputAfterClear = findNode(
      tree,
      (el) => el.type === 'input' && el.props['aria-label'] === 'Part name for row 1'
    )!;
    (part1InputAfterClear.props.onBlur as () => void)();
    tree = renderInteractiveApp();
    const part1InputRestored = findNode(
      tree,
      (el) => el.type === 'input' && el.props['aria-label'] === 'Part name for row 1'
    )!;
    expect(part1InputRestored.props.value).toBe('Part 1');

    // 7. Click "New Blank" project and verify empty-state messages across Tab 1, Tab 2, and Tab 3
    const newBlankBtn = findNode(
      tree,
      (el) => el.type === 'button' && JSON.stringify(el.props.children).includes('New Blank')
    )!;
    (newBlankBtn.props.onClick as () => void)();
    renderInteractiveApp(); // runs activeProject effect -> updates solverResult
    tree = renderInteractiveApp(); // renders updated solverResult
    const treeText = JSON.stringify(tree);
    expect(treeText).toContain('No required parts in this BOM yet.');
    expect(treeText).toContain('No vendor offerings in this project yet.');
    expect(treeText).toContain('No vendors in this project yet.');
    expect(treeText).toContain('No vendor orders selected yet.');
  });
});
