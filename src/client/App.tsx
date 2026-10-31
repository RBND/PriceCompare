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
  Shield,
  Key,
  Mail,
  Lock,
  Smartphone,
  UserCog,
  ShieldAlert,
  Settings,
  RefreshCw,
  UserX,
  CheckCircle,
  Search,
  Loader2,
  Compass,
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
  type AdminUserPublic,
  type GuestMigrationPayload,
  type AccountSecurityState,
  type PasskeyPublic,
  type OAuthAccountPublic,
  type SessionPublic,
} from '../shared/types.js';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { solveBundleOptimization, type SolverResult, type SolverInput } from '../shared/solver.js';
import { generateProjectCsv, formatCentsToDollars } from '../shared/export.js';
import { DEMO_BRAKE_PROJECT, DEMO_PC_PROJECT } from '../shared/demoData.js';
import QRCode from 'qrcode';
import { Bookmark, Pin, PinOff } from 'lucide-react';
import { ShareExportModal } from './ShareExportModal.js';
import { BookmarkletModal } from './BookmarkletModal.js';
import { BookmarkletConfirmationModal } from './BookmarkletConfirmationModal.js';
import { BookmarkletUndoToast } from './BookmarkletUndoToast.js';
import { OnboardingTour, TUTORIAL_COMPLETED_KEY, type TourStep } from './OnboardingTour.js';
import {
  BookmarkletPayloadSchema,
  sanitizeIncomingBookmarkletPayload,
  evaluateImportConfidence,
  applyBookmarkletImportToProject,
  buildBookmarkletHref,
  type BookmarkletPayload,
  type VerifiedBookmarkletCommit,
} from '../shared/bookmarklet.js';

const GUEST_STORAGE_KEY = 'priceit_guest_project_v2';
const GUEST_MAX_PARTS = 10;
const ACTIVE_CLOUD_ID_KEY = 'priceit_active_cloud_id';
const HAS_VISITED_KEY = 'priceit_has_visited';
const BOOKMARKLET_COMMIT_STORAGE_KEY = 'priceit_last_bookmarklet_commit';

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
    if (typeof localStorage !== 'undefined') {
      const hasVisited = localStorage.getItem(HAS_VISITED_KEY);
      const raw = localStorage.getItem(GUEST_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredGuestState;
        if (parsed && parsed.project && Array.isArray(parsed.project.parts)) {
          return parsed;
        }
      }
      // If the user has visited before and has a cleared/empty workspace, do not resurrect demo
      if (hasVisited) {
        return {
          client_project_uuid: makeClientId('guest-uuid'),
          is_dirty: false,
          project: {
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
          },
        };
      }
    }
  } catch {
    // Ignore localStorage parse errors
  }

  // First time visitor: mark visited and load default introductory demo
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(HAS_VISITED_KEY, 'true');
    }
  } catch {}

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

  // Share / Export Modal & Bookmarklet State
  const [isShareExportModalOpen, setIsShareExportModalOpen] = useState(false);
  const [isBookmarkletModalOpen, setIsBookmarkletModalOpen] = useState(false);
  const [isTourOpen, setIsTourOpen] = useState<boolean>(() => {
    try {
      if (typeof window !== 'undefined' && window.location) {
        const path = window.location.pathname || '/';
        const search = window.location.search || '';
        const hash = window.location.hash || '';
        if (
          path.startsWith('/share/') ||
          path.startsWith('/admin') ||
          path.startsWith('/privacy') ||
          path.startsWith('/terms') ||
          search.includes('share=') ||
          hash.includes('import_part=') ||
          window.name === 'priceit_capture_window'
        ) {
          return false;
        }
      }
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(TUTORIAL_COMPLETED_KEY) !== 'true';
      }
    } catch {}
    return false;
  });
  const [tourStepIndex, setTourStepIndex] = useState(0);
  const [installKey, setInstallKey] = useState<string>(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        let key = localStorage.getItem('priceit_bookmarklet_install_key');
        if (!key) {
          key = makeClientId('bm');
          localStorage.setItem('priceit_bookmarklet_install_key', key);
        }
        return key;
      }
    } catch {}
    return makeClientId('bm');
  });
  const [pinnedBomPartId, setPinnedBomPartId] = useState<string | null>(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem('priceit_pinned_bom_part_id') || null;
      }
    } catch {}
    return null;
  });
  const [pendingBookmarkletImport, setPendingBookmarkletImport] = useState<{
    incoming: BookmarkletPayload;
    reasons: string[];
    targetPartId?: string | null;
  } | null>(null);
  const [bookmarkletToast, setBookmarkletToast] = useState<{
    id: string;
    vendorName: string;
    price: number;
    packageYield: number;
    prevProject: ProjectPayload;
  } | null>(null);
  const [printQrSvg, setPrintQrSvg] = useState<string>('');
  const bookmarkletAnchorRef = useRef<HTMLAnchorElement | null>(null);

  // Dialog refs (using native <dialog closedby="any"> + Safari light-dismiss fallback per modern-web-guidance)
  const authDialogRef = useRef<HTMLDialogElement | null>(null);
  const vendorDialogRef = useRef<HTMLDialogElement | null>(null);
  const shareDialogRef = useRef<HTMLDialogElement | null>(null);
  const purchaseDialogRef = useRef<HTMLDialogElement | null>(null);
  const settingsDialogRef = useRef<HTMLDialogElement | null>(null);
  const passwordlessPromoDialogRef = useRef<HTMLDialogElement | null>(null);
  const webauthnAbortRef = useRef<AbortController | null>(null);

  // Account Settings Modal State
  const [settingsTab, setSettingsTab] = useState<'profile' | 'security' | 'oauth' | 'passkeys' | 'sessions'>('profile');
  const [accountSecurity, setAccountSecurity] = useState<AccountSecurityState | null>(null);
  const [isLoadingAccountSecurity, setIsLoadingAccountSecurity] = useState(false);
  const [profileDisplayName, setProfileDisplayName] = useState('');
  const [newEmailInput, setNewEmailInput] = useState('');
  const [emailCurrentPassword, setEmailCurrentPassword] = useState('');
  const [verifyEmailTokenInput, setVerifyEmailTokenInput] = useState('');
  const [changePassCurrent, setChangePassCurrent] = useState('');
  const [changePassNew, setChangePassNew] = useState('');
  const [changePassConfirm, setChangePassConfirm] = useState('');
  const [deleteAccountConfirm, setDeleteAccountConfirm] = useState('');
  const [deleteAccountPassword, setDeleteAccountPassword] = useState('');
  const [passkeyCustomName, setPasskeyCustomName] = useState('');
  const [editingPasskeyId, setEditingPasskeyId] = useState<string | null>(null);
  const [editingPasskeyName, setEditingPasskeyName] = useState('');
  const [accountMessage, setAccountMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  // Admin Console State
  const [adminTab, setAdminTab] = useState<'users' | 'oauth' | 'system'>('users');
  const [adminUsers, setAdminUsers] = useState<AdminUserPublic[]>([]);
  const [adminOAuthConfigs, setAdminOAuthConfigs] = useState<
    Array<{ provider: string; client_id: string; is_secret_set: boolean; enabled: boolean; redirect_uri?: string }>
  >([]);
  const [oauthInputs, setOauthInputs] = useState<Record<string, { client_id: string; client_secret: string; enabled: boolean }>>({});
  const [adminSearch, setAdminSearch] = useState('');
  const [isLoadingAdmin, setIsLoadingAdmin] = useState(false);
  const [adminMessage, setAdminMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Routing State for /admin and /
  const [currentPath, setCurrentPath] = useState<string>(() => {
    if (typeof window !== 'undefined' && window.location) {
      return window.location.pathname || '/';
    }
    return '/';
  });
  const [authLoading, setAuthLoading] = useState(true);

  const navigateTo = (path: string) => {
    if (typeof window !== 'undefined' && window.history) {
      window.history.pushState({}, '', path);
      setCurrentPath(path);
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handlePopState = () => {
      setCurrentPath(window.location.pathname || '/');
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (currentPath.startsWith('/admin') && user?.is_admin) {
      void fetchAdminData();
    }
  }, [currentPath, user?.is_admin]);

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

  function handleStartTour() {
    setTourStepIndex(0);
    setActiveTab('bom');
    setIsTourOpen(true);
  }

  function handleCloseTour() {
    setIsTourOpen(false);
    setActiveTab('bom');
    if (!isReadOnlyShare) {
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
    }
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(TUTORIAL_COMPLETED_KEY, 'true');
      }
    } catch {}
  }

  function handleTourStepChange(nextIndex: number, step: TourStep) {
    if (tourStepIndex === 0 && nextIndex > 0 && !isReadOnlyShare) {
      setConflictServerVersion(null);
      const demoCopy: ProjectPayload = {
        ...structuredClone(DEMO_BRAKE_PROJECT),
        id: undefined,
        client_project_uuid: makeClientId('uuid'),
        version: 1,
      };
      updateProject(() => demoCopy, true);
    }
    setTourStepIndex(nextIndex);
    if (step.tab && step.tab !== activeTab) {
      setActiveTab(step.tab);
    }
    if (step.expandVendorSection) {
      setIsVendorSectionOpen(true);
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

  // Polyfill WebAuthn if available and setup native <dialog> fallback for browsers without closedBy support (per modern-web-guidance: light-dismiss-a-dialog)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      import('webauthn-polyfills').catch(() => {});
    }

    const dialogs = [
      authDialogRef.current,
      vendorDialogRef.current,
      shareDialogRef.current,
      purchaseDialogRef.current,
      settingsDialogRef.current,
      passwordlessPromoDialogRef.current,
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

  // Check URL for ?share=<token>, OAuth redirect params, or logged-in session on startup
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pathMatch = window.location.pathname.match(/^\/share\/([A-Za-z0-9_-]+)/);
    const shareToken = pathMatch ? pathMatch[1] : params.get('share');
    const oauthLogin = params.get('oauth_login');
    const oauthLinked = params.get('oauth_linked');
    const oauthErrorParam = params.get('oauth_error');

    if (oauthLogin || oauthLinked || oauthErrorParam) {
      const nextParams = new URLSearchParams(window.location.search);
      nextParams.delete('oauth_login');
      nextParams.delete('oauth_linked');
      nextParams.delete('oauth_error');
      const cleanQuery = nextParams.toString();
      if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState(
          {},
          '',
          `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${window.location.hash}`
        );
      }
    }

    if (oauthErrorParam) {
      setAuthError(oauthErrorParam);
      setStatusBanner({ type: 'error', text: oauthErrorParam });
    }

    if (shareToken) {
      setIsTourOpen(false);
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
          setIsTourOpen(false);
          let migratedProjectId: string | null = null;
          if (oauthLogin && guestStateRef.current.is_dirty && guestStateRef.current.project.parts.length > 0) {
            try {
              const migPayload = buildGuestMigrationPayload();
              if (migPayload) {
                const migRes = await apiFetch<{ migrated_project_id: string | null }>('/api/projects/migrate-guest', {
                  method: 'POST',
                  body: JSON.stringify(migPayload),
                });
                migratedProjectId = migRes.migrated_project_id;
                try {
                  localStorage.removeItem(GUEST_STORAGE_KEY);
                } catch {}
                setGuestState((prev) => ({ ...prev, is_dirty: false }));
              }
            } catch {}
          }
          await refreshCloudProjectsAndSelect(shareToken ? false : true, migratedProjectId);
          if (oauthLogin) {
            setStatusBanner({
              type: 'success',
              text: migratedProjectId
                ? `Signed in via ${oauthLogin.toUpperCase()} as ${data.user.display_name} & migrated your guest project!`
                : `Signed in via ${oauthLogin.toUpperCase()} as ${data.user.display_name}.`,
            });
          } else if (oauthLinked) {
            setStatusBanner({
              type: 'success',
              text: `Connected ${oauthLinked.toUpperCase()} account successfully.`,
            });
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        setAuthLoading(false);
      });
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

  // Set bookmarklet anchor href imperatively to bypass React 19 JSX blocker
  useEffect(() => {
    if (bookmarkletAnchorRef.current) {
      bookmarkletAnchorRef.current.setAttribute('href', buildBookmarkletHref(installKey));
    }
  }, [installKey]);

  // PriceIt Bookmarklet Receiver and Multi-Tab Synchronization Bus
  const syncChannelRef = useRef<BroadcastChannel | null>(null);
  const processedCommitIdsRef = useRef<Set<string>>(new Set());
  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;
  const guestStateRef = useRef(guestState);
  guestStateRef.current = guestState;
  const isReadOnlyShareRef = useRef(isReadOnlyShare);
  isReadOnlyShareRef.current = isReadOnlyShare;
  const pinnedBomPartIdRef = useRef(pinnedBomPartId);
  pinnedBomPartIdRef.current = pinnedBomPartId;
  const installKeyRef = useRef(installKey);
  installKeyRef.current = installKey;
  const userRef = useRef(user);
  userRef.current = user;
  const authLoadingRef = useRef(authLoading);
  authLoadingRef.current = authLoading;

  function applyRemoteBookmarkletCommit(commit: VerifiedBookmarkletCommit, commitId?: string) {
    if (commitId) {
      if (processedCommitIdsRef.current.has(commitId)) return;
      processedCommitIdsRef.current.add(commitId);
    }
    const prev = activeProjectRef.current;
    updateProject((p) => applyBookmarkletImportToProject(p, commit));
    setBookmarkletToast({
      id: commitId || `toast_${Date.now()}`,
      vendorName: commit.vendorName,
      price: commit.price,
      packageYield: commit.packageYield,
      prevProject: prev,
    });
  }

  async function commitBookmarkletImport(finalCommit: VerifiedBookmarkletCommit) {
    const commitId = makeClientId('bm-commit');
    processedCommitIdsRef.current.add(commitId);
    const prev = activeProjectRef.current;
    const nextProject = applyBookmarkletImportToProject(prev, finalCommit);
    updateProject(() => nextProject);
    setPendingBookmarkletImport(null);

    const message = {
      type: 'PRICEIT_COMMIT_PART',
      commitId,
      payload: finalCommit,
    };
    if (syncChannelRef.current) {
      syncChannelRef.current.postMessage(message);
    } else if (typeof BroadcastChannel !== 'undefined') {
      try {
        const tempChannel = new BroadcastChannel('priceit_bom_sync');
        tempChannel.postMessage(message);
        tempChannel.close();
      } catch {}
    }

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(
          BOOKMARKLET_COMMIT_STORAGE_KEY,
          JSON.stringify({
            commitId,
            payload: finalCommit,
            timestamp: Date.now(),
          })
        );
      }
    } catch {}

    const isPopupWindow = typeof window !== 'undefined' && window.name === 'priceit_capture_window';
    if (!isPopupWindow) {
      setBookmarkletToast({
        id: commitId,
        vendorName: finalCommit.vendorName,
        price: finalCommit.price,
        packageYield: finalCommit.packageYield,
        prevProject: prev,
      });
    }

    if (userRef.current && nextProject.id) {
      const saved = await saveCloudProjectNow(nextProject);
      if (saved && syncChannelRef.current) {
        syncChannelRef.current.postMessage({
          type: 'PRICEIT_CLOUD_PROJECT_SAVED',
          projectId: saved.id,
          version: saved.version,
        });
      }
    }

    if (isPopupWindow) {
      setTimeout(() => window.close(), 250);
    }
  }

  function processIncomingHashImport() {
    if (authLoadingRef.current || typeof window === 'undefined' || !window.location) return;
    const hash = window.location.hash;
    if (!hash || !hash.includes('import_part=')) return;

    const match = hash.match(/import_part=([^&]+)/);
    if (!match) return;

    if (window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
    }
    try {
      const raw = JSON.parse(decodeURIComponent(match[1]));
      const parsed = BookmarkletPayloadSchema.safeParse(raw);
      if (parsed.success) {
        const incoming = sanitizeIncomingBookmarkletPayload(parsed.data);
        const currentProject = activeProjectRef.current;
        const isTrustedKey = incoming.installKey === installKeyRef.current;
        const isGuestFull = !userRef.current && currentProject.parts.length >= GUEST_MAX_PARTS;
        const evalResult = evaluateImportConfidence(
          incoming,
          currentProject.parts,
          pinnedBomPartIdRef.current,
          false,
          isTrustedKey,
          isGuestFull
        );

        if (
          evalResult.decision === 'AUTO_ADD_TO_EXISTING' ||
          evalResult.decision === 'AUTO_ADD_AS_NEW'
        ) {
          void commitBookmarkletImport({
            bomAction:
              evalResult.decision === 'AUTO_ADD_TO_EXISTING'
                ? 'ATTACH_EXISTING'
                : 'CREATE_NEW',
            targetBomPartId: evalResult.targetBomPart?.id || null,
            partName: incoming.partName,
            partNumber: incoming.partNumber || incoming.vendorSku || '',
            price: incoming.price || 0,
            packageYield: incoming.packageYield || 1,
            shippingCost: incoming.shippingCost || 0,
            vendorName: incoming.vendorHost || 'Vendor',
            referenceUrl: incoming.url,
            vendorSku: incoming.vendorSku,
            brand: incoming.brand,
            shippingRuleNote: incoming.shippingNote,
            inStock: incoming.inStock,
          });
        } else {
          setPendingBookmarkletImport({
            incoming,
            reasons: evalResult.reasonsToConfirm,
            targetPartId: evalResult.targetBomPart?.id || null,
          });

          // Enrich eBay and Amazon items via official eBay Buy Browse API (e.g., Manufacturer Part Number / OE/OEM Part Number & shipping)
          const lowerHost = incoming.vendorHost.toLowerCase();
          const lowerUrl = incoming.url.toLowerCase();
          if (
            (lowerHost.includes('ebay.') ||
              lowerUrl.includes('ebay.') ||
              lowerHost.includes('amazon.') ||
              lowerUrl.includes('amazon.')) &&
            typeof fetch === 'function'
          ) {
            fetch(
              `/api/sourcing/ebay-item?url=${encodeURIComponent(incoming.url)}&title=${encodeURIComponent(incoming.partName)}&hintPn=${encodeURIComponent(incoming.partNumber)}`
            )
              .then((r) => (r.ok ? r.json() : null))
              .then(
                (
                  ebayData: {
                    itemId?: string;
                    partNumber?: string;
                    brand?: string;
                    price?: number | null;
                    shippingCost?: number | null;
                  } | null
                ) => {
                  if (!ebayData) return;
                  setPendingBookmarkletImport((prevPending) => {
                    if (!prevPending || prevPending.incoming.url !== incoming.url) return prevPending;
                    const enrichedIncoming: BookmarkletPayload = {
                      ...prevPending.incoming,
                      partNumber: ebayData.partNumber || prevPending.incoming.partNumber,
                      brand: ebayData.brand || prevPending.incoming.brand,
                      vendorSku: ebayData.itemId || prevPending.incoming.vendorSku,
                      price:
                        prevPending.incoming.price && prevPending.incoming.price > 0
                          ? prevPending.incoming.price
                          : (ebayData.price ?? prevPending.incoming.price),
                      shippingCost:
                        prevPending.incoming.shippingCost !== null &&
                        prevPending.incoming.shippingCost !== undefined
                          ? prevPending.incoming.shippingCost
                          : (ebayData.shippingCost ?? null),
                    };
                    const reEval = evaluateImportConfidence(
                      enrichedIncoming,
                      activeProjectRef.current.parts,
                      pinnedBomPartIdRef.current,
                      false,
                      isTrustedKey,
                      !userRef.current && activeProjectRef.current.parts.length >= GUEST_MAX_PARTS
                    );
                    return {
                      incoming: enrichedIncoming,
                      reasons: reEval.reasonsToConfirm,
                      targetPartId: reEval.targetBomPart?.id || prevPending.targetPartId,
                    };
                  });
                }
              )
              .catch(() => {});
          }
        }
      }
    } catch (e) {
      console.error('Failed to parse incoming bookmarklet payload:', e);
    }
  }

  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        const existingRaw = localStorage.getItem(BOOKMARKLET_COMMIT_STORAGE_KEY);
        if (existingRaw) {
          const existingParsed = JSON.parse(existingRaw) as { commitId?: string };
          if (existingParsed && existingParsed.commitId) {
            processedCommitIdsRef.current.add(existingParsed.commitId);
          }
        }
      }
    } catch {}

    const channel =
      typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel('priceit_bom_sync')
        : null;
    syncChannelRef.current = channel;

    if (channel) {
      channel.onmessage = (event) => {
        if (!event.data) return;
        if (event.data.type === 'PING_MAIN_TAB') {
          if (typeof window === 'undefined' || window.name !== 'priceit_capture_window') {
            channel.postMessage({
              type: 'PONG_MAIN_TAB',
              project: activeProjectRef.current,
              parts: activeProjectRef.current.parts,
              pinnedBomPartId: pinnedBomPartIdRef.current,
              guestCount: activeProjectRef.current.parts.length,
            });
          }
        } else if (event.data.type === 'PONG_MAIN_TAB') {
          if (typeof window !== 'undefined' && window.name === 'priceit_capture_window' && event.data.project) {
            const incomingProj = event.data.project as ProjectPayload;
            if (!activeProjectRef.current.id || incomingProj.id === activeProjectRef.current.id) {
              setActiveProject(incomingProj);
            }
            if (event.data.pinnedBomPartId !== undefined) {
              setPinnedBomPartId(event.data.pinnedBomPartId);
            }
          }
        } else if (event.data.type === 'PRICEIT_COMMIT_PART') {
          const commit = event.data.payload as VerifiedBookmarkletCommit;
          applyRemoteBookmarkletCommit(commit, event.data.commitId);
        } else if (event.data.type === 'PRICEIT_CLOUD_PROJECT_SAVED') {
          if (
            event.data.projectId &&
            activeProjectRef.current.id === event.data.projectId &&
            typeof event.data.version === 'number'
          ) {
            setActiveProject((prev) => ({ ...prev, version: event.data.version }));
          }
        }
      };

      if (typeof window !== 'undefined' && window.name === 'priceit_capture_window') {
        channel.postMessage({ type: 'PING_MAIN_TAB' });
      }
    }

    const checkPendingStorageCommit = () => {
      try {
        if (typeof localStorage === 'undefined') return;
        const raw = localStorage.getItem(BOOKMARKLET_COMMIT_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as {
          commitId?: string;
          payload?: VerifiedBookmarkletCommit;
          timestamp?: number;
        };
        if (
          parsed &&
          parsed.commitId &&
          parsed.payload &&
          !processedCommitIdsRef.current.has(parsed.commitId) &&
          (!parsed.timestamp || Date.now() - parsed.timestamp < 5 * 60 * 1000)
        ) {
          applyRemoteBookmarkletCommit(parsed.payload, parsed.commitId);
        }
      } catch {}
    };

    const handleStorage = (e: StorageEvent) => {
      if (e.key === BOOKMARKLET_COMMIT_STORAGE_KEY && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue) as {
            commitId?: string;
            payload?: VerifiedBookmarkletCommit;
          };
          if (parsed && parsed.payload) {
            applyRemoteBookmarkletCommit(parsed.payload, parsed.commitId);
          }
        } catch {}
      } else if (e.key === 'priceit_pinned_bom_part_id') {
        setPinnedBomPartId(e.newValue || null);
      }
    };

    const handleHashChange = () => {
      processIncomingHashImport();
    };

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', handleStorage);
      window.addEventListener('focus', checkPendingStorageCommit);
      window.addEventListener('hashchange', handleHashChange);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', checkPendingStorageCommit);
    }

    return () => {
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('storage', handleStorage);
        window.removeEventListener('focus', checkPendingStorageCommit);
        window.removeEventListener('hashchange', handleHashChange);
      }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', checkPendingStorageCommit);
      }
      channel?.close();
      syncChannelRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!authLoading) {
      processIncomingHashImport();
    }
  }, [activeProject, pinnedBomPartId, installKey, user, authLoading]);

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

      let savedActiveId: string | null = null;
      try {
        if (typeof localStorage !== 'undefined') {
          savedActiveId = localStorage.getItem(ACTIVE_CLOUD_ID_KEY);
        }
      } catch {}

      const canAutoSelectFirst = selectFirst && !guestStateRef.current.is_dirty;
      const targetId =
        preferredId ||
        (savedActiveId && listRes.projects.some((p) => p.id === savedActiveId)
          ? savedActiveId
          : canAutoSelectFirst && listRes.projects[0]?.id);
      if (targetId) {
        const fullRes = await apiFetch<{ project: ProjectPayload & { share_token?: string | null } }>(
          `/api/projects/${targetId}`
        );
        activeProjectRef.current = fullRes.project;
        setActiveProject(fullRes.project);
        setIsReadOnlyShare(false);
        setConflictServerVersion(null);
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(ACTIVE_CLOUD_ID_KEY, targetId);
          }
        } catch {}
      }
    } catch {
      // ignore
    }
  }

  // Persist to localStorage for uncommitted/demo/guest workspaces or track active cloud project
  function updateProject(mutator: (prev: ProjectPayload) => ProjectPayload, allowResetReadOnly = false) {
    if (isReadOnlyShareRef.current && !allowResetReadOnly) return;

    setActiveProject((prev) => {
      const next = mutator(prev);
      if (!next.id) {
        const updatedGuest: StoredGuestState = {
          client_project_uuid: guestStateRef.current.client_project_uuid,
          is_dirty: true,
          project: {
            ...next,
            parts: userRef.current ? next.parts : next.parts.slice(0, GUEST_MAX_PARTS),
          },
        };
        guestStateRef.current = updatedGuest;
        activeProjectRef.current = updatedGuest.project;
        setGuestState(updatedGuest);
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(updatedGuest));
            localStorage.removeItem(ACTIVE_CLOUD_ID_KEY);
          }
        } catch {
          // ignore storage quota errors
        }
        return updatedGuest.project;
      } else {
        activeProjectRef.current = next;
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(ACTIVE_CLOUD_ID_KEY, next.id);
          }
        } catch {}
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
    if (window.location.pathname.startsWith('/share/')) {
      window.history.replaceState({}, '', '/');
    }
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

  async function saveCloudProjectNow(projectToSave = activeProject): Promise<(ProjectPayload & { share_token?: string | null }) | null> {
    if (!user || isReadOnlyShare) return null;
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
        await refreshCloudProjectsAndSelect(false, res.project.id);
        setStatusBanner({ type: 'success', text: `Saved v${res.project.version} to cloud.` });
        return res.project;
      } else {
        const res = await apiFetch<{ project: ProjectPayload & { share_token?: string | null } }>('/api/projects', {
          method: 'POST',
          body: JSON.stringify({
            ...sanitized,
            client_project_uuid: sanitized.client_project_uuid || makeClientId('uuid'),
          }),
        });
        setActiveProject(res.project);
        await refreshCloudProjectsAndSelect(false, res.project.id);
        setStatusBanner({ type: 'success', text: 'Created cloud project.' });
        return res.project;
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
      return null;
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

  function handleOAuthSignIn(provider: 'google' | 'facebook') {
    setAuthError('');
    const returnTo = typeof window !== 'undefined' && window.location.pathname.startsWith('/admin') ? '/admin' : '/';
    if (typeof window !== 'undefined') {
      window.location.href = `/api/auth/oauth/${provider}/start?mode=login&return_to=${encodeURIComponent(returnTo)}`;
    }
  }

  async function handleLogout() {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    setCloudProjects([]);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(ACTIVE_CLOUD_ID_KEY);
      }
    } catch {}
    const freshGuest = loadInitialGuestState();
    setGuestState(freshGuest);
    setActiveProject(freshGuest.project);
    setStatusBanner({ type: 'info', text: 'Signed out. Switched to local Guest workspace.' });
  }

  // WebAuthn Signal API helpers
  async function syncAcceptedCredentials(rpId: string, userIdBase64Url: string, credentialIds: string[]) {
    if (typeof window === 'undefined') return;
    try {
      const pkc = (window as unknown as { PublicKeyCredential?: Record<string, unknown> }).PublicKeyCredential;
      if (pkc && typeof pkc.signalAllAcceptedCredentials === 'function') {
        await (pkc.signalAllAcceptedCredentials as (opts: unknown) => Promise<void>)({
          rpId,
          userId: userIdBase64Url,
          allAcceptedCredentialIds: credentialIds,
        });
      }
    } catch (e) {
      console.warn('[WebAuthn] signalAllAcceptedCredentials error:', e);
    }
  }

  async function syncCurrentUserDetails(rpId: string, userIdBase64Url: string, name: string, displayName: string) {
    if (typeof window === 'undefined') return;
    try {
      const pkc = (window as unknown as { PublicKeyCredential?: Record<string, unknown> }).PublicKeyCredential;
      if (pkc && typeof pkc.signalCurrentUserDetails === 'function') {
        await (pkc.signalCurrentUserDetails as (opts: unknown) => Promise<void>)({
          rpId,
          userId: userIdBase64Url,
          name,
          displayName,
        });
      }
    } catch (e) {
      console.warn('[WebAuthn] signalCurrentUserDetails error:', e);
    }
  }

  async function signalUnknownCredential(rpId: string, credentialId: string) {
    if (typeof window === 'undefined') return;
    try {
      const pkc = (window as unknown as { PublicKeyCredential?: Record<string, unknown> }).PublicKeyCredential;
      if (pkc && typeof pkc.signalUnknownCredential === 'function') {
        await (pkc.signalUnknownCredential as (opts: unknown) => Promise<void>)({
          rpId,
          credentialId,
        });
      }
    } catch (e) {
      console.warn('[WebAuthn] signalUnknownCredential error:', e);
    }
  }

  async function fetchAccountSecurity() {
    try {
      setIsLoadingAccountSecurity(true);
      const res = await apiFetch<AccountSecurityState>('/api/auth/account');
      setAccountSecurity(res);
      setProfileDisplayName(res.display_name || user?.display_name || '');
      if (res.rp_id && res.user_id_base64url) {
        await syncAcceptedCredentials(res.rp_id, res.user_id_base64url, res.passkeys.map((p) => p.id));
      }
      return res;
    } catch (err: unknown) {
      setAccountMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to fetch account security',
      });
      return null;
    } finally {
      setIsLoadingAccountSecurity(false);
    }
  }

  async function handleOpenAccountSettings() {
    setAccountMessage(null);
    setNewEmailInput('');
    setEmailCurrentPassword('');
    setVerifyEmailTokenInput('');
    setChangePassCurrent('');
    setChangePassNew('');
    setChangePassConfirm('');
    setDeleteAccountConfirm('');
    setDeleteAccountPassword('');
    setPasskeyCustomName('');
    setEditingPasskeyId(null);
    settingsDialogRef.current?.showModal();
    await fetchAccountSecurity();
  }

  async function handleUpdateProfile(e: React.FormEvent) {
    e.preventDefault();
    setAccountMessage(null);
    try {
      const res = await apiFetch<{ user: UserPublic }>('/api/auth/profile', {
        method: 'PUT',
        body: JSON.stringify({ display_name: profileDisplayName }),
      });
      setUser(res.user);
      setAccountMessage({ type: 'success', text: 'Display name updated.' });
      if (accountSecurity?.rp_id && accountSecurity?.user_id_base64url) {
        await syncCurrentUserDetails(
          accountSecurity.rp_id,
          accountSecurity.user_id_base64url,
          res.user.email,
          res.user.display_name
        );
      }
      await fetchAccountSecurity();
    } catch (err: unknown) {
      setAccountMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to update profile',
      });
    }
  }

  async function handleRequestEmailChange(e: React.FormEvent) {
    e.preventDefault();
    setAccountMessage(null);
    try {
      const res = await apiFetch<{ ok: boolean; pending_email: string; dev_token?: string }>(
        '/api/auth/email/request',
        {
          method: 'POST',
          body: JSON.stringify({
            new_email: newEmailInput.trim(),
            current_password: emailCurrentPassword || undefined,
          }),
        }
      );
      setAccountMessage({
        type: 'info',
        text: res.dev_token
          ? `Verification requested! Dev token: ${res.dev_token}`
          : `Verification email sent to ${res.pending_email}. Please check your inbox or spam folder.`,
      });
      if (res.dev_token) {
        setVerifyEmailTokenInput(res.dev_token);
      }
      await fetchAccountSecurity();
    } catch (err: unknown) {
      setAccountMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to request email change',
      });
    }
  }

  async function handleVerifyEmailToken(e: React.FormEvent) {
    e.preventDefault();
    setAccountMessage(null);
    try {
      const res = await apiFetch<{ ok: boolean; user: UserPublic }>('/api/auth/email/verify', {
        method: 'POST',
        body: JSON.stringify({ token: verifyEmailTokenInput.trim() }),
      });
      setUser(res.user);
      setVerifyEmailTokenInput('');
      setNewEmailInput('');
      setEmailCurrentPassword('');
      setAccountMessage({ type: 'success', text: `Email successfully verified and updated to ${res.user.email}!` });
      if (accountSecurity?.rp_id && accountSecurity?.user_id_base64url) {
        await syncCurrentUserDetails(
          accountSecurity.rp_id,
          accountSecurity.user_id_base64url,
          res.user.email,
          res.user.display_name
        );
      }
      await fetchAccountSecurity();
    } catch (err: unknown) {
      setAccountMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Verification failed',
      });
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setAccountMessage(null);
    if (changePassNew !== changePassConfirm) {
      setAccountMessage({ type: 'error', text: 'New passwords do not match.' });
      return;
    }
    try {
      await apiFetch<{ ok: boolean; revoked_other_sessions: boolean }>('/api/auth/password/change', {
        method: 'POST',
        body: JSON.stringify({
          current_password: changePassCurrent,
          new_password: changePassNew,
        }),
      });
      setChangePassCurrent('');
      setChangePassNew('');
      setChangePassConfirm('');
      setAccountMessage({
        type: 'success',
        text: 'Password successfully changed. All other active sessions have been signed out.',
      });
      await fetchAccountSecurity();
    } catch (err: unknown) {
      setAccountMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to change password',
      });
    }
  }

  async function handleRemovePassword() {
    setAccountMessage(null);
    try {
      await apiFetch<{ ok: boolean; is_passwordless: boolean }>('/api/auth/password/remove', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      passwordlessPromoDialogRef.current?.close();
      setAccountMessage({
        type: 'success',
        text: 'Account converted to 100% passwordless! Password has been securely removed.',
      });
      await fetchAccountSecurity();
    } catch (err: unknown) {
      setAccountMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to remove password',
      });
    }
  }

  function handleLinkOAuth(provider: 'google' | 'facebook') {
    setAccountMessage(null);
    const returnTo = typeof window !== 'undefined' && window.location.pathname.startsWith('/admin') ? '/admin' : '/';
    if (typeof window !== 'undefined') {
      window.location.href = `/api/auth/oauth/${provider}/start?mode=link&return_to=${encodeURIComponent(returnTo)}`;
    }
  }

  async function handleUnlinkOAuth(provider: string) {
    setAccountMessage(null);
    try {
      await apiFetch(`/api/auth/oauth/${provider}`, { method: 'DELETE' });
      setAccountMessage({
        type: 'success',
        text: `Disconnected ${provider.toUpperCase()} account.`,
      });
      await fetchAccountSecurity();
    } catch (err: unknown) {
      setAccountMessage({
        type: 'error',
        text: err instanceof Error ? err.message : `Failed to unlink ${provider}`,
      });
    }
  }

  async function handleAddPasskey() {
    setAccountMessage(null);
    if (typeof window === 'undefined' || !window.PublicKeyCredential) {
      setAccountMessage({
        type: 'error',
        text: 'WebAuthn / Passkeys are not supported in this browser.',
      });
      return;
    }

    try {
      webauthnAbortRef.current?.abort();
      webauthnAbortRef.current = new AbortController();

      const rawRes = await apiFetch<any>('/api/auth/passkeys/register/options', {
        method: 'POST',
        body: JSON.stringify({ custom_name: passkeyCustomName.trim() || undefined }),
      });
      const options = rawRes.options || rawRes;
      const challengeId = rawRes.challengeId;

      const attResp = await startRegistration({
        optionsJSON: options,
      });

      const verifyRes = await apiFetch<{
        verified: boolean;
        passkey: PasskeyPublic;
        can_switch_passwordless: boolean;
        rp_id?: string;
        user_id_base64url?: string;
      }>('/api/auth/passkeys/register/verify', {
        method: 'POST',
        body: JSON.stringify({
          challengeId,
          ...attResp,
          custom_name: passkeyCustomName.trim() || undefined,
        }),
      });

      setPasskeyCustomName('');
      setAccountMessage({
        type: 'success',
        text: `Passkey "${verifyRes.passkey.name}" registered successfully!`,
      });

      const updatedSec = await fetchAccountSecurity();
      if (updatedSec?.rp_id && updatedSec?.user_id_base64url) {
        await syncAcceptedCredentials(
          updatedSec.rp_id,
          updatedSec.user_id_base64url,
          updatedSec.passkeys.map((p) => p.id)
        );
      }

      if (verifyRes.can_switch_passwordless) {
        passwordlessPromoDialogRef.current?.showModal();
      }
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') return;
      setAccountMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Passkey registration failed',
      });
    }
  }

  async function handleRenamePasskey(passkeyId: string) {
    if (!editingPasskeyName.trim()) return;
    try {
      await apiFetch(`/api/auth/passkeys/${encodeURIComponent(passkeyId)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editingPasskeyName.trim() }),
      });
      setEditingPasskeyId(null);
      setEditingPasskeyName('');
      await fetchAccountSecurity();
    } catch (err: unknown) {
      setAccountMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to rename passkey',
      });
    }
  }

  async function handleRevokePasskey(passkeyId: string) {
    if (!window.confirm('Are you sure you want to revoke this passkey?')) return;
    try {
      const res = await apiFetch<{ ok: boolean; credential_ids?: string[]; rp_id?: string; user_id_base64url?: string }>(
        `/api/auth/passkeys/${encodeURIComponent(passkeyId)}`,
        { method: 'DELETE' }
      );
      if (res.rp_id && res.user_id_base64url && res.credential_ids) {
        await syncAcceptedCredentials(res.rp_id, res.user_id_base64url, res.credential_ids);
      }
      setAccountMessage({ type: 'success', text: 'Passkey revoked.' });
      await fetchAccountSecurity();
    } catch (err: unknown) {
      setAccountMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to revoke passkey',
      });
    }
  }

  async function handlePasskeySignIn() {
    setAuthError('');
    if (typeof window === 'undefined' || !window.PublicKeyCredential) {
      setAuthError('Passkeys are not supported in this browser.');
      return;
    }

    try {
      webauthnAbortRef.current?.abort();
      webauthnAbortRef.current = new AbortController();

      const rawRes = await apiFetch<any>('/api/auth/passkeys/login/options', {
        method: 'POST',
      });
      const options = rawRes.options || rawRes;
      const challengeId = rawRes.challengeId;

      const asseResp = await startAuthentication({
        optionsJSON: options,
      });

      const res = await apiFetch<{ user: UserPublic }>('/api/auth/passkeys/login/verify', {
        method: 'POST',
        body: JSON.stringify({
          challengeId,
          ...asseResp,
        }),
      });

      setUser(res.user);
      authDialogRef.current?.close();
      await refreshCloudProjectsAndSelect(true);
      setStatusBanner({
        type: 'success',
        text: `Welcome back, ${res.user.display_name}! Signed in via Passkey.`,
      });
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') return;
      const apiErr = err as Error & { status?: number };
      if (apiErr.status === 404) {
        if (typeof window !== 'undefined') {
          const host = window.location.hostname || 'localhost';
          signalUnknownCredential(host, 'unknown');
        }
      }
      setAuthError(err instanceof Error ? err.message : 'Passkey sign-in failed');
    }
  }

  async function handleRevokeOtherSessions() {
    setAccountMessage(null);
    try {
      const res = await apiFetch<{ ok: boolean; revoked_count: number }>('/api/auth/sessions/revoke-others', {
        method: 'POST',
      });
      setAccountMessage({
        type: 'success',
        text: `Logged out ${res.revoked_count} other active device(s).`,
      });
      await fetchAccountSecurity();
    } catch (err: unknown) {
      setAccountMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to revoke other sessions',
      });
    }
  }

  async function handleRevokeSingleSession(sessionUid: string) {
    setAccountMessage(null);
    try {
      await apiFetch(`/api/auth/sessions/${sessionUid}`, { method: 'DELETE' });
      setAccountMessage({ type: 'success', text: 'Session revoked.' });
      await fetchAccountSecurity();
    } catch (err: unknown) {
      setAccountMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to revoke session',
      });
    }
  }

  async function handleDeleteAccount(e: React.FormEvent) {
    e.preventDefault();
    setAccountMessage(null);
    if (deleteAccountConfirm.trim() !== 'DELETE') {
      setAccountMessage({ type: 'error', text: 'Please type DELETE exactly to confirm.' });
      return;
    }
    if (!window.confirm('FINAL WARNING: This will permanently delete your account, projects, parts, and all credentials. Continue?')) {
      return;
    }

    try {
      const res = await apiFetch<{ ok: boolean; rp_id?: string; user_id_base64url?: string }>(
        '/api/auth/account/delete',
        {
          method: 'POST',
          body: JSON.stringify({
            confirmation: 'DELETE',
            current_password: deleteAccountPassword || undefined,
          }),
        }
      );

      if (res.rp_id && res.user_id_base64url) {
        await syncAcceptedCredentials(res.rp_id, res.user_id_base64url, []);
      }

      settingsDialogRef.current?.close();
      await handleLogout();
      setStatusBanner({
        type: 'info',
        text: 'Your PriceIt account and all associated data have been permanently deleted.',
      });
    } catch (err: unknown) {
      setAccountMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to delete account',
      });
    }
  }

  // Admin Console Handlers
  async function fetchAdminData() {
    setIsLoadingAdmin(true);
    setAdminMessage(null);
    try {
      const [usersRes, oauthRes] = await Promise.all([
        apiFetch<{ users: AdminUserPublic[] }>('/api/admin/users'),
        apiFetch<{ configs: Array<{ provider: string; client_id: string; is_secret_set: boolean; enabled: boolean }> }>('/api/admin/oauth'),
      ]);
      setAdminUsers(usersRes.users);
      setAdminOAuthConfigs(oauthRes.configs);
      const inputs: Record<string, { client_id: string; client_secret: string; enabled: boolean }> = {};
      for (const c of oauthRes.configs) {
        inputs[c.provider] = {
          client_id: c.client_id,
          client_secret: '',
          enabled: c.enabled,
        };
      }
      setOauthInputs(inputs);
    } catch (err: unknown) {
      setAdminMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to fetch administrator data',
      });
    } finally {
      setIsLoadingAdmin(false);
    }
  }

  function handleOpenAdminConsole() {
    navigateTo('/admin');
  }

  async function handleAdminBanUser(targetUser: AdminUserPublic) {
    const action = targetUser.is_banned ? 'Unban' : 'Ban & Suspend';
    if (!window.confirm(`${action} user "${targetUser.email}"? ${targetUser.is_banned ? 'They will be allowed to log in again.' : 'Their sessions will be terminated immediately.'}`)) {
      return;
    }
    try {
      await apiFetch(`/api/admin/users/${targetUser.id}/ban`, {
        method: 'POST',
        body: JSON.stringify({ banned: !targetUser.is_banned }),
      });
      setAdminMessage({
        type: 'success',
        text: `User ${targetUser.email} has been ${targetUser.is_banned ? 'unbanned' : 'banned'}.`,
      });
      await fetchAdminData();
    } catch (err: unknown) {
      setAdminMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to update ban status',
      });
    }
  }

  async function handleAdminResetPassword(targetUser: AdminUserPublic) {
    if (!window.confirm(`Force password reset for "${targetUser.email}"? This will lock their account, terminate all active sessions, and generate a reset token.`)) {
      return;
    }
    try {
      const res = await apiFetch<{ ok: boolean; reset_token?: string }>(`/api/admin/users/${targetUser.id}/reset-password`, {
        method: 'POST',
      });
      setAdminMessage({
        type: 'success',
        text: res.reset_token
          ? `Account locked & reset token generated for ${targetUser.email}: ${res.reset_token}`
          : `Account locked. Password reset email dispatched to ${targetUser.email}.`,
      });
      await fetchAdminData();
    } catch (err: unknown) {
      setAdminMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to force password reset',
      });
    }
  }

  async function handleAdminPromote(targetUser: AdminUserPublic) {
    const action = targetUser.is_admin ? 'Revoke Administrator' : 'Promote to Administrator';
    if (!window.confirm(`${action} for "${targetUser.email}"?`)) return;
    try {
      await apiFetch(`/api/admin/users/${targetUser.id}/promote`, {
        method: 'POST',
        body: JSON.stringify({ is_admin: !targetUser.is_admin }),
      });
      setAdminMessage({
        type: 'success',
        text: `Updated admin permissions for ${targetUser.email}.`,
      });
      await fetchAdminData();
    } catch (err: unknown) {
      setAdminMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to update admin permissions',
      });
    }
  }

  async function handleAdminDeleteUser(targetUser: AdminUserPublic) {
    if (!window.confirm(`PERMANENTLY DELETE user "${targetUser.email}" and all their projects? This cannot be undone.`)) {
      return;
    }
    try {
      await apiFetch(`/api/admin/users/${targetUser.id}`, { method: 'DELETE' });
      setAdminMessage({ type: 'success', text: `User ${targetUser.email} was permanently deleted.` });
      await fetchAdminData();
    } catch (err: unknown) {
      setAdminMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to delete user',
      });
    }
  }

  async function handleSaveOAuthConfig(provider: string) {
    const input = oauthInputs[provider];
    if (!input) return;
    try {
      await apiFetch('/api/admin/oauth', {
        method: 'PUT',
        body: JSON.stringify({
          provider,
          client_id: input.client_id,
          client_secret: input.client_secret || undefined,
          enabled: input.enabled,
        }),
      });
      setAdminMessage({
        type: 'success',
        text: `OAuth configuration for ${provider.toUpperCase()} saved successfully.`,
      });
      await fetchAdminData();
    } catch (err: unknown) {
      setAdminMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save OAuth config',
      });
    }
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

  async function handlePrintDatasheet() {
    if (!user) {
      setStatusBanner({
        type: 'info',
        text: 'Sign in to print or export official PDF BOM datasheets.',
      });
      authDialogRef.current?.showModal();
      return;
    }

    if (!activeProject.id || !cloudProjects.some((cp) => cp.id === activeProject.id)) {
      await saveCloudProjectNow();
    }

    let token = activeProject.share_token;
    if (!token && activeProject.id) {
      token = await handleGenerateShareToken();
    }

    const targetUrl = token ? `https://priceit.rbnd.cc/share/${token}` : `https://priceit.rbnd.cc`;
    try {
      const svg = await QRCode.toString(targetUrl, {
        type: 'svg',
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      });
      setPrintQrSvg(svg);
    } catch {}

    requestAnimationFrame(() => {
      setTimeout(() => {
        window.print();
      }, 100);
    });
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

  async function handleGenerateShareToken(): Promise<string | null> {
    if (!user) {
      setStatusBanner({
        type: 'info',
        text: 'Sign in to generate read-only cryptographic share links.',
      });
      authDialogRef.current?.showModal();
      return null;
    }

    let targetProjectId = activeProject.id;
    if (!targetProjectId || !cloudProjects.some((cp) => cp.id === targetProjectId)) {
      const saved = await saveCloudProjectNow();
      if (!saved || !saved.id) return null;
      targetProjectId = saved.id;
    }

    try {
      const res = await apiFetch<{ share_token: string }>(`/api/projects/${targetProjectId}/share`, {
        method: 'POST',
      });
      setActiveProject((prev) => ({ ...prev, id: targetProjectId, share_token: res.share_token }));
      if (typeof window !== 'undefined') {
        window.history.pushState({}, document.title, `/share/${res.share_token}`);
      }
      return res.share_token;
    } catch (err: unknown) {
      setStatusBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to generate share link',
      });
      return null;
    }
  }

  async function handleRevokeShareToken() {
    if (!activeProject.id) return;
    try {
      await apiFetch(`/api/projects/${activeProject.id}/share`, { method: 'DELETE' });
      setActiveProject((prev) => ({ ...prev, share_token: null }));
      if (typeof window !== 'undefined' && window.location.pathname.startsWith('/share/')) {
        window.history.replaceState({}, document.title, '/');
      }
    } catch {}
  }

  function handleTogglePinBomPart(partId: string | null) {
    if (!partId || pinnedBomPartId === partId) {
      setPinnedBomPartId(null);
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem('priceit_pinned_bom_part_id');
        }
      } catch {}
    } else {
      setPinnedBomPartId(partId);
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('priceit_pinned_bom_part_id', partId);
        }
      } catch {}
    }
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

  // Dedicated Route: /privacy policy (accessible directly via priceit.rbnd.cc/privacy)
  if (currentPath.startsWith('/privacy')) {
    return (
      <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--bg-base)' }}>
        <header className="border-b px-6 py-3 flex items-center justify-between" style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2">
            <span className="font-bold tracking-tight text-sm uppercase">PriceIt // Privacy Policy</span>
          </div>
          <button
            type="button"
            onClick={() => navigateTo('/')}
            className="text-xs px-3 py-1.5 border font-mono-tabular cursor-pointer hover:bg-[var(--bg-hover)]"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            ← Back to Workshop
          </button>
        </header>

        <main className="flex-1 p-6 max-w-4xl w-full mx-auto">
          <div className="p-6 border shadow-sm flex flex-col gap-4 text-xs leading-relaxed" style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <h1 className="font-bold text-lg uppercase tracking-wider text-[var(--text-primary)]">PriceIt Privacy Policy</h1>
              <span className="text-[10px] font-mono-tabular px-2 py-0.5 border" style={{ backgroundColor: 'var(--accent-amber-bg)', borderColor: 'var(--accent-amber)', color: 'var(--accent-amber)' }}>
                Official Policy
              </span>
            </div>

            <div className="text-[11px] font-mono-tabular" style={{ color: 'var(--text-secondary)' }}>
              <strong>Domain:</strong> priceit.rbnd.cc &bull; <strong>Effective:</strong> October 29, 2026
            </div>

            <p>
              At <strong>PriceIt</strong> (&ldquo;we&rdquo;, &ldquo;our&rdquo;, or &ldquo;us&rdquo;), operating at <code>priceit.rbnd.cc</code>, we respect your privacy and are committed to protecting your personal data. This Privacy Policy explains how we collect, use, store, and safeguard information when you use the PriceIt universal parts procurement and bundle optimization platform.
            </p>

            <h2 className="font-bold text-sm uppercase text-[var(--accent-amber)] mt-2">1. Information We Collect</h2>
            <ul className="list-disc pl-5 flex flex-col gap-1">
              <li><strong>Google & OAuth Account Information:</strong> When signing in using Google OAuth or federated providers, we collect your name, email address, and avatar URL provided via standard <code>openid</code>, <code>email</code>, and <code>profile</code> scopes.</li>
              <li><strong>Account Credentials:</strong> If registering via email, we store a cryptographically hashed version of your password (bcrypt work factor 11). If registering with WebAuthn/FIDO2 Passkeys, we store the public credential ID and public key. We never have access to your biometric data or private keys.</li>
              <li><strong>Workshop & BOM Data:</strong> Bills of Materials (BOM), custom part numbers, vendor listings, pricing data, bundle mappings, and purchase orders you explicitly save to your private cloud projects.</li>
              <li><strong>Technical & Session Information:</strong> Operating system / browser User-Agent and IP address for session security, fraud prevention, rate limiting, and device management.</li>
            </ul>

            <h2 className="font-bold text-sm uppercase text-[var(--accent-amber)] mt-2">2. How We Use Your Information</h2>
            <ul className="list-disc pl-5 flex flex-col gap-1">
              <li>To authenticate your identity and provide secure access to your saved projects across devices.</li>
              <li>To execute algorithmic bundle-kit cost solvers and purchase optimization calculations.</li>
              <li>To send account verification and security alert emails (e.g. password resets or email updates).</li>
              <li>To protect our platform against brute-force attacks, credential stuffing, and abuse.</li>
            </ul>

            <h2 className="font-bold text-sm uppercase text-[var(--accent-amber)] mt-2">3. Google User Data Policy & Limited Use</h2>
            <p>
              PriceIt adheres strictly to the Google API Services User Data Policy, including the Limited Use requirements:
            </p>
            <ul className="list-disc pl-5 flex flex-col gap-1">
              <li>We <strong>never sell, rent, or trade</strong> your Google account data or personal information to third parties, advertisers, or data brokers.</li>
              <li>We do <strong>not</strong> use your data or project content to train generalized artificial intelligence (AI) or machine learning models.</li>
              <li>We do not transfer your Google user data to any external parties, except as strictly necessary to operate our core service or comply with applicable law.</li>
            </ul>

            <h2 className="font-bold text-sm uppercase text-[var(--accent-amber)] mt-2">4. Data Storage, Security & Retention</h2>
            <p>
              Your data is stored in isolated, encrypted production databases with strict access controls. Passwords are never stored in plaintext. Session cookies are HTTP-only and transmission is strictly enforced over TLS/HTTPS (TLS 1.2 / 1.3).
            </p>

            <h2 className="font-bold text-sm uppercase text-[var(--accent-amber)] mt-2">5. Account Deletion & Data Rights</h2>
            <p>
              You retain complete ownership of your data. You may export your projects to CSV at any time. You can permanently delete your user account and all associated project data directly in the application under <strong>Account Settings ➔ Sessions & Danger ➔ Permanently Delete Account</strong>.
            </p>

            <h2 className="font-bold text-sm uppercase text-[var(--accent-amber)] mt-2">6. Contact Information</h2>
            <p>
              For any privacy inquiries or data requests, contact our administrator at: <strong>privacy@rbnd.cc</strong>
            </p>
          </div>
        </main>
      </div>
    );
  }

  // Dedicated Route: /terms of service (accessible directly via priceit.rbnd.cc/terms)
  if (currentPath.startsWith('/terms')) {
    return (
      <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--bg-base)' }}>
        <header className="border-b px-6 py-3 flex items-center justify-between" style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2">
            <span className="font-bold tracking-tight text-sm uppercase">PriceIt // Terms of Service</span>
          </div>
          <button
            type="button"
            onClick={() => navigateTo('/')}
            className="text-xs px-3 py-1.5 border font-mono-tabular cursor-pointer hover:bg-[var(--bg-hover)]"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            ← Back to Workshop
          </button>
        </header>

        <main className="flex-1 p-6 max-w-4xl w-full mx-auto">
          <div className="p-6 border shadow-sm flex flex-col gap-4 text-xs leading-relaxed" style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <h1 className="font-bold text-lg uppercase tracking-wider text-[var(--text-primary)]">PriceIt Terms of Service</h1>
              <span className="text-[10px] font-mono-tabular px-2 py-0.5 border" style={{ backgroundColor: 'var(--accent-amber-bg)', borderColor: 'var(--accent-amber)', color: 'var(--accent-amber)' }}>
                User Agreement
              </span>
            </div>

            <div className="text-[11px] font-mono-tabular" style={{ color: 'var(--text-secondary)' }}>
              <strong>Domain:</strong> priceit.rbnd.cc &bull; <strong>Effective:</strong> October 29, 2026
            </div>

            <p>
              Welcome to <strong>PriceIt</strong> (&ldquo;we&rdquo;, &ldquo;our&rdquo;, or &ldquo;us&rdquo;), hosted at <code>priceit.rbnd.cc</code>. By accessing, registering for, or using the PriceIt application, you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the application.
            </p>

            <h2 className="font-bold text-sm uppercase text-[var(--accent-amber)] mt-2">1. Use of the Service</h2>
            <p>
              PriceIt provides tools for parts list aggregation, vendor offering comparison, and combinatorial bundle cost optimization. You agree to use the service in accordance with all applicable laws and regulations.
            </p>
            <ul className="list-disc pl-5 flex flex-col gap-1">
              <li>You may not use the service to scrape, harvest, or disrupt third-party vendor platforms in violation of their respective terms.</li>
              <li>You may not attempt to reverse engineer, disrupt, or compromise the security or availability of the PriceIt platform or infrastructure.</li>
              <li>Accounts found attempting malicious exploitation, denial of service, or unauthorized administrative privilege escalation are subject to immediate suspension.</li>
            </ul>

            <h2 className="font-bold text-sm uppercase text-[var(--accent-amber)] mt-2">2. Account Security & Authentication</h2>
            <p>
              You are responsible for maintaining the confidentiality of your account credentials, passkeys, and authentication sessions. You agree to notify us immediately of any unauthorized use of your account.
            </p>

            <h2 className="font-bold text-sm uppercase text-[var(--accent-amber)] mt-2">3. Intellectual Property & User Content</h2>
            <p>
              You retain all rights, title, and ownership of the Bills of Materials (BOM), custom part notes, and project data you create and store in PriceIt. We claim no ownership over your proprietary lists or project configurations.
            </p>

            <h2 className="font-bold text-sm uppercase text-[var(--accent-amber)] mt-2">4. Vendor Pricing & Third-Party Information</h2>
            <p>
              PriceIt provides mathematical optimization based on vendor listings, pricing, shipping tiers, and discounts entered by users or retrieved via public metadata. We do not guarantee that third-party vendors will honor prices or maintain item availability. You are solely responsible for verifying final order terms directly with vendors prior to making purchases.
            </p>

            <h2 className="font-bold text-sm uppercase text-[var(--accent-amber)] mt-2">5. Disclaimer of Warranties & Limitation of Liability</h2>
            <p>
              PriceIt is provided on an &ldquo;AS IS&rdquo; and &ldquo;AS AVAILABLE&rdquo; basis without warranties of any kind, whether express or implied. In no event shall PriceIt or its developers be liable for any direct, indirect, incidental, special, or consequential damages resulting from the use or inability to use the service.
            </p>

            <h2 className="font-bold text-sm uppercase text-[var(--accent-amber)] mt-2">6. Termination</h2>
            <p>
              You may terminate your account at any time by deleting your account from Account Settings. We reserve the right to suspend or terminate accounts that violate these Terms of Service.
            </p>

            <h2 className="font-bold text-sm uppercase text-[var(--accent-amber)] mt-2">7. Contact Information</h2>
            <p>
              For questions regarding these Terms of Service, contact our administrator at: <strong>support@rbnd.cc</strong>
            </p>
          </div>
        </main>
      </div>
    );
  }

  // Dedicated Route: /admin directory (accessible directly via priceit.rbnd.cc/admin)
  if (currentPath.startsWith('/admin')) {
    if (authLoading) {
      return (
        <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--bg-base)' }}>
          <div className="flex items-center gap-2 text-xs font-mono-tabular" style={{ color: 'var(--text-secondary)' }}>
            <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-amber)]" />
            <span>Loading PriceIt Administration Console...</span>
          </div>
        </div>
      );
    }

    if (!user) {
      return (
        <div className="min-h-screen flex flex-col justify-between" style={{ backgroundColor: 'var(--bg-base)' }}>
          <header
            className="border-b px-6 py-3 flex items-center justify-between"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-[var(--accent-amber)]" />
              <span className="font-mono-tabular font-bold text-sm tracking-wider uppercase">
                PriceIt // Admin Directory (/admin)
              </span>
            </div>
            <button
              type="button"
              onClick={() => navigateTo('/')}
              className="text-xs px-3 py-1.5 border font-mono-tabular cursor-pointer hover:bg-[var(--bg-hover)]"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              ← Back to Workshop
            </button>
          </header>

          <main className="flex-1 flex items-center justify-center p-4">
            <div
              className="w-full max-w-md p-6 border shadow-lg"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
            >
              <div className="text-center mb-6">
                <div className="inline-flex p-3 rounded-full mb-3" style={{ backgroundColor: 'var(--accent-amber-bg)' }}>
                  <ShieldAlert className="w-6 h-6 text-[var(--accent-amber)]" />
                </div>
                <h1 className="font-bold text-base uppercase tracking-wider">Restricted Administration Access</h1>
                <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                  Sign in with an authorized administrator account to access this directory.
                </p>
              </div>

              {authError && (
                <div
                  className="p-3 mb-4 text-xs border font-mono-tabular"
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
                <div>
                  <label className="block text-[11px] font-mono-tabular uppercase mb-1">Email</label>
                  <input
                    type="email"
                    required
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
                    style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-mono-tabular uppercase mb-1">Password</label>
                  <input
                    type="password"
                    required
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
                    style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-2 text-xs font-bold uppercase border cursor-pointer mt-1"
                  style={{
                    backgroundColor: 'var(--accent-amber-bg)',
                    borderColor: 'var(--accent-amber)',
                    color: 'var(--accent-amber)',
                  }}
                >
                  Sign In as Administrator
                </button>

                <button
                  type="button"
                  onClick={handlePasskeySignIn}
                  className="w-full py-2 text-xs font-semibold flex items-center justify-center gap-1.5 border cursor-pointer"
                  style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                >
                  <Key className="w-3.5 h-3.5 text-[var(--accent-amber)]" />
                  Sign In with Passkey / WebAuthn
                </button>
              </form>

              <div className="border-t pt-3 mt-4" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="text-[11px] font-mono-tabular uppercase mb-2 text-center" style={{ color: 'var(--text-secondary)' }}>
                  Or Federated OAuth
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(['google', 'facebook'] as const).map((prov) => (
                    <button
                      key={prov}
                      type="button"
                      onClick={() => handleOAuthSignIn(prov)}
                      className="px-3 py-1.5 text-xs font-mono-tabular uppercase border cursor-pointer hover:bg-[var(--bg-hover)] text-center"
                      style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                    >
                      {prov}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </main>
        </div>
      );
    }

    if (!user.is_admin) {
      return (
        <div className="min-h-screen flex flex-col justify-between" style={{ backgroundColor: 'var(--bg-base)' }}>
          <header
            className="border-b px-6 py-3 flex items-center justify-between"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-[var(--accent-danger)]" />
              <span className="font-mono-tabular font-bold text-sm tracking-wider uppercase">PriceIt // Access Denied</span>
            </div>
            <button
              type="button"
              onClick={() => navigateTo('/')}
              className="text-xs px-3 py-1.5 border font-mono-tabular cursor-pointer hover:bg-[var(--bg-hover)]"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              ← Back to Workshop
            </button>
          </header>

          <main className="flex-1 flex items-center justify-center p-4">
            <div
              className="w-full max-w-md p-6 border text-center shadow-lg"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--accent-danger)' }}
            >
              <div className="inline-flex p-3 rounded-full mb-3" style={{ backgroundColor: 'var(--accent-danger-bg)' }}>
                <ShieldAlert className="w-8 h-8 text-[var(--accent-danger)]" />
              </div>
              <h1 className="font-bold text-base text-[var(--accent-danger)] uppercase tracking-wider mb-2">
                403 Forbidden: Administrator Privileges Required
              </h1>
              <p className="text-xs mb-5" style={{ color: 'var(--text-secondary)' }}>
                Your signed-in account (<strong>{user.email}</strong>) does not have administrator privileges to view this directory.
              </p>
              <div className="flex justify-center gap-3">
                <button
                  type="button"
                  onClick={() => navigateTo('/')}
                  className="px-4 py-2 text-xs font-bold uppercase border cursor-pointer hover:bg-[var(--bg-hover)]"
                  style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                >
                  ← Return to Workshop
                </button>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="px-4 py-2 text-xs font-bold uppercase border cursor-pointer"
                  style={{
                    backgroundColor: 'var(--accent-danger-bg)',
                    borderColor: 'var(--accent-danger)',
                    color: 'var(--accent-danger)',
                  }}
                >
                  Sign Out
                </button>
              </div>
            </div>
          </main>
        </div>
      );
    }

    // Authenticated administrator view
    return (
      <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--bg-base)' }}>
        {/* Full-Page Admin Header */}
        <header
          className="border-b px-6 py-3 flex flex-wrap items-center justify-between gap-3"
          style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex items-center gap-3">
            <ShieldAlert className="w-5 h-5 text-[var(--accent-amber)]" />
            <div>
              <div className="font-mono-tabular font-bold text-sm tracking-wider uppercase flex items-center gap-2">
                <span>PriceIt // Admin & Moderation Console</span>
                <span
                  className="px-2 py-0.5 text-[10px] font-mono-tabular uppercase border"
                  style={{
                    backgroundColor: 'var(--accent-amber-bg)',
                    borderColor: 'var(--accent-amber)',
                    color: 'var(--accent-amber)',
                  }}
                >
                  /admin
                </span>
              </div>
              <div className="text-[11px] font-mono-tabular" style={{ color: 'var(--text-secondary)' }}>
                Signed in as: <strong>{user.display_name}</strong> ({user.email})
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={fetchAdminData}
              disabled={isLoadingAdmin}
              className="text-xs px-2.5 py-1.5 border font-mono-tabular cursor-pointer flex items-center gap-1.5 hover:bg-[var(--bg-hover)]"
              style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
              title="Refresh Data"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingAdmin ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={() => navigateTo('/')}
              className="text-xs px-3 py-1.5 border font-mono-tabular cursor-pointer flex items-center gap-1.5 hover:bg-[var(--bg-hover)]"
              style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
            >
              <span>← Back to Workshop</span>
            </button>
            <button
              type="button"
              onClick={handleToggleColorScheme}
              className="p-1.5 border cursor-pointer hover:bg-[var(--bg-hover)]"
              style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
              title="Toggle Light / Dark Theme"
            >
              <Sun className="w-3.5 h-3.5 inline dark:hidden" />
              <Moon className="w-3.5 h-3.5 hidden dark:inline" />
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="p-1.5 border cursor-pointer text-[var(--accent-danger)] hover:bg-[var(--accent-danger-bg)]"
              style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
              title="Sign Out"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </header>

        {/* Tab Navigation */}
        <div
          className="flex border-b text-xs font-semibold overflow-x-auto px-6"
          style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
        >
          {[
            { id: 'users', label: `Users & Moderation (${adminUsers.length})`, icon: UserCog },
            { id: 'oauth', label: 'OAuth Setup & Keys', icon: Key },
            { id: 'system', label: 'System Overview', icon: Settings },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = adminTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setAdminTab(tab.id as any)}
                className={`px-4 py-2.5 border-b-2 flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                  isActive
                    ? 'border-[var(--accent-amber)] text-[var(--text-primary)] font-bold'
                    : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Feedback / Error Message Strip */}
        {adminMessage && (
          <div
            className="px-6 py-3 text-xs border-b font-mono-tabular"
            style={{
              backgroundColor: adminMessage.type === 'error' ? 'var(--accent-danger-bg)' : 'var(--accent-emerald-bg)',
              borderColor: 'var(--border-subtle)',
              color: adminMessage.type === 'error' ? 'var(--accent-danger)' : 'var(--accent-emerald)',
            }}
          >
            {adminMessage.text}
          </div>
        )}

        <main className="flex-1 p-6 max-w-7xl w-full mx-auto flex flex-col gap-6">
          {/* TAB 1: User Moderation */}
          {adminTab === 'users' && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[var(--text-muted)]" />
                  <input
                    type="text"
                    placeholder="Search by email or display name..."
                    value={adminSearch}
                    onChange={(e) => setAdminSearch(e.target.value)}
                    className="w-full pl-8 pr-2.5 py-1.5 text-xs font-mono-tabular border"
                    style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                  />
                </div>
                <div className="text-xs text-[var(--text-secondary)] font-mono-tabular shrink-0">
                  Showing {adminUsers.filter((u) => u.email.toLowerCase().includes(adminSearch.toLowerCase()) || u.display_name.toLowerCase().includes(adminSearch.toLowerCase())).length} of {adminUsers.length} accounts
                </div>
              </div>

              <div className="table-wrapper">
                <table className="workshop-table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Flags & Status</th>
                      <th>Sessions</th>
                      <th>Projects</th>
                      <th>Created</th>
                      <th className="text-end">Moderation Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminUsers
                      .filter((u) => u.email.toLowerCase().includes(adminSearch.toLowerCase()) || u.display_name.toLowerCase().includes(adminSearch.toLowerCase()))
                      .map((u) => {
                        const isSelf = u.id === user?.id;
                        return (
                          <tr key={u.id}>
                            <td>
                              <div className="font-semibold text-xs text-[var(--text-primary)]">{u.display_name}</div>
                              <div className="text-[11px] font-mono-tabular" style={{ color: 'var(--text-secondary)' }}>
                                {u.email}
                              </div>
                            </td>
                            <td>
                              <div className="flex flex-wrap gap-1">
                                {u.is_admin && (
                                  <span className="text-[10px] px-1.5 py-0.5 border font-mono-tabular bg-[var(--accent-amber-bg)] text-[var(--accent-amber)] font-bold">
                                    ADMIN
                                  </span>
                                )}
                                {u.is_banned && (
                                  <span className="text-[10px] px-1.5 py-0.5 border font-mono-tabular bg-[var(--accent-danger-bg)] text-[var(--accent-danger)] font-bold">
                                    SUSPENDED
                                  </span>
                                )}
                                {u.password_reset_required && (
                                  <span className="text-[10px] px-1.5 py-0.5 border font-mono-tabular bg-[var(--accent-amber-bg)] text-[var(--accent-amber)]">
                                    LOCKED
                                  </span>
                                )}
                                {u.is_passwordless ? (
                                  <span className="text-[10px] px-1.5 py-0.5 border font-mono-tabular bg-[var(--accent-emerald-bg)] text-[var(--accent-emerald)]">
                                    PWDLESS
                                  </span>
                                ) : (
                                  <span className="text-[10px] px-1.5 py-0.5 border font-mono-tabular bg-[var(--bg-elevated)] text-[var(--text-secondary)]">
                                    PASSWORD
                                  </span>
                                )}
                              </div>
                              {u.ban_reason && (
                                <div className="text-[10px] text-[var(--accent-danger)] mt-0.5">
                                  Reason: {u.ban_reason}
                                </div>
                              )}
                            </td>
                            <td className="font-mono-tabular text-xs">
                              {u.active_sessions_count} active
                            </td>
                            <td className="font-mono-tabular text-xs">
                              {u.projects_count}
                            </td>
                            <td className="font-mono-tabular text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                              {new Date(u.created_at).toLocaleDateString()}
                            </td>
                            <td className="text-end">
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={isSelf}
                                  onClick={() => handleAdminBanUser(u)}
                                  className={`px-2 py-0.5 text-[11px] border cursor-pointer disabled:opacity-30 ${
                                    u.is_banned ? 'bg-[var(--accent-emerald-bg)] text-[var(--accent-emerald)]' : 'bg-[var(--accent-danger-bg)] text-[var(--accent-danger)]'
                                  }`}
                                  style={{ borderColor: 'var(--border-subtle)' }}
                                  title={u.is_banned ? 'Unban Account' : 'Suspend & Terminate Sessions'}
                                >
                                  {u.is_banned ? 'Unban' : 'Suspend'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleAdminResetPassword(u)}
                                  className="px-2 py-0.5 text-[11px] border cursor-pointer hover:bg-[var(--bg-hover)]"
                                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                                  title="Lock account and force password reset token"
                                >
                                  Reset Pwd
                                </button>
                                <button
                                  type="button"
                                  disabled={isSelf}
                                  onClick={() => handleAdminPromote(u)}
                                  className="px-2 py-0.5 text-[11px] border cursor-pointer disabled:opacity-30"
                                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                                  title={u.is_admin ? 'Revoke Admin' : 'Grant Admin'}
                                >
                                  {u.is_admin ? 'Demote' : 'Make Admin'}
                                </button>
                                <button
                                  type="button"
                                  disabled={isSelf}
                                  onClick={() => handleAdminDeleteUser(u)}
                                  className="px-2 py-0.5 text-[11px] border cursor-pointer text-[var(--accent-danger)] disabled:opacity-30 hover:bg-[var(--accent-danger-bg)]"
                                  style={{ borderColor: 'var(--border-subtle)' }}
                                  title="Delete User and projects permanently"
                                >
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 2: OAuth Setup */}
          {adminTab === 'oauth' && (
            <div className="flex flex-col gap-4">
              <div className="p-3 border text-xs" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
                <p className="mb-1 font-semibold text-[var(--text-primary)]">
                  Configure OAuth Applications & API Credentials
                </p>
                <p className="text-[var(--text-secondary)]">
                  Configure your OAuth App credentials below. Values entered here take precedence over environment variables and are securely saved in SQLite.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3">
                {(['google', 'facebook'] as const).map((prov) => {
                  const currentInput = oauthInputs[prov] || { client_id: '', client_secret: '', enabled: true };
                  const liveConfig = adminOAuthConfigs.find((c) => c.provider === prov);
                  const callbackUri =
                    liveConfig?.redirect_uri ||
                    `${typeof window !== 'undefined' ? window.location.origin : 'https://priceit.rbnd.cc'}/api/auth/oauth/${prov}/callback`;
                  return (
                    <div
                      key={prov}
                      className="p-3.5 border flex flex-col gap-3"
                      style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Key className="w-4 h-4 text-[var(--accent-amber)]" />
                          <span className="font-bold text-xs uppercase tracking-wider">{prov}</span>
                          {liveConfig?.client_id && liveConfig?.is_secret_set ? (
                            <span className="text-[10px] px-1.5 py-0.2 border bg-[var(--accent-emerald-bg)] text-[var(--accent-emerald)] font-mono-tabular">
                              CONFIGURED (LIVE OAUTH)
                            </span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.2 border bg-[var(--bg-elevated)] text-[var(--text-muted)] font-mono-tabular">
                              NOT CONFIGURED
                            </span>
                          )}
                        </div>

                        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            checked={currentInput.enabled}
                            onChange={(e) =>
                              setOauthInputs((prev) => ({
                                ...prev,
                                [prov]: { ...currentInput, enabled: e.target.checked },
                              }))
                            }
                          />
                          <span>Enabled</span>
                        </label>
                      </div>

                      <div className="p-2 border text-[11px] font-mono-tabular flex items-center justify-between gap-2" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
                        <div className="truncate">
                          <span style={{ color: 'var(--text-secondary)' }}>Authorized Redirect URI: </span>
                          <span className="font-semibold text-[var(--text-primary)]">{callbackUri}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard?.writeText(callbackUri).catch(() => {});
                            setAdminMessage({ type: 'success', text: `Copied ${prov.toUpperCase()} Redirect URI to clipboard.` });
                          }}
                          className="px-2 py-0.5 border text-[10px] cursor-pointer shrink-0 hover:bg-[var(--bg-hover)]"
                          style={{ borderColor: 'var(--border-subtle)' }}
                        >
                          Copy URI
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-mono-tabular uppercase mb-1">
                            Client ID / Application ID
                          </label>
                          <input
                            type="text"
                            value={currentInput.client_id}
                            onChange={(e) =>
                              setOauthInputs((prev) => ({
                                ...prev,
                                [prov]: { ...currentInput, client_id: e.target.value },
                              }))
                            }
                            placeholder={`Enter ${prov} Client ID`}
                            className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
                            style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-mono-tabular uppercase mb-1">
                            Client Secret {liveConfig?.is_secret_set ? '(•••••••• Configured)' : ''}
                          </label>
                          <input
                            type="password"
                            value={currentInput.client_secret}
                            onChange={(e) =>
                              setOauthInputs((prev) => ({
                                ...prev,
                                [prov]: { ...currentInput, client_secret: e.target.value },
                              }))
                            }
                            placeholder={liveConfig?.is_secret_set ? 'Leave blank to keep current secret' : `Enter ${prov} Client Secret`}
                            className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
                            style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                          />
                        </div>
                      </div>

                      <div className="flex justify-end pt-1">
                        <button
                          type="button"
                          onClick={() => handleSaveOAuthConfig(prov)}
                          className="px-3.5 py-1.5 text-xs font-semibold border cursor-pointer"
                          style={{
                            backgroundColor: 'var(--accent-amber-bg)',
                            borderColor: 'var(--accent-amber)',
                            color: 'var(--accent-amber)',
                          }}
                        >
                          Save {prov.toUpperCase()} Configuration
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 3: System Overview */}
          {adminTab === 'system' && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 border" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
                <div className="text-[11px] text-[var(--text-secondary)] uppercase">Total Users</div>
                <div className="text-xl font-bold font-mono-tabular mt-1">{adminUsers.length}</div>
              </div>
              <div className="p-3 border" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
                <div className="text-[11px] text-[var(--text-secondary)] uppercase">Active Sessions</div>
                <div className="text-xl font-bold font-mono-tabular mt-1">
                  {adminUsers.reduce((sum, u) => sum + u.active_sessions_count, 0)}
                </div>
              </div>
              <div className="p-3 border" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
                <div className="text-[11px] text-[var(--text-secondary)] uppercase">Cloud Projects</div>
                <div className="text-xl font-bold font-mono-tabular mt-1">
                  {adminUsers.reduce((sum, u) => sum + u.projects_count, 0)}
                </div>
              </div>
              <div className="p-3 border" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
                <div className="text-[11px] text-[var(--text-secondary)] uppercase">Administrators</div>
                <div className="text-xl font-bold font-mono-tabular mt-1">
                  {adminUsers.filter((u) => u.is_admin).length}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }

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
          <div data-tour="presets-bar" className="flex items-center gap-1.5">
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

          <a
            ref={bookmarkletAnchorRef}
            data-tour="bookmarklet-btn"
            onClick={(e) => {
              e.preventDefault();
              setIsBookmarkletModalOpen(true);
            }}
            draggable
            className="h-[26px] px-2 text-xs border inline-flex items-center gap-1 cursor-grab active:cursor-grabbing box-border select-none"
            style={{
              height: '26px',
              boxSizing: 'border-box',
              backgroundColor: 'var(--accent-amber-bg)',
              borderColor: 'var(--accent-amber)',
              color: 'var(--accent-amber)',
            }}
            title="PriceIt Capture Bookmarklet (Drag to your bookmarks bar, or click for setup guide)"
          >
            <Bookmark className="w-3.5 h-3.5 fill-[var(--accent-amber)]" /> + PriceIt Capture
          </a>

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
            data-tour="share-export-btn"
            onClick={() => setIsShareExportModalOpen(true)}
            className="h-[26px] px-2 text-xs border inline-flex items-center gap-1 cursor-pointer box-border"
            style={{
              height: '26px',
              boxSizing: 'border-box',
              backgroundColor: 'var(--bg-elevated)',
              borderColor: 'var(--border-subtle)',
            }}
            title="Share Link, Copy Markdown/Reddit, Print PDF, or Export CSV"
          >
            <Share2 className="w-3.5 h-3.5 text-[var(--accent-sky)]" /> Share / Export
          </button>

          <button
            id="start-tour-btn"
            type="button"
            onClick={handleStartTour}
            className="h-[26px] px-2 text-xs border inline-flex items-center gap-1 cursor-pointer box-border hover:bg-[var(--bg-hover)]"
            style={{
              height: '26px',
              boxSizing: 'border-box',
              backgroundColor: isTourOpen ? 'var(--accent-amber-bg)' : 'var(--bg-elevated)',
              borderColor: isTourOpen ? 'var(--accent-amber)' : 'var(--border-subtle)',
              color: isTourOpen ? 'var(--accent-amber)' : 'var(--text-primary)',
            }}
            title="Open Interactive Feature Tour & User Guide"
            aria-label="Open Interactive Feature Tour & User Guide"
          >
            <Compass className="w-3.5 h-3.5 text-[var(--accent-amber)]" /> Tour / Guide
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
              <button
                type="button"
                onClick={handleOpenAccountSettings}
                className="h-[26px] px-2 text-xs font-mono-tabular border inline-flex items-center gap-1.5 cursor-pointer box-border hover:bg-[var(--bg-hover)]"
                style={{
                  height: '26px',
                  boxSizing: 'border-box',
                  backgroundColor: 'var(--bg-elevated)',
                  borderColor: 'var(--border-subtle)',
                  color: 'var(--text-primary)',
                }}
                title="Account Settings & Security"
                aria-label="Account Settings"
              >
                <UserCog className="w-3.5 h-3.5 text-[var(--accent-amber)]" />
                <span>{user.display_name}</span>
              </button>
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

      {/* Pinned BOM Part Active Indicator */}
      {(() => {
        const pinnedPart = activeProject.parts.find((p) => p.id === pinnedBomPartId);
        if (!pinnedPart) return null;
        return (
          <div className="no-print px-4 py-2 bg-[var(--accent-amber-bg)] border-b border-[var(--accent-amber)] flex items-center justify-between text-xs text-[var(--accent-amber)]">
            <div className="flex items-center gap-2">
              <Bookmark className="w-3.5 h-3.5 fill-[var(--accent-amber)] shrink-0" />
              <span>
                <strong>PINNED FOR BOOKMARKLET:</strong> All captured offerings will auto-attach to{' '}
                <strong>{pinnedPart.name}</strong> {pinnedPart.part_number ? `(${pinnedPart.part_number})` : ''}.
              </span>
            </div>
            <button
              type="button"
              onClick={() => handleTogglePinBomPart(null)}
              className="px-2 py-0.5 border border-[var(--accent-amber)] hover:bg-[var(--accent-amber)] hover:text-black rounded text-[11px] font-medium cursor-pointer"
            >
              Unpin Part
            </button>
          </div>
        );
      })()}

      {/* Project Metadata Header */}
      <section
        className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-4"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[280px]">
          <div className="flex flex-col flex-1 max-w-xl">
            <input
              id="project-title-input"
              aria-label="Project Name"
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
                data-tour="bom-add-form"
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
                    <th className="w-16 no-print"></th>
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
                                      className="text-[10px] text-left underline cursor-pointer whitespace-nowrap"
                                      style={{ color: 'var(--text-secondary)' }}
                                    >
                                      Mark as Owned
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
                                      className="text-[10px] text-left underline cursor-pointer whitespace-nowrap"
                                      style={{ color: 'var(--text-secondary)' }}
                                    >
                                      Mark as Owned
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="no-print text-center">
                            {!isReadOnlyShare && (
                              <div className="flex items-center justify-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => handleTogglePinBomPart(part.id)}
                                  className={`p-1 cursor-pointer transition-colors ${
                                    pinnedBomPartId === part.id
                                      ? 'text-[var(--accent-amber)] opacity-100'
                                      : 'opacity-50 hover:opacity-100 text-[var(--text-secondary)]'
                                  }`}
                                  title={
                                    pinnedBomPartId === part.id
                                      ? 'Pinned! Bookmarklet captures attach directly to this part (Click to unpin)'
                                      : 'Pin for Bookmarklet Capture (Auto-attaches scraped offerings to this part)'
                                  }
                                  aria-label={`Pin ${part.name} for bookmarklet capture`}
                                >
                                  <Bookmark
                                    className={`w-3.5 h-3.5 ${pinnedBomPartId === part.id ? 'fill-[var(--accent-amber)]' : ''}`}
                                  />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleRemovePart(part.id)}
                                  className="p-1 opacity-70 hover:opacity-100 cursor-pointer"
                                  title="Remove Part"
                                  aria-label={`Remove ${part.name}`}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
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
                data-tour="offering-add-form"
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
              data-tour="coverage-matrix"
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
            data-tour="vendor-shipping-rules"
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
                data-tour="optimal-plan-orders"
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
                  <div className="flex">
                    <button
                      type="button"
                      onClick={() => setIsShareExportModalOpen(true)}
                      className="w-full px-4 py-2.5 text-xs font-semibold border flex items-center justify-center gap-2 cursor-pointer shadow-sm hover:brightness-110"
                      style={{
                        backgroundColor: 'var(--accent-sky-bg)',
                        borderColor: 'var(--accent-sky)',
                        color: 'var(--accent-sky)',
                      }}
                    >
                      <Share2 className="w-4 h-4" /> Open Share / Export Hub (CSV, PDF with QR, Markdown, Reddit, Link)
                    </button>
                  </div>
                </div>
              </section>

              {/* Branded Print PDF Footer with Live Scannable QR Code */}
              <div className="print-only print-branded-footer">
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  {printQrSvg && (
                    <div
                      style={{ width: '64px', height: '64px' }}
                      dangerouslySetInnerHTML={{ __html: printQrSvg }}
                    />
                  )}
                  <div>
                    <div style={{ fontWeight: 'bold', fontSize: '11pt' }}>
                      PriceIt — Universal Parts &amp; Bundle Optimizer
                    </div>
                    <div style={{ color: '#4b5563', fontSize: '8.5pt' }}>
                      Scan QR code or visit{' '}
                      <strong style={{ color: '#000' }}>
                        {activeProject.share_token
                          ? `priceit.rbnd.cc/share/${activeProject.share_token}`
                          : 'priceit.rbnd.cc'}
                      </strong>{' '}
                      for live pricing, direct order links, and bundle solver updates.
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: '8pt', color: '#6b7280' }}>
                  <div>Datasheet Generated: {new Date().toLocaleDateString()}</div>
                  <div>Total Cost: ${formatCentsToDollars(solverResult.grand_total_cents)}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer with Privacy Policy & Terms of Service */}
      <footer
        className="no-print border-t px-6 py-3 flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono-tabular"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
      >
        <div className="flex items-center gap-2">
          <span>PriceIt &bull; Universal Parts & Bundle Price Optimizer</span>
          <span className="text-[10px] px-1.5 py-0.5 border" style={{ borderColor: 'var(--border-subtle)' }}>v1.0</span>
        </div>
        <div className="flex items-center gap-4">
          <button type="button" onClick={() => navigateTo('/privacy')} className="hover:underline cursor-pointer">
            Privacy Policy
          </button>
          <span>&bull;</span>
          <button type="button" onClick={() => navigateTo('/terms')} className="hover:underline cursor-pointer">
            Terms of Service
          </button>
          <span>&bull;</span>
          <a href="mailto:support@rbnd.cc" className="hover:underline">
            Support
          </a>
        </div>
      </footer>

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
                autoComplete="username webauthn"
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

            {authMode === 'login' && (
              <button
                type="button"
                onClick={handlePasskeySignIn}
                className="w-full py-2 text-xs font-semibold flex items-center justify-center gap-1.5 border cursor-pointer"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  borderColor: 'var(--border-subtle)',
                  color: 'var(--text-primary)',
                }}
              >
                <Key className="w-3.5 h-3.5 text-[var(--accent-amber)]" />
                Sign In with Passkey / WebAuthn
              </button>
            )}
          </form>

          <div className="border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="text-[11px] font-mono-tabular uppercase mb-2" style={{ color: 'var(--text-secondary)' }}>
              Or Continue with Federated OAuth Provider
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(['google', 'facebook'] as const).map((prov) => (
                <button
                  key={prov}
                  type="button"
                  onClick={() => handleOAuthSignIn(prov)}
                  className="px-3 py-1.5 text-xs font-mono-tabular uppercase border cursor-pointer hover:bg-[var(--bg-hover)]"
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

      {/* Dialog 5: Account Settings, OAuth Linking, Passkeys & Session Management */}
      <dialog
        ref={settingsDialogRef}
        {...({ closedby: 'any' } as React.DialogHTMLAttributes<HTMLDialogElement>)}
        aria-labelledby="account-settings-dialog-title"
        className="workshop-dialog modal-lg"
      >
        <div
          className="px-4 py-3 border-b flex items-center justify-between"
          style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
        >
          <h2 id="account-settings-dialog-title" className="font-bold text-sm uppercase tracking-wider flex items-center gap-1.5">
            <UserCog className="w-4 h-4 text-[var(--accent-amber)]" />
            Account Settings & Security
          </h2>
          <button
            type="button"
            onClick={() => settingsDialogRef.current?.close()}
            className="text-xs px-2 py-0.5 border cursor-pointer"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            ESC
          </button>
        </div>

        {/* Tab Navigation */}
        <div
          className="flex border-b text-xs font-semibold overflow-x-auto"
          style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
        >
          {[
            { id: 'profile', label: 'Profile & Email', icon: Mail },
            { id: 'security', label: 'Password & Security', icon: Lock },
            { id: 'oauth', label: 'OAuth Logins', icon: Key },
            { id: 'passkeys', label: 'Passkeys', icon: Smartphone },
            { id: 'sessions', label: 'Sessions & Danger', icon: Shield },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = settingsTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSettingsTab(tab.id as any)}
                className={`px-3.5 py-2.5 border-b-2 flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                  isActive ? 'border-[var(--accent-amber)] text-[var(--text-primary)] font-bold' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Feedback / Error Message Strip */}
        {accountMessage && (
          <div
            className="p-3 text-xs border-b font-mono-tabular"
            style={{
              backgroundColor:
                accountMessage.type === 'error'
                  ? 'var(--accent-danger-bg)'
                  : accountMessage.type === 'success'
                    ? 'var(--accent-emerald-bg)'
                    : 'var(--accent-amber-bg)',
              borderColor: 'var(--border-subtle)',
              color:
                accountMessage.type === 'error'
                  ? 'var(--accent-danger)'
                  : accountMessage.type === 'success'
                    ? 'var(--accent-emerald)'
                    : 'var(--accent-amber)',
            }}
          >
            {accountMessage.text}
          </div>
        )}

        <div className="p-4 max-h-[70vh] overflow-y-auto flex flex-col gap-5">
          {/* TAB 1: Profile & Email */}
          {settingsTab === 'profile' && (
            <div className="flex flex-col gap-6">
              {/* Profile Display Name */}
              <form onSubmit={handleUpdateProfile} className="flex flex-col gap-2">
                <h3 className="font-semibold text-xs uppercase tracking-wider text-[var(--text-secondary)]">
                  Public Profile
                </h3>
                <div>
                  <label className="block text-xs font-mono-tabular uppercase mb-1">Display Name</label>
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={profileDisplayName}
                    onChange={(e) => setProfileDisplayName(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs border"
                    style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                  />
                </div>
                <div className="flex justify-end pt-1">
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-xs font-semibold border cursor-pointer"
                    style={{
                      backgroundColor: 'var(--accent-amber-bg)',
                      borderColor: 'var(--accent-amber)',
                      color: 'var(--accent-amber)',
                    }}
                  >
                    Save Display Name
                  </button>
                </div>
              </form>

              {/* Change Email */}
              <div className="border-t pt-4 flex flex-col gap-3" style={{ borderColor: 'var(--border-subtle)' }}>
                <h3 className="font-semibold text-xs uppercase tracking-wider text-[var(--text-secondary)]">
                  Email Address & Verification
                </h3>
                <div className="text-xs">
                  <span className="text-[var(--text-secondary)]">Current Email: </span>
                  <span className="font-mono-tabular font-bold">{user?.email || 'N/A'}</span>
                </div>

                {accountSecurity?.pending_email && (
                  <div
                    className="p-2.5 border text-xs font-mono-tabular"
                    style={{
                      backgroundColor: 'var(--accent-amber-bg)',
                      borderColor: 'var(--accent-amber)',
                      color: 'var(--accent-amber)',
                    }}
                  >
                    ⏳ Pending verification email sent to: <strong>{accountSecurity.pending_email}</strong>. Check your inbox or paste the token below to confirm.
                  </div>
                )}

                <form onSubmit={handleRequestEmailChange} className="flex flex-col gap-2">
                  <div>
                    <label className="block text-xs font-mono-tabular uppercase mb-1">New Email Address</label>
                    <input
                      type="email"
                      required
                      value={newEmailInput}
                      onChange={(e) => setNewEmailInput(e.target.value)}
                      placeholder="new.email@domain.com"
                      className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
                      style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                    />
                  </div>

                  {accountSecurity?.has_password && (
                    <div>
                      <label className="block text-xs font-mono-tabular uppercase mb-1">Current Password (Required for verification)</label>
                      <input
                        type="password"
                        required
                        value={emailCurrentPassword}
                        onChange={(e) => setEmailCurrentPassword(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
                        style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                      />
                    </div>
                  )}

                  {accountSecurity?.is_passwordless && (
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Note: As a passwordless account, requesting an email change requires recent passkey re-authentication.
                    </div>
                  )}

                  <div className="flex justify-end pt-1">
                    <button
                      type="submit"
                      className="px-3 py-1.5 text-xs font-semibold border cursor-pointer"
                      style={{
                        backgroundColor: 'var(--bg-elevated)',
                        borderColor: 'var(--border-subtle)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      Send Verification Token
                    </button>
                  </div>
                </form>

                {/* Confirm Token Form */}
                <form onSubmit={handleVerifyEmailToken} className="mt-2 p-3 border flex flex-col gap-2" style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}>
                  <label className="block text-xs font-mono-tabular uppercase font-semibold">
                    Confirm Email Verification Token
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      required
                      placeholder="Paste 43-character token from verification email"
                      value={verifyEmailTokenInput}
                      onChange={(e) => setVerifyEmailTokenInput(e.target.value)}
                      className="flex-1 px-2.5 py-1.5 text-xs font-mono-tabular border"
                      style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                    />
                    <button
                      type="submit"
                      className="px-4 py-1.5 text-xs font-semibold border cursor-pointer shrink-0"
                      style={{
                        backgroundColor: 'var(--accent-emerald-bg)',
                        borderColor: 'var(--accent-emerald)',
                        color: 'var(--accent-emerald)',
                      }}
                    >
                      Verify & Activate
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* TAB 2: Password & Security */}
          {settingsTab === 'security' && (
            <div className="flex flex-col gap-4">
              {accountSecurity?.is_passwordless ? (
                <div
                  className="p-4 border flex items-start gap-3"
                  style={{
                    backgroundColor: 'var(--accent-emerald-bg)',
                    borderColor: 'var(--accent-emerald)',
                    color: 'var(--accent-emerald)',
                  }}
                >
                  <Shield className="w-5 h-5 shrink-0 mt-0.5" />
                  <div className="text-xs">
                    <strong className="block text-sm font-semibold mb-1">✓ 100% Passwordless Account</strong>
                    Your account is permanently passwordless! It is secured exclusively by hardware/biometric Passkeys and connected OAuth providers. There is no password stored on the server that can be leaked, phished, or brute-forced.
                  </div>
                </div>
              ) : (
                <form onSubmit={handleChangePassword} className="flex flex-col gap-3">
                  <h3 className="font-semibold text-xs uppercase tracking-wider text-[var(--text-secondary)]">
                    Change Password
                  </h3>
                  <div>
                    <label className="block text-xs font-mono-tabular uppercase mb-1">Current Password</label>
                    <input
                      type="password"
                      required
                      value={changePassCurrent}
                      onChange={(e) => setChangePassCurrent(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
                      style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-mono-tabular uppercase mb-1">New Password (min 8 chars)</label>
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={changePassNew}
                      onChange={(e) => setChangePassNew(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
                      style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-mono-tabular uppercase mb-1">Confirm New Password</label>
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={changePassConfirm}
                      onChange={(e) => setChangePassConfirm(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
                      style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                    />
                  </div>

                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    🔒 Security Invariant: Changing your password will automatically sign out all other active devices and sessions.
                  </div>

                  <div className="flex justify-end pt-1">
                    <button
                      type="submit"
                      className="px-4 py-1.5 text-xs font-semibold border cursor-pointer"
                      style={{
                        backgroundColor: 'var(--accent-amber-bg)',
                        borderColor: 'var(--accent-amber)',
                        color: 'var(--accent-amber)',
                      }}
                    >
                      Update Password
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* TAB 3: Connected OAuth Logins */}
          {settingsTab === 'oauth' && (
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="font-semibold text-xs uppercase tracking-wider text-[var(--text-secondary)] mb-1">
                  Connected Social & Enterprise Logins
                </h3>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Link external identity providers to sign in with one click without needing a password.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-2">
                {(['google', 'facebook'] as const).map((prov) => {
                  const linked = accountSecurity?.oauth_accounts.find((a) => a.provider === prov);
                  return (
                    <div
                      key={prov}
                      className="p-3 border flex items-center justify-between gap-3"
                      style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
                    >
                      <div className="flex items-center gap-2">
                        <Key className="w-4 h-4 text-[var(--accent-amber)]" />
                        <div>
                          <div className="font-semibold text-xs capitalize">{prov}</div>
                          {linked ? (
                            <div className="text-[11px] font-mono-tabular" style={{ color: 'var(--accent-emerald)' }}>
                              ✓ Linked ({linked.email || linked.provider_account_id})
                            </div>
                          ) : (
                            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              Not connected
                            </div>
                          )}
                        </div>
                      </div>

                      {linked ? (
                        <button
                          type="button"
                          onClick={() => handleUnlinkOAuth(prov)}
                          className="px-2.5 py-1 text-xs border cursor-pointer hover:bg-[var(--accent-danger-bg)]"
                          style={{
                            borderColor: 'var(--border-subtle)',
                            color: 'var(--accent-danger)',
                          }}
                        >
                          Disconnect
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleLinkOAuth(prov)}
                          className="px-3 py-1 text-xs font-semibold border cursor-pointer"
                          style={{
                            backgroundColor: 'var(--bg-surface)',
                            borderColor: 'var(--border-strong)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          Connect {prov}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {accountSecurity?.has_password &&
                ((accountSecurity.oauth_accounts && accountSecurity.oauth_accounts.length > 0) ||
                  (accountSecurity.passkeys && accountSecurity.passkeys.length > 0)) && (
                  <div className="p-3 border mt-2 flex items-center justify-between gap-3" style={{ backgroundColor: 'var(--accent-amber-bg)', borderColor: 'var(--accent-amber)' }}>
                    <div className="text-xs">
                      <strong>Ready for Passwordless?</strong> You have alternate sign-in methods configured. You can eliminate your password entirely.
                    </div>
                    <button
                      type="button"
                      onClick={handleRemovePassword}
                      className="px-3 py-1.5 text-xs font-bold border cursor-pointer shrink-0"
                      style={{
                        backgroundColor: 'var(--bg-surface)',
                        borderColor: 'var(--accent-amber)',
                        color: 'var(--accent-amber)',
                      }}
                    >
                      Switch to Passwordless
                    </button>
                  </div>
                )}
            </div>
          )}

          {/* TAB 4: Passkeys */}
          {settingsTab === 'passkeys' && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-xs uppercase tracking-wider text-[var(--text-secondary)]">
                    Hardware & Biometric Passkeys (FIDO2 / WebAuthn)
                  </h3>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Sign in instantly using Touch ID, Face ID, Windows Hello, or YubiKey.
                  </p>
                </div>
              </div>

              {/* Add Passkey Bar */}
              <div className="p-3 border flex flex-col sm:flex-row gap-2 items-center" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
                <input
                  type="text"
                  placeholder="Passkey nickname (e.g. MacBook Touch ID, Work YubiKey)"
                  value={passkeyCustomName}
                  onChange={(e) => setPasskeyCustomName(e.target.value)}
                  className="w-full sm:flex-1 px-2.5 py-1.5 text-xs border"
                  style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                />
                <button
                  type="button"
                  onClick={handleAddPasskey}
                  className="w-full sm:w-auto px-4 py-1.5 text-xs font-semibold border cursor-pointer shrink-0 flex items-center justify-center gap-1.5"
                  style={{
                    backgroundColor: 'var(--accent-emerald-bg)',
                    borderColor: 'var(--accent-emerald)',
                    color: 'var(--accent-emerald)',
                  }}
                >
                  <Plus className="w-3.5 h-3.5" /> Register New Passkey
                </button>
              </div>

              {/* Passkey List */}
              <div className="flex flex-col gap-2">
                {!accountSecurity?.passkeys || accountSecurity.passkeys.length === 0 ? (
                  <div className="p-4 border text-center text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                    No passkeys registered yet. Click &quot;Register New Passkey&quot; above to add one.
                  </div>
                ) : (
                  accountSecurity.passkeys.map((pk) => (
                    <div
                      key={pk.id}
                      className="p-3 border flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                      style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                    >
                      <div className="flex items-center gap-2.5">
                        <Smartphone className="w-4 h-4 text-[var(--accent-emerald)] shrink-0" />
                        <div>
                          {editingPasskeyId === pk.id ? (
                            <div className="flex items-center gap-1.5">
                              <input
                                type="text"
                                value={editingPasskeyName}
                                onChange={(e) => setEditingPasskeyName(e.target.value)}
                                className="px-1.5 py-0.5 text-xs border font-mono-tabular"
                                style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-strong)' }}
                              />
                              <button
                                type="button"
                                onClick={() => handleRenamePasskey(pk.id)}
                                className="px-2 py-0.5 text-xs border font-semibold cursor-pointer"
                                style={{ borderColor: 'var(--border-subtle)' }}
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingPasskeyId(null)}
                                className="px-1.5 py-0.5 text-xs cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="font-semibold text-xs flex items-center gap-1.5">
                              <span>{pk.name}</span>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingPasskeyId(pk.id);
                                  setEditingPasskeyName(pk.name);
                                }}
                                className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer underline"
                              >
                                Rename
                              </button>
                            </div>
                          )}
                          <div className="text-[10px] font-mono-tabular mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                            Added: {new Date(pk.registered_at).toLocaleDateString()}
                            {pk.last_used_at ? ` • Last used: ${new Date(pk.last_used_at).toLocaleDateString()}` : ' • Never used'}
                            {pk.backed_up ? ' • Synced Cloud Vault' : ' • Hardware Bound'}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleRevokePasskey(pk.id)}
                        className="px-2.5 py-1 text-xs border cursor-pointer self-end sm:self-auto hover:bg-[var(--accent-danger-bg)]"
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--accent-danger)' }}
                      >
                        Revoke
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* TAB 5: Sessions & Danger */}
          {settingsTab === 'sessions' && (
            <div className="flex flex-col gap-6">
              {/* Active Sessions */}
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-xs uppercase tracking-wider text-[var(--text-secondary)]">
                      Active Devices & Sessions
                    </h3>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Manage authenticated browser sessions across your devices.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleRevokeOtherSessions}
                    className="px-3 py-1.5 text-xs font-semibold border cursor-pointer shrink-0"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      borderColor: 'var(--border-subtle)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    Log Out All Other Devices
                  </button>
                </div>

                <div className="flex flex-col gap-2">
                  {accountSecurity?.sessions.map((sess) => (
                    <div
                      key={sess.session_uid}
                      className="p-3 border flex items-center justify-between gap-2"
                      style={{
                        backgroundColor: sess.is_current ? 'var(--bg-elevated)' : 'var(--bg-surface)',
                        borderColor: sess.is_current ? 'var(--accent-amber)' : 'var(--border-subtle)',
                      }}
                    >
                      <div className="text-xs">
                        <div className="flex items-center gap-1.5 font-semibold">
                          <span>{sess.user_agent.slice(0, 60)}</span>
                          {sess.is_current && (
                            <span className="text-[10px] px-1.5 py-0.2 border bg-[var(--accent-amber-bg)] text-[var(--accent-amber)] font-mono-tabular">
                              CURRENT DEVICE
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] font-mono-tabular mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                          IP: {sess.ip_address} • Last Active: {new Date(sess.last_active_at).toLocaleString()}
                        </div>
                      </div>

                      {!sess.is_current && (
                        <button
                          type="button"
                          onClick={() => handleRevokeSingleSession(sess.session_uid)}
                          className="px-2 py-0.5 text-xs border cursor-pointer hover:bg-[var(--accent-danger-bg)] text-[var(--accent-danger)]"
                          style={{ borderColor: 'var(--border-subtle)' }}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Danger Zone */}
              <div className="border border-[var(--accent-danger)] p-4 flex flex-col gap-3" style={{ backgroundColor: 'var(--accent-danger-bg)' }}>
                <h3 className="font-bold text-xs uppercase tracking-wider text-[var(--accent-danger)] flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" /> Danger Zone: Delete Account
                </h3>
                <p className="text-xs" style={{ color: 'var(--text-primary)' }}>
                  Permanently delete your user profile, all cloud projects, BOM data, offering records, and passkey credentials. This action cannot be reversed.
                </p>

                <form onSubmit={handleDeleteAccount} className="flex flex-col gap-2 pt-1">
                  <div>
                    <label className="block text-[11px] font-mono-tabular uppercase mb-1">
                      Type <strong>DELETE</strong> to confirm:
                    </label>
                    <input
                      type="text"
                      required
                      value={deleteAccountConfirm}
                      onChange={(e) => setDeleteAccountConfirm(e.target.value)}
                      placeholder="DELETE"
                      className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
                      style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--accent-danger)' }}
                    />
                  </div>

                  {accountSecurity?.has_password && (
                    <div>
                      <label className="block text-[11px] font-mono-tabular uppercase mb-1">
                        Current Password (Required)
                      </label>
                      <input
                        type="password"
                        required
                        value={deleteAccountPassword}
                        onChange={(e) => setDeleteAccountPassword(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs font-mono-tabular border"
                        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
                      />
                    </div>
                  )}

                  <div className="flex justify-end pt-1">
                    <button
                      type="submit"
                      disabled={deleteAccountConfirm.trim() !== 'DELETE'}
                      className="px-4 py-1.5 text-xs font-bold uppercase border cursor-pointer disabled:opacity-50"
                      style={{
                        backgroundColor: 'var(--accent-danger)',
                        borderColor: 'var(--accent-danger)',
                        color: '#ffffff',
                      }}
                    >
                      Permanently Delete Account
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      </dialog>

      {/* Dialog 6: Passwordless Account Conversion Promo Modal */}
      <dialog
        ref={passwordlessPromoDialogRef}
        {...({ closedby: 'any' } as React.DialogHTMLAttributes<HTMLDialogElement>)}
        aria-labelledby="passwordless-promo-title"
        className="workshop-dialog max-w-md w-full"
      >
        <div
          className="px-4 py-3 border-b flex items-center justify-between"
          style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
        >
          <h2 id="passwordless-promo-title" className="font-bold text-sm uppercase tracking-wider flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-[var(--accent-amber)]" />
            Switch to 100% Passwordless?
          </h2>
          <button
            type="button"
            onClick={() => passwordlessPromoDialogRef.current?.close()}
            className="text-xs px-2 py-0.5 border cursor-pointer"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            ESC
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4 text-xs">
          <div className="p-3 border leading-relaxed" style={{ backgroundColor: 'var(--accent-emerald-bg)', borderColor: 'var(--accent-emerald)', color: 'var(--accent-emerald)' }}>
            🎉 <strong>Your Passkey is registered!</strong> You can now eliminate your password entirely and convert to a permanent passwordless account.
          </div>

          <div className="flex flex-col gap-2">
            <div className="font-semibold uppercase tracking-wider text-[11px] text-[var(--text-secondary)]">
              Why Go Passwordless:
            </div>
            <ul className="list-disc pl-4 flex flex-col gap-1 text-[var(--text-primary)]">
              <li><strong>Zero phishable credentials</strong>: Passkeys use public-key cryptography bound to this site domain.</li>
              <li><strong>Instant biometric access</strong>: Log in with Touch ID, Face ID, or Windows Hello in under a second.</li>
              <li><strong>Server database security</strong>: No password hash exists on the server to leak or brute-force.</li>
            </ul>
          </div>

          <div className="pt-2 flex justify-end gap-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <button
              type="button"
              onClick={() => passwordlessPromoDialogRef.current?.close()}
              className="px-3 py-1.5 text-xs border cursor-pointer"
              style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
            >
              Keep Password for Now
            </button>
            <button
              type="button"
              onClick={handleRemovePassword}
              className="px-4 py-1.5 text-xs font-bold border cursor-pointer"
              style={{
                backgroundColor: 'var(--accent-emerald-bg)',
                borderColor: 'var(--accent-emerald)',
                color: 'var(--accent-emerald)',
              }}
            >
              Switch to Passwordless Now
            </button>
          </div>
        </div>
      </dialog>

      {/* Feature 1: Unified Share & Export Modal */}
      <ShareExportModal
        isOpen={isShareExportModalOpen}
        onClose={() => setIsShareExportModalOpen(false)}
        project={activeProject}
        solverResult={solverResult}
        user={user}
        onRequireAuth={(text) => {
          setIsShareExportModalOpen(false);
          setStatusBanner({ type: 'info', text });
          authDialogRef.current?.showModal();
        }}
        onGenerateShareToken={handleGenerateShareToken}
        onRevokeShareToken={handleRevokeShareToken}
        onTriggerPrint={handlePrintDatasheet}
      />

      {/* Feature 2: Bookmarklet Setup & Guide Modal */}
      <BookmarkletModal
        isOpen={isBookmarkletModalOpen}
        onClose={() => setIsBookmarkletModalOpen(false)}
        installKey={installKey}
      />

      {/* Feature 2: Bookmarklet Confirmation Modal */}
      {pendingBookmarkletImport && (
        <BookmarkletConfirmationModal
          isOpen={Boolean(pendingBookmarkletImport)}
          incoming={pendingBookmarkletImport.incoming}
          existingBomParts={activeProject.parts}
          reasonsToConfirm={pendingBookmarkletImport.reasons}
          initialTargetBomPartId={pendingBookmarkletImport.targetPartId}
          isGuestFull={!user && activeProject.parts.length >= GUEST_MAX_PARTS}
          onCommit={(finalCommit) => {
            void commitBookmarkletImport(finalCommit);
          }}
          onCancel={() => {
            setPendingBookmarkletImport(null);
            if (window.name === 'priceit_capture_window') {
              window.close();
            }
          }}
        />
      )}

      {/* Feature 2: Bookmarklet Auto-Add Undo Toast */}
      <BookmarkletUndoToast
        toast={bookmarkletToast}
        onUndo={() => {
          if (bookmarkletToast) {
            const restored: ProjectPayload = {
              ...bookmarkletToast.prevProject,
              version: activeProjectRef.current.version,
            };
            updateProject(() => restored, true);
            setBookmarkletToast(null);
            if (userRef.current && restored.id) {
              void saveCloudProjectNow(restored);
            }
          }
        }}
        onDismiss={() => setBookmarkletToast(null)}
      />

      {/* Interactive First-Time User Guide & Feature Tour */}
      <OnboardingTour
        isOpen={isTourOpen}
        stepIndex={tourStepIndex}
        onStepChange={handleTourStepChange}
        onClose={handleCloseTour}
      />
    </div>
  );
}
