import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import {
  Share2,
  FileSpreadsheet,
  Printer,
  Copy,
  Check,
  ExternalLink,
  Trash2,
  Code,
  FileText,
  Lock,
} from 'lucide-react';
import type { ProjectPayload, UserPublic } from '../shared/types.js';
import type { SolverResult } from '../shared/solver.js';
import {
  generateProjectMarkdown,
  generateProjectRedditMarkdown,
  generateProjectCsv,
  formatCentsToDollars,
} from '../shared/export.js';

interface ShareExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: ProjectPayload & { share_token?: string | null };
  solverResult: SolverResult;
  user: UserPublic | null;
  onRequireAuth: (action: string) => void;
  onGenerateShareToken: () => Promise<string | null>;
  onRevokeShareToken: () => Promise<void>;
  onTriggerPrint: () => Promise<void>;
}

export function ShareExportModal({
  isOpen,
  onClose,
  project,
  solverResult,
  user,
  onRequireAuth,
  onGenerateShareToken,
  onRevokeShareToken,
  onTriggerPrint,
}: ShareExportModalProps) {
  const [activeTab, setActiveTab] = useState<'share' | 'copy' | 'pdf' | 'csv'>('share');
  const [copyMode, setCopyMode] = useState<'summary' | 'full'>('full');
  const [copyFormat, setCopyFormat] = useState<'markdown' | 'reddit'>('markdown');
  const [copiedState, setCopiedState] = useState<string | null>(null);
  const [qrSvg, setQrSvg] = useState<string>('');
  const [isGeneratingShare, setIsGeneratingShare] = useState(false);

  const shareToken = project.share_token;
  const shareUrl = shareToken
    ? `https://priceit.rbnd.cc/share/${shareToken}`
    : `https://priceit.rbnd.cc`;

  useEffect(() => {
    if (shareToken) {
      QRCode.toString(shareUrl, {
        type: 'svg',
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      })
        .then((svg) => setQrSvg(svg))
        .catch(() => setQrSvg(''));
    } else {
      setQrSvg('');
    }
  }, [shareToken, shareUrl]);

  if (!isOpen) return null;

  const previewText =
    copyFormat === 'markdown'
      ? generateProjectMarkdown(project, solverResult, copyMode, shareUrl)
      : generateProjectRedditMarkdown(project, solverResult, copyMode, shareUrl);

  const handleCopyClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedState(label);
    setTimeout(() => setCopiedState(null), 2500);
  };

  const handleCreateShareLink = async () => {
    if (!user) {
      onRequireAuth('Create a free account to generate public shareable links.');
      return;
    }
    setIsGeneratingShare(true);
    try {
      await onGenerateShareToken();
    } finally {
      setIsGeneratingShare(false);
    }
  };

  const handleDownloadCsv = () => {
    if (!user) {
      onRequireAuth('Create a free account to download CSV/Excel spreadsheets.');
      return;
    }
    const csv = generateProjectCsv(project, solverResult);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(project.name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-bom.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrintClick = async () => {
    if (!user) {
      onRequireAuth('Sign in to print or export official PDF BOM datasheets.');
      return;
    }
    await onTriggerPrint();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-2xl border rounded-lg shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
        style={{
          borderColor: 'var(--border-subtle)',
          backgroundColor: 'var(--bg-surface)',
          color: 'var(--text-primary)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3.5 border-b"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderColor: 'var(--border-subtle)',
            color: 'var(--text-primary)',
          }}
        >
          <div className="flex items-center gap-2">
            <Share2 className="w-4 h-4 text-[var(--accent-sky)]" />
            <h2 className="text-sm font-semibold tracking-wide uppercase font-mono-tabular text-[var(--text-primary)]">
              Share / Export Hub
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-2.5 py-1 border hover:bg-[var(--bg-hover)] cursor-pointer rounded"
            style={{
              borderColor: 'var(--border-subtle)',
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-primary)',
            }}
          >
            ✕ Esc
          </button>
        </div>

        {/* Tab Navigation */}
        <div
          className="flex border-b text-xs"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          <button
            type="button"
            onClick={() => setActiveTab('share')}
            className="flex-1 py-2.5 px-3 flex items-center justify-center gap-1.5 font-medium border-b-2 transition-colors cursor-pointer"
            style={{
              borderColor: activeTab === 'share' ? 'var(--accent-sky)' : 'transparent',
              color: activeTab === 'share' ? 'var(--accent-sky)' : 'var(--text-secondary)',
              backgroundColor: activeTab === 'share' ? 'var(--bg-surface)' : 'transparent',
            }}
          >
            <Share2 className="w-3.5 h-3.5" /> Share Link
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('copy')}
            className="flex-1 py-2.5 px-3 flex items-center justify-center gap-1.5 font-medium border-b-2 transition-colors cursor-pointer"
            style={{
              borderColor: activeTab === 'copy' ? 'var(--accent-sky)' : 'transparent',
              color: activeTab === 'copy' ? 'var(--accent-sky)' : 'var(--text-secondary)',
              backgroundColor: activeTab === 'copy' ? 'var(--bg-surface)' : 'transparent',
            }}
          >
            <Code className="w-3.5 h-3.5" /> Copy Markdown / Reddit
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('pdf')}
            className="flex-1 py-2.5 px-3 flex items-center justify-center gap-1.5 font-medium border-b-2 transition-colors cursor-pointer"
            style={{
              borderColor: activeTab === 'pdf' ? 'var(--accent-sky)' : 'transparent',
              color: activeTab === 'pdf' ? 'var(--accent-sky)' : 'var(--text-secondary)',
              backgroundColor: activeTab === 'pdf' ? 'var(--bg-surface)' : 'transparent',
            }}
          >
            <Printer className="w-3.5 h-3.5" /> Print PDF {!user && <Lock className="w-3 h-3 text-[var(--accent-amber)]" />}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('csv')}
            className="flex-1 py-2.5 px-3 flex items-center justify-center gap-1.5 font-medium border-b-2 transition-colors cursor-pointer"
            style={{
              borderColor: activeTab === 'csv' ? 'var(--accent-sky)' : 'transparent',
              color: activeTab === 'csv' ? 'var(--accent-sky)' : 'var(--text-secondary)',
              backgroundColor: activeTab === 'csv' ? 'var(--bg-surface)' : 'transparent',
            }}
          >
            <FileSpreadsheet className="w-3.5 h-3.5" /> CSV / Excel {!user && <Lock className="w-3 h-3 text-[var(--accent-amber)]" />}
          </button>
        </div>

        {/* Tab Content */}
        <div
          className="p-5 overflow-y-auto flex-1 text-xs"
          style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
        >
          {/* TAB 1: Share Link */}
          {activeTab === 'share' && (
            <div className="space-y-4">
              <p className="text-[var(--text-secondary)] leading-relaxed">
                Generate a clean read-only link. Pasting it into Discord, Slack, Reddit, or Twitter automatically generates an adaptive 1200×630 OpenGraph card showing the project name, total cost, and dollar savings.
              </p>

              {shareToken ? (
                <div className="space-y-3">
                  <label className="block text-[11px] font-mono-tabular uppercase text-[var(--text-muted)]">
                    Active Read-Only Share URL
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      readOnly
                      value={shareUrl}
                      className="flex-1 px-3 py-1.5 border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-primary)] font-mono-tabular select-all rounded"
                    />
                    <button
                      type="button"
                      onClick={() => handleCopyClipboard(shareUrl, 'link')}
                      className="px-3 py-1.5 bg-[var(--accent-sky-bg)] border border-[var(--accent-sky)] text-[var(--accent-sky)] font-medium inline-flex items-center gap-1.5 cursor-pointer rounded hover:brightness-110"
                    >
                      {copiedState === 'link' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedState === 'link' ? 'Copied!' : 'Copy Link'}
                    </button>
                  </div>

                  <div className="p-3 bg-[var(--bg-base)] border border-[var(--border-subtle)] rounded flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {qrSvg && (
                        <div
                          className="w-16 h-16 bg-white p-1 rounded border border-slate-300 shrink-0"
                          dangerouslySetInnerHTML={{ __html: qrSvg }}
                        />
                      )}
                      <div>
                        <div className="font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                          <ExternalLink className="w-3.5 h-3.5 text-[var(--accent-emerald)]" /> Live OpenGraph Embed Enabled
                        </div>
                        <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                          OpenGraph Card: <code className="text-[var(--accent-sky)]">/api/og/{shareToken}.png</code>
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={onRevokeShareToken}
                      className="px-2.5 py-1 text-[11px] bg-[var(--accent-danger-bg)] text-[var(--accent-danger)] border border-[var(--accent-danger)] rounded hover:brightness-110 inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" /> Revoke Link
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-6 bg-[var(--bg-base)] border border-dashed border-[var(--border-subtle)] rounded text-center space-y-3">
                  <div className="text-sm font-semibold text-[var(--text-primary)]">
                    No active share link for this project yet.
                  </div>
                  <p className="text-[var(--text-secondary)] text-xs max-w-sm mx-auto leading-relaxed">
                    Anyone with the cryptographic link will be able to inspect parts, prices, and vendor consolidation without editing rights.
                  </p>
                  <button
                    type="button"
                    onClick={handleCreateShareLink}
                    disabled={isGeneratingShare}
                    className="px-4 py-2 bg-[var(--accent-sky-bg)] border border-[var(--accent-sky)] text-[var(--accent-sky)] font-semibold inline-flex items-center gap-1.5 cursor-pointer shadow-sm hover:brightness-110 rounded"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    {isGeneratingShare ? 'Generating...' : 'Create Public Share Link'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: Copy Markdown / Reddit */}
          {activeTab === 'copy' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[var(--border-subtle)]">
                {/* Format toggle */}
                <div className="inline-flex rounded border border-[var(--border-subtle)] bg-[var(--bg-base)] p-0.5">
                  <button
                    type="button"
                    onClick={() => setCopyFormat('markdown')}
                    className="px-2.5 py-1 text-xs rounded-xs font-medium cursor-pointer"
                    style={{
                      backgroundColor: copyFormat === 'markdown' ? 'var(--accent-sky)' : 'transparent',
                      color: copyFormat === 'markdown' ? '#ffffff' : 'var(--text-secondary)',
                    }}
                  >
                    GitHub Markdown
                  </button>
                  <button
                    type="button"
                    onClick={() => setCopyFormat('reddit')}
                    className="px-2.5 py-1 text-xs rounded-xs font-medium cursor-pointer"
                    style={{
                      backgroundColor: copyFormat === 'reddit' ? 'var(--accent-sky)' : 'transparent',
                      color: copyFormat === 'reddit' ? '#ffffff' : 'var(--text-secondary)',
                    }}
                  >
                    Reddit Markdown Table
                  </button>
                </div>

                {/* Detail level toggle */}
                <div className="inline-flex rounded border border-[var(--border-subtle)] bg-[var(--bg-base)] p-0.5">
                  <button
                    type="button"
                    onClick={() => setCopyMode('summary')}
                    className="px-2 py-1 text-xs rounded-xs font-medium cursor-pointer"
                    style={{
                      backgroundColor: copyMode === 'summary' ? 'var(--bg-elevated)' : 'transparent',
                      color: copyMode === 'summary' ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}
                  >
                    Summary Only
                  </button>
                  <button
                    type="button"
                    onClick={() => setCopyMode('full')}
                    className="px-2 py-1 text-xs rounded-xs font-medium cursor-pointer"
                    style={{
                      backgroundColor: copyMode === 'full' ? 'var(--bg-elevated)' : 'transparent',
                      color: copyMode === 'full' ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}
                  >
                    Full Breakdown
                  </button>
                </div>
              </div>

              {/* Text Preview Box */}
              <div className="relative">
                <textarea
                  readOnly
                  rows={9}
                  value={previewText}
                  className="w-full p-2.5 text-[11px] font-mono border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-primary)] select-all rounded"
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => handleCopyClipboard(previewText, 'preview')}
                  className="px-4 py-2 bg-[var(--accent-emerald-bg)] border border-[var(--accent-emerald)] text-[var(--accent-emerald)] font-semibold inline-flex items-center gap-1.5 cursor-pointer shadow-sm hover:brightness-110 rounded"
                >
                  {copiedState === 'preview' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedState === 'preview' ? 'Copied to Clipboard!' : `Copy ${copyFormat === 'reddit' ? 'Reddit Table' : 'Markdown'}`}
                </button>
              </div>
            </div>
          )}

          {/* TAB 3: Print PDF */}
          {activeTab === 'pdf' && (
            <div className="space-y-4">
              <p className="text-[var(--text-secondary)] leading-relaxed">
                Produces an official workshop purchase order datasheet optimized for 8.5×11 and A4 printers. Stamped with an SVG QR code linking shop mechanics and labmates directly to the live BOM.
              </p>

              <div className="p-4 bg-[var(--bg-base)] border border-[var(--border-subtle)] rounded flex items-center justify-between">
                <div>
                  <div className="font-semibold text-[var(--text-primary)]">
                    Print-Ready Purchase Order Datasheet
                  </div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-1">
                    Auto-provisions a live share link and QR code in footer.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handlePrintClick}
                  className="px-4 py-2 bg-[var(--accent-sky-bg)] border border-[var(--accent-sky)] text-[var(--accent-sky)] font-semibold inline-flex items-center gap-1.5 cursor-pointer hover:brightness-110 rounded"
                >
                  <Printer className="w-3.5 h-3.5" /> Print / Save PDF
                </button>
              </div>
            </div>
          )}

          {/* TAB 4: Export CSV / Excel */}
          {activeTab === 'csv' && (
            <div className="space-y-4">
              <p className="text-[var(--text-secondary)] leading-relaxed">
                Download a sanitized CSV spreadsheet containing the full BOM, optimal vendor orders, and bundle savings. Cells starting with dangerous prefixes (<code className="text-amber-400">= + - @</code>) are securely escaped.
              </p>

              <div className="p-4 bg-[var(--bg-base)] border border-[var(--border-subtle)] rounded flex items-center justify-between">
                <div>
                  <div className="font-semibold text-[var(--text-primary)]">
                    Sanitized CSV / Excel Spreadsheet
                  </div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-1">
                    Total: ${formatCentsToDollars(solverResult.grand_total_cents)} across {solverResult.vendor_orders.length} vendor orders
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleDownloadCsv}
                  className="px-4 py-2 bg-[var(--accent-emerald-bg)] border border-[var(--accent-emerald)] text-[var(--accent-emerald)] font-semibold inline-flex items-center gap-1.5 cursor-pointer hover:brightness-110 rounded"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" /> Download CSV
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
