import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Plus,
  Trash2,
  ExternalLink,
  Check,
  AlertTriangle,
  Download,
  Printer,
  Share2,
  FolderPlus,
  LogIn,
  LogOut,
  Sun,
  Moon,
  Truck,
  Layers,
  Package,
  Calculator,
  Copy,
  Sparkles,
  FileSpreadsheet,
} from 'lucide-react';
import {
  extractVendorFromUrl,
  isValidHttpUrl,
  type Part,
  type Offering,
  type BundleMapping,
  type VendorProfile,
  type ProjectPayload,
  type PurchaseRecord,
  type UserPublic,
  type GuestMigrationPayload,
} from '../shared/types.js';
import { solveBundleOptimization, type SolverResult, type SolverInput } from '../shared/solver.js';
import { generateProjectCsv, formatCentsToDollars } from '../shared/export.js';
import { DEMO_BRAKE_PROJECT, DEMO_PC_PROJECT } from '../shared/demoData.js';

const GUEST_STORAGE_KEY = 'priceit_guest_project_v2';
const GUEST_MAX_PARTS = 10;

interface StoredGuestState {
  client_project_uuid: string;
  is_dirty: boolean;
  project: ProjectPayload;
}

function makeClientId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
}

function loadInitialGuestState(): StoredGuestState {
  try {
    const raw = localStorage.getItem(GUEST_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredGuestState;
      if (parsed && parsed.project && Array.isArray(parsed.project.parts)) {
        return parsed;
      }
    }
  } catch {
    // Ignore localStorage parse errors
  }

  return {
    client_project_uuid: makeClientId('guest-uuid'),
    is_dirty: false,
    project: structuredClone(DEMO_BRAKE_PROJECT),
  };
}

async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set('X-PriceIt-CSRF', '1');
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: 'same-origin',
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed with status ${res.status}`) as Error & {
      status?: number;
      current_version?: number;
    };
    err.status = res.status;
    err.current_version = data.current_version;
    throw err;
  }
  return data as T;
}

export function App() {
  const [user, setUser] = useState<UserPublic | null>(null);
  const [guestState, setGuestState] = useState<StoredGuestState>(() => loadInitialGuestState());
  const [cloudProjects, setCloudProjects] = useState<
    Array<{ id: string; name: string; category: string; parts_count: number; offerings_count: number; version: number }>
  >([]);
  const [activeProject, setActiveProject] = useState<ProjectPayload & { share_token?: string | null }>(() =>
    loadInitialGuestState().project
  );
  const [isReadOnlyShare, setIsReadOnlyShare] = useState(false);
  const [conflictServerVersion, setConflictServerVersion] = useState<number | null>(null);
  const [statusBanner, setStatusBanner] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [bannerCountdown, setBannerCountdown] = useState(10);
  const [isSaving, setIsSaving] = useState(false);

  // Dialog refs (using native <dialog closedby="any"> + Safari light-dismiss fallback per modern-web-guidance)
  const authDialogRef = useRef<HTMLDialogElement | null>(null);
  const vendorDialogRef = useRef<HTMLDialogElement | null>(null);
  const shareDialogRef = useRef<HTMLDialogElement | null>(null);
  const purchaseDialogRef = useRef<HTMLDialogElement | null>(null);

  // Purchase Modal State
  const [purchaseTarget, setPurchaseTarget] = useState<
    | { type: 'offering'; offering: Offering; qty: number; vendorName?: string }
    | { type: 'part'; part: Part; qty: number }
    | null
  >(null);
  const [purchasePaidAmount, setPurchasePaidAmount] = useState('');
  const [purchaseOrderNumber, setPurchaseOrderNumber] = useState('');
  const [purchaseNotes, setPurchaseNotes] = useState('');
  const [editingPurchaseId, setEditingPurchaseId] = useState<string | null>(null);

  // Derived fulfillment, procurement progress and unfulfilled demand
  const fulfilledPartMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const purchase of activeProject.purchases || []) {
      if (purchase.offering_id) {
        const qty = purchase.offering_qty || 1;
        const mappings = activeProject.bundle_mappings.filter((bm) => bm.offering_id === purchase.offering_id);
        for (const m of mappings) {
          map.set(m.part_id, (map.get(m.part_id) || 0) + m.yield_qty * qty);
        }
      } else if (purchase.part_id) {
        const qty = purchase.part_qty || 1;
        map.set(purchase.part_id, (map.get(purchase.part_id) || 0) + qty);
      }
    }
    return map;
  }, [activeProject.purchases, activeProject.bundle_mappings]);

  const neededParts = useMemo(() => {
    return activeProject.parts
      .map((part) => {
        const fulfilled = fulfilledPartMap.get(part.id) || 0;
        const remaining = Math.max(0, part.required_qty - fulfilled);
        return {
          ...part,
          required_qty: remaining,
        };
      })
      .filter((p) => p.required_qty > 0);
  }, [activeProject.parts, fulfilledPartMap]);

  const totalSpentCents = useMemo(() => {
    return (activeProject.purchases || []).reduce((sum, p) => sum + p.actual_paid_cents, 0);
  }, [activeProject.purchases]);

  const fulfilledPartsCount = useMemo(() => {
    return activeProject.parts.filter((p) => (fulfilledPartMap.get(p.id) || 0) >= p.required_qty).length;
  }, [activeProject.parts, fulfilledPartMap]);

  // Solver state (runs via Web Worker with synchronous fallback)
  const [solverResult, setSolverResult] = useState<SolverResult>(() => {
    const initialMap = new Map<string, number>();
    for (const purchase of activeProject.purchases || []) {
      if (purchase.offering_id) {
        const qty = purchase.offering_qty || 1;
        const mappings = activeProject.bundle_mappings.filter((bm) => bm.offering_id === purchase.offering_id);
        for (const m of mappings) {
          initialMap.set(m.part_id, (initialMap.get(m.part_id) || 0) + m.yield_qty * qty);
        }
      } else if (purchase.part_id) {
        const qty = purchase.part_qty || 1;
        initialMap.set(purchase.part_id, (initialMap.get(purchase.part_id) || 0) + qty);
      }
    }
    const initialNeeded = activeProject.parts
      .map((part) => ({
        ...part,
        required_qty: Math.max(0, part.required_qty - (initialMap.get(part.id) || 0)),
      }))
      .filter((p) => p.required_qty > 0);

    return solveBundleOptimization({
      parts: initialNeeded,
      offerings: activeProject.offerings,
      bundle_mappings: activeProject.bundle_mappings,
      vendor_profiles: activeProject.vendor_profiles || [],
      default_tax_bps: activeProject.default_tax_bps || 0,
    });
  });
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  // Workflow Tabs state & refs (WAI-ARIA tablist with roving tabindex & keyboard navigation)
  const [activeTab, setActiveTab] = useState<'bom' | 'matrix' | 'plan'>('bom');
  const tabBomRef = useRef<HTMLButtonElement | null>(null);
  const tabMatrixRef = useRef<HTMLButtonElement | null>(null);
  const tabPlanRef = useRef<HTMLButtonElement | null>(null);
  const newPartNameInputRef = useRef<HTMLInputElement | null>(null);
  const [isVendorSectionOpen, setIsVendorSectionOpen] = useState(true);

  function switchTab(nextTab: 'bom' | 'matrix' | 'plan', focusTabButton = false) {
    setActiveTab(nextTab);
    if (focusTabButton) {
      const refs: Record<'bom' | 'matrix' | 'plan', React.RefObject<HTMLButtonElement | null>> = {
        bom: tabBomRef,
        matrix: tabMatrixRef,
        plan: tabPlanRef,
      };
      refs[nextTab].current?.focus();
    }
  }

  // Auth modal state
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authDisplayName, setAuthDisplayName] = useState('');
  const [authError, setAuthError] = useState('');

  // Quick-add Part state
  const [newPartName, setNewPartName] = useState('');
  const [newPartSku, setNewPartSku] = useState('');
  const [newPartCat, setNewPartCat] = useState('');
  const [newPartQty, setNewPartQty] = useState('');

  // Quick-add Offering state
  const [newOffUrl, setNewOffUrl] = useState('');
  const [newOffVendor, setNewOffVendor] = useState('');
  const [newOffTitle, setNewOffTitle] = useState('');
  const [newOffSku, setNewOffSku] = useState('');
  const [newOffPrice, setNewOffPrice] = useState('');
  const [newOffShip, setNewOffShip] = useState('');
  const [newOffDiscount, setNewOffDiscount] = useState('');
  const [newOffSelectedParts, setNewOffSelectedParts] = useState<Record<string, number>>({});

  // Setup native <dialog> fallback for browsers without closedBy support (per modern-web-guidance: light-dismiss-a-dialog)
  useEffect(() => {
    const dialogs = [
      authDialogRef.current,
      vendorDialogRef.current,
      shareDialogRef.current,
      purchaseDialogRef.current,
    ].filter(Boolean) as HTMLDialogElement[];

    const cleanups: Array<() => void> = [];
    for (const dialog of dialogs) {
      if (!('closedBy' in HTMLDialogElement.prototype)) {
        const handler = (event: MouseEvent) => {
          if (event.target !== dialog) return;
          const rect = dialog.getBoundingClientRect();
          const isDialogContent =
            rect.top <= event.clientY &&
            event.clientY <= rect.top + rect.height &&
            rect.left <= event.clientX &&
            event.clientX <= rect.left + rect.width;
          if (isDialogContent) return;
          dialog.close();
        };
        dialog.addEventListener('click', handler);
        cleanups.push(() => dialog.removeEventListener('click', handler));
      }
    }
    return () => cleanups.forEach((fn) => fn());
  }, []);

  // Initialize Web Worker for bundle solver
  useEffect(() => {
    try {
      const worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        if (e.data && e.data.requestId === reqIdRef.current) {
          setSolverResult(e.data.result);
        }
      };
      workerRef.current = worker;
      return () => worker.terminate();
    } catch {
      // Fallback if Worker isn't supported in environment
      return undefined;
    }
  }, []);

  // Trigger solver whenever project data changes (optimizing for needed unfulfilled parts)
  useEffect(() => {
    const input: SolverInput = {
      parts: neededParts,
      offerings: activeProject.offerings,
      bundle_mappings: activeProject.bundle_mappings,
      vendor_profiles: activeProject.vendor_profiles || [],
      default_tax_bps: activeProject.default_tax_bps || 0,
    };

    reqIdRef.current += 1;
    if (workerRef.current) {
      workerRef.current.postMessage({ requestId: reqIdRef.current, input });
    } else {
      setSolverResult(solveBundleOptimization(input));
    }
  }, [
    neededParts,
    activeProject.offerings,
    activeProject.bundle_mappings,
    activeProject.vendor_profiles,
    activeProject.default_tax_bps,
  ]);

  // Check URL for ?share=<token> or check logged-in session on startup
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shareToken = params.get('share');

    if (shareToken) {
      fetch(`/api/shares/${encodeURIComponent(shareToken)}`)
        .then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok || !data.project) {
            throw new Error(data.error || 'Shared project link is invalid or expired.');
          }
          setActiveProject(data.project);
          setIsReadOnlyShare(true);
          setStatusBanner({
            type: 'info',
            text: 'Viewing read-only shared project link. Click "Clone to Workspace" to edit your own copy.',
          });
        })
        .catch((err: unknown) => {
          setStatusBanner({
            type: 'error',
            text: err instanceof Error ? err.message : 'Shared project link is invalid or expired.',
          });
        });
    }

    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then(async (data) => {
        if (data.user) {
          setUser(data.user);
          await refreshCloudProjectsAndSelect(shareToken ? false : true);
        }
      })
      .catch(() => {});
  }, []);

  // Auto-dismiss status notification banner after 10 seconds with ticking countdown
  useEffect(() => {
    if (!statusBanner) return undefined;

    setBannerCountdown(10);
    const timer = setInterval(() => {
      setBannerCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setStatusBanner(null);
          setConflictServerVersion(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [statusBanner]);

  async function refreshCloudProjectsAndSelect(selectFirst = false, preferredId?: string | null) {
    try {
      const listRes = await apiFetch<{
        projects: Array<{
          id: string;
          name: string;
          category: string;
          parts_count: number;
          offerings_count: number;
          version: number;
        }>;
      }>('/api/projects');
      setCloudProjects(listRes.projects);

      const targetId = preferredId || (selectFirst && listRes.projects[0]?.id);
      if (targetId) {
        const fullRes = await apiFetch<{ project: ProjectPayload & { share_token?: string | null } }>(
          `/api/projects/${targetId}`
        );
        setActiveProject(fullRes.project);
        setIsReadOnlyShare(false);
        setConflictServerVersion(null);
      }
    } catch {
      // ignore
    }
  }

  // Persist to localStorage in guest mode or auto-sync to cloud when logged in
  function updateProject(mutator: (prev: ProjectPayload) => ProjectPayload,allowResetReadOnly = false) {
    if (isReadOnlyShare && !allowResetReadOnly) return;

    setActiveProject((prev) => {
      const next = mutator(prev);
      if (!user) {
        const updatedGuest: StoredGuestState = {
          client_project_uuid: guestState.client_project_uuid,
          is_dirty: true,
          project: {
            ...next,
            parts: next.parts.slice(0, GUEST_MAX_PARTS),
          },
        };
        setGuestState(updatedGuest);
        try {
          localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(updatedGuest));
        } catch {
          // ignore storage quota errors
        }
        return updatedGuest.project;
      }
      return next;
    });
  }

  function handleCloneSharedProject() {
    const cloned: ProjectPayload = {
      ...structuredClone(activeProject),
      id: undefined,
      client_project_uuid: makeClientId('uuid'),
      name: `${activeProject.name} (Copy)`,
      version: 1,
    };
    setIsReadOnlyShare(false);
    setConflictServerVersion(null);
    if (window.location.search.includes('share=')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    updateProject(() => cloned, true);
    setStatusBanner({
      type: 'success',
      text: user
        ? 'Cloned shared project to your workspace. Click "Save Cloud" to persist.'
        : `Cloned shared project to your local Guest workspace (max ${GUEST_MAX_PARTS} parts).`,
    });
  }

  function normalizeProjectForSave(proj: ProjectPayload): ProjectPayload {
    return {
      ...proj,
      name: proj.name.trim() || 'Untitled Parts Project',
      parts: proj.parts.map((p, idx) => ({
        ...p,
        name: p.name.trim() || `Part ${idx + 1}`,
      })),
    };
  }

  async function saveCloudProjectNow(projectToSave = activeProject) {
    if (!user || isReadOnlyShare) return;
    const sanitized = normalizeProjectForSave(projectToSave);
    setIsSaving(true);
    setConflictServerVersion(null);
    try {
      if (sanitized.id && cloudProjects.some((cp) => cp.id === sanitized.id)) {
        const res = await apiFetch<{ project: ProjectPayload & { share_token?: string | null } }>(
          `/api/projects/${sanitized.id}`,
          {
            method: 'PUT',
            body: JSON.stringify(sanitized),
          }
        );
        setActiveProject(res.project);
        await refreshCloudProjectsAndSelect(false);
        setStatusBanner({ type: 'success', text: `Saved v${res.project.version} to cloud.` });
      } else {
        const res = await apiFetch<{ project: ProjectPayload & { share_token?: string | null } }>('/api/projects', {
          method: 'POST',
          body: JSON.stringify({
            ...sanitized,
            client_project_uuid: sanitized.client_project_uuid || makeClientId('uuid'),
          }),
        });
        setActiveProject(res.project);
        await refreshCloudProjectsAndSelect(false);
        setStatusBanner({ type: 'success', text: 'Created cloud project.' });
      }
    } catch (err: unknown) {
      const apiErr = err as Error & { status?: number; current_version?: number };
      if (apiErr.status === 409) {
        setConflictServerVersion(apiErr.current_version ?? (sanitized.version || 1) + 1);
      }
      setStatusBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save cloud project',
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeleteProject(projectIdToDelete?: string) {
    if (isReadOnlyShare) return;

    const targetId = projectIdToDelete || activeProject.id;
    const isCloud = user && targetId && cloudProjects.some((cp) => cp.id === targetId);
    const targetName = isCloud
      ? cloudProjects.find((p) => p.id === targetId)?.name || activeProject.name
      : activeProject.name;

    const confirmed = window.confirm(
      `Are you sure you want to delete "${targetName}"? This action cannot be undone.`
    );
    if (!confirmed) return;

    if (isCloud && targetId) {
      try {
        await apiFetch(`/api/projects/${targetId}`, { method: 'DELETE' });
        setStatusBanner({ type: 'success', text: `Project "${targetName}" has been deleted.` });

        const remaining = cloudProjects.filter((p) => p.id !== targetId);
        setCloudProjects(remaining);

        if (targetId === activeProject.id) {
          if (remaining.length > 0) {
            const nextRes = await apiFetch<{ project: ProjectPayload & { share_token?: string | null } }>(
              `/api/projects/${remaining[0].id}`
            );
            setActiveProject(nextRes.project);
            setIsReadOnlyShare(false);
          } else {
            const blank: ProjectPayload = {
              id: undefined,
              client_project_uuid: makeClientId('uuid'),
              name: 'Untitled Parts Project',
              category: 'Custom Project',
              currency: 'USD',
              default_tax_bps: 0,
              version: 1,
              parts: [],
              offerings: [],
              bundle_mappings: [],
              vendor_profiles: [],
            };
            updateProject(() => blank, true);
          }
        }
      } catch (err: unknown) {
        setStatusBanner({
          type: 'error',
          text: err instanceof Error ? err.message : 'Failed to delete cloud project.',
        });
      }
    } else {
      // Local / Guest project
      const blank: ProjectPayload = {
        id: undefined,
        client_project_uuid: makeClientId('uuid'),
        name: 'Untitled Parts Project',
        category: 'Custom Project',
        currency: 'USD',
        default_tax_bps: 0,
        version: 1,
        parts: [],
        offerings: [],
        bundle_mappings: [],
        vendor_profiles: [],
      };
      updateProject(() => blank, true);
      try {
        localStorage.removeItem(GUEST_STORAGE_KEY);
      } catch {}
      setStatusBanner({ type: 'info', text: 'Project cleared.' });
    }
  }

  // Dark / Light mode toggle following modern-web-guidance: dark-mode-toggle
  function handleToggleColorScheme() {
    const meta = document.querySelector('meta[name="color-scheme"]') as HTMLMetaElement | null;
    if (!meta) return;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem('color-scheme');
    } catch {}
    const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const sysScheme = sysDark ? 'dark' : 'light';
    const currentRendered = stored === 'dark' || stored === 'light' ? stored : sysScheme;
    const target = currentRendered === 'dark' ? 'light' : 'dark';

    if (target !== sysScheme) {
      try {
        localStorage.setItem('color-scheme', target);
      } catch {}
      meta.content = target;
    } else {
      try {
        localStorage.removeItem('color-scheme');
      } catch {}
      meta.content = 'light dark';
    }
  }

  // URL Paste auto-detect vendor hostname (Zero network calls)
  function handleOfferingUrlChange(val: string) {
    setNewOffUrl(val);
    if (!newOffVendor.trim()) {
      const detected = extractVendorFromUrl(val);
      if (detected) {
        setNewOffVendor(detected);
      }
    }
  }

  // Add Part to BOM
  function handleAddPart(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newPartName.trim();
    if (!trimmed) return;

    if (!user && activeProject.parts.length >= GUEST_MAX_PARTS) {
      setStatusBanner({
        type: 'error',
        text: `Guest projects support up to ${GUEST_MAX_PARTS} parts. Sign in for up to 200 parts & unlimited projects.`,
      });
      authDialogRef.current?.showModal();
      return;
    }

    const qty = Math.max(1, Math.min(10000, parseInt(newPartQty, 10) || 1));
    const newPart: Part = {
      id: makeClientId('part'),
      name: trimmed,
      part_number: newPartSku.trim(),
      category_tag: newPartCat.trim() || 'Part',
      required_qty: qty,
      sort_order: activeProject.parts.length,
    };

    updateProject((prev) => ({
      ...prev,
      parts: [...prev.parts, newPart],
    }));

    setNewPartName('');
    setNewPartSku('');
    setNewPartCat('');
    setNewPartQty('');
    newPartNameInputRef.current?.focus();
  }

  function handleRemovePart(partId: string) {
    updateProject((prev) => ({
      ...prev,
      parts: prev.parts.filter((p) => p.id !== partId),
      bundle_mappings: prev.bundle_mappings.filter((bm) => bm.part_id !== partId),
    }));
  }

  function handleUpdatePartQty(partId: string, qty: number) {
    const clamped = Math.max(1, Math.min(10000, qty || 1));
    updateProject((prev) => ({
      ...prev,
      parts: prev.parts.map((p) => (p.id === partId ? { ...p, required_qty: clamped } : p)),
    }));
  }

  function handleUpdatePart(partId: string, patch: Partial<Part>) {
    updateProject((prev) => ({
      ...prev,
      parts: prev.parts.map((p) => (p.id === partId ? { ...p, ...patch } : p)),
    }));
  }

  function handleUpdateOffering(offeringId: string, patch: Partial<Offering>) {
    updateProject((prev) => ({
      ...prev,
      offerings: prev.offerings.map((o) => (o.id === offeringId ? { ...o, ...patch } : o)),
    }));
  }

  function handleOpenOrderPurchase(offering: Offering, qty: number, defaultTotalCents: number, vendorName: string) {
    setEditingPurchaseId(null);
    setPurchaseTarget({ type: 'offering', offering, qty, vendorName });
    setPurchasePaidAmount((defaultTotalCents / 100).toFixed(2));
    setPurchaseOrderNumber('');
    setPurchaseNotes('');
    purchaseDialogRef.current?.showModal();
  }

  function handleOpenPartPurchase(part: Part) {
    const fulfilled = fulfilledPartMap.get(part.id) || 0;
    const remaining = Math.max(1, part.required_qty - fulfilled);
    setEditingPurchaseId(null);
    setPurchaseTarget({ type: 'part', part, qty: remaining });
    setPurchasePaidAmount('0.00');
    setPurchaseOrderNumber('');
    setPurchaseNotes('Procured offline / already owned');
    purchaseDialogRef.current?.showModal();
  }

  function handleOpenEditPurchase(purchase: PurchaseRecord) {
    setEditingPurchaseId(purchase.id);
    if (purchase.offering_id) {
      const off = activeProject.offerings.find((o) => o.id === purchase.offering_id);
      if (off) {
        setPurchaseTarget({
          type: 'offering',
          offering: off,
          qty: purchase.offering_qty || 1,
          vendorName: off.vendor_name,
        });
      } else {
        setPurchaseTarget(null);
      }
    } else if (purchase.part_id) {
      const part = activeProject.parts.find((p) => p.id === purchase.part_id);
      if (part) {
        setPurchaseTarget({
          type: 'part',
          part,
          qty: purchase.part_qty || 1,
        });
      } else {
        setPurchaseTarget(null);
      }
    }
    setPurchasePaidAmount((purchase.actual_paid_cents / 100).toFixed(2));
    setPurchaseOrderNumber(purchase.order_number || '');
    setPurchaseNotes(purchase.notes || '');
    purchaseDialogRef.current?.showModal();
  }

  function handleSavePurchase(e: React.FormEvent) {
    e.preventDefault();
    const paidCents = Math.max(0, Math.round((parseFloat(purchasePaidAmount) || 0) * 100));

    if (editingPurchaseId) {
      updateProject((prev) => ({
        ...prev,
        purchases: (prev.purchases || []).map((p) =>
          p.id === editingPurchaseId
            ? {
                ...p,
                actual_paid_cents: paidCents,
                order_number: purchaseOrderNumber.trim(),
                notes: purchaseNotes.trim(),
              }
            : p
        ),
      }));
      setStatusBanner({ type: 'success', text: 'Purchase record updated.' });
    } else if (purchaseTarget) {
      const newRecord: PurchaseRecord = {
        id: makeClientId('purchase'),
        purchased_at: Date.now(),
        actual_paid_cents: paidCents,
        order_number: purchaseOrderNumber.trim(),
        notes: purchaseNotes.trim(),
        offering_id: purchaseTarget.type === 'offering' ? purchaseTarget.offering.id : null,
        offering_qty: purchaseTarget.type === 'offering' ? purchaseTarget.qty : null,
        part_id: purchaseTarget.type === 'part' ? purchaseTarget.part.id : null,
        part_qty: purchaseTarget.type === 'part' ? purchaseTarget.qty : null,
      };

      updateProject((prev) => ({
        ...prev,
        purchases: [...(prev.purchases || []), newRecord],
      }));
      setStatusBanner({ type: 'success', text: 'Marked as purchased! Remaining plan re-optimized.' });
    }

    purchaseDialogRef.current?.close();
  }

  function handleUndoPurchase(purchaseId: string) {
    updateProject((prev) => ({
      ...prev,
      purchases: (prev.purchases || []).filter((p) => p.id !== purchaseId),
    }));
    setStatusBanner({ type: 'info', text: 'Purchase removed. Item returned to solver demand.' });
  }

  function handleTabListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const order: Array<'bom' | 'matrix' | 'plan'> = ['bom', 'matrix', 'plan'];
    const currentIdx = order.indexOf(activeTab);
    let nextTab: 'bom' | 'matrix' | 'plan' | null = null;

    if (e.key === 'ArrowRight') {
      nextTab = order[(currentIdx + 1) % order.length];
    } else if (e.key === 'ArrowLeft') {
      nextTab = order[(currentIdx - 1 + order.length) % order.length];
    } else if (e.key === 'Home') {
      nextTab = order[0];
    } else if (e.key === 'End') {
      nextTab = order[order.length - 1];
    }

    if (nextTab) {
      e.preventDefault();
      switchTab(nextTab, true);
    }
  }

  // Add Offering / Bundle
  function handleAddOffering(e: React.FormEvent) {
    e.preventDefault();
    const vendor = newOffVendor.trim() || extractVendorFromUrl(newOffUrl) || 'Generic Vendor';
    const title = newOffTitle.trim();
    if (!title) return;

    if (newOffUrl.trim() && !isValidHttpUrl(newOffUrl.trim())) {
      setStatusBanner({
        type: 'error',
        text: 'Reference URL must be a valid http:// or https:// address.',
      });
      return;
    }

    const priceCents = Math.max(0, Math.round((parseFloat(newOffPrice) || 0) * 100));
    const shipCents = Math.max(0, Math.round((parseFloat(newOffShip) || 0) * 100));
    const discCents = Math.max(0, Math.round((parseFloat(newOffDiscount) || 0) * 100));

    const offId = makeClientId('off');
    const newOffering: Offering = {
      id: offId,
      vendor_name: vendor,
      title,
      part_number: newOffSku.trim(),
      reference_url: newOffUrl.trim(),
      price_cents: priceCents,
      shipping_cents: shipCents,
      discount_cents: discCents,
      max_purchasable_qty: null,
      in_stock: true,
      notes: '',
    };

    const newMappings: BundleMapping[] = Object.entries(newOffSelectedParts)
      .filter(([, y]) => y > 0)
      .map(([partId, yieldQty]) => ({
        offering_id: offId,
        part_id: partId,
        yield_qty: yieldQty,
      }));

    updateProject((prev) => ({
      ...prev,
      offerings: [...prev.offerings, newOffering],
      bundle_mappings: [...prev.bundle_mappings, ...newMappings],
    }));

    setNewOffTitle('');
    setNewOffSku('');
    setNewOffUrl('');
    setNewOffPrice('');
    setNewOffShip('');
    setNewOffDiscount('');
    setNewOffSelectedParts({});
  }

  function handleRemoveOffering(offeringId: string) {
    updateProject((prev) => ({
      ...prev,
      offerings: prev.offerings.filter((o) => o.id !== offeringId),
      bundle_mappings: prev.bundle_mappings.filter((bm) => bm.offering_id !== offeringId),
    }));
  }

  // Interactive Matrix cell toggle & yield adjustment
  function handleToggleMatrixCell(offeringId: string, partId: string) {
    updateProject((prev) => {
      const existing = prev.bundle_mappings.find(
        (bm) => bm.offering_id === offeringId && bm.part_id === partId
      );
      if (existing) {
        return {
          ...prev,
          bundle_mappings: prev.bundle_mappings.filter(
            (bm) => !(bm.offering_id === offeringId && bm.part_id === partId)
          ),
        };
      } else {
        return {
          ...prev,
          bundle_mappings: [
            ...prev.bundle_mappings,
            { offering_id: offeringId, part_id: partId, yield_qty: 1 },
          ],
        };
      }
    });
  }

  function handleChangeMatrixYield(offeringId: string, partId: string, newYield: number) {
    const clamped = Math.max(0, Math.min(10000, newYield));
    updateProject((prev) => {
      if (clamped === 0) {
        return {
          ...prev,
          bundle_mappings: prev.bundle_mappings.filter(
            (bm) => !(bm.offering_id === offeringId && bm.part_id === partId)
          ),
        };
      }
      const exists = prev.bundle_mappings.some(
        (bm) => bm.offering_id === offeringId && bm.part_id === partId
      );
      if (exists) {
        return {
          ...prev,
          bundle_mappings: prev.bundle_mappings.map((bm) =>
            bm.offering_id === offeringId && bm.part_id === partId
              ? { ...bm, yield_qty: clamped }
              : bm
          ),
        };
      }
      return {
        ...prev,
        bundle_mappings: [
          ...prev.bundle_mappings,
          { offering_id: offeringId, part_id: partId, yield_qty: clamped },
        ],
      };
    });
  }

  // Auth & Idempotent Guest Migration
  function buildGuestMigrationPayload(): GuestMigrationPayload | undefined {
    if (guestState.is_dirty && guestState.project.parts.length > 0) {
      const sanitized = normalizeProjectForSave(guestState.project);
      return {
        client_project_uuid: guestState.client_project_uuid,
        is_dirty: true,
        project: {
          ...sanitized,
          parts: sanitized.parts.slice(0, GUEST_MAX_PARTS),
        },
      };
    }
    return undefined;
  }

  async function handleAuthSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAuthError('');
    try {
      const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const guestMigration = buildGuestMigrationPayload();
      const res = await apiFetch<{ user: UserPublic; migrated_project_id: string | null }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          email: authEmail,
          password: authPassword,
          display_name: authDisplayName || undefined,
          guest_migration: guestMigration,
        }),
      });

      setUser(res.user);
      if (guestMigration) {
        try {
          localStorage.removeItem(GUEST_STORAGE_KEY);
        } catch {}
        setGuestState((prev) => ({ ...prev, is_dirty: false }));
      }

      authDialogRef.current?.close();
      await refreshCloudProjectsAndSelect(true, res.migrated_project_id);
      setStatusBanner({
        type: 'success',
        text: res.migrated_project_id
          ? `Signed in as ${res.user.display_name} & migrated your guest project to the cloud!`
          : `Signed in as ${res.user.display_name}.`,
      });
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : 'Authentication failed');
    }
  }

  async function handleOAuthSignIn(provider: 'google' | 'microsoft' | 'reddit' | 'meta') {
    setAuthError('');
    try {
      const emailToUse = authEmail.trim() || `user.${provider}@priceit.rbnd.cc`;
      const guestMigration = buildGuestMigrationPayload();
      const res = await apiFetch<{ user: UserPublic; migrated_project_id: string | null }>(
        '/api/auth/oauth/callback',
        {
          method: 'POST',
          body: JSON.stringify({
            provider,
            provider_account_id: `oauth-${provider}-${emailToUse}`,
            email: emailToUse,
            display_name: authDisplayName.trim() || `${provider.toUpperCase()} Craftsperson`,
            guest_migration: guestMigration,
          }),
        }
      );

      setUser(res.user);
      if (guestMigration) {
        try {
          localStorage.removeItem(GUEST_STORAGE_KEY);
        } catch {}
        setGuestState((prev) => ({ ...prev, is_dirty: false }));
      }

      authDialogRef.current?.close();
      await refreshCloudProjectsAndSelect(true, res.migrated_project_id);
      setStatusBanner({
        type: 'success',
        text: `Signed in via ${provider.toUpperCase()} as ${res.user.display_name}.`,
      });
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : 'OAuth login failed');
    }
  }

  async function handleLogout() {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    setCloudProjects([]);
    const freshGuest = loadInitialGuestState();
    setGuestState(freshGuest);
    setActiveProject(freshGuest.project);
    setStatusBanner({ type: 'info', text: 'Signed out. Switched to local Guest workspace.' });
  }

  // Export CSV / Excel & Print PDF (Registered tier feature)
  function handleExportCsv() {
    if (!user) {
      setStatusBanner({
        type: 'info',
        text: 'Create a free account to unlock CSV/Excel exports and shareable BOM links.',
      });
      authDialogRef.current?.showModal();
      return;
    }

    const csv = generateProjectCsv(activeProject, solverResult);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeProject.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-bom.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handlePrintDatasheet() {
    if (!user) {
      setStatusBanner({
        type: 'info',
        text: 'Sign in to print or export official PDF BOM datasheets.',
      });
      authDialogRef.current?.showModal();
      return;
    }
    window.print();
  }

  async function handleOpenShareDialog() {
    if (!user) {
      setStatusBanner({
        type: 'info',
        text: 'Sign in to generate read-only cryptographic share links.',
      });
      authDialogRef.current?.showModal();
      return;
    }

    if (!activeProject.id || !cloudProjects.some((cp) => cp.id === activeProject.id)) {
      await saveCloudProjectNow();
    }
    shareDialogRef.current?.showModal();
  }

  async function handleGenerateShareToken() {
    if (!activeProject.id) return;
    try {
      const res = await apiFetch<{ share_token: string }>(`/api/projects/${activeProject.id}/share`, {
        method: 'POST',
      });
      setActiveProject((prev) => ({ ...prev, share_token: res.share_token }));
    } catch (err: unknown) {
      setStatusBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to generate share link',
      });
    }
  }

  async function handleRevokeShareToken() {
    if (!activeProject.id) return;
    try {
      await apiFetch(`/api/projects/${activeProject.id}/share`, { method: 'DELETE' });
      setActiveProject((prev) => ({ ...prev, share_token: null }));
    } catch {}
  }

  // Distinct vendors across offerings + vendor profiles
  const distinctVendors = useMemo(() => {
    const map = new Map<string, VendorProfile>();
    for (const vp of activeProject.vendor_profiles || []) {
      map.set(vp.vendor_name.trim().toLowerCase(), vp);
    }
    for (const off of activeProject.offerings) {
      const key = off.vendor_name.trim().toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          vendor_name: off.vendor_name.trim(),
          flat_shipping_cents: 0,
          free_shipping_threshold_cents: null,
          tax_rate_bps: activeProject.default_tax_bps || 0,
        });
      }
    }
    return Array.from(map.values());
  }, [activeProject.offerings, activeProject.vendor_profiles, activeProject.default_tax_bps]);

  function handleUpdateVendorProfile(vendorName: string, patch: Partial<VendorProfile>) {
    updateProject((prev) => {
      const existing = (prev.vendor_profiles || []).find(
        (vp) => vp.vendor_name.toLowerCase() === vendorName.toLowerCase()
      );
      let nextProfiles: VendorProfile[];
      if (existing) {
        nextProfiles = (prev.vendor_profiles || []).map((vp) =>
          vp.vendor_name.toLowerCase() === vendorName.toLowerCase() ? { ...vp, ...patch } : vp
        );
      } else {
        nextProfiles = [
          ...(prev.vendor_profiles || []),
          {
            vendor_name: vendorName,
            flat_shipping_cents: 0,
            free_shipping_threshold_cents: null,
            tax_rate_bps: prev.default_tax_bps || 0,
            ...patch,
          },
        ];
      }
      return { ...prev, vendor_profiles: nextProfiles };
    });
  }

  // Set of winning offering IDs for highlighting in the matrix
  const winningOfferingQtyMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const order of solverResult.vendor_orders) {
      for (const item of order.items) {
        map.set(item.offering.id, item.qty);
      }
    }
    return map;
  }, [solverResult]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top Industrial Utility Bar */}
      <header
        className="no-print border-b px-4 py-2.5 flex flex-wrap items-center justify-between gap-3"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="font-bold tracking-tight text-sm uppercase">PriceIt</span>
          </div>

          <div className="h-4 w-[1px]" style={{ backgroundColor: 'var(--border-subtle)' }} />

          {/* Preset / Cloud Project Switcher */}
          <div className="flex items-center gap-1.5">
            {user && cloudProjects.length > 0 && (
              <div className="flex items-center gap-1">
                <select
                  aria-label="Select Cloud Project"
                  value={activeProject.id || ''}
                  onChange={async (e) => {
                    const id = e.target.value;
                    if (!id) return;
                    const res = await apiFetch<{ project: ProjectPayload & { share_token?: string | null } }>(
                      `/api/projects/${id}`
                    );
                    setActiveProject(res.project);
                    setIsReadOnlyShare(false);
                  }}
                  className="px-2 py-1 text-xs border font-medium"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    borderColor: 'var(--border-subtle)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {cloudProjects.map((cp) => (
                    <option key={cp.id} value={cp.id}>
                      {cp.name} ({cp.parts_count}P / {cp.offerings_count}O)
                    </option>
                  ))}
                </select>
                {activeProject.id && cloudProjects.some((cp) => cp.id === activeProject.id) && (
                  <button
                    type="button"
                    onClick={() => handleDeleteProject(activeProject.id)}
                    className="p-1 text-xs border cursor-pointer hover:text-red-500 transition-colors"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      borderColor: 'var(--border-subtle)',
                    }}
                    title="Delete selected cloud project"
                    aria-label="Delete selected cloud project"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                setIsReadOnlyShare(false);
                setConflictServerVersion(null);
                const copy: ProjectPayload = {
                  ...structuredClone(DEMO_BRAKE_PROJECT),
                  id: undefined,
                  client_project_uuid: makeClientId('uuid'),
                  version: 1,
                };
                updateProject(() => copy, true);
              }}
              className="px-2 py-1 text-xs border cursor-pointer"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                borderColor: 'var(--border-subtle)',
              }}
              title="Load Automotive Parts & Tune-Up Demo"
            >
              Demo: Auto Parts
            </button>

            <button
              type="button"
              onClick={() => {
                setIsReadOnlyShare(false);
                setConflictServerVersion(null);
                const copy: ProjectPayload = {
                  ...structuredClone(DEMO_PC_PROJECT),
                  id: undefined,
                  client_project_uuid: makeClientId('uuid'),
                  version: 1,
                };
                updateProject(() => copy, true);
              }}
              className="px-2 py-1 text-xs border cursor-pointer"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                borderColor: 'var(--border-subtle)',
              }}
              title="Load AM5 SFF PC Build Demo"
            >
              Demo: PC Build
            </button>

            <button
              type="button"
              onClick={() => {
                setIsReadOnlyShare(false);
                setConflictServerVersion(null);
                const blank: ProjectPayload = {
                  id: undefined,
                  client_project_uuid: makeClientId('uuid'),
                  name: 'Untitled Parts Project',
                  category: 'Custom Project',
                  currency: 'USD',
                  default_tax_bps: 700,
                  version: 1,
                  parts: [],
                  offerings: [],
                  bundle_mappings: [],
                  vendor_profiles: [],
                };
                updateProject(() => blank, true);
              }}
              className="px-2 py-1 text-xs border flex items-center gap-1 cursor-pointer"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <FolderPlus className="w-3.5 h-3.5" /> New Blank
            </button>
          </div>
        </div>

        {/* Right Controls: Guest Quota / Cloud Sync / Export / Auth / Theme */}
        <div className="flex items-center gap-2">
          {isReadOnlyShare && (
            <button
              type="button"
              onClick={handleCloneSharedProject}
              className="h-[26px] px-2.5 text-xs font-semibold border inline-flex items-center gap-1 cursor-pointer box-border"
              style={{
                height: '26px',
                boxSizing: 'border-box',
                backgroundColor: 'var(--accent-amber-bg)',
                borderColor: 'var(--accent-amber)',
                color: 'var(--accent-amber)',
              }}
            >
              <Copy className="w-3.5 h-3.5" /> Clone to Workspace
            </button>
          )}

          {!user ? (
            <div
              className="h-[26px] text-xs font-mono-tabular px-2 border inline-flex items-center gap-1.5 box-border"
              style={{
                height: '26px',
                boxSizing: 'border-box',
                backgroundColor: 'var(--bg-elevated)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-secondary)',
              }}
            >
              <span>GUEST MODE:</span>
              <strong style={{ color: 'var(--text-primary)' }}>
                {activeProject.parts.length}/{GUEST_MAX_PARTS} Parts
              </strong>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => saveCloudProjectNow()}
              disabled={isSaving || isReadOnlyShare}
              className="h-[26px] px-2.5 text-xs font-medium border inline-flex items-center cursor-pointer box-border"
              style={{
                height: '26px',
                boxSizing: 'border-box',
                backgroundColor: 'var(--accent-emerald-bg)',
                borderColor: 'var(--accent-emerald)',
                color: 'var(--accent-emerald)',
              }}
            >
              {isSaving ? 'Syncing...' : `Save Cloud (v${activeProject.version || 1})`}
            </button>
          )}

          <button
            type="button"
            onClick={() => vendorDialogRef.current?.showModal()}
            className="h-[26px] px-2 text-xs border inline-flex items-center gap-1 cursor-pointer box-border"
            style={{
              height: '26px',
              boxSizing: 'border-box',
              backgroundColor: 'var(--bg-elevated)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <Truck className="w-3.5 h-3.5" /> Vendor Shipping/Tax ({distinctVendors.length})
          </button>

          <button
            type="button"
            onClick={handleExportCsv}
            className="h-[26px] px-2 text-xs border inline-flex items-center gap-1 cursor-pointer box-border"
            style={{
              height: '26px',
              boxSizing: 'border-box',
              backgroundColor: 'var(--bg-elevated)',
              borderColor: 'var(--border-subtle)',
            }}
            title="Export Sanitized CSV / Excel BOM"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" /> Export CSV
          </button>

          <button
            type="button"
            onClick={handlePrintDatasheet}
            className="h-[26px] px-2 text-xs border inline-flex items-center gap-1 cursor-pointer box-border"
            style={{
              height: '26px',
              boxSizing: 'border-box',
              backgroundColor: 'var(--bg-elevated)',
              borderColor: 'var(--border-subtle)',
            }}
            title="Print PDF Datasheet"
          >
            <Printer className="w-3.5 h-3.5" /> Print PDF
          </button>

          <button
            type="button"
            onClick={handleOpenShareDialog}
            className="h-[26px] px-2 text-xs border inline-flex items-center gap-1 cursor-pointer box-border"
            style={{
              height: '26px',
              boxSizing: 'border-box',
              backgroundColor: 'var(--bg-elevated)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <Share2 className="w-3.5 h-3.5" /> Share
          </button>

          <button
            type="button"
            onClick={handleToggleColorScheme}
            className="h-[26px] w-[28px] p-0 border inline-flex items-center justify-center cursor-pointer box-border"
            style={{
              height: '26px',
              width: '28px',
              boxSizing: 'border-box',
              backgroundColor: 'var(--bg-elevated)',
              borderColor: 'var(--border-subtle)',
            }}
            aria-label="Toggle light or dark color scheme"
            title="Toggle Light / Dark Theme"
          >
            <Sun className="w-3.5 h-3.5 inline dark:hidden" />
            <Moon className="w-3.5 h-3.5 hidden dark:inline" />
          </button>

          {!user ? (
            <button
              type="button"
              onClick={() => {
                setAuthError('');
                authDialogRef.current?.showModal();
              }}
              className="h-[26px] px-2.5 text-xs font-semibold border inline-flex items-center gap-1 cursor-pointer box-border"
              style={{
                height: '26px',
                boxSizing: 'border-box',
                backgroundColor: 'var(--accent-amber-bg)',
                borderColor: 'var(--accent-amber)',
                color: 'var(--accent-amber)',
              }}
            >
              <LogIn className="w-3.5 h-3.5" /> Sign In / Sync
            </button>
          ) : (
            <div className="inline-flex items-center gap-1.5 h-[26px] box-border">
              <span className="text-xs font-mono-tabular leading-[26px] inline-flex items-center" style={{ color: 'var(--text-secondary)' }}>
                {user.display_name}
              </span>
              <button
                type="button"
                onClick={handleLogout}
                className="h-[26px] w-[28px] p-0 border inline-flex items-center justify-center cursor-pointer box-border"
                style={{
                  height: '26px',
                  width: '28px',
                  boxSizing: 'border-box',
                  backgroundColor: 'var(--bg-elevated)',
                  borderColor: 'var(--border-subtle)',
                }}
                title="Sign Out"
                aria-label="Sign Out"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Status Notification Strip */}
      {statusBanner && (
        <div
          className="no-print px-4 py-1.5 text-xs border-b flex flex-wrap items-center justify-between gap-2"
          style={{
            backgroundColor:
              statusBanner.type === 'error'
                ? 'var(--accent-danger-bg)'
                : statusBanner.type === 'success'
                  ? 'var(--accent-emerald-bg)'
                  : 'var(--accent-amber-bg)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          <span>{statusBanner.text}</span>
          <div className="flex items-center gap-2">
            {isReadOnlyShare && (
              <button
                type="button"
                onClick={handleCloneSharedProject}
                className="px-2 py-0.5 border font-semibold cursor-pointer"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderColor: 'var(--border-strong)',
                }}
              >
                Clone to Workspace
              </button>
            )}
            {conflictServerVersion !== null && activeProject.id && (
              <>
                <button
                  type="button"
                  onClick={() => refreshCloudProjectsAndSelect(false, activeProject.id)}
                  className="px-2 py-0.5 border font-semibold cursor-pointer"
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    borderColor: 'var(--border-strong)',
                  }}
                >
                  Reload Server (v{conflictServerVersion})
                </button>
                <button
                  type="button"
                  onClick={() =>
                    saveCloudProjectNow({
                      ...activeProject,
                      version: conflictServerVersion,
                    })
                  }
                  className="px-2 py-0.5 border font-semibold cursor-pointer"
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    borderColor: 'var(--border-strong)',
                  }}
                >
                  Force Overwrite Cloud
                </button>
              </>
            )}
            <div className="flex items-center gap-1.5 ml-2">
              <button
                type="button"
                onClick={() => {
                  setStatusBanner(null);
                  setConflictServerVersion(null);
                }}
                className="underline text-xs cursor-pointer hover:opacity-80"
              >
                Dismiss
              </button>
              <span className="text-[11px] font-mono-tabular opacity-75 select-none">
                ({bannerCountdown}s)
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Project Metadata Header */}
      <section
        className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-4"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[280px]">
          <div className="flex flex-col flex-1 max-w-xl">
            <label
              htmlFor="project-title-input"
              className="text-[10px] font-mono-tabular uppercase tracking-wider"
              style={{ color: 'var(--text-muted)' }}
            >
              PROJECT BILL OF MATERIALS
            </label>
            <input
              id="project-title-input"
              type="text"
              value={activeProject.name}
              disabled={isReadOnlyShare}
              onChange={(e) => updateProject((prev) => ({ ...prev, name: e.target.value }))}
              onBlur={() => {
                if (!activeProject.name.trim()) {
                  updateProject((prev) => ({ ...prev, name: 'Untitled Parts Project' }));
                }
              }}
              className="font-semibold text-base bg-transparent border-b border-transparent focus:border-current focus:outline-none py-0.5"
            />
          </div>

          <div className="flex flex-col">
            <label
              htmlFor="project-cat-input"
              className="text-[10px] font-mono-tabular uppercase tracking-wider"
              style={{ color: 'var(--text-muted)' }}
            >
              CATEGORY
            </label>
            <input
              id="project-cat-input"
              type="text"
              value={activeProject.category || ''}
              disabled={isReadOnlyShare}
              onChange={(e) => updateProject((prev) => ({ ...prev, category: e.target.value }))}
              className="text-xs font-mono-tabular px-2 py-1 border w-36"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                borderColor: 'var(--border-subtle)',
              }}
            />
          </div>

          <div className="flex flex-col">
            <label
              htmlFor="project-tax-input"
              className="text-[10px] font-mono-tabular uppercase tracking-wider"
              style={{ color: 'var(--text-muted)' }}
            >
              DEFAULT SALES TAX %
            </label>
            <input
              id="project-tax-input"
              type="number"
              step="0.01"
              min="0"
              max="50"
              disabled={isReadOnlyShare}
              value={((activeProject.default_tax_bps || 0) / 100).toFixed(2)}
              onChange={(e) => {
                const bps = Math.max(0, Math.min(10000, Math.round((parseFloat(e.target.value) || 0) * 100)));
                updateProject((prev) => ({ ...prev, default_tax_bps: bps }));
              }}
              className="text-xs font-mono-tabular px-2 py-1 border w-24"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                borderColor: 'var(--border-subtle)',
              }}
            />
          </div>

          {!isReadOnlyShare && (
            <div className="flex flex-col justify-end">
              <span className="text-[10px] font-mono-tabular uppercase tracking-wider opacity-0 select-none">
                ACTION
              </span>
              <button
                type="button"
                onClick={() => handleDeleteProject()}
                className="px-2.5 py-1 text-xs border flex items-center gap-1.5 cursor-pointer transition-colors text-red-500 hover:text-red-600 hover:bg-red-500/10"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  borderColor: 'var(--border-subtle)',
                }}
                title={user && activeProject.id ? 'Delete this cloud project' : 'Clear this project'}
                aria-label={user && activeProject.id ? 'Delete this cloud project' : 'Clear this project'}
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{user && activeProject.id ? 'Delete Project' : 'Clear Project'}</span>
              </button>
            </div>
          )}
        </div>

        {/* High-Density Solver Telemetry Readout */}
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[10px] font-mono-tabular uppercase" style={{ color: 'var(--text-muted)' }}>
              SOLVER ENGINE ({solverResult.components_count} COMP / {solverResult.solve_time_ms}ms)
            </div>
            <div className="text-xs font-mono-tabular">
              {activeProject.parts.length > 0 && fulfilledPartsCount === activeProject.parts.length ? (
                <span style={{ color: 'var(--accent-emerald)' }}>
                  ● ALL {activeProject.parts.length} PARTS PROCURED
                </span>
              ) : solverResult.status === 'optimal' ? (
                <span style={{ color: 'var(--accent-emerald)' }}>
                  ● ALL {activeProject.parts.length} PARTS COVERED
                </span>
              ) : solverResult.status === 'partial' ? (
                <span style={{ color: 'var(--accent-amber)' }}>
                  ▲ {solverResult.uncovered_part_ids.length} PART(S) UNCOVERED
                </span>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>○ NO PARTS IN BOM</span>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => switchTab('plan')}
            className="px-3 py-1.5 border text-right cursor-pointer transition-colors"
            style={{
              backgroundColor: activeTab === 'plan' ? 'var(--accent-emerald-bg)' : 'var(--bg-elevated)',
              borderColor: activeTab === 'plan' ? 'var(--accent-emerald)' : 'var(--border-strong)',
            }}
            title="Jump to 3. Optimal Purchase Plan"
          >
            <div className="text-[10px] font-mono-tabular uppercase" style={{ color: 'var(--text-secondary)' }}>
              PROJECT OUT-OF-POCKET TOTAL ↗
            </div>
            <div className="text-lg font-bold font-mono-tabular">
              ${formatCentsToDollars(totalSpentCents + solverResult.grand_total_cents)}
              {totalSpentCents > 0 && (
                <span
                  className="ml-2 text-xs px-1.5 py-0.5 border"
                  style={{
                    backgroundColor: 'var(--accent-emerald-bg)',
                    borderColor: 'var(--accent-emerald)',
                    color: 'var(--accent-emerald)',
                  }}
                >
                  PAID ${formatCentsToDollars(totalSpentCents)}
                </span>
              )}
              {solverResult.savings_vs_baseline_cents > 0 && totalSpentCents === 0 && (
                <span
                  className="ml-2 text-xs px-1.5 py-0.5 border"
                  style={{
                    backgroundColor: 'var(--accent-emerald-bg)',
                    borderColor: 'var(--accent-emerald)',
                    color: 'var(--accent-emerald)',
                  }}
                >
                  SAVE ${formatCentsToDollars(solverResult.savings_vs_baseline_cents)}
                </span>
              )}
            </div>
          </button>
        </div>
      </section>

      {/* Accessible WAI-ARIA Workflow Tab Bar */}
      <div
        role="tablist"
        aria-label="Project Workflow Sections"
        onKeyDown={handleTabListKeyDown}
        className="no-print workshop-tablist"
      >
        <button
          ref={tabBomRef}
          id="tab-bom"
          type="button"
          role="tab"
          aria-selected={activeTab === 'bom'}
          aria-controls="panel-bom"
          tabIndex={activeTab === 'bom' ? 0 : -1}
          onClick={() => switchTab('bom')}
          className={`workshop-tab ${activeTab === 'bom' ? 'active' : ''}`}
        >
          <Package className="w-3.5 h-3.5" aria-hidden="true" />
          <span>1. Parts List (BOM)</span>
          <span
            className="text-[11px] font-mono-tabular px-1.5 py-0.5 border"
            style={
              activeProject.parts.length > 0 && fulfilledPartsCount === activeProject.parts.length
                ? {
                    backgroundColor: 'var(--accent-emerald-bg)',
                    borderColor: 'var(--accent-emerald)',
                    color: 'var(--accent-emerald)',
                  }
                : solverResult.uncovered_part_ids.length > 0 && activeProject.parts.length > 0
                ? {
                    backgroundColor: 'var(--accent-danger-bg)',
                    borderColor: 'var(--accent-danger)',
                    color: 'var(--accent-danger)',
                  }
                : {
                    backgroundColor: 'var(--bg-surface)',
                    borderColor: 'var(--border-subtle)',
                    color: 'var(--text-secondary)',
                  }
            }
          >
            {activeProject.parts.length > 0 && fulfilledPartsCount === activeProject.parts.length
              ? `${activeProject.parts.length} • All Procured`
              : activeProject.parts.length > 0 && solverResult.uncovered_part_ids.length > 0
              ? `${activeProject.parts.length} • ${solverResult.uncovered_part_ids.length} Missing`
              : `${activeProject.parts.length}`}
          </span>
        </button>

        <button
          ref={tabMatrixRef}
          id="tab-matrix"
          type="button"
          role="tab"
          aria-selected={activeTab === 'matrix'}
          aria-controls="panel-matrix"
          tabIndex={activeTab === 'matrix' ? 0 : -1}
          onClick={() => switchTab('matrix')}
          className={`workshop-tab ${activeTab === 'matrix' ? 'active' : ''}`}
        >
          <Layers className="w-3.5 h-3.5" aria-hidden="true" />
          <span>2. Vendor Listings &amp; Prices</span>
          <span
            className="text-[11px] font-mono-tabular px-1.5 py-0.5 border"
            style={{
              backgroundColor: 'var(--bg-surface)',
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}
          >
            {activeProject.offerings.length}
          </span>
        </button>

        <button
          ref={tabPlanRef}
          id="tab-plan"
          type="button"
          role="tab"
          aria-selected={activeTab === 'plan'}
          aria-controls="panel-plan"
          tabIndex={activeTab === 'plan' ? 0 : -1}
          onClick={() => switchTab('plan')}
          className={`workshop-tab ${activeTab === 'plan' ? 'active' : ''}`}
        >
          <Calculator className="w-3.5 h-3.5" aria-hidden="true" />
          <span>3. Optimal Purchase Plan</span>
          <span
            className="text-[11px] font-mono-tabular px-1.5 py-0.5 border"
            style={
              solverResult.savings_vs_baseline_cents > 0
                ? {
                    backgroundColor: 'var(--accent-emerald-bg)',
                    borderColor: 'var(--accent-emerald)',
                    color: 'var(--accent-emerald)',
                  }
                : {
                    backgroundColor: 'var(--bg-surface)',
                    borderColor: 'var(--border-subtle)',
                    color: 'var(--text-secondary)',
                  }
            }
          >
            ${formatCentsToDollars(solverResult.grand_total_cents)}
            {solverResult.savings_vs_baseline_cents > 0
              ? ` • Save $${formatCentsToDollars(solverResult.savings_vs_baseline_cents)}`
              : ''}
          </span>
        </button>
      </div>

      {/* Main Tabbed Workspace (Full Print Datasheet prints both Tab 1 BOM and Tab 3 Plan regardless of active tab) */}
      <main className="flex-1 p-4 flex flex-col gap-4">
        {/* TAB 1: 1. Parts List (BOM) */}
        <div
          id="panel-bom"
          role="tabpanel"
          aria-labelledby="tab-bom"
          className={`print-datasheet-panel ${activeTab !== 'bom' ? 'tab-panel-inactive' : ''}`}
        >
          <section
            className="workshop-panel border"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <div
              className="px-3 py-2 border-b flex flex-wrap items-center justify-between gap-2"
              style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
            >
              <div className="flex items-center gap-2 font-semibold text-xs uppercase tracking-wider">
                <Package className="w-3.5 h-3.5" /> 1. Bill of Materials (Required Parts)
              </div>
              <span className="text-xs font-mono-tabular" style={{ color: 'var(--text-secondary)' }}>
                {activeProject.parts.length} Required Item(s) •{' '}
                {activeProject.parts.length - solverResult.uncovered_part_ids.length} Covered
              </span>
            </div>

            {/* Rapid Keyboard-First BOM Entry Bar at Top of Tab 1 */}
            {!isReadOnlyShare && (
              <form
                onSubmit={handleAddPart}
                className="no-print p-3 border-b flex flex-wrap items-center gap-2"
                style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
              >
                <span
                  className="text-[11px] font-mono-tabular uppercase font-semibold mr-1"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  + Add Required Part:
                </span>
                <input
                  ref={newPartNameInputRef}
                  type="text"
                  placeholder="Required part name (e.g. Front Brake Rotor)..."
                  value={newPartName}
                  onChange={(e) => setNewPartName(e.target.value)}
                  className="flex-1 min-w-[220px] px-2.5 py-1.5 text-xs border"
                  style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                  required
                />
                <input
                  type="text"
                  placeholder="Part # / SKU"
                  value={newPartSku}
                  onChange={(e) => setNewPartSku(e.target.value)}
                  className="w-36 px-2.5 py-1.5 text-xs font-mono-tabular border"
                  style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                />
                <input
                  type="text"
                  placeholder="Category"
                  value={newPartCat}
                  onChange={(e) => setNewPartCat(e.target.value)}
                  className="w-32 px-2.5 py-1.5 text-xs border"
                  style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                />
                <input
                  type="number"
                  min={1}
                  max={10000}
                  placeholder="Qty (1)"
                  aria-label="New part required quantity"
                  title="Required quantity (defaults to 1)"
                  value={newPartQty}
                  onChange={(e) => setNewPartQty(e.target.value)}
                  className="w-20 px-2 py-1.5 text-xs font-mono-tabular border"
                  style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 text-xs font-semibold border flex items-center gap-1 cursor-pointer"
                  style={{
                    backgroundColor: 'var(--accent-amber-bg)',
                    borderColor: 'var(--accent-amber)',
                    color: 'var(--accent-amber)',
                  }}
                >
                  <Plus className="w-3.5 h-3.5" /> Add Part
                </button>
              </form>
            )}

            <div className="table-wrapper" tabIndex={0} role="region" aria-label="Bill of Materials Required Parts">
              <table className="workshop-table">
                <thead>
                  <tr>
                    <th className="w-10">#</th>
                    <th>Part Name / Specification</th>
                    <th className="w-44">Part # / SKU</th>
                    <th className="w-36">Category</th>
                    <th className="w-28">Req Qty</th>
                    <th className="w-32">Coverage</th>
                    <th className="w-12 no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {activeProject.parts.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center py-6 text-xs" style={{ color: 'var(--text-muted)' }}>
                        No required parts in this BOM yet. Use the quick-add bar above to add your first part.
                      </td>
                    </tr>
                  ) : (
                    activeProject.parts.map((part, idx) => {
                      const fulfilled = fulfilledPartMap.get(part.id) || 0;
                      const remaining = Math.max(0, part.required_qty - fulfilled);
                      const isFullyProcured = fulfilled >= part.required_qty;
                      const isPartialProcured = fulfilled > 0 && !isFullyProcured;
                      const isUncovered = solverResult.uncovered_part_ids.includes(part.id) && !isFullyProcured;

                      return (
                        <tr
                          key={part.id}
                          style={
                            isFullyProcured
                              ? { backgroundColor: 'color-mix(in oklch, var(--accent-emerald-bg) 25%, transparent)' }
                              : undefined
                          }
                        >
                          <td className="font-mono-tabular" style={{ color: 'var(--text-muted)' }}>
                            {idx + 1}
                          </td>
                          <th scope="row">
                            <input
                              type="text"
                              disabled={isReadOnlyShare}
                              aria-label={`Part name for row ${idx + 1}`}
                              value={part.name}
                              onChange={(e) => handleUpdatePart(part.id, { name: e.target.value })}
                              onBlur={() => {
                                if (!part.name.trim()) {
                                  handleUpdatePart(part.id, { name: `Part ${idx + 1}` });
                                }
                              }}
                              className={`bom-inline-input w-full px-1.5 py-0.5 text-xs font-semibold border border-transparent hover:border-[var(--border-subtle)] focus:border-[var(--accent-amber)] focus:outline-none bg-transparent ${isFullyProcured ? 'line-through text-[var(--text-muted)]' : ''}`}
                            />
                          </th>
                          <td className="font-mono-tabular text-xs">
                            <input
                              type="text"
                              disabled={isReadOnlyShare}
                              placeholder="—"
                              aria-label={`Part number or SKU for ${part.name}`}
                              value={part.part_number || ''}
                              onChange={(e) => handleUpdatePart(part.id, { part_number: e.target.value })}
                              className="bom-inline-input w-full px-1.5 py-0.5 text-xs font-mono-tabular border border-transparent hover:border-[var(--border-subtle)] focus:border-[var(--accent-amber)] focus:outline-none bg-transparent"
                              style={{ color: 'var(--text-secondary)' }}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              disabled={isReadOnlyShare}
                              placeholder="General"
                              aria-label={`Category for ${part.name}`}
                              value={part.category_tag || ''}
                              onChange={(e) => handleUpdatePart(part.id, { category_tag: e.target.value })}
                              className="bom-inline-input w-full px-1.5 py-0.5 text-[11px] font-mono-tabular border"
                              style={{
                                backgroundColor: 'var(--bg-elevated)',
                                borderColor: 'var(--border-subtle)',
                              }}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              min={1}
                              max={10000}
                              disabled={isReadOnlyShare}
                              aria-label={`Required quantity for ${part.name}`}
                              value={part.required_qty}
                              onChange={(e) => handleUpdatePartQty(part.id, parseInt(e.target.value, 10))}
                              className="bom-inline-input w-20 px-1.5 py-0.5 text-xs font-mono-tabular border"
                              style={{
                                backgroundColor: 'var(--bg-elevated)',
                                borderColor: 'var(--border-subtle)',
                              }}
                            />
                          </td>
                          <td className="font-mono-tabular text-xs">
                            <div className="flex flex-col gap-1 items-start">
                              {isFullyProcured ? (
                                <span
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 border"
                                  style={{
                                    backgroundColor: 'var(--accent-emerald-bg)',
                                    borderColor: 'var(--accent-emerald)',
                                    color: 'var(--accent-emerald)',
                                  }}
                                  title={`${fulfilled} units procured out of ${part.required_qty} required`}
                                >
                                  <Check className="w-3 h-3" /> Procured ({fulfilled}/{part.required_qty})
                                </span>
                              ) : isPartialProcured ? (
                                <div className="flex flex-col gap-0.5">
                                  <span
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 border"
                                    style={{
                                      backgroundColor: 'var(--accent-amber-bg)',
                                      borderColor: 'var(--accent-amber)',
                                      color: 'var(--accent-amber)',
                                    }}
                                  >
                                    ▲ Partial ({fulfilled}/{part.required_qty})
                                  </span>
                                  {!isReadOnlyShare && (
                                    <button
                                      type="button"
                                      onClick={() => handleOpenPartPurchase(part)}
                                      className="text-[10px] text-left underline cursor-pointer"
                                      style={{ color: 'var(--accent-amber)' }}
                                    >
                                      + Procure remaining ({remaining})
                                    </button>
                                  )}
                                </div>
                              ) : isUncovered ? (
                                <div className="flex flex-col gap-0.5">
                                  <span
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 border"
                                    style={{
                                      backgroundColor: 'var(--accent-danger-bg)',
                                      borderColor: 'var(--accent-danger)',
                                      color: 'var(--accent-danger)',
                                    }}
                                  >
                                    <AlertTriangle className="w-3 h-3" /> Missing
                                  </span>
                                  {!isReadOnlyShare && (
                                    <button
                                      type="button"
                                      onClick={() => handleOpenPartPurchase(part)}
                                      className="text-[10px] text-left underline cursor-pointer"
                                      style={{ color: 'var(--text-secondary)' }}
                                    >
                                      + Mark Owned / Procured
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <div className="flex flex-col gap-0.5">
                                  <span
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 border"
                                    style={{
                                      backgroundColor: 'var(--accent-emerald-bg)',
                                      borderColor: 'var(--accent-emerald)',
                                      color: 'var(--accent-emerald)',
                                    }}
                                  >
                                    <Check className="w-3 h-3" /> Covered
                                  </span>
                                  {!isReadOnlyShare && (
                                    <button
                                      type="button"
                                      onClick={() => handleOpenPartPurchase(part)}
                                      className="text-[10px] text-left underline cursor-pointer"
                                      style={{ color: 'var(--text-secondary)' }}
                                    >
                                      + Mark Owned / Procured
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="no-print text-center">
                            {!isReadOnlyShare && (
                              <button
                                type="button"
                                onClick={() => handleRemovePart(part.id)}
                                className="p-1 opacity-70 hover:opacity-100 cursor-pointer"
                                title="Remove Part"
                                aria-label={`Remove ${part.name}`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Quick Action Footer to proceed to Tab 2 */}
            <div
              className="no-print px-3 py-2.5 border-t flex flex-wrap items-center justify-between gap-2"
              style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
            >
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Next step: map vendor offerings &amp; multi-part bundle kits to your required BOM parts.
              </span>
              <button
                type="button"
                onClick={() => switchTab('matrix', true)}
                className="px-3 py-1.5 text-xs font-semibold border flex items-center gap-1.5 cursor-pointer"
                style={{
                  backgroundColor: 'var(--accent-amber-bg)',
                  borderColor: 'var(--accent-amber)',
                  color: 'var(--accent-amber)',
                }}
              >
                <span>2. Vendor Listings &amp; Prices →</span>
              </button>
            </div>
          </section>
        </div>

        {/* TAB 2: 2. Vendor Listings & Prices */}
        <div
          id="panel-matrix"
          role="tabpanel"
          aria-labelledby="tab-matrix"
          className={`no-print flex flex-col gap-4 ${activeTab !== 'matrix' ? 'tab-panel-inactive' : ''}`}
        >
          <section
            className="workshop-panel border"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            {/* Top Entry Bar: Add Vendor Offering or Multi-Part Bundle Kit */}
            {!isReadOnlyShare && (
              <form
                onSubmit={handleAddOffering}
                className="p-3 border-b flex flex-col gap-2.5"
                style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
              >
                <div
                  className="text-[11px] font-mono-tabular uppercase font-semibold"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  + Add Vendor Offering or Multi-Part Bundle Kit (Manual Entry + Auto URL Hostname Detection)
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                  <input
                    type="url"
                    placeholder="Optional Reference URL (e.g. https://www.rockauto.com/...) → auto-fills Vendor"
                    value={newOffUrl}
                    onChange={(e) => handleOfferingUrlChange(e.target.value)}
                    className="sm:col-span-5 px-2.5 py-1 text-xs border font-mono-tabular"
                    style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                  />
                  <input
                    type="text"
                    placeholder="Vendor Name (e.g. RockAuto)"
                    value={newOffVendor}
                    onChange={(e) => setNewOffVendor(e.target.value)}
                    className="sm:col-span-3 px-2.5 py-1 text-xs border"
                    style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                    required
                  />
                  <input
                    type="text"
                    placeholder="Vendor SKU / Part #"
                    value={newOffSku}
                    onChange={(e) => setNewOffSku(e.target.value)}
                    className="sm:col-span-4 px-2.5 py-1 text-xs font-mono-tabular border"
                    style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                  <input
                    type="text"
                    placeholder="Offering or Bundle Title (e.g. Complete Front Brake Kit: 2x Rotors + Pads)"
                    value={newOffTitle}
                    onChange={(e) => setNewOffTitle(e.target.value)}
                    className="sm:col-span-6 px-2.5 py-1 text-xs border"
                    style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                    required
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Price ($)"
                    value={newOffPrice}
                    onChange={(e) => setNewOffPrice(e.target.value)}
                    className="sm:col-span-2 px-2 py-1 text-xs font-mono-tabular border"
                    style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                    required
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Shipping ($)"
                    aria-label="Shipping ($)"
                    title="Shipping cost (optional, defaults to $0.00)"
                    value={newOffShip}
                    onChange={(e) => setNewOffShip(e.target.value)}
                    className="sm:col-span-2 px-2 py-1 text-xs font-mono-tabular border"
                    style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Discount ($)"
                    aria-label="Discount ($)"
                    title="Discount or instant rebate (optional, defaults to $0.00)"
                    value={newOffDiscount}
                    onChange={(e) => setNewOffDiscount(e.target.value)}
                    className="sm:col-span-2 px-2 py-1 text-xs font-mono-tabular border"
                    style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                  />
                </div>

                {/* Part Checkboxes & Yield Selector for New Offering */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-mono-tabular" style={{ color: 'var(--text-secondary)' }}>
                      Includes Parts:
                    </span>
                    {activeProject.parts.map((part, idx) => {
                      const y = newOffSelectedParts[part.id] || 0;
                      return (
                        <div
                          key={part.id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 border text-xs"
                          style={{
                            backgroundColor: y > 0 ? 'var(--accent-amber-bg)' : 'var(--bg-surface)',
                            borderColor: y > 0 ? 'var(--accent-amber)' : 'var(--border-subtle)',
                          }}
                        >
                          <label className="inline-flex items-center gap-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={y > 0}
                              onChange={(e) => {
                                setNewOffSelectedParts((prev) => ({
                                  ...prev,
                                  [part.id]: e.target.checked ? 1 : 0,
                                }));
                              }}
                            />
                            <span className="font-mono-tabular">P{idx + 1}:</span>
                            <span className="truncate max-w-[110px]">{part.name}</span>
                          </label>
                          {y > 0 && (
                            <div className="inline-flex items-center gap-1 ml-1 pl-1 border-l" style={{ borderColor: 'var(--accent-amber)' }}>
                              <span className="text-[10px] font-mono-tabular font-semibold uppercase" style={{ color: 'var(--text-secondary)' }}>
                                Qty
                              </span>
                              <input
                                type="number"
                                min={1}
                                max={10000}
                                value={y}
                                onChange={(e) =>
                                  setNewOffSelectedParts((prev) => ({
                                    ...prev,
                                    [part.id]: Math.max(1, parseInt(e.target.value, 10) || 1),
                                  }))
                                }
                                className="w-14 px-1.5 py-0.5 text-xs font-mono-tabular border text-center"
                                style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-strong)' }}
                                title="Yield quantity included per offering"
                                aria-label={`Quantity of ${part.name} included`}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <button
                    type="submit"
                    className="px-3 py-1 text-xs font-semibold border flex items-center gap-1 cursor-pointer"
                    style={{
                      backgroundColor: 'var(--accent-amber-bg)',
                      borderColor: 'var(--accent-amber)',
                      color: 'var(--accent-amber)',
                    }}
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Offering
                  </button>
                </div>
              </form>
            )}

            {/* Full-Width Bundle Coverage Matrix Header */}
            <div
              className="px-3 py-2 border-b flex flex-wrap items-center justify-between gap-2"
              style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
            >
              <div className="flex items-center gap-2 font-semibold text-xs uppercase tracking-wider">
                <Layers className="w-3.5 h-3.5" /> 2. Vendor Listings &amp; Price Matrix
              </div>
              <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                Click any matrix cell to toggle coverage or set multi-pack yield (e.g. 4x spark plugs)
              </span>
            </div>

            <div
              className="table-wrapper"
              tabIndex={0}
              role="region"
              aria-label="Parts to Offerings Coverage Matrix"
            >
              <table className="workshop-table">
                <thead>
                  <tr>
                    <th className="min-w-[260px]">Vendor &amp; Offering</th>
                    <th className="w-28 text-right">Price / Disc</th>
                    <th className="w-24 text-right">Ship</th>
                    {activeProject.parts.map((part, idx) => (
                      <th key={part.id} className="w-24 text-center" title={part.name}>
                        <div className="font-mono-tabular text-[11px]">
                          P{idx + 1} (×{part.required_qty})
                        </div>
                        <div
                          className="truncate max-w-[96px] text-[10px] font-normal mx-auto"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {part.name}
                        </div>
                      </th>
                    ))}
                    <th className="w-10 no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {activeProject.offerings.length === 0 ? (
                    <tr>
                      <td
                        colSpan={activeProject.parts.length + 4}
                        className="text-center py-6 text-xs"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        No vendor offerings in this project yet. Use the form above to add single-item listings or
                        multi-part bundle kits.
                      </td>
                    </tr>
                  ) : (
                    activeProject.offerings.map((off) => {
                      const selectedQty = winningOfferingQtyMap.get(off.id) || 0;

                      return (
                        <tr
                          key={off.id}
                          style={
                            selectedQty > 0
                              ? { backgroundColor: 'color-mix(in oklch, var(--accent-emerald-bg) 38%, transparent)' }
                              : undefined
                          }
                        >
                          <th scope="row">
                            <div className="flex items-center justify-between gap-1 mb-1">
                              <input
                                type="text"
                                disabled={isReadOnlyShare}
                                aria-label={`Vendor name for ${off.title}`}
                                value={off.vendor_name}
                                onChange={(e) => handleUpdateOffering(off.id, { vendor_name: e.target.value })}
                                className="bom-inline-input w-28 px-1 py-0.5 text-[10px] font-mono-tabular uppercase font-semibold border border-transparent hover:border-[var(--border-subtle)] focus:border-[var(--accent-amber)] focus:outline-none bg-transparent"
                                style={{
                                  backgroundColor: 'var(--bg-elevated)',
                                }}
                              />
                              {selectedQty > 0 && (
                                <span
                                  className="text-[10px] font-mono-tabular px-1.5 py-0.2 border font-bold shrink-0"
                                  style={{
                                    backgroundColor: 'var(--accent-emerald-bg)',
                                    borderColor: 'var(--accent-emerald)',
                                    color: 'var(--accent-emerald)',
                                  }}
                                >
                                  BUY ×{selectedQty}
                                </span>
                              )}
                            </div>
                            <div className="font-medium text-xs flex items-center gap-1">
                              <input
                                type="text"
                                disabled={isReadOnlyShare}
                                aria-label={`Title for ${off.title}`}
                                value={off.title}
                                onChange={(e) => handleUpdateOffering(off.id, { title: e.target.value })}
                                className="bom-inline-input flex-1 px-1 py-0.5 text-xs font-semibold border border-transparent hover:border-[var(--border-subtle)] focus:border-[var(--accent-amber)] focus:outline-none bg-transparent"
                              />
                              {off.reference_url && (
                                <a
                                  href={off.reference_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex opacity-70 hover:opacity-100 shrink-0"
                                  title={off.reference_url}
                                >
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              )}
                            </div>
                            <div className="mt-0.5">
                              <input
                                type="text"
                                disabled={isReadOnlyShare}
                                placeholder="SKU —"
                                aria-label={`Vendor SKU for ${off.title}`}
                                value={off.part_number || ''}
                                onChange={(e) => handleUpdateOffering(off.id, { part_number: e.target.value })}
                                className="bom-inline-input w-full px-1 py-0.2 text-[10px] font-mono-tabular border border-transparent hover:border-[var(--border-subtle)] focus:border-[var(--accent-amber)] focus:outline-none bg-transparent"
                                style={{ color: 'var(--text-muted)' }}
                              />
                            </div>
                          </th>

                          <td className="font-mono-tabular text-right">
                            <div className="flex items-center justify-end font-semibold text-xs">
                              <span className="text-[var(--text-secondary)]">$</span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                disabled={isReadOnlyShare}
                                aria-label={`Price for ${off.title}`}
                                value={(off.price_cents / 100).toFixed(2)}
                                onChange={(e) => {
                                  const val = Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 100));
                                  handleUpdateOffering(off.id, { price_cents: val });
                                }}
                                className="bom-inline-input w-16 px-1 py-0.5 text-xs text-right font-semibold font-mono-tabular border border-transparent hover:border-[var(--border-subtle)] focus:border-[var(--accent-amber)] focus:outline-none bg-transparent"
                              />
                            </div>
                            <div className="flex items-center justify-end text-[10px] mt-0.5">
                              <span style={{ color: 'var(--accent-emerald)' }}>-$</span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder="0.00"
                                disabled={isReadOnlyShare}
                                aria-label={`Discount for ${off.title}`}
                                value={off.discount_cents ? (off.discount_cents / 100).toFixed(2) : ''}
                                onChange={(e) => {
                                  const raw = e.target.value.trim();
                                  const val = raw === '' ? 0 : Math.max(0, Math.round((parseFloat(raw) || 0) * 100));
                                  handleUpdateOffering(off.id, { discount_cents: val });
                                }}
                                className="bom-inline-input w-14 px-1 py-0.2 text-[10px] text-right font-mono-tabular border border-transparent hover:border-[var(--border-subtle)] focus:border-[var(--accent-amber)] focus:outline-none bg-transparent"
                                style={{ color: 'var(--accent-emerald)' }}
                                title="Discount or rebate ($)"
                              />
                            </div>
                          </td>

                          <td className="font-mono-tabular text-right text-xs">
                            <div className="flex items-center justify-end">
                              <span className="text-[var(--text-secondary)]">$</span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                disabled={isReadOnlyShare}
                                aria-label={`Shipping for ${off.title}`}
                                value={(off.shipping_cents / 100).toFixed(2)}
                                onChange={(e) => {
                                  const val = Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 100));
                                  handleUpdateOffering(off.id, { shipping_cents: val });
                                }}
                                className="bom-inline-input w-14 px-1 py-0.5 text-xs text-right font-mono-tabular border border-transparent hover:border-[var(--border-subtle)] focus:border-[var(--accent-amber)] focus:outline-none bg-transparent"
                              />
                            </div>
                          </td>

                          {activeProject.parts.map((part) => {
                            const mapping = activeProject.bundle_mappings.find(
                              (bm) => bm.offering_id === off.id && bm.part_id === part.id
                            );
                            const y = mapping?.yield_qty || 0;

                            return (
                              <td key={part.id} className="text-center p-1">
                                {y > 0 ? (
                                  <div className="inline-flex items-center gap-1">
                                    <button
                                      type="button"
                                      disabled={isReadOnlyShare}
                                      onClick={() => handleToggleMatrixCell(off.id, part.id)}
                                      className="px-1.5 py-0.5 text-xs font-mono-tabular border font-bold cursor-pointer"
                                      style={{
                                        backgroundColor: 'var(--accent-amber-bg)',
                                        borderColor: 'var(--accent-amber)',
                                        color: 'var(--accent-amber)',
                                      }}
                                      title="Click to uncheck part from offering"
                                    >
                                      ✓
                                    </button>
                                    <input
                                      type="number"
                                      min={0}
                                      max={10000}
                                      disabled={isReadOnlyShare}
                                      aria-label={`Yield quantity of ${part.name} in ${off.title}`}
                                      value={y}
                                      onChange={(e) =>
                                        handleChangeMatrixYield(
                                          off.id,
                                          part.id,
                                          parseInt(e.target.value, 10) || 0
                                        )
                                      }
                                      className="w-14 px-1 py-0.5 text-xs font-mono-tabular border text-center"
                                      style={{
                                        backgroundColor: 'var(--bg-surface)',
                                        borderColor: 'var(--border-strong)',
                                      }}
                                      title="Units yielded per 1 offering purchased"
                                    />
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={isReadOnlyShare}
                                    onClick={() => handleToggleMatrixCell(off.id, part.id)}
                                    className="w-7 h-6 text-xs font-mono-tabular border opacity-45 hover:opacity-100 cursor-pointer"
                                    style={{
                                      backgroundColor: 'var(--bg-elevated)',
                                      borderColor: 'var(--border-subtle)',
                                    }}
                                    title={`Include ${part.name} in this offering`}
                                  >
                                    ·
                                  </button>
                                )}
                              </td>
                            );
                          })}

                          <td className="no-print text-center">
                            {!isReadOnlyShare && (
                              <button
                                type="button"
                                onClick={() => handleRemoveOffering(off.id)}
                                className="p-1 opacity-70 hover:opacity-100 cursor-pointer"
                                title="Remove Offering"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Quick Action Footer on Tab 2 */}
            <div
              className="px-3 py-2.5 border-t flex flex-wrap items-center justify-between gap-2"
              style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
            >
              <button
                type="button"
                onClick={() => switchTab('bom', true)}
                className="px-3 py-1.5 text-xs font-medium border cursor-pointer"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                ← 1. Parts List (BOM)
              </button>
              <button
                type="button"
                onClick={() => switchTab('plan', true)}
                className="px-3 py-1.5 text-xs font-semibold border flex items-center gap-1.5 cursor-pointer"
                style={{
                  backgroundColor: 'var(--accent-emerald-bg)',
                  borderColor: 'var(--accent-emerald)',
                  color: 'var(--accent-emerald)',
                }}
              >
                <span>3. Optimal Purchase Plan →</span>
              </button>
            </div>
          </section>

          {/* Inline Collapsible Vendor Shipping, Free-Shipping Minimums & Tax Rules Panel */}
          <details
            open={isVendorSectionOpen}
            onToggle={(e) => setIsVendorSectionOpen((e.currentTarget as HTMLDetailsElement).open)}
            className="workshop-panel border"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <summary
              className="px-3 py-2 border-b flex items-center justify-between cursor-pointer select-none"
              style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
            >
              <div className="flex items-center gap-2 font-semibold text-xs uppercase tracking-wider">
                <Truck className="w-3.5 h-3.5" /> Vendor Shipping, Free-Shipping Minimums &amp; Tax Rules ({distinctVendors.length})
              </div>
              <span className="text-[11px] font-mono-tabular" style={{ color: 'var(--text-secondary)' }}>
                {isVendorSectionOpen ? 'Click to collapse ▲' : 'Click to expand ▼'}
              </span>
            </summary>

            <div className="p-3 flex flex-col gap-3">
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Configure flat per-order shipping charges, free-shipping order minimums (e.g. $49.00 on FCP Euro or $35.00
                on Amazon), and vendor-specific tax rates. The bundle solver automatically factors these thresholds when
                consolidating vendor orders.
              </p>

              {!user && (
                <div
                  className="p-2.5 border text-xs flex flex-wrap items-center justify-between gap-2"
                  style={{
                    backgroundColor: 'var(--accent-amber-bg)',
                    borderColor: 'var(--accent-amber)',
                  }}
                >
                  <span>
                    Custom per-vendor shipping &amp; free-shipping thresholds require a Registered Account (Guest mode uses
                    per-item shipping &amp; default project tax).
                  </span>
                  <button
                    type="button"
                    onClick={() => authDialogRef.current?.showModal()}
                    className="px-2.5 py-1 font-semibold border shrink-0 cursor-pointer"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      borderColor: 'var(--accent-amber)',
                      color: 'var(--accent-amber)',
                    }}
                  >
                    Sign In to Unlock
                  </button>
                </div>
              )}

              <div className="table-wrapper">
                <table className="workshop-table">
                  <thead>
                    <tr>
                      <th>Vendor</th>
                      <th>Flat Order Ship ($)</th>
                      <th>Free Ship Min ($)</th>
                      <th>Tax Rate (%)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {distinctVendors.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-center py-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                          No vendors in this project yet. Add an offering above to configure vendor shipping &amp;
                          free-shipping minimums.
                        </td>
                      </tr>
                    ) : (
                      distinctVendors.map((vp) => (
                        <tr key={vp.vendor_name}>
                          <th scope="row">{vp.vendor_name}</th>
                          <td>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              disabled={!user || isReadOnlyShare}
                              aria-label={`Flat order shipping for ${vp.vendor_name}`}
                              value={((vp.flat_shipping_cents || 0) / 100).toFixed(2)}
                              onChange={(e) =>
                                handleUpdateVendorProfile(vp.vendor_name, {
                                  flat_shipping_cents: Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 100)),
                                })
                              }
                              className="w-24 px-1.5 py-0.5 text-xs font-mono-tabular border disabled:opacity-60"
                              style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              placeholder="None"
                              disabled={!user || isReadOnlyShare}
                              aria-label={`Free shipping minimum for ${vp.vendor_name}`}
                              value={
                                vp.free_shipping_threshold_cents !== null &&
                                vp.free_shipping_threshold_cents !== undefined
                                  ? (vp.free_shipping_threshold_cents / 100).toFixed(2)
                                  : ''
                              }
                              onChange={(e) => {
                                const raw = e.target.value.trim();
                                handleUpdateVendorProfile(vp.vendor_name, {
                                  free_shipping_threshold_cents:
                                    raw === '' ? null : Math.max(0, Math.round((parseFloat(raw) || 0) * 100)),
                                });
                              }}
                              className="w-28 px-1.5 py-0.5 text-xs font-mono-tabular border disabled:opacity-60"
                              style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              max="50"
                              disabled={!user || isReadOnlyShare}
                              aria-label={`Tax rate percentage for ${vp.vendor_name}`}
                              value={((vp.tax_rate_bps ?? activeProject.default_tax_bps ?? 0) / 100).toFixed(2)}
                              onChange={(e) =>
                                handleUpdateVendorProfile(vp.vendor_name, {
                                  tax_rate_bps: Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 100)),
                                })
                              }
                              className="w-24 px-1.5 py-0.5 text-xs font-mono-tabular border disabled:opacity-60"
                              style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                            />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </details>
        </div>

        {/* TAB 3: 3. Optimal Purchase Plan (Checkout-Ready 2-Column Layout) */}
        <div
          id="panel-plan"
          role="tabpanel"
          aria-labelledby="tab-plan"
          className={`print-datasheet-panel ${activeTab !== 'plan' ? 'tab-panel-inactive' : ''}`}
        >
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* Left Column (7 cols): Itemized Vendor Orders grouped by retailer */}
            <div className="lg:col-span-7 flex flex-col gap-4">
              <section
                className="workshop-panel border"
                style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-strong)' }}
              >
                <div
                  className="px-3 py-2.5 border-b flex items-center justify-between"
                  style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                >
                  <div className="flex items-center gap-2 font-bold text-xs uppercase tracking-wider">
                    <Calculator className="w-4 h-4" /> 3. Optimal Purchase Plan — Itemized Vendor Orders
                  </div>
                  <span className="text-[11px] font-mono-tabular" style={{ color: 'var(--text-secondary)' }}>
                    {solverResult.vendor_orders.length} Vendor Order(s)
                  </span>
                </div>

                <div className="p-3 flex flex-col gap-3">
                  {/* All Parts Fulfilled Celebration Banner */}
                  {activeProject.parts.length > 0 && neededParts.length === 0 && (
                    <div
                      className="p-3 border text-xs flex items-center justify-between gap-2"
                      style={{
                        backgroundColor: 'var(--accent-emerald-bg)',
                        borderColor: 'var(--accent-emerald)',
                        color: 'var(--accent-emerald)',
                      }}
                    >
                      <div className="flex items-center gap-2 font-semibold">
                        <Check className="w-4 h-4" />
                        <span>All BOM Parts Procured! Your project procurement is 100% complete.</span>
                      </div>
                    </div>
                  )}

                  {/* Procured Items & Purchased Orders Section */}
                  {(activeProject.purchases || []).length > 0 && (
                    <div
                      className="border"
                      style={{ borderColor: 'var(--accent-emerald)', backgroundColor: 'var(--bg-canvas)' }}
                    >
                      <div
                        className="px-3 py-2 border-b flex flex-wrap items-center justify-between gap-2"
                        style={{ backgroundColor: 'var(--accent-emerald-bg)', borderColor: 'var(--accent-emerald)' }}
                      >
                        <div
                          className="font-bold text-xs uppercase tracking-wide flex items-center gap-2"
                          style={{ color: 'var(--accent-emerald)' }}
                        >
                          <Check className="w-4 h-4" />
                          <span>Procured Items &amp; Purchased Orders ({activeProject.purchases.length})</span>
                        </div>
                        <span className="font-mono-tabular font-bold text-xs" style={{ color: 'var(--accent-emerald)' }}>
                          Spent: ${formatCentsToDollars(totalSpentCents)}
                        </span>
                      </div>

                      <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
                        {activeProject.purchases.map((purchase) => {
                          const offering = purchase.offering_id
                            ? activeProject.offerings.find((o) => o.id === purchase.offering_id)
                            : null;
                          const part = purchase.part_id
                            ? activeProject.parts.find((p) => p.id === purchase.part_id)
                            : null;

                          return (
                            <div
                              key={purchase.id}
                              className="p-3 flex flex-wrap items-center justify-between gap-3 text-xs"
                            >
                              <div className="flex-1 min-w-[200px]">
                                <div className="font-semibold flex items-center gap-2">
                                  <span
                                    className="text-[10px] font-mono-tabular px-1.5 py-0.2 border"
                                    style={{
                                      backgroundColor: 'var(--bg-elevated)',
                                      borderColor: 'var(--border-subtle)',
                                      color: 'var(--text-secondary)',
                                    }}
                                  >
                                    {new Date(purchase.purchased_at).toLocaleDateString()}
                                  </span>
                                  <span>
                                    {purchase.offering_id
                                      ? `${purchase.offering_qty || 1}× ${offering?.title || 'Vendor Item'} (${offering?.vendor_name || 'Vendor'})`
                                      : `${purchase.part_qty || 1}× ${part?.name || 'BOM Part'} (Direct Procurement)`}
                                  </span>
                                </div>

                                <div
                                  className="mt-1 flex flex-wrap items-center gap-2 text-[11px] font-mono-tabular"
                                  style={{ color: 'var(--text-secondary)' }}
                                >
                                  {purchase.order_number && <span>Order #: {purchase.order_number}</span>}
                                  {purchase.notes && <span className="italic">Note: {purchase.notes}</span>}
                                </div>
                              </div>

                              <div className="flex items-center gap-3">
                                <span className="font-mono-tabular font-bold text-xs">
                                  ${formatCentsToDollars(purchase.actual_paid_cents)}
                                </span>

                                {!isReadOnlyShare && (
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => handleOpenEditPurchase(purchase)}
                                      className="px-2 py-0.5 text-[11px] border cursor-pointer"
                                      style={{
                                        backgroundColor: 'var(--bg-surface)',
                                        borderColor: 'var(--border-subtle)',
                                      }}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleUndoPurchase(purchase.id)}
                                      className="px-2 py-0.5 text-[11px] border cursor-pointer"
                                      style={{
                                        backgroundColor: 'var(--accent-danger-bg)',
                                        borderColor: 'var(--accent-danger)',
                                        color: 'var(--accent-danger)',
                                      }}
                                      title="Undo this purchase and return items to solver demand"
                                    >
                                      Undo
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {solverResult.uncovered_part_ids.length > 0 && (
                    <div
                      className="p-2.5 border text-xs flex flex-wrap items-center justify-between gap-2"
                      style={{
                        backgroundColor: 'var(--accent-danger-bg)',
                        borderColor: 'var(--accent-danger)',
                        color: 'var(--accent-danger)',
                      }}
                    >
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <div>
                          <strong>Uncovered BOM Parts:</strong> Add offerings or toggle matrix coverage for{' '}
                          {solverResult.uncovered_part_ids
                            .map((id) => activeProject.parts.find((p) => p.id === id)?.name || id)
                            .join(', ')}
                          .
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => switchTab('matrix', true)}
                        className="no-print px-2.5 py-1 text-xs font-semibold border cursor-pointer"
                        style={{
                          backgroundColor: 'var(--bg-surface)',
                          borderColor: 'var(--accent-danger)',
                          color: 'var(--accent-danger)',
                        }}
                      >
                        Fix in Matrix →
                      </button>
                    </div>
                  )}

                  {solverResult.vendor_orders.length === 0 ? (
                    <div className="py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                      {activeProject.parts.length > 0 && neededParts.length === 0
                        ? 'All parts in your project have been procured and accounted for.'
                        : 'No vendor orders selected yet. Add required parts in Tab 1 and map vendor offerings in Tab 2.'}
                    </div>
                  ) : (
                    solverResult.vendor_orders.map((order) => (
                      <div
                        key={order.vendor_name}
                        className="border"
                        style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-canvas)' }}
                      >
                        <div
                          className="px-3 py-2 border-b flex flex-wrap items-center justify-between gap-2"
                          style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                        >
                          <div className="font-bold text-xs uppercase tracking-wide flex items-center gap-2">
                            <span>ORDER: {order.vendor_name}</span>
                            {order.free_shipping_applied && (
                              <span
                                className="text-[10px] font-mono-tabular px-1.5 py-0.5 border"
                                style={{
                                  backgroundColor: 'var(--accent-emerald-bg)',
                                  borderColor: 'var(--accent-emerald)',
                                  color: 'var(--accent-emerald)',
                                }}
                              >
                                FREE SHIPPING THRESHOLD MET
                              </span>
                            )}
                          </div>
                          <span className="font-mono-tabular font-bold text-xs">
                            ${formatCentsToDollars(order.total_cents)}
                          </span>
                        </div>

                        <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
                          {order.items.map((item) => (
                            <div
                              key={item.offering.id}
                              className="p-3 flex flex-wrap items-start justify-between gap-3"
                            >
                              <div className="flex-1 min-w-[220px]">
                                <div className="text-xs font-medium flex flex-wrap items-center gap-2">
                                  <span
                                    className="font-mono-tabular font-bold px-1.5 py-0.5 border"
                                    style={{
                                      backgroundColor: 'var(--accent-emerald-bg)',
                                      borderColor: 'var(--accent-emerald)',
                                      color: 'var(--accent-emerald)',
                                    }}
                                  >
                                    BUY ×{item.qty}
                                  </span>
                                  <span className="font-semibold">{item.offering.title}</span>
                                  {item.offering.part_number && (
                                    <span
                                      className="text-[11px] font-mono-tabular"
                                      style={{ color: 'var(--text-muted)' }}
                                    >
                                      (SKU: {item.offering.part_number})
                                    </span>
                                  )}
                                </div>

                                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                  {item.parts_covered.map((pc) => (
                                    <span
                                      key={pc.part_id}
                                      className="text-[10px] font-mono-tabular px-1.5 py-0.5 border"
                                      style={{
                                        backgroundColor: 'var(--bg-surface)',
                                        borderColor: 'var(--border-subtle)',
                                        color: 'var(--text-secondary)',
                                      }}
                                    >
                                      Yields {pc.total_yield}× {pc.part_name}
                                    </span>
                                  ))}
                                </div>
                              </div>

                              <div className="flex items-center gap-2">
                                {!isReadOnlyShare && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleOpenOrderPurchase(
                                        item.offering,
                                        item.qty,
                                        item.line_subtotal_cents,
                                        order.vendor_name
                                      )
                                    }
                                    className="px-2 py-1 text-xs font-semibold border inline-flex items-center gap-1 cursor-pointer"
                                    style={{
                                      backgroundColor: 'var(--accent-emerald-bg)',
                                      borderColor: 'var(--accent-emerald)',
                                      color: 'var(--accent-emerald)',
                                    }}
                                    title="Mark this item/kit as purchased to lock it into your financial ledger"
                                  >
                                    <Check className="w-3 h-3" /> Mark Purchased
                                  </button>
                                )}

                                {item.offering.reference_url && (
                                  <a
                                    href={item.offering.reference_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="no-print px-2.5 py-1 text-xs font-semibold border inline-flex items-center gap-1"
                                    style={{
                                      backgroundColor: 'var(--accent-amber-bg)',
                                      borderColor: 'var(--accent-amber)',
                                      color: 'var(--accent-amber)',
                                    }}
                                  >
                                    <span>Open Vendor Link ↗</span>
                                  </a>
                                )}

                                <div className="text-right font-mono-tabular text-xs">
                                  <div className="font-semibold">${formatCentsToDollars(item.line_subtotal_cents)}</div>
                                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                    @${formatCentsToDollars(item.unit_net_price_cents)}/ea
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* Vendor Order Math Footer */}
                        <div
                          className="px-3 py-2 border-t text-xs font-mono-tabular flex flex-col gap-0.5"
                          style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                        >
                          <div className="flex justify-between" style={{ color: 'var(--text-secondary)' }}>
                            <span>Items Subtotal:</span>
                            <span>${formatCentsToDollars(order.subtotal_cents)}</span>
                          </div>
                          <div className="flex justify-between" style={{ color: 'var(--text-secondary)' }}>
                            <span>
                              Shipping{' '}
                              {order.free_shipping_threshold_cents !== null
                                ? `(Free ≥ $${formatCentsToDollars(order.free_shipping_threshold_cents)})`
                                : ''}
                              :
                            </span>
                            <span>
                              {order.free_shipping_applied
                                ? '$0.00 (FREE)'
                                : `$${formatCentsToDollars(order.shipping_cents)}`}
                            </span>
                          </div>
                          <div className="flex justify-between" style={{ color: 'var(--text-secondary)' }}>
                            <span>Estimated Tax ({(order.tax_rate_bps / 100).toFixed(2)}%):</span>
                            <span>${formatCentsToDollars(order.tax_cents)}</span>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>

            {/* Right Column (5 cols): Financial Summary Ledger, Spare Parts Callout & Export/Share Actions */}
            <div className="lg:col-span-5 flex flex-col gap-4">
              <section
                className="workshop-panel border p-3 flex flex-col gap-3"
                style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-strong)' }}
              >
                <div
                  className="pb-2 border-b font-bold text-xs uppercase tracking-wider flex items-center justify-between"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <span>Financial Summary Ledger</span>
                  {solverResult.savings_vs_baseline_cents > 0 && (
                    <span
                      className="text-[11px] font-mono-tabular px-1.5 py-0.5 border"
                      style={{
                        backgroundColor: 'var(--accent-emerald-bg)',
                        borderColor: 'var(--accent-emerald)',
                        color: 'var(--accent-emerald)',
                      }}
                    >
                      NET SAVINGS: ${formatCentsToDollars(solverResult.savings_vs_baseline_cents)}
                    </span>
                  )}
                </div>

                {/* Grand Total Ledger vs Single-Item Baseline */}
                <div
                  className="p-3 border font-mono-tabular"
                  style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-strong)' }}
                >
                  <div className="flex justify-between text-xs py-0.5" style={{ color: 'var(--accent-emerald)' }}>
                    <span className="font-semibold">Actual Spent So Far:</span>
                    <span className="font-bold">${formatCentsToDollars(totalSpentCents)}</span>
                  </div>

                  <div className="flex justify-between text-xs py-0.5" style={{ color: 'var(--text-secondary)' }}>
                    <span>Remaining to Spend (Solver):</span>
                    <span>${formatCentsToDollars(solverResult.grand_total_cents)}</span>
                  </div>

                  <div className="flex justify-between text-xs py-0.5" style={{ color: 'var(--text-muted)' }}>
                    <span className="pl-2">↳ Remaining Net Parts:</span>
                    <span>${formatCentsToDollars(solverResult.total_subtotal_cents)}</span>
                  </div>
                  <div className="flex justify-between text-xs py-0.5" style={{ color: 'var(--text-muted)' }}>
                    <span className="pl-2">↳ Remaining Shipping:</span>
                    <span>${formatCentsToDollars(solverResult.total_shipping_cents)}</span>
                  </div>
                  <div className="flex justify-between text-xs py-0.5" style={{ color: 'var(--text-muted)' }}>
                    <span className="pl-2">↳ Remaining Sales Tax:</span>
                    <span>${formatCentsToDollars(solverResult.total_tax_cents)}</span>
                  </div>

                  {solverResult.baseline_single_item_cents !== null && (
                    <div
                      className="flex justify-between text-xs py-1 mt-1 border-t"
                      style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                    >
                      <span>Individual Single-Item Baseline:</span>
                      <span className={solverResult.savings_vs_baseline_cents > 0 ? 'line-through' : undefined}>
                        ${formatCentsToDollars(solverResult.baseline_single_item_cents)}
                      </span>
                    </div>
                  )}

                  <div
                    className="flex justify-between items-baseline text-base font-bold pt-2 mt-1 border-t"
                    style={{ borderColor: 'var(--border-strong)' }}
                  >
                    <span>PROJECTED GRAND TOTAL:</span>
                    <span style={{ color: 'var(--accent-emerald)' }}>
                      ${formatCentsToDollars(totalSpentCents + solverResult.grand_total_cents)}
                    </span>
                  </div>

                  {/* Procurement Progress Bar */}
                  {activeProject.parts.length > 0 && (
                    <div className="mt-3 pt-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                      <div className="flex justify-between text-[11px] mb-1">
                        <span style={{ color: 'var(--text-secondary)' }}>Procurement Progress:</span>
                        <strong>
                          {fulfilledPartsCount} / {activeProject.parts.length} Parts Fulfilled (
                          {Math.round((fulfilledPartsCount / activeProject.parts.length) * 100)}%)
                        </strong>
                      </div>
                      <div
                        className="w-full h-2 border overflow-hidden"
                        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                      >
                        <div
                          className="h-full transition-all duration-300"
                          style={{
                            width: `${Math.min(100, Math.round((fulfilledPartsCount / activeProject.parts.length) * 100))}%`,
                            backgroundColor: 'var(--accent-emerald)',
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Spare / Bonus Units Callout from Overlapping Bundles */}
                {solverResult.spare_parts.length > 0 && (
                  <div
                    className="p-2.5 border text-xs"
                    style={{
                      backgroundColor: 'var(--accent-amber-bg)',
                      borderColor: 'var(--accent-amber)',
                    }}
                  >
                    <div
                      className="font-bold uppercase text-[11px] font-mono-tabular flex items-center gap-1.5"
                      style={{ color: 'var(--accent-amber)' }}
                    >
                      <Sparkles className="w-3.5 h-3.5" /> Bonus / Spare Parts Included (Over-Coverage Savings)
                    </div>
                    <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                      Buying overlapping bundles is cheaper than buying single items separately and yields free spare
                      inventory:
                    </p>
                    <ul className="mt-1.5 space-y-1 font-mono-tabular text-xs">
                      {solverResult.spare_parts.map((sp) => (
                        <li key={sp.part_id} className="flex justify-between">
                          <span>{sp.part_name}</span>
                          <strong>
                            +{sp.surplus_qty} Spare ({sp.provided_qty} provided vs {sp.required_qty} required)
                          </strong>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Prominent Export, Print Datasheet & Share Project Actions */}
                <div className="no-print pt-1 flex flex-col gap-2">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={handleExportCsv}
                      className="px-3 py-2 text-xs font-semibold border flex items-center justify-center gap-1.5 cursor-pointer"
                      style={{
                        backgroundColor: 'var(--bg-elevated)',
                        borderColor: 'var(--border-subtle)',
                      }}
                    >
                      <FileSpreadsheet className="w-3.5 h-3.5" /> Export CSV
                    </button>

                    <button
                      type="button"
                      onClick={handlePrintDatasheet}
                      className="px-3 py-2 text-xs font-semibold border flex items-center justify-center gap-1.5 cursor-pointer"
                      style={{
                        backgroundColor: 'var(--bg-elevated)',
                        borderColor: 'var(--border-subtle)',
                      }}
                    >
                      <Printer className="w-3.5 h-3.5" /> Print PDF Datasheet
                    </button>

                    <button
                      type="button"
                      onClick={handleOpenShareDialog}
                      className="px-3 py-2 text-xs font-semibold border flex items-center justify-center gap-1.5 cursor-pointer"
                      style={{
                        backgroundColor: 'var(--accent-amber-bg)',
                        borderColor: 'var(--accent-amber)',
                        color: 'var(--accent-amber)',
                      }}
                    >
                      <Share2 className="w-3.5 h-3.5" /> Share Project Link
                    </button>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>

      {/* Dialog 1: Hardened Auth & OAuth Modal (native <dialog closedby="any">) */}
      <dialog
        ref={authDialogRef}
        {...({ closedby: 'any' } as React.DialogHTMLAttributes<HTMLDialogElement>)}
        aria-labelledby="auth-dialog-title"
        className="workshop-dialog"
      >
        <div
          className="px-4 py-3 border-b flex items-center justify-between"
          style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
        >
          <h2 id="auth-dialog-title" className="font-bold text-sm uppercase tracking-wider">
            {authMode === 'login' ? 'Sign In to PriceIt Cloud' : 'Create PriceIt Account'}
          </h2>
          <button
            type="button"
            onClick={() => authDialogRef.current?.close()}
            className="text-xs px-2 py-0.5 border cursor-pointer"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            ESC
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4">
          {guestState.is_dirty && guestState.project.parts.length > 0 && (
            <div
              className="p-2.5 border text-xs font-mono-tabular"
              style={{
                backgroundColor: 'var(--accent-emerald-bg)',
                borderColor: 'var(--accent-emerald)',
                color: 'var(--accent-emerald)',
              }}
            >
              ✓ Your active guest project ({guestState.project.parts.length} parts) will automatically migrate to your
              account on sign-in.
            </div>
          )}

          {authError && (
            <div
              className="p-2.5 border text-xs"
              style={{
                backgroundColor: 'var(--accent-danger-bg)',
                borderColor: 'var(--accent-danger)',
                color: 'var(--accent-danger)',
              }}
            >
              {authError}
            </div>
          )}

          <form onSubmit={handleAuthSubmit} className="flex flex-col gap-3">
            {authMode === 'register' && (
              <div>
                <label className="block text-xs font-mono-tabular uppercase mb-1">Display Name</label>
                <input
                  type="text"
                  value={authDisplayName}
                  onChange={(e) => setAuthDisplayName(e.target.value)}
                  placeholder="Alex Rivera"
                  className="w-full px-2.5 py-1.5 text-xs border"
                  style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-mono-tabular uppercase mb-1">Email Address</label>
              <input
                type="email"
                required
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder="engineer@workshop.io"
                className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
                style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
              />
            </div>

            <div>
              <label className="block text-xs font-mono-tabular uppercase mb-1">
                Password (min 8 chars)
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
                style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
              />
            </div>

            <button
              type="submit"
              className="w-full py-2 text-xs font-bold uppercase border cursor-pointer"
              style={{
                backgroundColor: 'var(--accent-amber-bg)',
                borderColor: 'var(--accent-amber)',
                color: 'var(--accent-amber)',
              }}
            >
              {authMode === 'login' ? 'Sign In & Sync Projects' : 'Create Account & Migrate'}
            </button>
          </form>

          <div className="border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="text-[11px] font-mono-tabular uppercase mb-2" style={{ color: 'var(--text-secondary)' }}>
              Or Continue with Federated OAuth Provider
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(['google', 'microsoft', 'reddit', 'meta'] as const).map((prov) => (
                <button
                  key={prov}
                  type="button"
                  onClick={() => handleOAuthSignIn(prov)}
                  className="px-3 py-1.5 text-xs font-mono-tabular uppercase border cursor-pointer"
                  style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                >
                  {prov}
                </button>
              ))}
            </div>
          </div>

          <div className="text-xs text-center">
            {authMode === 'login' ? (
              <span>
                Need an account?{' '}
                <button
                  type="button"
                  onClick={() => setAuthMode('register')}
                  className="underline font-semibold cursor-pointer"
                >
                  Register here
                </button>
              </span>
            ) : (
              <span>
                Already registered?{' '}
                <button
                  type="button"
                  onClick={() => setAuthMode('login')}
                  className="underline font-semibold cursor-pointer"
                >
                  Sign in
                </button>
              </span>
            )}
          </div>
        </div>
      </dialog>

      {/* Dialog 2: Custom Vendor Shipping & Tax Threshold Profiles */}
      <dialog
        ref={vendorDialogRef}
        {...({ closedby: 'any' } as React.DialogHTMLAttributes<HTMLDialogElement>)}
        aria-labelledby="vendor-dialog-title"
        className="workshop-dialog"
      >
        <div
          className="px-4 py-3 border-b flex items-center justify-between"
          style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
        >
          <h2 id="vendor-dialog-title" className="font-bold text-sm uppercase tracking-wider">
            Vendor Shipping &amp; Free-Shipping Threshold Profiles
          </h2>
          <button
            type="button"
            onClick={() => vendorDialogRef.current?.close()}
            className="text-xs px-2 py-0.5 border cursor-pointer"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            Done
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3">
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            Configure flat per-order shipping charges, free-shipping order minimums (e.g. $49.00 on FCP Euro or $35.00
            on Amazon), and vendor-specific tax rates. The bundle solver factors these thresholds into account when
            consolidating orders.
          </p>

          {!user && (
            <div
              className="p-2.5 border text-xs flex items-center justify-between gap-2"
              style={{
                backgroundColor: 'var(--accent-amber-bg)',
                borderColor: 'var(--accent-amber)',
              }}
            >
              <span>
                Custom per-vendor shipping &amp; free-shipping thresholds require a Registered Account (Guest mode uses
                per-item shipping &amp; default project tax).
              </span>
              <button
                type="button"
                onClick={() => {
                  vendorDialogRef.current?.close();
                  authDialogRef.current?.showModal();
                }}
                className="px-2.5 py-1 font-semibold border shrink-0 cursor-pointer"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderColor: 'var(--accent-amber)',
                  color: 'var(--accent-amber)',
                }}
              >
                Sign In to Unlock
              </button>
            </div>
          )}

          <div className="table-wrapper">
            <table className="workshop-table">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Flat Order Ship ($)</th>
                  <th>Free Ship Min ($)</th>
                  <th>Tax Rate (%)</th>
                </tr>
              </thead>
              <tbody>
                {distinctVendors.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-center py-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                      No vendors in this project yet. Add an offering in Tab 2 to configure vendor shipping &amp;
                      free-shipping minimums.
                    </td>
                  </tr>
                ) : (
                  distinctVendors.map((vp) => (
                    <tr key={vp.vendor_name}>
                      <th scope="row">{vp.vendor_name}</th>
                      <td>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          disabled={!user || isReadOnlyShare}
                          value={((vp.flat_shipping_cents || 0) / 100).toFixed(2)}
                          onChange={(e) =>
                            handleUpdateVendorProfile(vp.vendor_name, {
                              flat_shipping_cents: Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 100)),
                            })
                          }
                          className="w-20 px-1.5 py-0.5 text-xs font-mono-tabular border disabled:opacity-60"
                          style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="None"
                          disabled={!user || isReadOnlyShare}
                          value={
                            vp.free_shipping_threshold_cents !== null && vp.free_shipping_threshold_cents !== undefined
                              ? (vp.free_shipping_threshold_cents / 100).toFixed(2)
                              : ''
                          }
                          onChange={(e) => {
                            const raw = e.target.value.trim();
                            handleUpdateVendorProfile(vp.vendor_name, {
                              free_shipping_threshold_cents:
                                raw === '' ? null : Math.max(0, Math.round((parseFloat(raw) || 0) * 100)),
                            });
                          }}
                          className="w-24 px-1.5 py-0.5 text-xs font-mono-tabular border disabled:opacity-60"
                          style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="50"
                          disabled={!user || isReadOnlyShare}
                          value={((vp.tax_rate_bps ?? activeProject.default_tax_bps ?? 0) / 100).toFixed(2)}
                          onChange={(e) =>
                            handleUpdateVendorProfile(vp.vendor_name, {
                              tax_rate_bps: Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 100)),
                            })
                          }
                          className="w-20 px-1.5 py-0.5 text-xs font-mono-tabular border disabled:opacity-60"
                          style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </dialog>

      {/* Dialog 3: Cryptographic Share Link Modal */}
      <dialog
        ref={shareDialogRef}
        {...({ closedby: 'any' } as React.DialogHTMLAttributes<HTMLDialogElement>)}
        aria-labelledby="share-dialog-title"
        className="workshop-dialog"
      >
        <div
          className="px-4 py-3 border-b flex items-center justify-between"
          style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
        >
          <h2 id="share-dialog-title" className="font-bold text-sm uppercase tracking-wider">
            Share Read-Only Project Link
          </h2>
          <button
            type="button"
            onClick={() => shareDialogRef.current?.close()}
            className="text-xs px-2 py-0.5 border cursor-pointer"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            Close
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3">
          {activeProject.share_token ? (
            <>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Anyone with this 128-bit token link can view the BOM, coverage matrix, and optimal bundle breakdown in
                read-only mode:
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={`${window.location.origin}/?share=${activeProject.share_token}`}
                  className="flex-1 px-2.5 py-1.5 text-xs font-mono-tabular border"
                  style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                />
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(
                      `${window.location.origin}/?share=${activeProject.share_token}`
                    );
                    setStatusBanner({ type: 'success', text: 'Copied share link to clipboard!' });
                  }}
                  className="px-3 py-1.5 text-xs font-semibold border flex items-center gap-1 cursor-pointer"
                  style={{
                    backgroundColor: 'var(--accent-emerald-bg)',
                    borderColor: 'var(--accent-emerald)',
                    color: 'var(--accent-emerald)',
                  }}
                >
                  <Copy className="w-3.5 h-3.5" /> Copy
                </button>
              </div>
              <div>
                <button
                  type="button"
                  onClick={handleRevokeShareToken}
                  className="text-xs underline cursor-pointer"
                  style={{ color: 'var(--accent-danger)' }}
                >
                  Revoke Share Link
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Generate a public read-only link for this project to share with clients, friends, or build forums.
              </p>
              <button
                type="button"
                onClick={handleGenerateShareToken}
                className="px-3 py-2 text-xs font-bold uppercase border cursor-pointer"
                style={{
                  backgroundColor: 'var(--accent-amber-bg)',
                  borderColor: 'var(--accent-amber)',
                  color: 'var(--accent-amber)',
                }}
              >
                Generate 128-Bit Share Link
              </button>
            </>
          )}
        </div>
      </dialog>

      {/* Dialog 4: Purchase Record Modal (native <dialog closedby="any">) */}
      <dialog
        ref={purchaseDialogRef}
        {...({ closedby: 'any' } as React.DialogHTMLAttributes<HTMLDialogElement>)}
        aria-labelledby="purchase-dialog-title"
        className="workshop-dialog"
      >
        <div
          className="px-4 py-3 border-b flex items-center justify-between"
          style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
        >
          <h2 id="purchase-dialog-title" className="font-bold text-sm uppercase tracking-wider flex items-center gap-1.5">
            <Check className="w-4 h-4 text-[var(--accent-emerald)]" />
            {editingPurchaseId ? 'Edit Purchase Record' : 'Record Procurement / Purchase'}
          </h2>
          <button
            type="button"
            onClick={() => purchaseDialogRef.current?.close()}
            className="text-xs px-2 py-0.5 border cursor-pointer"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            ESC
          </button>
        </div>

        <form onSubmit={handleSavePurchase} className="p-4 flex flex-col gap-3">
          {purchaseTarget && (
            <div
              className="p-2.5 border text-xs"
              style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
            >
              <div className="font-semibold text-xs text-[var(--text-primary)]">
                {purchaseTarget.type === 'offering'
                  ? `${purchaseTarget.qty}× ${purchaseTarget.offering.title}`
                  : `${purchaseTarget.qty}× ${purchaseTarget.part.name}`}
              </div>
              <div className="text-[11px] font-mono-tabular mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                {purchaseTarget.type === 'offering'
                  ? `Vendor: ${purchaseTarget.vendorName || purchaseTarget.offering.vendor_name}`
                  : `Direct BOM Item: ${purchaseTarget.part.category_tag || 'Part'}`}
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
              Actual Final Paid Amount ($)
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              required
              value={purchasePaidAmount}
              onChange={(e) => setPurchasePaidAmount(e.target.value)}
              placeholder="0.00"
              className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-strong)' }}
            />
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Enter final out-of-pocket amount paid (including applicable tax/shipping) or $0.00 if already owned.
            </span>
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
              Order / Tracking # (Optional)
            </label>
            <input
              type="text"
              value={purchaseOrderNumber}
              onChange={(e) => setPurchaseOrderNumber(e.target.value)}
              placeholder="e.g. 114-8291048-91823 or store receipt #"
              className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
              Notes / Location (Optional)
            </label>
            <input
              type="text"
              value={purchaseNotes}
              onChange={(e) => setPurchaseNotes(e.target.value)}
              placeholder="e.g. Bought on eBay, or pulled from garage shelf"
              className="w-full px-2.5 py-1.5 text-xs border"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
            />
          </div>

          <div className="pt-2 flex justify-end gap-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <button
              type="button"
              onClick={() => purchaseDialogRef.current?.close()}
              className="px-3 py-1.5 text-xs border cursor-pointer"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 text-xs font-semibold border cursor-pointer"
              style={{
                backgroundColor: 'var(--accent-emerald-bg)',
                borderColor: 'var(--accent-emerald)',
                color: 'var(--accent-emerald)',
              }}
            >
              {editingPurchaseId ? 'Save Changes' : 'Confirm Purchase'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
