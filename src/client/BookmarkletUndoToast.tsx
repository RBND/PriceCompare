import React, { useEffect } from 'react';
import { RotateCcw, X } from 'lucide-react';

interface BookmarkletUndoToastProps {
  toast: {
    id: string;
    vendorName: string;
    price: number;
    packageYield: number;
  } | null;
  onUndo: () => void;
  onDismiss: () => void;
}

export function BookmarkletUndoToast({ toast, onUndo, onDismiss }: BookmarkletUndoToastProps) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      onDismiss();
    }, 6000);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;

  return (
    <div className="fixed bottom-5 right-5 z-50 flex items-center gap-3 bg-[var(--bg-elevated)] border border-[var(--accent-sky)] text-[var(--text-primary)] px-4 py-3 rounded-lg shadow-2xl animate-fade-in font-sans text-xs">
      <div>
        <div className="font-mono-tabular text-[10px] text-[var(--accent-sky)] uppercase font-semibold">
          AUTO-ADDED TO SOLVER
        </div>
        <div className="mt-0.5">
          <strong className="text-[var(--text-primary)]">{toast.vendorName}</strong> — $
          {toast.price.toFixed(2)}{' '}
          {toast.packageYield > 1 && (
            <span className="text-[var(--text-muted)] text-[11px]">
              (Yield: {toast.packageYield})
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 ml-2 border-l border-[var(--border-subtle)] pl-3">
        <button
          type="button"
          onClick={onUndo}
          className="px-2.5 py-1 bg-[var(--bg-base)] border border-[var(--border-subtle)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded inline-flex items-center gap-1 cursor-pointer font-medium"
        >
          <RotateCcw className="w-3 h-3 text-[var(--accent-amber)]" /> Undo / Edit
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
