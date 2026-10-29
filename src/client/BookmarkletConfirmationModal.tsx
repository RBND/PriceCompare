import React, { useState, useEffect, useRef } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import type { Part } from '../shared/types.js';
import type { BookmarkletPayload, VerifiedBookmarkletCommit } from '../shared/bookmarklet.js';

interface BookmarkletConfirmationModalProps {
  isOpen: boolean;
  incoming: BookmarkletPayload;
  existingBomParts: Part[];
  reasonsToConfirm: string[];
  initialTargetBomPartId?: string | null;
  isGuestFull?: boolean;
  onCommit: (commit: VerifiedBookmarkletCommit) => void;
  onCancel: () => void;
}

export function BookmarkletConfirmationModal({
  isOpen,
  incoming,
  existingBomParts,
  reasonsToConfirm,
  initialTargetBomPartId,
  isGuestFull = false,
  onCommit,
  onCancel,
}: BookmarkletConfirmationModalProps) {
  const [bomAction, setBomAction] = useState<'ATTACH_EXISTING' | 'CREATE_NEW'>(
    initialTargetBomPartId && existingBomParts.length > 0 ? 'ATTACH_EXISTING' : 'CREATE_NEW'
  );
  const [targetBomPartId, setTargetBomPartId] = useState<string>(
    initialTargetBomPartId || existingBomParts[0]?.id || ''
  );
  const [partName, setPartName] = useState(incoming.partName || '');
  const [partNumber, setPartNumber] = useState(incoming.partNumber || incoming.vendorSku || '');
  const [priceStr, setPriceStr] = useState(
    incoming.price !== null && incoming.price !== undefined ? String(incoming.price) : ''
  );
  const [packageYieldStr, setPackageYieldStr] = useState(String(incoming.packageYield || 1));
  const [shippingStr, setShippingStr] = useState(
    incoming.shippingCost !== null && incoming.shippingCost !== undefined
      ? String(incoming.shippingCost)
      : '0'
  );

  const priceInputRef = useRef<HTMLInputElement>(null);
  const submitBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen) {
      if (!incoming.price || incoming.price <= 0) {
        priceInputRef.current?.focus();
      } else {
        submitBtnRef.current?.focus();
      }
    }
  }, [isOpen, incoming.price]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const parsedPrice = parseFloat(priceStr);
    const parsedYield = parseInt(packageYieldStr, 10);
    const parsedShipping = parseFloat(shippingStr);

    onCommit({
      bomAction: isGuestFull ? 'ATTACH_EXISTING' : bomAction,
      targetBomPartId: bomAction === 'ATTACH_EXISTING' ? targetBomPartId : null,
      partName: partName.trim() || 'Scraped Part',
      partNumber: partNumber.trim(),
      price: isNaN(parsedPrice) ? 0 : Math.max(0, parsedPrice),
      packageYield: isNaN(parsedYield) || parsedYield < 1 ? 1 : parsedYield,
      shippingCost: isNaN(parsedShipping) ? 0 : Math.max(0, parsedShipping),
      vendorName: incoming.vendorHost || 'Vendor',
      referenceUrl: incoming.url,
      vendorSku: incoming.vendorSku,
      brand: incoming.brand,
      shippingRuleNote: incoming.shippingNote,
      inStock: incoming.inStock,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="w-full max-w-lg border rounded-lg shadow-2xl overflow-hidden"
        style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3.5 border-b"
          style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        >
          <div>
            <span className="font-mono-tabular text-[10px] uppercase tracking-wider text-[var(--accent-sky)] block">
              PRICEIT CAPTURE // {incoming.vendorHost || 'RETAILER'}
            </span>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Confirm Part &amp; BOM Mapping
            </h2>
          </div>
          <span
            className="text-[10px] font-mono-tabular px-2 py-0.5 rounded border"
            style={{ backgroundColor: 'var(--bg-base)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
          >
            Enter ↵ to Save
          </span>
        </div>

        {/* Warning Banner */}
        {reasonsToConfirm.length > 0 && (
          <div className="p-3 bg-amber-950/30 border-b border-amber-900/50 text-amber-300 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
            <div className="space-y-0.5">
              <strong className="block font-mono-tabular uppercase text-[10px] text-amber-400">
                Verify Before Committing to Solver
              </strong>
              {reasonsToConfirm.map((r, i) => (
                <div key={i} className="text-[11px] leading-tight">
                  • {r}
                </div>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {/* Action Destination */}
          <div className="p-3 bg-[var(--bg-base)] border border-[var(--border-subtle)] rounded space-y-2">
            <label className="block text-[10px] font-mono-tabular uppercase text-[var(--text-muted)]">
              1. BOM Destination
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5 cursor-pointer text-[var(--text-primary)]">
                <input
                  type="radio"
                  name="bomAction"
                  value="ATTACH_EXISTING"
                  checked={bomAction === 'ATTACH_EXISTING' || existingBomParts.length === 0}
                  onChange={() => setBomAction('ATTACH_EXISTING')}
                  disabled={existingBomParts.length === 0}
                />
                Attach as Alternate Vendor Offering
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer text-[var(--text-primary)]">
                <input
                  type="radio"
                  name="bomAction"
                  value="CREATE_NEW"
                  checked={bomAction === 'CREATE_NEW' && existingBomParts.length > 0}
                  onChange={() => setBomAction('CREATE_NEW')}
                  disabled={isGuestFull}
                />
                + Create as New BOM Part {isGuestFull && '(Guest Full)'}
              </label>
            </div>

            {bomAction === 'ATTACH_EXISTING' && existingBomParts.length > 0 && (
              <div className="mt-2">
                <select
                  value={targetBomPartId}
                  onChange={(e) => setTargetBomPartId(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-primary)] rounded font-sans text-xs"
                >
                  {existingBomParts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} {p.part_number ? `(${p.part_number})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Form Fields */}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Part Name</label>
              <input
                type="text"
                required
                value={partName}
                onChange={(e) => setPartName(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-primary)] rounded text-xs"
              />
            </div>

            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Part # / MPN</label>
              <input
                type="text"
                value={partNumber}
                onChange={(e) => setPartNumber(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-primary)] rounded font-mono text-xs"
              />
            </div>

            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                Listing Price ($)
              </label>
              <input
                ref={priceInputRef}
                type="number"
                step="0.01"
                min="0"
                required
                value={priceStr}
                onChange={(e) => setPriceStr(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--accent-sky)] font-mono font-semibold rounded text-xs"
              />
            </div>

            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                Package Yield (Units Included)
              </label>
              <input
                type="number"
                step="1"
                min="1"
                required
                value={packageYieldStr}
                onChange={(e) => setPackageYieldStr(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-primary)] font-mono rounded text-xs"
              />
            </div>

            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                Shipping ($0 = Free)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={shippingStr}
                onChange={(e) => setShippingStr(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-primary)] font-mono rounded text-xs"
              />
            </div>
          </div>

          {/* Footer Actions */}
          <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border-subtle)]">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] cursor-pointer rounded"
            >
              Cancel (Esc)
            </button>
            <button
              ref={submitBtnRef}
              type="submit"
              className="px-4 py-1.5 bg-[var(--accent-sky-bg)] border border-[var(--accent-sky)] text-[var(--accent-sky)] font-semibold inline-flex items-center gap-1.5 cursor-pointer hover:brightness-110 rounded"
            >
              <Check className="w-3.5 h-3.5" /> Confirm &amp; Add to Solver ↵
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
