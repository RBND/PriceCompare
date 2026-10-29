import React, { useRef, useEffect, useState } from 'react';
import { Bookmark, Copy, Check, ExternalLink, HelpCircle } from 'lucide-react';
import { buildBookmarkletHref } from '../shared/bookmarklet.js';

interface BookmarkletModalProps {
  isOpen: boolean;
  onClose: () => void;
  installKey: string;
}

export function BookmarkletModal({ isOpen, onClose, installKey }: BookmarkletModalProps) {
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState(false);
  const [dragTip, setDragTip] = useState(false);

  const bookmarkletCode = buildBookmarkletHref(installKey);

  useEffect(() => {
    if (anchorRef.current) {
      // Direct DOM attribute attachment bypasses React 19 JSX javascript: protocol blocker
      anchorRef.current.setAttribute('href', bookmarkletCode);
    }
  }, [bookmarkletCode, isOpen]);

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(bookmarkletCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleDragAnchorClick = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragTip(true);
    setTimeout(() => setDragTip(false), 3000);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-lg border rounded-lg shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
        style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3.5 border-b"
          style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        >
          <div className="flex items-center gap-2">
            <Bookmark className="w-4 h-4 text-[var(--accent-amber)]" />
            <h2 className="text-sm font-semibold tracking-wide uppercase font-mono-tabular text-[var(--text-primary)]">
              PriceIt Capture Bookmarklet
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-2.5 py-1 border hover:bg-[var(--bg-hover)] cursor-pointer rounded"
            style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
          >
            ✕ Esc
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 overflow-y-auto text-xs">
          <p className="text-[var(--text-secondary)] leading-relaxed">
            Eliminate typing part numbers and prices manually. Drag this button directly into your browser's Bookmarks toolbar. When viewing a part on any supported retailer, click it to capture the part instantly into your PriceIt BOM.
          </p>

          {/* Draggable Target Box */}
          <div className="p-5 bg-[var(--bg-base)] border border-dashed border-[var(--accent-amber)] rounded-lg text-center space-y-2.5">
            <span className="text-[11px] font-mono-tabular text-[var(--text-muted)] uppercase tracking-wider block">
              Drag This Button to Your Bookmarks Bar
            </span>

            <div className="flex items-center justify-center gap-2">
              <a
                ref={anchorRef}
                onClick={handleDragAnchorClick}
                draggable
                className="px-4 py-2 bg-[var(--accent-amber-bg)] border border-[var(--accent-amber)] text-[var(--accent-amber)] font-bold text-xs inline-flex items-center gap-2 rounded shadow-md cursor-grab active:cursor-grabbing hover:scale-105 transition-transform select-none"
              >
                <Bookmark className="w-4 h-4 fill-[var(--accent-amber)]" /> + PriceIt Capture
              </a>
            </div>

            {dragTip && (
              <div className="text-[11px] text-[var(--accent-amber)] font-medium animate-pulse">
                Click &amp; drag the button up into your browser's Bookmarks bar!
              </div>
            )}
          </div>

          {/* Alternative: Copy Code */}
          <div className="flex items-center justify-between p-3 bg-[var(--bg-base)] border border-[var(--border-subtle)] rounded">
            <div>
              <div className="font-semibold text-[var(--text-primary)]">Can't drag on your browser?</div>
              <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                Copy the code and paste it as the URL of a new browser bookmark.
              </div>
            </div>
            <button
              type="button"
              onClick={handleCopy}
              className="px-3 py-1.5 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-medium inline-flex items-center gap-1.5 cursor-pointer hover:bg-[var(--bg-hover)]"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-[var(--accent-emerald)]" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied!' : 'Copy Code'}
            </button>
          </div>

          {/* Supported Stores Grid */}
          <div>
            <span className="text-[11px] font-mono-tabular text-[var(--text-muted)] uppercase tracking-wider block mb-2">
              Optimized Retailer Adapters
            </span>
            <div className="grid grid-cols-2 gap-1.5 text-[11px] text-[var(--text-secondary)]">
              <div className="p-1.5 bg-[var(--bg-base)] border border-[var(--border-subtle)] rounded flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-emerald)]"></span> Amazon (ASIN/MPN + Tech Specs)
              </div>
              <div className="p-1.5 bg-[var(--bg-base)] border border-[var(--border-subtle)] rounded flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-emerald)]"></span> McMaster-Carr (Pack Yields)
              </div>
              <div className="p-1.5 bg-[var(--bg-base)] border border-[var(--border-subtle)] rounded flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-emerald)]"></span> DigiKey (Pricing Tables)
              </div>
              <div className="p-1.5 bg-[var(--bg-base)] border border-[var(--border-subtle)] rounded flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-emerald)]"></span> Mouser Electronics
              </div>
              <div className="p-1.5 bg-[var(--bg-base)] border border-[var(--border-subtle)] rounded flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-emerald)]"></span> RockAuto (Catalog Selection)
              </div>
              <div className="p-1.5 bg-[var(--bg-base)] border border-[var(--border-subtle)] rounded flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-emerald)]"></span> FCP Euro (OE Automotive)
              </div>
              <div className="p-1.5 bg-[var(--bg-base)] border border-[var(--border-subtle)] rounded flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-emerald)]"></span> Grainger Industrial
              </div>
              <div className="p-1.5 bg-[var(--bg-base)] border border-[var(--border-subtle)] rounded flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-emerald)]"></span> Micro Center (Bundles/CPUs)
              </div>
            </div>
            <div className="mt-1.5 text-[10px] text-[var(--text-muted)]">
              + Universal Schema.org JSON-LD support for Shopify, WooCommerce, Adafruit, SparkFun, and thousands of other e-commerce sites.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
