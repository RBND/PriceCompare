import React, { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  ChevronLeft,
  ChevronRight,
  X,
  Compass,
  Check,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
} from 'lucide-react';

export const TUTORIAL_COMPLETED_KEY = 'priceit_tutorial_completed_v1';

export type TourTab = 'bom' | 'matrix' | 'plan';
export type TourPlacement = 'center' | 'bottom' | 'top' | 'left' | 'right';

export interface TourStep {
  id: string;
  title: string;
  badge: string;
  description: string;
  tip: string;
  targetSelector: string | null;
  tab?: TourTab;
  preferredPlacement: TourPlacement;
  expandVendorSection?: boolean;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to PriceIt Workshop',
    badge: 'QUICK START GUIDE',
    description:
      'PriceIt is a combinatorial parts & bundle price optimizer. Instead of manually comparing single items against multi-packs, combo kits, and free-shipping thresholds across stores, PriceIt solves the exact cheapest purchase combination for your entire build. When you click Start, we will load a sample Demo Project so you can see every tab and calculation filled out as we walk through the features.',
    tip: 'Demo Data Notice: We load sample demo data when you click Start so you can see a complete project in action, and we will automatically clear it when the tour ends so you have a fresh start!',
    targetSelector: null,
    tab: 'bom',
    preferredPlacement: 'center',
  },
  {
    id: 'presets-bar',
    title: 'Project Presets & Workspace Controls',
    badge: 'PROJECT SWITCHER',
    description:
      'We just loaded the "Demo: Auto Parts" sample project for this tour. Anytime in the future, you can click "Demo: Auto Parts" or "Demo: PC Build" to explore sample builds, or click "New Blank" to reset to an empty workspace.',
    tip: 'Below the top bar, you can also rename your project, set its category, and configure your default local sales tax rate.',
    targetSelector: '[data-tour="presets-bar"]',
    tab: 'bom',
    preferredPlacement: 'bottom',
  },
  {
    id: 'bom-add-form',
    title: 'Step 1: Build Your Parts List (BOM)',
    badge: 'TAB 1 • BILL OF MATERIALS',
    description:
      'Start by listing every part your project requires along with its Part # / SKU and required quantity (e.g., 2× Front Brake Rotors or 4× Spark Plugs).',
    tip: 'Every cell in the BOM table below is inline-editable, and you can mark parts you already own using "Mark as Owned".',
    targetSelector: '[data-tour="bom-add-form"]',
    tab: 'bom',
    preferredPlacement: 'bottom',
  },
  {
    id: 'bookmarklet-btn',
    title: 'One-Click Web Capture Bookmarklet (Optional)',
    badge: 'OPTIONAL • BROWSER BOOKMARKLET',
    description:
      'What it does & benefits: "+ PriceIt Capture" is a browser bookmarklet you can drag to your bookmarks bar. While shopping on eBay, Amazon, RockAuto, or any store, clicking it automatically extracts the product title, MPN/part number, price, shipping cost, and pack quantity—sending it straight into your open PriceIt tab without copy-pasting between tabs.',
    tip: '100% Optional — Not Required: You never have to install or use the bookmarklet! You can always type or paste parts and prices manually in Tab 1 and Tab 2. If you do use it, click the Bookmark Pin icon on any BOM row to auto-attach captured listings directly to that part.',
    targetSelector: '[data-tour="bookmarklet-btn"]',
    tab: 'bom',
    preferredPlacement: 'bottom',
  },
  {
    id: 'offering-add-form',
    title: 'Step 2: Add Vendor Listings & Bundle Kits',
    badge: 'TAB 2 • VENDOR OFFERINGS',
    description:
      'Here in Tab 2, add individual vendor listings or multi-part combo kits manually (or review items captured via the bookmarklet). Paste a product URL to auto-detect the retailer name, enter the price/shipping/discount, and check which BOM parts the listing includes.',
    tip: 'If a single listing is a combo kit (like "2× Rotors + 1× Brake Pad Set"), check both parts and set their yield quantities!',
    targetSelector: '[data-tour="offering-add-form"]',
    tab: 'matrix',
    preferredPlacement: 'bottom',
  },
  {
    id: 'coverage-matrix',
    title: 'Interactive Bundle Coverage Matrix',
    badge: 'TAB 2 • COVERAGE MATRIX',
    description:
      'This matrix maps every vendor listing (rows) against your required BOM parts (columns). Click any "·" cell to toggle coverage ("✓") and adjust how many units of that part are included per purchase.',
    tip: 'Rows highlighted in emerald green with a "BUY ×N" badge are currently selected by the solver as part of your cheapest order plan.',
    targetSelector: '[data-tour="coverage-matrix"]',
    tab: 'matrix',
    preferredPlacement: 'top',
  },
  {
    id: 'vendor-shipping-rules',
    title: 'Vendor Shipping & Free-Shipping Minimums',
    badge: 'TAB 2 • SHIPPING THRESHOLDS',
    description:
      'Configure per-order flat shipping charges, free-shipping minimums (such as Free Shipping on orders ≥ $35 or $49), and vendor-specific tax rates.',
    tip: 'The solver automatically checks whether consolidating items at one vendor unlocks free shipping to beat a cheaper unit price elsewhere!',
    targetSelector: '[data-tour="vendor-shipping-rules"]',
    tab: 'matrix',
    preferredPlacement: 'top',
    expandVendorSection: true,
  },
  {
    id: 'optimal-plan-orders',
    title: 'Step 3: Optimal Purchase Plan & Ledger',
    badge: 'TAB 3 • SOLVER RESULTS',
    description:
      'Tab 3 shows your checkout-ready shopping list grouped by retailer, complete with direct vendor links, net savings vs. buying single items, and any bonus spare parts from overlapping kits.',
    tip: 'As you buy items in real life, click "Mark Purchased" to lock in what you actually paid—the solver dynamically re-optimizes your remaining unpurchased parts!',
    targetSelector: '[data-tour="optimal-plan-orders"]',
    tab: 'plan',
    preferredPlacement: 'top',
  },
  {
    id: 'share-export-btn',
    title: 'Share, Print QR Datasheets & Cloud Sync',
    badge: 'EXPORT & CLOUD SYNC',
    description:
      'Click "Share / Export" to generate a read-only share link, print a workshop PDF datasheet with a scannable QR code, copy Markdown/Reddit tables, or download a CSV spreadsheet.',
    tip: 'Click "Finish Tour" below (or Close) and we will clear this sample demo data so you have a fresh, blank workspace ready for your own project!',
    targetSelector: '[data-tour="share-export-btn"]',
    tab: 'plan',
    preferredPlacement: 'bottom',
  },
];

export interface OnboardingTourProps {
  isOpen: boolean;
  stepIndex: number;
  onStepChange: (nextIndex: number, step: TourStep) => void;
  onClose: () => void;
}

interface ComputedPosition {
  placement: TourPlacement;
  top: number;
  left: number;
  arrowOffsetPx: number;
  targetRect: { top: number; left: number; width: number; height: number } | null;
}

export function OnboardingTour({ isOpen, stepIndex, onStepChange, onClose }: OnboardingTourProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const nextBtnRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<ComputedPosition>({
    placement: 'center',
    top: 0,
    left: 0,
    arrowOffsetPx: 160,
    targetRect: null,
  });

  const safeIndex = Math.max(0, Math.min(TOUR_STEPS.length - 1, stepIndex));
  const currentStep = TOUR_STEPS[safeIndex];
  const isFirstStep = safeIndex === 0;
  const isLastStep = safeIndex === TOUR_STEPS.length - 1;

  const goToStep = (nextIdx: number) => {
    const clamped = Math.max(0, Math.min(TOUR_STEPS.length - 1, nextIdx));
    onStepChange(clamped, TOUR_STEPS[clamped]);
  };

  // Manage native popover="manual" open/close and programmatic focus per modern-web-guidance (persistent-app-tours)
  useEffect(() => {
    const el = popoverRef.current;
    if (!el) return;

    if (isOpen) {
      if (typeof el.showPopover === 'function') {
        try {
          el.showPopover();
        } catch {
          // Ignore if already open
        }
      }
      // Programmatically shift focus into the non-modal popover so keyboard/AT users perceive context
      if (nextBtnRef.current && typeof nextBtnRef.current.focus === 'function') {
        nextBtnRef.current.focus({ preventScroll: true });
      }
    } else {
      if (typeof el.hidePopover === 'function') {
        try {
          el.hidePopover();
        } catch {
          // Ignore if already hidden
        }
      }
    }
  }, [isOpen, safeIndex]);

  // Highlight active target element with pulsing glow & calculate tethered popover coordinates
  useEffect(() => {
    if (!isOpen || typeof document === 'undefined' || typeof window === 'undefined') {
      return undefined;
    }

    // Clear any stale data-tour-active attributes
    const clearHighlights = () => {
      if (typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('[data-tour-active="true"]').forEach((node) => {
          node.removeAttribute('data-tour-active');
          node.classList.remove('tour-target-glow');
        });
      }
    };

    clearHighlights();

    const selector = currentStep.targetSelector;
    if (!selector || typeof document.querySelector !== 'function') {
      setPos({
        placement: 'center',
        top: 0,
        left: 0,
        arrowOffsetPx: 160,
        targetRect: null,
      });
      return clearHighlights;
    }

    let rafId = 0;
    let targetEl = document.querySelector(selector) as HTMLElement | null;

    const applyHighlightAndMeasure = (shouldScroll: boolean) => {
      targetEl = document.querySelector(selector) as HTMLElement | null;
      if (!targetEl) {
        setPos({
          placement: 'center',
          top: 0,
          left: 0,
          arrowOffsetPx: 160,
          targetRect: null,
        });
        return;
      }

      targetEl.setAttribute('data-tour-active', 'true');
      targetEl.classList.add('tour-target-glow');

      if (shouldScroll && typeof targetEl.scrollIntoView === 'function') {
        const rectBefore = targetEl.getBoundingClientRect();
        const vh = window.innerHeight || 800;
        if (rectBefore.top < 70 || rectBefore.bottom > vh - 120) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        }
      }

      const rect = targetEl.getBoundingClientRect();
      const vw = window.innerWidth || 1024;
      const vh = window.innerHeight || 768;
      const cardWidth = Math.min(390, vw - 24);
      const cardHeight = popoverRef.current?.offsetHeight || 255;
      const gap = 16;

      let placement: TourPlacement = currentStep.preferredPlacement;
      const spaceBelow = vh - rect.bottom;
      const spaceAbove = rect.top;

      if (placement === 'bottom' && spaceBelow < cardHeight + gap + 16 && spaceAbove > spaceBelow) {
        placement = 'top';
      } else if (placement === 'top' && spaceAbove < cardHeight + gap + 16 && spaceBelow > spaceAbove) {
        placement = 'bottom';
      }

      const targetCenterX = rect.left + rect.width / 2;
      let left = Math.round(targetCenterX - cardWidth / 2);
      left = Math.max(12, Math.min(vw - cardWidth - 12, left));

      let top =
        placement === 'top'
          ? Math.round(rect.top - cardHeight - gap)
          : Math.round(rect.bottom + gap);

      // Clamp vertical position inside viewport
      top = Math.max(12, Math.min(vh - cardHeight - 12, top));

      // Calculate horizontal offset for the arrow along the popover card edge so it points directly at the target center
      const arrowOffsetPx = Math.max(24, Math.min(cardWidth - 24, Math.round(targetCenterX - left)));

      setPos({
        placement,
        top,
        left,
        arrowOffsetPx,
        targetRect: {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    };

    // Initial measure (and slight delay after tab switch render)
    applyHighlightAndMeasure(true);
    const timer = setTimeout(() => applyHighlightAndMeasure(false), 120);

    const handleViewportUpdate = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => applyHighlightAndMeasure(false));
    };

    window.addEventListener('resize', handleViewportUpdate);
    window.addEventListener('scroll', handleViewportUpdate, true);

    return () => {
      clearTimeout(timer);
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleViewportUpdate);
      window.removeEventListener('scroll', handleViewportUpdate, true);
      clearHighlights();
    };
  }, [isOpen, safeIndex, currentStep.targetSelector, currentStep.preferredPlacement]);

  // Keyboard navigation: ArrowRight (Next), ArrowLeft (Back), Escape (Close)
  useEffect(() => {
    if (!isOpen || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      const isEditingInput = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select';

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      if (isEditingInput) return;

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (!isLastStep) {
          goToStep(safeIndex + 1);
        } else {
          onClose();
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (!isFirstStep) {
          goToStep(safeIndex - 1);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, safeIndex, isFirstStep, isLastStep]);

  if (!isOpen) {
    return null;
  }

  const effectivePlacement: TourPlacement = currentStep.targetSelector
    ? pos.targetRect
      ? pos.placement
      : currentStep.preferredPlacement
    : 'center';
  const isCentered = effectivePlacement === 'center' || !currentStep.targetSelector;

  const dynamicStyle: React.CSSProperties = isCentered
    ? {
        position: 'fixed',
        inset: 0,
        margin: 'auto',
        width: 'min(420px, calc(100vw - 24px))',
        height: 'fit-content',
        zIndex: 90,
      }
    : {
        position: 'fixed',
        top: `${pos.top}px`,
        left: `${pos.left}px`,
        margin: 0,
        width: 'min(390px, calc(100vw - 24px))',
        zIndex: 90,
        ['--tour-arrow-x' as string]: `${pos.arrowOffsetPx}px`,
      };

  return (
    <div
      ref={popoverRef}
      id="priceit-onboarding-tour"
      {...({ popover: 'manual' } as React.HTMLAttributes<HTMLDivElement>)}
      role="dialog"
      aria-modal="false"
      aria-labelledby="tour-step-title"
      aria-describedby="tour-step-desc"
      data-placement={effectivePlacement}
      className="no-print tour-popover-card"
      style={dynamicStyle}
    >
      <div className="tour-popover-content relative flex flex-col">
        {/* Directional Caret Arrow & Animated Pointer Badge */}
        {!isCentered && (
          <div
            className={`tour-arrow tour-arrow-${effectivePlacement}`}
            style={{ left: `${pos.arrowOffsetPx}px` }}
            aria-hidden="true"
          >
            <div className="tour-arrow-diamond" />
          </div>
        )}

        {/* Top Industrial Accent Header */}
        <div
          className="px-3.5 py-2 border-b flex items-center justify-between gap-2"
          style={{
            backgroundColor: 'var(--accent-amber-bg)',
            borderColor: 'var(--accent-amber)',
          }}
        >
          <div className="flex items-center gap-1.5">
            <Compass className="w-3.5 h-3.5 text-[var(--accent-amber)] shrink-0" aria-hidden="true" />
            <span
              className="text-[10px] font-mono-tabular font-bold uppercase tracking-wider"
              style={{ color: 'var(--accent-amber)' }}
            >
              STEP {safeIndex + 1} OF {TOUR_STEPS.length} &bull; {currentStep.badge}
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close tutorial"
            title="Close tutorial (Esc)"
            className="p-0.5 border cursor-pointer hover:opacity-80 flex items-center justify-center"
            style={{
              backgroundColor: 'var(--bg-surface)',
              borderColor: 'var(--accent-amber)',
              color: 'var(--text-primary)',
            }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body Content */}
        <div className="p-3.5 flex flex-col gap-2.5" style={{ backgroundColor: 'var(--bg-surface)' }}>
          <div className="flex items-start justify-between gap-2">
            <h2
              id="tour-step-title"
              className="font-bold text-sm tracking-tight"
              style={{ color: 'var(--text-primary)' }}
            >
              {currentStep.title}
            </h2>

            {!isCentered && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono-tabular font-semibold border shrink-0 tour-pointer-pill"
                style={{
                  backgroundColor: 'var(--accent-amber-bg)',
                  borderColor: 'var(--accent-amber)',
                  color: 'var(--accent-amber)',
                }}
              >
                {effectivePlacement === 'bottom' && <ArrowUp className="w-3 h-3" />}
                {effectivePlacement === 'top' && <ArrowDown className="w-3 h-3" />}
                {effectivePlacement === 'left' && <ArrowRight className="w-3 h-3" />}
                {effectivePlacement === 'right' && <ArrowLeft className="w-3 h-3" />}
                <span>Highlighted</span>
              </span>
            )}
          </div>

          <p
            id="tour-step-desc"
            className="text-xs leading-relaxed"
            style={{ color: 'var(--text-secondary)' }}
          >
            {currentStep.description}
          </p>

          <div
            className="p-2 border text-[11px] flex items-start gap-2"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-primary)',
            }}
          >
            <Sparkles className="w-3.5 h-3.5 text-[var(--accent-amber)] shrink-0 mt-0.5" aria-hidden="true" />
            <span>{currentStep.tip}</span>
          </div>
        </div>

        {/* Step Progress Dots & Navigation Controls Footer */}
        <div
          className="px-3.5 py-2.5 border-t flex flex-wrap items-center justify-between gap-2"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          {/* Progress Dots */}
          <div className="flex items-center gap-1" role="group" aria-label="Tutorial step progress">
            {TOUR_STEPS.map((s, idx) => {
              const isCurrent = idx === safeIndex;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => goToStep(idx)}
                  aria-label={`Jump to step ${idx + 1}: ${s.title}`}
                  aria-current={isCurrent ? 'step' : undefined}
                  title={`${idx + 1}. ${s.title}`}
                  className="h-2 transition-all cursor-pointer border"
                  style={{
                    width: isCurrent ? '18px' : '8px',
                    backgroundColor: isCurrent ? 'var(--accent-amber)' : 'var(--bg-surface)',
                    borderColor: isCurrent ? 'var(--accent-amber)' : 'var(--border-strong)',
                  }}
                />
              );
            })}
          </div>

          {/* Action Buttons: Close/Skip, Back, Next/Finish */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onClose}
              className="px-2 py-1 text-[11px] font-mono-tabular border cursor-pointer hover:bg-[var(--bg-hover)]"
              style={{
                backgroundColor: 'var(--bg-surface)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-secondary)',
              }}
            >
              Close
            </button>

            <button
              type="button"
              disabled={isFirstStep}
              onClick={() => goToStep(safeIndex - 1)}
              className="px-2.5 py-1 text-xs font-medium border inline-flex items-center gap-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--bg-hover)]"
              style={{
                backgroundColor: 'var(--bg-surface)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-primary)',
              }}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Back</span>
            </button>

            {!isLastStep ? (
              <button
                ref={nextBtnRef}
                type="button"
                onClick={() => goToStep(safeIndex + 1)}
                className="px-3 py-1 text-xs font-bold border inline-flex items-center gap-1 cursor-pointer"
                style={{
                  backgroundColor: 'var(--accent-amber-bg)',
                  borderColor: 'var(--accent-amber)',
                  color: 'var(--accent-amber)',
                }}
              >
                <span>{isFirstStep ? 'Start' : 'Next'}</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                ref={nextBtnRef}
                type="button"
                onClick={onClose}
                className="px-3 py-1 text-xs font-bold border inline-flex items-center gap-1 cursor-pointer"
                style={{
                  backgroundColor: 'var(--accent-emerald-bg)',
                  borderColor: 'var(--accent-emerald)',
                  color: 'var(--accent-emerald)',
                }}
              >
                <Check className="w-3.5 h-3.5" />
                <span>Finish Tour</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
