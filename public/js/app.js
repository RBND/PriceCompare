/**
 * Car Parts & Bundle Price Optimizer — Clean-Room v2 Frontend Application
 * Fully adheres to modern-web-guidance:
 * - faster-spa-view-transitions: Caches rendered state using content-visibility: hidden
 * - responsive-table: Accessible container-query tables with data-label injection
 * - dialog: Native <dialog> modals with pointer-bounds closedby="any" fallback
 * - validate-input-after-interaction: :user-invalid styling with aria-invalid sync
 */

(function () {
  'use strict';

  // Global App State
  let appState = {
    parts: [],
    listings: [],
    settings: {
      projectName: 'Car Parts Price Optimizer',
      taxRate: 0.06625,
      zipCode: '08879',
      sellerShipping: {}
    }
  };

  let solverOutput = null;
  let activeTabId = 'tab-parts';
  let activeProjectId = null;
  let projectsList = [];

  // DOM Elements Cache
  const els = {
    inputTaxRate: document.getElementById('inputTaxRate'),
    inputZipCode: document.getElementById('inputZipCode'),
    projectTitle: document.getElementById('projectTitle'),
    kpiShopTotal: document.getElementById('kpiShopTotal'),
    kpiCheapestTotal: document.getElementById('kpiCheapestTotal'),
    kpiSavingsTotal: document.getElementById('kpiSavingsTotal'),
    syncIndicator: document.getElementById('syncIndicator'),
    btnExportMenu: document.getElementById('btnExportMenu'),
    exportDropdownMenu: document.getElementById('exportDropdownMenu'),

    // Project Selector & Modals
    projectSelect: document.getElementById('projectSelect'),
    btnHeaderNewProject: document.getElementById('btnHeaderNewProject'),
    btnHeaderManageProjects: document.getElementById('btnHeaderManageProjects'),
    exportXlsxLink: document.getElementById('exportXlsxLink'),
    exportJsonLink: document.getElementById('exportJsonLink'),

    dialogNewProject: document.getElementById('dialogNewProject'),
    formNewProject: document.getElementById('formNewProject'),
    inputNewProjectName: document.getElementById('inputNewProjectName'),

    dialogManageProjects: document.getElementById('dialogManageProjects'),
    manageProjectsListContainer: document.getElementById('manageProjectsListContainer'),
    btnModalNewProject: document.getElementById('btnModalNewProject'),

    // Tabs
    tabButtons: document.querySelectorAll('.tab-btn'),
    spaViews: document.querySelectorAll('.spa-view'),
    badgePartsCount: document.getElementById('badgePartsCount'),
    badgeListingsCount: document.getElementById('badgeListingsCount'),
    badgeWinningSavings: document.getElementById('badgeWinningSavings'),

    // Tab 1: Parts
    formAddPart: document.getElementById('formAddPart'),
    newPartName: document.getElementById('newPartName'),
    newPartNumbers: document.getElementById('newPartNumbers'),
    newPartShopPrice: document.getElementById('newPartShopPrice'),
    newPartTaxable: document.getElementById('newPartTaxable'),
    tbodyParts: document.getElementById('tbodyParts'),
    btnOpenImportPartsModal: document.getElementById('btnOpenImportPartsModal'),
    btnResetDefaultParts: document.getElementById('btnResetDefaultParts'),

    // Tab 2: Listings & Bundles
    inputFetchUrl: document.getElementById('inputFetchUrl'),
    btnFetchUrl: document.getElementById('btnFetchUrl'),
    fetchStatusMsg: document.getElementById('fetchStatusMsg'),
    formListing: document.getElementById('formListing'),
    editListingId: document.getElementById('editListingId'),
    listingTypeBadge: document.getElementById('listingTypeBadge'),
    partsChecklistGrid: document.getElementById('partsChecklistGrid'),
    btnSelectAllParts: document.getElementById('btnSelectAllParts'),
    btnClearSelectedParts: document.getElementById('btnClearSelectedParts'),
    listingTitle: document.getElementById('listingTitle'),
    listingSeller: document.getElementById('listingSeller'),
    listingCondition: document.getElementById('listingCondition'),
    listingPrice: document.getElementById('listingPrice'),
    listingShippingMode: document.getElementById('listingShippingMode'),
    wrapShippingAmount: document.getElementById('wrapShippingAmount'),
    listingShippingAmount: document.getElementById('listingShippingAmount'),
    listingTaxMode: document.getElementById('listingTaxMode'),
    wrapManualTax: document.getElementById('wrapManualTax'),
    listingManualTax: document.getElementById('listingManualTax'),
    listingState: document.getElementById('listingState'),
    listingUrl: document.getElementById('listingUrl'),
    listingNotes: document.getElementById('listingNotes'),
    wrapPurchasedListingFields: document.getElementById('wrapPurchasedListingFields'),
    listingFinalCost: document.getElementById('listingFinalCost'),
    listingFinalPrice: document.getElementById('listingFinalPrice'),
    listingPurchaseNotes: document.getElementById('listingPurchaseNotes'),
    listingPreviewTotal: document.getElementById('listingPreviewTotal'),
    listingPreviewSub: document.getElementById('listingPreviewSub'),
    btnResetListingForm: document.getElementById('btnResetListingForm'),
    btnSubmitListing: document.getElementById('btnSubmitListing'),

    // Seller Overrides
    formAddSellerOverride: document.getElementById('formAddSellerOverride'),
    overrideSellerName: document.getElementById('overrideSellerName'),
    overrideMode: document.getElementById('overrideMode'),
    wrapOverrideAmount: document.getElementById('wrapOverrideAmount'),
    overrideAmount: document.getElementById('overrideAmount'),
    overrideTaxable: document.getElementById('overrideTaxable'),
    sellerOverridesList: document.getElementById('sellerOverridesList'),
    badgeOverridesCount: document.getElementById('badgeOverridesCount'),

    // Listings Table
    selectFilterListings: document.getElementById('selectFilterListings'),
    btnRefreshEbayPrices: document.getElementById('btnRefreshEbayPrices'),
    tbodyListings: document.getElementById('tbodyListings'),

    // Tab 3: Results
    uncoverableBanner: document.getElementById('uncoverableBanner'),
    uncoverableListText: document.getElementById('uncoverableListText'),
    duplicateBanner: document.getElementById('duplicateBanner'),
    duplicateListText: document.getElementById('duplicateListText'),
    resShopBaselineVal: document.getElementById('resShopBaselineVal'),
    resCheapestVal: document.getElementById('resCheapestVal'),
    resNetSavingsVal: document.getElementById('resNetSavingsVal'),
    resNetSavingsPct: document.getElementById('resNetSavingsPct'),
    resSpentVal: document.getElementById('resSpentVal'),
    resToBuySub: document.getElementById('resToBuySub'),
    tbodyOptimalCart: document.getElementById('tbodyOptimalCart'),
    tfootOptimalCart: document.getElementById('tfootOptimalCart'),
    bundleVerdictsGrid: document.getElementById('bundleVerdictsGrid'),

    // Dialogs
    dialogImportParts: document.getElementById('dialogImportParts'),
    formImportParts: document.getElementById('formImportParts'),
    importFile: document.getElementById('importFile'),
    importContent: document.getElementById('importContent'),
    dialogBackups: document.getElementById('dialogBackups'),
    btnOpenBackupsModal: document.getElementById('btnOpenBackupsModal'),
    backupsListContainer: document.getElementById('backupsListContainer'),

    // Dialog Mark Purchased
    dialogMarkPurchased: document.getElementById('dialogMarkPurchased'),
    dialogMarkPurchasedTitle: document.getElementById('dialogMarkPurchasedTitle'),
    purchasedItemInfoBox: document.getElementById('purchasedItemInfoBox'),
    purchasedItemTitle: document.getElementById('purchasedItemTitle'),
    purchasedItemMeta: document.getElementById('purchasedItemMeta'),
    formMarkPurchased: document.getElementById('formMarkPurchased'),
    purchasedListingId: document.getElementById('purchasedListingId'),
    inputFinalCost: document.getElementById('inputFinalCost'),
    detailsOfferCalc: document.getElementById('detailsOfferCalc'),
    badgeOfferSavings: document.getElementById('badgeOfferSavings'),
    inputOfferPrice: document.getElementById('inputOfferPrice'),
    inputOfferShipping: document.getElementById('inputOfferShipping'),
    inputOfferTax: document.getElementById('inputOfferTax'),
    btnAutoCalcOfferTax: document.getElementById('btnAutoCalcOfferTax'),
    calcTaxRateLabel: document.getElementById('calcTaxRateLabel'),
    btnApplyOfferCalc: document.getElementById('btnApplyOfferCalc'),
    offerSavingsAlert: document.getElementById('offerSavingsAlert'),
    inputPurchaseNotes: document.getElementById('inputPurchaseNotes'),
    btnUnmarkPurchased: document.getElementById('btnUnmarkPurchased'),
    btnConfirmPurchase: document.getElementById('btnConfirmPurchase')
  };

  // Utility: Format currency
  function fmtCur(num) {
    const val = Number(num);
    if (!Number.isFinite(val)) return '$0.00';
    return '$' + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // --- Project Routing & State Management ---
  function getActiveProjectIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('project') || localStorage.getItem('activeProjectId') || null;
  }

  function setActiveProjectId(id, updateUrl = true) {
    activeProjectId = id;
    localStorage.setItem('activeProjectId', id);
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set('project', id);
      window.history.pushState({ projectId: id }, '', url.toString());
    }
    updateExportLinks();
  }

  function updateExportLinks() {
    if (!activeProjectId) return;
    if (els.exportXlsxLink) {
      els.exportXlsxLink.href = `/api/projects/${encodeURIComponent(activeProjectId)}/export/xlsx`;
    }
    if (els.exportJsonLink) {
      els.exportJsonLink.href = `/api/projects/${encodeURIComponent(activeProjectId)}/export/json`;
    }
  }

  function renderProjectSelector() {
    if (!els.projectSelect) return;
    els.projectSelect.innerHTML = '';
    projectsList.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === activeProjectId) opt.selected = true;
      els.projectSelect.appendChild(opt);
    });
  }

  async function loadProjectsList(preferredId = null) {
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      projectsList = data.projects || [];

      let targetId = preferredId || getActiveProjectIdFromUrl();
      if (!targetId || !projectsList.some(p => p.id === targetId)) {
        targetId = data.defaultProjectId || (projectsList[0] ? projectsList[0].id : 'corvette-z51');
      }

      setActiveProjectId(targetId, true);
      renderProjectSelector();
      await loadProjectState(activeProjectId);
    } catch (err) {
      console.error('Error loading projects list:', err);
      showSyncIndicator('Error loading projects', true);
    }
  }

  async function loadProjectState(id) {
    try {
      showSyncIndicator('Loading...', false);
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      appState = data.state;
      if (els.projectSelect) els.projectSelect.value = id;
      recalculateAndRender();
      showSyncIndicator('● Saved', false);
    } catch (err) {
      console.error(`Error loading project ${id}:`, err);
      showSyncIndicator('Error loading project', true);
    }
  }

  let saveDebounceTimer = null;
  function saveStateToServer(createSnapshot = true) {
    showSyncIndicator('Saving...', false);
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);

    saveDebounceTimer = setTimeout(async () => {
      try {
        const targetId = activeProjectId || 'corvette-z51';
        const res = await fetch(`/api/projects/${encodeURIComponent(targetId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: appState, createSnapshot })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        appState = data.state;
        showSyncIndicator('● Saved', false);
        // Refresh project summary in projectList
        const existing = projectsList.find(p => p.id === targetId);
        if (existing) {
          existing.name = appState.settings.projectName || targetId;
          existing.partsCount = appState.parts.length;
          existing.listingsCount = appState.listings.length;
          existing.updatedAt = appState.updatedAt;
          renderProjectSelector();
        }
      } catch (err) {
        console.error('Error saving state:', err);
        showSyncIndicator('Error saving to server', true);
      }
    }, 300);
  }

  function showSyncIndicator(msg, isError) {
    if (!els.syncIndicator) return;
    els.syncIndicator.textContent = msg;
    els.syncIndicator.style.color = isError ? 'var(--color-danger)' : 'var(--color-success)';
  }

  // --- Recalculate & Render All Views ---
  function recalculateAndRender() {
    // Run client-side calculation using calc.js
    solverOutput = window.PriceCompareCalc.evaluateState(appState);
    const summary = solverOutput.solution.summary;

    // Header Settings Sync
    const projName = appState.settings.projectName || 'Price Optimizer';
    if (els.projectTitle) els.projectTitle.textContent = projName;
    document.title = `${projName} — PriceCompare`;
    if (els.projectSelect && activeProjectId) {
      els.projectSelect.value = activeProjectId;
    }
    updateExportLinks();

    if (els.inputTaxRate) els.inputTaxRate.value = (Number(appState.settings.taxRate) * 100).toFixed(3);
    if (els.inputZipCode) els.inputZipCode.value = appState.settings.zipCode || '08879';

    // Header KPIs
    if (els.kpiShopTotal) els.kpiShopTotal.textContent = fmtCur(summary.shopBaselineTotal);
    if (els.kpiCheapestTotal) els.kpiCheapestTotal.textContent = fmtCur(summary.optimalTotal);
    if (els.kpiSavingsTotal) {
      els.kpiSavingsTotal.textContent = `${fmtCur(summary.totalSavings)} (${summary.savingsPct}%)`;
    }

    // Tab badges
    if (els.badgePartsCount) els.badgePartsCount.textContent = appState.parts.length;
    if (els.badgeListingsCount) els.badgeListingsCount.textContent = appState.listings.length;
    if (els.badgeWinningSavings) els.badgeWinningSavings.textContent = `Save ${fmtCur(summary.totalSavings)}`;

    // Render Tab 1: Parts
    renderPartsTable();

    // Render Tab 2: Listings & Bundles
    renderListingsChecklist();
    renderSellerOverrides();
    renderListingsTable();
    updateListingFormPreview();

    // Render Tab 3: Cheapest Results
    renderCheapestResults();
  }

  // --- TAB 1: PARTS TABLE ---
  function renderPartsTable() {
    if (!els.tbodyParts) return;
    els.tbodyParts.innerHTML = '';

    const parts = appState.parts || [];
    const taxRate = Number(appState.settings.taxRate) || 0.06625;
    const winningListings = solverOutput?.solution?.winningListingsMap || new Map();
    const winningShopParts = solverOutput?.solution?.winningShopPartsMap || new Map();

    if (parts.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'center-col';
      td.style.padding = '2rem';
      td.textContent = 'No parts added yet. Add a part above or click "Reset to C7 Parts".';
      tr.appendChild(td);
      els.tbodyParts.appendChild(tr);
      return;
    }

    parts.forEach(part => {
      const tr = document.createElement('tr');

      // Part Name
      const tdName = document.createElement('td');
      tdName.setAttribute('data-label', 'Part Name');
      const strongName = document.createElement('strong');
      strongName.textContent = part.name;
      tdName.appendChild(strongName);
      if (part.notes) {
        const sub = document.createElement('div');
        sub.className = 'card-sub';
        sub.textContent = part.notes;
        tdName.appendChild(sub);
      }
      tr.appendChild(tdName);

      // Part Numbers + Search eBay
      const tdPn = document.createElement('td');
      tdPn.setAttribute('data-label', 'Part Numbers');
      const pns = part.partNumbers || [];
      const pnText = document.createElement('span');
      pnText.textContent = pns.length > 0 ? pns.join(', ') : '—';
      tdPn.appendChild(pnText);
      tr.appendChild(tdPn);

      // Shop Price Pre-tax
      const tdShop = document.createElement('td');
      tdShop.setAttribute('data-label', 'Shop Quote');
      tdShop.className = 'num-col';
      tdShop.textContent = fmtCur(part.shopPrice);
      tr.appendChild(tdShop);

      // Shop Price w/ Tax
      const tdShopTax = document.createElement('td');
      tdShopTax.setAttribute('data-label', 'Shop w/ Tax');
      tdShopTax.className = 'num-col';
      const shopCost = window.PriceCompareCalc.shopPartCost(part, taxRate);
      tdShopTax.textContent = fmtCur(shopCost.total);
      tr.appendChild(tdShopTax);

      // Listings count covering this part
      const tdCoverCount = document.createElement('td');
      tdCoverCount.setAttribute('data-label', 'Listings');
      tdCoverCount.className = 'center-col';
      const count = appState.listings.filter(l => (l.partIds || []).includes(part.id)).length;
      const countBadge = document.createElement('span');
      countBadge.className = count > 0 ? 'badge badge-primary' : 'badge badge-subtle';
      countBadge.textContent = `${count} quotes`;
      tdCoverCount.appendChild(countBadge);
      tr.appendChild(tdCoverCount);

      // Winning Source
      const tdWinner = document.createElement('td');
      tdWinner.setAttribute('data-label', 'Best Source');
      let winnerLabel = 'No source found';
      let winnerClass = 'badge badge-warning';

      if (winningShopParts.has(part.id)) {
        winnerLabel = `Shop Quote (${fmtCur(shopCost.total)})`;
        winnerClass = 'badge badge-subtle';
      } else {
        for (const [lid, winInfo] of winningListings.entries()) {
          if ((winInfo.listing.partIds || []).includes(part.id)) {
            const isBundle = (winInfo.listing.partIds || []).length > 1;
            winnerLabel = isBundle ? `Bundle: ${winInfo.listing.title}` : winInfo.listing.title;
            winnerClass = 'badge badge-success';
            break;
          }
        }
      }

      const winBadge = document.createElement('span');
      winBadge.className = winnerClass;
      winBadge.textContent = winnerLabel;
      tdWinner.appendChild(winBadge);
      tr.appendChild(tdWinner);

      // Actions
      const tdActions = document.createElement('td');
      tdActions.setAttribute('data-label', 'Actions');
      tdActions.className = 'action-col';

      const wrapActions = document.createElement('div');
      wrapActions.className = 'table-actions';

      // "Search eBay" link button
      if (pns.length > 0) {
        const btnSearch = document.createElement('a');
        btnSearch.className = 'btn-search-ebay';
        btnSearch.target = '_blank';
        btnSearch.rel = 'noopener noreferrer';
        btnSearch.href = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(pns.join(' | '))}`;
        btnSearch.textContent = 'eBay ↗';
        wrapActions.appendChild(btnSearch);
      }

      // Delete Part button
      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'btn btn-sm btn-danger-outline';
      btnDel.textContent = '✕';
      btnDel.title = 'Delete part';
      btnDel.addEventListener('click', () => {
        if (confirm(`Remove "${part.name}" from your parts list?`)) {
          appState.parts = appState.parts.filter(p => p.id !== part.id);
          // Remove from listings
          appState.listings.forEach(l => {
            l.partIds = (l.partIds || []).filter(pid => pid !== part.id);
          });
          saveStateToServer(true);
          recalculateAndRender();
        }
      });
      wrapActions.appendChild(btnDel);

      tdActions.appendChild(wrapActions);
      tr.appendChild(tdActions);

      els.tbodyParts.appendChild(tr);
    });
  }

  // --- TAB 2: LISTINGS & BUNDLES ---
  function renderListingsChecklist() {
    if (!els.partsChecklistGrid) return;
    const parts = appState.parts || [];
    const prevChecked = new Set(
      Array.from(els.partsChecklistGrid.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value)
    );

    els.partsChecklistGrid.innerHTML = '';

    if (parts.length === 0) {
      els.partsChecklistGrid.textContent = 'Please add parts in Tab 1 (Parts List) first.';
      return;
    }

    parts.forEach(part => {
      const label = document.createElement('label');
      label.className = 'part-check-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = 'selectedListingParts';
      cb.value = part.id;
      if (prevChecked.has(part.id)) {
        cb.checked = true;
        label.classList.add('checked');
      }

      cb.addEventListener('change', () => {
        label.classList.toggle('checked', cb.checked);
        updateListingTypeBadge();
      });

      const spanText = document.createElement('span');
      spanText.textContent = part.name;

      label.appendChild(cb);
      label.appendChild(spanText);
      els.partsChecklistGrid.appendChild(label);
    });

    updateListingTypeBadge();
  }

  function updateListingTypeBadge() {
    if (!els.partsChecklistGrid || !els.listingTypeBadge) return;
    const count = els.partsChecklistGrid.querySelectorAll('input[type="checkbox"]:checked').length;
    if (count === 0) {
      els.listingTypeBadge.textContent = '0 Parts (Please check at least 1)';
      els.listingTypeBadge.className = 'badge badge-warning';
    } else if (count === 1) {
      els.listingTypeBadge.textContent = 'Individual Part Listing';
      els.listingTypeBadge.className = 'badge badge-primary';
    } else {
      els.listingTypeBadge.textContent = `Bundle (${count} Parts Included)`;
      els.listingTypeBadge.className = 'badge badge-bundle-type';
    }
    updateListingFormPreview();
  }

  function updateListingFormPreview() {
    if (!els.listingPreviewTotal) return;
    const price = Math.max(0, parseFloat(els.listingPrice?.value) || 0);
    const shipMode = els.listingShippingMode?.value || 'free';
    const shipAmount = shipMode === 'amount' ? Math.max(0, parseFloat(els.listingShippingAmount?.value) || 0) : 0;
    const taxRate = Number(appState.settings.taxRate) || 0.06625;
    const taxMode = els.listingTaxMode?.value || 'rate';

    let tax = 0;
    if (taxMode === 'rate') {
      tax = window.PriceCompareCalc.round2((price + shipAmount) * taxRate);
    } else if (taxMode === 'manual') {
      tax = Math.max(0, parseFloat(els.listingManualTax?.value) || 0);
    }

    const total = window.PriceCompareCalc.round2(price + shipAmount + tax);

    // Check if seller has an override
    const seller = String(els.listingSeller?.value || '').trim();
    let overrideNote = '';
    if (seller && appState.settings.sellerShipping) {
      const sKey = window.PriceCompareCalc.normalizeSeller(seller);
      for (const [key, ovr] of Object.entries(appState.settings.sellerShipping)) {
        if (window.PriceCompareCalc.normalizeSeller(key) === sKey && ovr) {
          overrideNote = ` • Note: ${key} shipping override applies in cart!`;
          break;
        }
      }
    }

    els.listingPreviewTotal.innerHTML = `Landed Total: <strong>${fmtCur(total)}</strong>`;
    if (els.listingPreviewSub) {
      els.listingPreviewSub.textContent = `(${fmtCur(price)} item + ${fmtCur(shipAmount)} ship + ${fmtCur(tax)} tax)${overrideNote}`;
    }
  }

  function renderSellerOverrides() {
    if (!els.sellerOverridesList) return;
    els.sellerOverridesList.innerHTML = '';
    const overrides = appState.settings.sellerShipping || {};
    const keys = Object.keys(overrides);

    if (els.badgeOverridesCount) {
      els.badgeOverridesCount.textContent = `${keys.length} Set`;
    }

    if (keys.length === 0) {
      const p = document.createElement('p');
      p.className = 'card-sub';
      p.style.fontStyle = 'italic';
      p.textContent = 'No seller shipping overrides configured yet.';
      els.sellerOverridesList.appendChild(p);
      return;
    }

    keys.forEach(seller => {
      const ovr = overrides[seller];
      const div = document.createElement('div');
      div.className = 'override-item-pill';

      const desc = document.createElement('span');
      const modeText = ovr.mode === 'free' ? 'Free combined shipping' : `$${Number(ovr.amount).toFixed(2)} flat combined shipping`;
      const taxText = ovr.taxable ? ' (taxable)' : ' (non-taxable)';
      desc.innerHTML = `<strong>${seller}</strong>: ${modeText}${taxText}`;
      div.appendChild(desc);

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'btn btn-sm btn-danger-outline';
      btnDel.textContent = 'Remove';
      btnDel.addEventListener('click', () => {
        delete appState.settings.sellerShipping[seller];
        saveStateToServer(true);
        recalculateAndRender();
      });
      div.appendChild(btnDel);

      els.sellerOverridesList.appendChild(div);
    });
  }

  // --- Purchase Dialog & Offer Calculator ---
  function openMarkPurchasedModal(listing) {
    if (!listing || !els.dialogMarkPurchased) return;
    const isAlreadyPurchased = listing.state === 'purchased';
    const cost = window.PriceCompareCalc.listingCost(listing, appState.settings);

    if (els.purchasedListingId) els.purchasedListingId.value = listing.id;
    if (els.dialogMarkPurchasedTitle) {
      els.dialogMarkPurchasedTitle.textContent = isAlreadyPurchased
        ? 'Edit Purchase Details & Final Cost'
        : 'Mark Listing as Purchased';
    }

    if (els.purchasedItemTitle) els.purchasedItemTitle.textContent = listing.title;
    if (els.purchasedItemMeta) {
      const origCost = window.PriceCompareCalc.listingCost({ ...listing, state: 'normal', finalCost: null }, appState.settings);
      els.purchasedItemMeta.textContent = `${listing.seller || 'eBay'} • Listed item: ${fmtCur(listing.price)} • Listed landed total: ${fmtCur(origCost.total)}`;
    }

    // Default final cost to current finalCost if set, or original landed total
    const defaultFinalCost = (listing.finalCost !== null && listing.finalCost !== undefined && !isNaN(Number(listing.finalCost)))
      ? Number(listing.finalCost).toFixed(2)
      : cost.total.toFixed(2);
    if (els.inputFinalCost) els.inputFinalCost.value = defaultFinalCost;

    if (els.inputOfferPrice) {
      els.inputOfferPrice.value = (listing.finalPrice !== null && listing.finalPrice !== undefined)
        ? listing.finalPrice
        : listing.price;
    }
    if (els.inputOfferShipping) {
      els.inputOfferShipping.value = (listing.finalShipping !== null && listing.finalShipping !== undefined)
        ? listing.finalShipping
        : (cost.shipping || 0);
    }
    if (els.inputOfferTax) {
      els.inputOfferTax.value = (listing.finalTax !== null && listing.finalTax !== undefined)
        ? listing.finalTax
        : (cost.tax || 0);
    }
    if (els.inputPurchaseNotes) {
      els.inputPurchaseNotes.value = listing.purchaseNotes || listing.notes || '';
    }

    updateOfferCalcPreview(listing);

    if (els.btnUnmarkPurchased) {
      els.btnUnmarkPurchased.style.display = isAlreadyPurchased ? 'inline-flex' : 'none';
    }

    if (els.btnConfirmPurchase) {
      els.btnConfirmPurchase.textContent = isAlreadyPurchased ? '✓ Update Purchase' : '✓ Confirm Purchase';
    }

    els.dialogMarkPurchased.showModal();
  }

  function updateOfferCalcPreview(listing) {
    if (!listing) {
      const lid = els.purchasedListingId?.value;
      listing = appState.listings.find(l => l.id === lid);
      if (!listing) return;
    }

    const taxRate = Number(appState.settings.taxRate) || 0.06625;
    if (els.calcTaxRateLabel) {
      els.calcTaxRateLabel.textContent = `${(taxRate * 100).toFixed(3)}%`;
    }

    const offerPrice = parseFloat(els.inputOfferPrice?.value) || 0;
    const offerShip = parseFloat(els.inputOfferShipping?.value) || 0;
    const offerTax = parseFloat(els.inputOfferTax?.value) || 0;
    const offerTotal = window.PriceCompareCalc.round2(offerPrice + offerShip + offerTax);

    const origPrice = Number(listing.price) || 0;
    const diff = window.PriceCompareCalc.round2(origPrice - offerPrice);

    if (els.offerSavingsAlert && els.badgeOfferSavings) {
      if (offerPrice > 0 && diff > 0) {
        const pct = origPrice > 0 ? Math.round((diff / origPrice) * 100) : 0;
        els.offerSavingsAlert.style.display = 'block';
        els.offerSavingsAlert.textContent = `✓ Offer saves $${diff.toFixed(2)} (${pct}% discount vs $${origPrice.toFixed(2)} listed price). Landed total: $${offerTotal.toFixed(2)}`;
        els.badgeOfferSavings.textContent = `Save $${diff.toFixed(2)}`;
        els.badgeOfferSavings.className = 'badge badge-success';
      } else {
        els.offerSavingsAlert.style.display = 'none';
        els.badgeOfferSavings.textContent = 'Optional';
        els.badgeOfferSavings.className = 'badge badge-subtle';
      }
    }
  }

  function renderListingsTable() {
    if (!els.tbodyListings) return;
    els.tbodyListings.innerHTML = '';

    const listings = appState.listings || [];
    const filter = els.selectFilterListings?.value || 'all';
    const partsMap = new Map((appState.parts || []).map(p => [p.id, p]));
    const solution = solverOutput?.solution;
    const verdicts = solverOutput?.verdicts || {};
    const winningListings = solution?.winningListingsMap || new Map();

    const filtered = listings.filter(l => {
      const count = (l.partIds || []).length;
      if (filter === 'bundles') return count > 1;
      if (filter === 'individual') return count <= 1;
      if (filter === 'incart') return winningListings.has(l.id);
      return true;
    });

    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 11;
      td.className = 'center-col';
      td.style.padding = '2rem';
      td.textContent = 'No listings match the current filter.';
      tr.appendChild(td);
      els.tbodyListings.appendChild(tr);
      return;
    }

    filtered.forEach(listing => {
      const isWinning = winningListings.has(listing.id);
      const isPurchased = listing.state === 'purchased';
      const cost = window.PriceCompareCalc.listingCost(listing, appState.settings);
      const isBundle = (listing.partIds || []).length > 1;
      const verdict = verdicts[listing.id];

      const tr = document.createElement('tr');
      if (isPurchased) {
        tr.className = isWinning ? 'row-winning row-purchased' : 'row-purchased';
      } else if (isWinning) {
        tr.className = 'row-winning';
      }

      // Title & Link
      const tdTitle = document.createElement('td');
      tdTitle.setAttribute('data-label', 'Title');
      const titleStrong = document.createElement('strong');
      titleStrong.textContent = listing.title;
      tdTitle.appendChild(titleStrong);

      if (isPurchased) {
        const pBadge = document.createElement('span');
        pBadge.className = 'badge badge-success';
        pBadge.style.marginLeft = '0.5rem';
        pBadge.textContent = cost.hasFinalCost ? `✓ Purchased ($${cost.total.toFixed(2)})` : '✓ Purchased';
        tdTitle.appendChild(pBadge);
      }

      const noteText = listing.purchaseNotes || listing.notes;
      if (noteText) {
        const sub = document.createElement('div');
        sub.className = 'card-sub';
        sub.textContent = noteText;
        tdTitle.appendChild(sub);
      }
      tr.appendChild(tdTitle);

      // Type Badge
      const tdType = document.createElement('td');
      tdType.setAttribute('data-label', 'Type');
      const typeBadge = document.createElement('span');
      typeBadge.className = isBundle ? 'badge badge-bundle-type' : 'badge badge-primary';
      typeBadge.textContent = isBundle ? `Bundle (${(listing.partIds || []).length})` : 'Individual';
      tdType.appendChild(typeBadge);
      tr.appendChild(tdType);

      // Parts Included
      const tdParts = document.createElement('td');
      tdParts.setAttribute('data-label', 'Parts Included');
      const partNames = (listing.partIds || []).map(pid => partsMap.get(pid)?.name || 'Unknown part');
      tdParts.textContent = partNames.join(', ');
      tr.appendChild(tdParts);

      // Seller
      const tdSeller = document.createElement('td');
      tdSeller.setAttribute('data-label', 'Seller');
      tdSeller.textContent = listing.seller || 'eBay';
      tr.appendChild(tdSeller);

      // Price
      const tdPrice = document.createElement('td');
      tdPrice.setAttribute('data-label', 'Price');
      tdPrice.className = 'num-col';
      tdPrice.textContent = fmtCur(cost.price);
      if (cost.savingsOnOffer > 0) {
        const sBadge = document.createElement('div');
        sBadge.className = 'badge-offer-saved';
        sBadge.style.marginTop = '0.2rem';
        sBadge.textContent = `Offer: -$${cost.savingsOnOffer.toFixed(2)}`;
        tdPrice.appendChild(sBadge);
      }
      tr.appendChild(tdPrice);

      // Shipping
      const tdShip = document.createElement('td');
      tdShip.setAttribute('data-label', 'Shipping');
      tdShip.className = 'num-col';
      if (cost.isUnknownShipping) {
        tdShip.innerHTML = '<span class="text-danger" title="Unknown shipping">Inquire ⚠</span>';
      } else if (cost.shipping === 0) {
        tdShip.innerHTML = '<span class="text-success">Free</span>';
      } else {
        tdShip.textContent = fmtCur(cost.shipping);
      }
      tr.appendChild(tdShip);

      // Tax
      const tdTax = document.createElement('td');
      tdTax.setAttribute('data-label', 'Tax');
      tdTax.className = 'num-col';
      tdTax.textContent = fmtCur(cost.tax);
      tr.appendChild(tdTax);

      // Total
      const tdTotal = document.createElement('td');
      tdTotal.setAttribute('data-label', 'Total');
      tdTotal.className = 'num-col';
      const strongTotal = document.createElement('strong');
      strongTotal.textContent = fmtCur(cost.total);
      tdTotal.appendChild(strongTotal);
      if (isPurchased) {
        const pLabel = document.createElement('div');
        pLabel.style.fontSize = '0.72rem';
        pLabel.style.color = 'var(--color-success)';
        pLabel.style.fontWeight = '600';
        pLabel.textContent = cost.hasFinalCost ? 'Final Paid' : 'Purchased';
        tdTotal.appendChild(pLabel);
      }
      tr.appendChild(tdTotal);

      // Verdict
      const tdVerdict = document.createElement('td');
      tdVerdict.setAttribute('data-label', 'Verdict');
      if (verdict && verdict.badgeText) {
        const vBadge = document.createElement('span');
        if (verdict.verdictType === 'bundle_wins') {
          vBadge.className = 'badge badge-success';
        } else if (verdict.verdictType === 'individual_wins') {
          vBadge.className = 'badge badge-warning';
        } else {
          vBadge.className = 'badge badge-subtle';
        }
        vBadge.textContent = verdict.badgeText;
        tdVerdict.appendChild(vBadge);
      }
      tr.appendChild(tdVerdict);

      // State selector
      const tdState = document.createElement('td');
      tdState.setAttribute('data-label', 'Status');
      tdState.className = 'center-col';

      const selState = document.createElement('select');
      selState.className = 'select-field';
      selState.style.height = '1.85rem';
      selState.style.fontSize = '0.75rem';

      [
        { val: 'normal', text: 'Normal' },
        { val: 'must', text: 'Must Buy' },
        { val: 'purchased', text: 'Purchased' },
        { val: 'excluded', text: 'Excluded' }
      ].forEach(opt => {
        const o = document.createElement('option');
        o.value = opt.val;
        o.textContent = opt.text;
        if (listing.state === opt.val) o.selected = true;
        selState.appendChild(o);
      });

      selState.addEventListener('change', () => {
        if (selState.value === 'purchased') {
          openMarkPurchasedModal(listing);
        } else {
          listing.state = selState.value;
          if (isPurchased) {
            listing.finalCost = null;
            listing.finalPrice = null;
          }
          saveStateToServer(true);
          recalculateAndRender();
        }
      });
      tdState.appendChild(selState);

      if (isPurchased) {
        const btnEditPaid = document.createElement('button');
        btnEditPaid.type = 'button';
        btnEditPaid.className = 'btn-link';
        btnEditPaid.style.display = 'block';
        btnEditPaid.style.fontSize = '0.72rem';
        btnEditPaid.style.marginTop = '0.2rem';
        btnEditPaid.textContent = cost.hasFinalCost ? `Edit Paid (${fmtCur(cost.total)})` : 'Set Final Cost';
        btnEditPaid.addEventListener('click', () => openMarkPurchasedModal(listing));
        tdState.appendChild(btnEditPaid);
      }
      tr.appendChild(tdState);

      // Actions
      const tdActions = document.createElement('td');
      tdActions.setAttribute('data-label', 'Actions');
      tdActions.className = 'action-col';

      const wrapActions = document.createElement('div');
      wrapActions.className = 'table-actions';

      if (listing.url) {
        const btnLink = document.createElement('a');
        btnLink.className = 'btn-open-link';
        btnLink.href = listing.url;
        btnLink.target = '_blank';
        btnLink.rel = 'noopener noreferrer';
        btnLink.textContent = 'Open ↗';
        wrapActions.appendChild(btnLink);
      }

      // Quick Purchase Action Button
      const btnPurchaseAction = document.createElement('button');
      btnPurchaseAction.type = 'button';
      if (isPurchased) {
        btnPurchaseAction.className = 'btn btn-sm btn-emerald';
        btnPurchaseAction.textContent = `✓ ${fmtCur(cost.total)}`;
        btnPurchaseAction.title = 'Edit purchase details';
      } else {
        btnPurchaseAction.className = 'btn btn-sm btn-emerald-outline';
        btnPurchaseAction.textContent = '✓ Purchased?';
        btnPurchaseAction.title = 'Mark as purchased';
      }
      btnPurchaseAction.addEventListener('click', () => openMarkPurchasedModal(listing));
      wrapActions.appendChild(btnPurchaseAction);

      const btnEdit = document.createElement('button');
      btnEdit.type = 'button';
      btnEdit.className = 'btn btn-sm btn-secondary';
      btnEdit.textContent = 'Edit';
      btnEdit.addEventListener('click', () => {
        populateListingFormForEdit(listing);
      });
      wrapActions.appendChild(btnEdit);

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'btn btn-sm btn-danger-outline';
      btnDel.textContent = '✕';
      btnDel.title = 'Delete listing';
      btnDel.addEventListener('click', () => {
        if (confirm(`Delete listing "${listing.title}"?`)) {
          appState.listings = appState.listings.filter(l => l.id !== listing.id);
          saveStateToServer(true);
          recalculateAndRender();
        }
      });
      wrapActions.appendChild(btnDel);

      tdActions.appendChild(wrapActions);
      tr.appendChild(tdActions);

      els.tbodyListings.appendChild(tr);
    });
  }

  function populateListingFormForEdit(listing) {
    if (els.editListingId) els.editListingId.value = listing.id;
    if (els.listingTitle) els.listingTitle.value = listing.title;
    if (els.listingSeller) els.listingSeller.value = listing.seller;
    if (els.listingCondition) els.listingCondition.value = listing.condition || 'Used';
    if (els.listingPrice) els.listingPrice.value = listing.price;
    if (els.listingShippingMode) els.listingShippingMode.value = listing.shippingMode || (listing.freeShipping ? 'free' : 'amount');
    if (els.listingShippingAmount) els.listingShippingAmount.value = listing.shipping || 0;
    if (els.listingTaxMode) els.listingTaxMode.value = listing.taxMode || 'rate';
    if (els.listingManualTax) els.listingManualTax.value = listing.manualTax || 0;
    if (els.listingState) els.listingState.value = listing.state || 'normal';
    if (els.listingUrl) els.listingUrl.value = listing.url || '';
    if (els.listingNotes) els.listingNotes.value = listing.notes || '';

    // Purchase fields
    if (els.listingFinalCost) els.listingFinalCost.value = listing.finalCost != null ? listing.finalCost : '';
    if (els.listingFinalPrice) els.listingFinalPrice.value = listing.finalPrice != null ? listing.finalPrice : '';
    if (els.listingPurchaseNotes) els.listingPurchaseNotes.value = listing.purchaseNotes || '';
    if (els.wrapPurchasedListingFields) {
      els.wrapPurchasedListingFields.style.display = listing.state === 'purchased' ? 'block' : 'none';
    }

    // Check checkboxes
    const pSet = new Set(listing.partIds || []);
    if (els.partsChecklistGrid) {
      els.partsChecklistGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = pSet.has(cb.value);
        cb.closest('.part-check-item')?.classList.toggle('checked', cb.checked);
      });
    }

    if (els.wrapShippingAmount) {
      els.wrapShippingAmount.style.display = els.listingShippingMode.value === 'amount' ? 'flex' : 'none';
    }
    if (els.wrapManualTax) {
      els.wrapManualTax.style.display = els.listingTaxMode.value === 'manual' ? 'flex' : 'none';
    }

    if (els.btnSubmitListing) els.btnSubmitListing.textContent = 'Update Listing';
    updateListingTypeBadge();
    els.formListing?.scrollIntoView({ behavior: 'smooth' });
  }

  // --- TAB 3: CHEAPEST RESULTS VIEW ---
  function renderCheapestResults() {
    if (!solverOutput) return;
    const solution = solverOutput.solution;
    const summary = solution.summary;
    const partsMap = new Map((appState.parts || []).map(p => [p.id, p]));

    // Alerts
    if (els.uncoverableBanner && els.uncoverableListText) {
      if (solution.uncoverableParts.length > 0) {
        els.uncoverableBanner.style.display = 'block';
        els.uncoverableListText.textContent = solution.uncoverableParts.map(p => p.name).join(', ');
      } else {
        els.uncoverableBanner.style.display = 'none';
      }
    }

    if (els.duplicateBanner && els.duplicateListText) {
      if (solution.duplicatePartNames.length > 0) {
        els.duplicateBanner.style.display = 'block';
        els.duplicateListText.textContent = `Includes duplicate parts (${solution.duplicatePartNames.join(', ')}) because purchasing the bundle remained the cheapest overall option.`;
      } else {
        els.duplicateBanner.style.display = 'none';
      }
    }

    // Results KPIs
    if (els.resShopBaselineVal) els.resShopBaselineVal.textContent = fmtCur(summary.shopBaselineTotal);
    if (els.resCheapestVal) els.resCheapestVal.textContent = fmtCur(summary.optimalTotal);
    if (els.resNetSavingsVal) els.resNetSavingsVal.textContent = fmtCur(summary.totalSavings);
    if (els.resNetSavingsPct) els.resNetSavingsPct.textContent = `${summary.savingsPct}% reduction vs shop baseline quote`;
    if (els.resSpentVal) els.resSpentVal.textContent = `${fmtCur(summary.purchasedTotal)} spent`;
    if (els.resToBuySub) els.resToBuySub.textContent = `${fmtCur(summary.toBuyTotal)} remaining to purchase`;

    // Buy List Table
    if (els.tbodyOptimalCart) {
      els.tbodyOptimalCart.innerHTML = '';
      const cart = solution.bestCart || [];

      if (cart.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 9;
        td.className = 'center-col';
        td.style.padding = '2rem';
        td.textContent = 'No purchase options selected. Add parts and listings to calculate.';
        tr.appendChild(td);
        els.tbodyOptimalCart.appendChild(tr);
      } else {
        cart.forEach(opt => {
          const tr = document.createElement('tr');
          if (opt.type === 'listing') {
            const l = opt.listing;
            const c = window.PriceCompareCalc.listingCost(l, appState.settings);
            const isBundle = (l.partIds || []).length > 1;
            const coveredNames = (l.partIds || []).map(pid => partsMap.get(pid)?.name || pid).join(', ');

            // Item Title
            const tdTitle = document.createElement('td');
            tdTitle.setAttribute('data-label', 'Item');
            const titleStrong = document.createElement('strong');
            titleStrong.textContent = l.title;
            tdTitle.appendChild(titleStrong);
            if (l.state === 'purchased') {
              const badge = document.createElement('span');
              badge.className = 'badge badge-success';
              badge.style.marginLeft = '0.5rem';
              badge.textContent = c.hasFinalCost ? `✓ Purchased (${fmtCur(c.total)})` : '✓ Purchased';
              tdTitle.appendChild(badge);

              if (c.savingsOnOffer > 0) {
                const sBadge = document.createElement('span');
                sBadge.className = 'badge badge-offer-saved';
                sBadge.style.marginLeft = '0.35rem';
                sBadge.textContent = `Offer: Saved ${fmtCur(c.savingsOnOffer)}`;
                tdTitle.appendChild(sBadge);
              }
            }
            tr.appendChild(tdTitle);

            // Type
            const tdType = document.createElement('td');
            tdType.setAttribute('data-label', 'Type');
            const b = document.createElement('span');
            b.className = isBundle ? 'badge badge-bundle-type' : 'badge badge-primary';
            b.textContent = isBundle ? 'Bundle' : 'Individual';
            tdType.appendChild(b);
            tr.appendChild(tdType);

            // Parts Covered
            const tdParts = document.createElement('td');
            tdParts.setAttribute('data-label', 'Parts Covered');
            tdParts.textContent = coveredNames;
            tr.appendChild(tdParts);

            // Seller
            const tdSeller = document.createElement('td');
            tdSeller.setAttribute('data-label', 'Seller');
            tdSeller.textContent = l.seller || 'eBay';
            tr.appendChild(tdSeller);

            // Price
            const tdPrice = document.createElement('td');
            tdPrice.setAttribute('data-label', 'Price');
            tdPrice.className = 'num-col';
            tdPrice.textContent = fmtCur(c.price);
            if (c.savingsOnOffer > 0) {
              const sBadge = document.createElement('div');
              sBadge.className = 'badge-offer-saved';
              sBadge.style.marginTop = '0.2rem';
              sBadge.textContent = `Offer: -${fmtCur(c.savingsOnOffer)}`;
              tdPrice.appendChild(sBadge);
            }
            tr.appendChild(tdPrice);

            // Shipping
            const tdShip = document.createElement('td');
            tdShip.setAttribute('data-label', 'Shipping');
            tdShip.className = 'num-col';
            tdShip.textContent = c.shipping === 0 ? 'Free' : fmtCur(c.shipping);
            tr.appendChild(tdShip);

            // Tax
            const tdTax = document.createElement('td');
            tdTax.setAttribute('data-label', 'Tax');
            tdTax.className = 'num-col';
            tdTax.textContent = fmtCur(c.tax);
            tr.appendChild(tdTax);

            // Total
            const tdTotal = document.createElement('td');
            tdTotal.setAttribute('data-label', 'Total');
            tdTotal.className = 'num-col';
            const sTotal = document.createElement('strong');
            sTotal.textContent = fmtCur(c.total);
            tdTotal.appendChild(sTotal);
            if (l.state === 'purchased') {
              const pTag = document.createElement('div');
              pTag.style.fontSize = '0.72rem';
              pTag.style.color = 'var(--color-success)';
              pTag.style.fontWeight = '600';
              pTag.textContent = c.hasFinalCost ? 'Final Paid' : 'Purchased';
              tdTotal.appendChild(pTag);
            }
            tr.appendChild(tdTotal);

            // Link & Purchase Button
            const tdLink = document.createElement('td');
            tdLink.setAttribute('data-label', 'Purchase Link');
            tdLink.className = 'action-col';

            const wrapCartActions = document.createElement('div');
            wrapCartActions.className = 'table-actions';

            if (l.url) {
              const a = document.createElement('a');
              a.className = 'btn-open-link';
              a.href = l.url;
              a.target = '_blank';
              a.rel = 'noopener noreferrer';
              a.textContent = 'Open ↗';
              wrapCartActions.appendChild(a);
            }

            const btnBuyAction = document.createElement('button');
            btnBuyAction.type = 'button';
            if (l.state === 'purchased') {
              btnBuyAction.className = 'btn btn-sm btn-emerald';
              btnBuyAction.textContent = `✓ ${fmtCur(c.total)}`;
              btnBuyAction.title = 'Edit purchase details or final cost';
            } else {
              btnBuyAction.className = 'btn btn-sm btn-emerald-outline';
              btnBuyAction.textContent = '✓ Mark Purchased';
              btnBuyAction.title = 'Mark as purchased & record final cost';
            }
            btnBuyAction.addEventListener('click', () => openMarkPurchasedModal(l));
            wrapCartActions.appendChild(btnBuyAction);

            tdLink.appendChild(wrapCartActions);
            tr.appendChild(tdLink);

          } else if (opt.type === 'shop') {
            const p = opt.part;
            const c = window.PriceCompareCalc.shopPartCost(p, Number(appState.settings.taxRate) || 0.06625);

            // Title
            const tdTitle = document.createElement('td');
            tdTitle.setAttribute('data-label', 'Item');
            const titleStrong = document.createElement('strong');
            titleStrong.textContent = `Shop / OEM New: ${p.name}`;
            tdTitle.appendChild(titleStrong);
            tr.appendChild(tdTitle);

            // Type
            const tdType = document.createElement('td');
            tdType.setAttribute('data-label', 'Type');
            const b = document.createElement('span');
            b.className = 'badge badge-subtle';
            b.textContent = 'Shop Quote';
            tdType.appendChild(b);
            tr.appendChild(tdType);

            // Parts Covered
            const tdParts = document.createElement('td');
            tdParts.setAttribute('data-label', 'Parts Covered');
            tdParts.textContent = p.name;
            tr.appendChild(tdParts);

            // Seller
            const tdSeller = document.createElement('td');
            tdSeller.setAttribute('data-label', 'Seller');
            tdSeller.textContent = 'Shop / Dealer';
            tr.appendChild(tdSeller);

            // Price
            const tdPrice = document.createElement('td');
            tdPrice.setAttribute('data-label', 'Price');
            tdPrice.className = 'num-col';
            tdPrice.textContent = fmtCur(c.price);
            tr.appendChild(tdPrice);

            // Shipping
            const tdShip = document.createElement('td');
            tdShip.setAttribute('data-label', 'Shipping');
            tdShip.className = 'num-col';
            tdShip.textContent = '$0.00';
            tr.appendChild(tdShip);

            // Tax
            const tdTax = document.createElement('td');
            tdTax.setAttribute('data-label', 'Tax');
            tdTax.className = 'num-col';
            tdTax.textContent = fmtCur(c.tax);
            tr.appendChild(tdTax);

            // Total
            const tdTotal = document.createElement('td');
            tdTotal.setAttribute('data-label', 'Total');
            tdTotal.className = 'num-col';
            const sTotal = document.createElement('strong');
            sTotal.textContent = fmtCur(c.total);
            tdTotal.appendChild(sTotal);
            tr.appendChild(tdTotal);

            // Link
            const tdLink = document.createElement('td');
            tdLink.setAttribute('data-label', 'Purchase Link');
            tdLink.className = 'action-col';
            const spanShop = document.createElement('span');
            spanShop.className = 'card-sub';
            spanShop.textContent = 'Buy from Shop / Dealer';
            tdLink.appendChild(spanShop);
            tr.appendChild(tdLink);
          }

          els.tbodyOptimalCart.appendChild(tr);
        });
      }
    }

    // Footers / Totals row
    if (els.tfootOptimalCart) {
      const pTotal = summary.purchasedTotal || 0;
      const bTotal = summary.toBuyTotal || 0;
      els.tfootOptimalCart.innerHTML = `
        <tr>
          <td colspan="4">
            <strong>TOTAL CHEAPEST PLAN</strong>
            <div style="font-size: 0.78rem; font-weight: normal; color: var(--color-text-muted); margin-top: 0.2rem;">
              <span style="color: var(--color-success); font-weight: 600;">${fmtCur(pTotal)} purchased</span> • 
              <span>${fmtCur(bTotal)} still to buy</span>
            </div>
          </td>
          <td class="num-col">${fmtCur(summary.optimalPreTax)}</td>
          <td class="num-col">${fmtCur(summary.optimalShipping)}</td>
          <td class="num-col">${fmtCur(summary.optimalTax)}</td>
          <td class="num-col"><strong class="text-primary">${fmtCur(summary.optimalTotal)}</strong></td>
          <td></td>
        </tr>
      `;
    }

    // Bundle vs. Individual Cards Grid
    if (els.bundleVerdictsGrid) {
      els.bundleVerdictsGrid.innerHTML = '';
      const bundles = (appState.listings || []).filter(l => (l.partIds || []).length > 1);

      if (bundles.length === 0) {
        const p = document.createElement('p');
        p.className = 'card-sub';
        p.style.gridColumn = '1 / -1';
        p.textContent = 'No multi-part bundles entered yet. When you add listings covering 2 or more parts, head-to-head comparisons will appear here.';
        els.bundleVerdictsGrid.appendChild(p);
      } else {
        bundles.forEach(bundle => {
          const verdict = solverOutput.verdicts[bundle.id];
          const card = document.createElement('div');
          const isWinning = verdict?.inCart;
          const winsVsIndiv = verdict?.verdictType === 'bundle_wins';
          card.className = `bundle-card ${winsVsIndiv ? 'wins' : 'loses'}`;

          const header = document.createElement('div');
          header.className = 'bundle-card-header';

          const title = document.createElement('div');
          title.className = 'bundle-card-title';
          title.textContent = bundle.title;
          header.appendChild(title);

          const inCartPill = document.createElement('span');
          inCartPill.className = isWinning ? 'badge badge-success' : 'badge badge-subtle';
          inCartPill.textContent = isWinning ? '✓ In Winning Cart' : 'Not in Cart';
          header.appendChild(inCartPill);
          card.appendChild(header);

          // Parts list in bundle
          const partsSub = document.createElement('div');
          partsSub.className = 'card-sub';
          const pNames = (bundle.partIds || []).map(pid => partsMap.get(pid)?.name || pid).join(', ');
          partsSub.textContent = `Parts: ${pNames}`;
          card.appendChild(partsSub);

          // Side-by-Side comparison
          const compBar = document.createElement('div');
          compBar.className = 'bundle-comparison-bar';

          const bPrice = document.createElement('div');
          bPrice.innerHTML = `Bundle Cost: <strong>${fmtCur(verdict?.bundleCost)}</strong>`;
          compBar.appendChild(bPrice);

          const iPrice = document.createElement('div');
          iPrice.innerHTML = verdict?.altCost !== null
            ? `Individual Mix: <strong>${fmtCur(verdict?.altCost)}</strong>`
            : `Individual Mix: <em>No alternative</em>`;
          compBar.appendChild(iPrice);
          card.appendChild(compBar);

          // Verdict Banner
          if (verdict?.badgeText) {
            const vBanner = document.createElement('div');
            vBanner.className = `bundle-verdict-banner ${winsVsIndiv ? 'wins' : 'loses'}`;
            vBanner.textContent = verdict.badgeText;
            card.appendChild(vBanner);
          }

          // Link Button
          if (bundle.url) {
            const a = document.createElement('a');
            a.className = 'btn btn-sm btn-secondary';
            a.style.alignSelf = 'flex-start';
            a.href = bundle.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = 'Open Listing ↗';
            card.appendChild(a);
          }

          els.bundleVerdictsGrid.appendChild(card);
        });
      }
    }
  }

  // --- SPA Tab Navigation & faster-spa-view-transitions Pattern ---
  function switchTab(targetBtn) {
    if (!targetBtn) return;
    const targetPanelId = targetBtn.getAttribute('aria-controls');
    const targetPanel = document.getElementById(targetPanelId);
    if (!targetPanel) return;

    els.tabButtons.forEach(btn => {
      btn.classList.remove('active');
      btn.setAttribute('aria-selected', 'false');
      btn.setAttribute('tabindex', '-1');
    });

    els.spaViews.forEach(view => {
      view.classList.add('inactive');
      view.setAttribute('aria-hidden', 'true');
    });

    targetBtn.classList.add('active');
    targetBtn.setAttribute('aria-selected', 'true');
    targetBtn.setAttribute('tabindex', '0');

    targetPanel.classList.remove('inactive');
    targetPanel.setAttribute('aria-hidden', 'false');

    activeTabId = targetBtn.id;
    try {
      localStorage.setItem('pricecompare_active_tab', activeTabId);
    } catch {}

    targetPanel.focus();
  }

  function setupTabs() {
    els.tabButtons.forEach((btn, idx) => {
      btn.addEventListener('click', () => switchTab(btn));

      // Arrow-key accessible tab navigation
      btn.addEventListener('keydown', (e) => {
        let targetIdx = idx;
        if (e.key === 'ArrowRight') {
          targetIdx = (idx + 1) % els.tabButtons.length;
        } else if (e.key === 'ArrowLeft') {
          targetIdx = (idx - 1 + els.tabButtons.length) % els.tabButtons.length;
        } else if (e.key === 'Home') {
          targetIdx = 0;
        } else if (e.key === 'End') {
          targetIdx = els.tabButtons.length - 1;
        } else {
          return;
        }
        e.preventDefault();
        const nextBtn = els.tabButtons[targetIdx];
        nextBtn.focus();
        switchTab(nextBtn);
      });
    });

    // Restore last active tab
    try {
      const savedTabId = localStorage.getItem('pricecompare_active_tab');
      if (savedTabId) {
        const savedBtn = document.getElementById(savedTabId);
        if (savedBtn) switchTab(savedBtn);
      }
    } catch {}
  }

  // --- Setup Form Listeners & Modals ---
  function setupForms() {
    // Add Part Form (Tab 1)
    els.formAddPart?.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = String(els.newPartName?.value || '').trim();
      if (!name) return;

      const pns = window.PriceCompareCalc ? els.newPartNumbers?.value.split(/[,;\/]|\bor\b/i).map(s => s.trim()).filter(Boolean) : [];
      const shopPrice = Math.max(0, parseFloat(els.newPartShopPrice?.value) || 0);
      const shopTaxable = els.newPartTaxable?.checked !== false;

      const newPart = {
        id: 'part-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        name,
        partNumbers: pns,
        shopPrice,
        shopTaxable,
        notes: ''
      };

      appState.parts.push(newPart);
      els.newPartName.value = '';
      if (els.newPartNumbers) els.newPartNumbers.value = '';
      if (els.newPartShopPrice) els.newPartShopPrice.value = '';
      saveStateToServer(true);
      recalculateAndRender();
    });

    // Reset default C7 parts button
    els.btnResetDefaultParts?.addEventListener('click', async () => {
      if (confirm('Reset your parts list to the baseline 11 C7 Corvette replacement parts? (Existing listings will be kept)')) {
        try {
          const targetId = activeProjectId || 'corvette-z51';
          const res = await fetch(`/api/projects/${encodeURIComponent(targetId)}/reset`, { method: 'POST' });
          if (!res.ok) throw new Error('Reset failed');
          const data = await res.json();
          appState = data.state;
          recalculateAndRender();
        } catch (err) {
          alert('Error resetting parts: ' + err.message);
        }
      }
    });

    // eBay & URL Auto-Pull (Tab 2)
    els.btnFetchUrl?.addEventListener('click', async () => {
      const urlOrId = String(els.inputFetchUrl?.value || '').trim();
      if (!urlOrId) return;

      els.btnFetchUrl.disabled = true;
      els.fetchStatusMsg.className = 'fetch-status-msg loading';
      els.fetchStatusMsg.textContent = 'Pulling listing info...';

      try {
        const targetId = activeProjectId || 'corvette-z51';
        const res = await fetch(`/api/projects/${encodeURIComponent(targetId)}/listings/fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urlOrId })
        });
        const data = await res.json();

        if (data.ok) {
          els.fetchStatusMsg.className = 'fetch-status-msg success';
          els.fetchStatusMsg.textContent = `✓ Auto-filled from ${data.source === 'api' ? 'eBay API' : 'Page metadata'}`;

          if (data.title && els.listingTitle) els.listingTitle.value = data.title;
          if (data.seller && els.listingSeller) els.listingSeller.value = data.seller;
          if (data.price !== undefined && els.listingPrice) els.listingPrice.value = data.price;
          if (data.url && els.listingUrl) els.listingUrl.value = data.url;
          if (data.condition && els.listingCondition) els.listingCondition.value = data.condition;

          if (els.listingShippingMode) {
            els.listingShippingMode.value = data.shippingMode || (data.freeShipping ? 'free' : 'amount');
            if (els.wrapShippingAmount) {
              els.wrapShippingAmount.style.display = els.listingShippingMode.value === 'amount' ? 'flex' : 'none';
            }
          }
          if (els.listingShippingAmount) els.listingShippingAmount.value = data.shipping || 0;

          // Attempt smart match with parts list
          const titleLower = (data.title || '').toLowerCase();
          const matchedPartIds = new Set();

          appState.parts.forEach(part => {
            // Match part numbers
            for (const pn of part.partNumbers || []) {
              if (pn.length >= 6 && titleLower.includes(pn.toLowerCase())) {
                matchedPartIds.add(part.id);
                break;
              }
            }
          });

          if (matchedPartIds.size > 0 && els.partsChecklistGrid) {
            els.partsChecklistGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
              if (matchedPartIds.has(cb.value)) {
                cb.checked = true;
                cb.closest('.part-check-item')?.classList.add('checked');
              }
            });
            updateListingTypeBadge();
          }

          updateListingFormPreview();
        } else {
          els.fetchStatusMsg.className = 'fetch-status-msg error';
          els.fetchStatusMsg.textContent = data.message || data.reason || 'Could not auto-pull info. Please enter details manually.';
        }
      } catch (err) {
        els.fetchStatusMsg.className = 'fetch-status-msg error';
        els.fetchStatusMsg.textContent = 'Request failed: ' + err.message;
      } finally {
        els.btnFetchUrl.disabled = false;
      }
    });

    // Select All / Clear parts buttons
    els.btnSelectAllParts?.addEventListener('click', () => {
      if (!els.partsChecklistGrid) return;
      els.partsChecklistGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = true;
        cb.closest('.part-check-item')?.classList.add('checked');
      });
      updateListingTypeBadge();
    });

    els.btnClearSelectedParts?.addEventListener('click', () => {
      if (!els.partsChecklistGrid) return;
      els.partsChecklistGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
        cb.closest('.part-check-item')?.classList.remove('checked');
      });
      updateListingTypeBadge();
    });

    // Shipping Mode toggle
    els.listingShippingMode?.addEventListener('change', () => {
      const mode = els.listingShippingMode.value;
      if (els.wrapShippingAmount) {
        els.wrapShippingAmount.style.display = mode === 'amount' ? 'flex' : 'none';
      }
      updateListingFormPreview();
    });

    // Listing State toggle (shows purchased fields when Already Purchased is selected)
    els.listingState?.addEventListener('change', () => {
      if (els.wrapPurchasedListingFields) {
        els.wrapPurchasedListingFields.style.display = els.listingState.value === 'purchased' ? 'block' : 'none';
      }
      if (els.listingState.value === 'purchased' && els.listingFinalCost && !els.listingFinalCost.value) {
        els.listingFinalCost.value = els.listingPrice?.value || '';
      }
    });

    // Tax Mode toggle
    els.listingTaxMode?.addEventListener('change', () => {
      const mode = els.listingTaxMode.value;
      if (els.wrapManualTax) {
        els.wrapManualTax.style.display = mode === 'manual' ? 'flex' : 'none';
      }
      updateListingFormPreview();
    });

    // Real-time recalculation of preview
    [els.listingPrice, els.listingShippingAmount, els.listingManualTax, els.listingSeller].forEach(input => {
      input?.addEventListener('input', updateListingFormPreview);
    });

    // Submit Listing Form
    els.formListing?.addEventListener('submit', (e) => {
      e.preventDefault();
      const selectedPartIds = Array.from(
        els.partsChecklistGrid?.querySelectorAll('input[type="checkbox"]:checked') || []
      ).map(cb => cb.value);

      if (selectedPartIds.length === 0) {
        alert('Please check at least one part included in this listing.');
        return;
      }

      const id = els.editListingId?.value || ('listing-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
      const title = String(els.listingTitle?.value || '').trim();
      const seller = String(els.listingSeller?.value || '').trim();
      const condition = els.listingCondition?.value || 'Used';
      const price = Math.max(0, parseFloat(els.listingPrice?.value) || 0);
      const shippingMode = els.listingShippingMode?.value || 'free';
      const shipping = shippingMode === 'amount' ? Math.max(0, parseFloat(els.listingShippingAmount?.value) || 0) : 0;
      const taxMode = els.listingTaxMode?.value || 'rate';
      const manualTax = taxMode === 'manual' ? Math.max(0, parseFloat(els.listingManualTax?.value) || 0) : 0;
      const state = els.listingState?.value || 'normal';
      const url = String(els.listingUrl?.value || '').trim();
      const notes = String(els.listingNotes?.value || '').trim();

      const finalCost = (state === 'purchased')
        ? (els.listingFinalCost?.value !== '' ? Math.max(0, parseFloat(els.listingFinalCost.value) || 0) : price)
        : null;
      const finalPrice = (state === 'purchased' && els.listingFinalPrice?.value !== '')
        ? Math.max(0, parseFloat(els.listingFinalPrice.value) || 0)
        : null;
      const purchaseNotes = state === 'purchased' ? String(els.listingPurchaseNotes?.value || '').trim() : '';

      const newListing = {
        id,
        title,
        seller,
        condition,
        price,
        shippingMode,
        freeShipping: shippingMode === 'free',
        shipping,
        taxMode,
        manualTax,
        state,
        finalCost,
        finalPrice,
        purchaseNotes,
        partIds: selectedPartIds,
        url,
        notes,
        lastFetchedAt: new Date().toISOString()
      };

      const existingIdx = appState.listings.findIndex(l => l.id === id);
      if (existingIdx !== -1) {
        appState.listings[existingIdx] = newListing;
      } else {
        appState.listings.unshift(newListing);
      }

      resetListingForm();
      saveStateToServer(true);
      recalculateAndRender();
    });

    els.btnResetListingForm?.addEventListener('click', resetListingForm);

    // Refresh eBay Prices
    els.btnRefreshEbayPrices?.addEventListener('click', async () => {
      els.btnRefreshEbayPrices.disabled = true;
      els.btnRefreshEbayPrices.textContent = '↻ Refreshing...';
      try {
        const targetId = activeProjectId || 'corvette-z51';
        const res = await fetch(`/api/projects/${encodeURIComponent(targetId)}/listings/refresh`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          appState = data.state;
          recalculateAndRender();
          alert(`Refreshed ${data.updatedCount} listings. (${data.endedCount} ended listings auto-excluded).`);
        }
      } catch (err) {
        alert('Refresh error: ' + err.message);
      } finally {
        els.btnRefreshEbayPrices.disabled = false;
        els.btnRefreshEbayPrices.textContent = '↻ Refresh eBay Prices';
      }
    });

    // Add Seller Shipping Override
    els.overrideMode?.addEventListener('change', () => {
      if (els.wrapOverrideAmount) {
        els.wrapOverrideAmount.style.display = els.overrideMode.value === 'flat' ? 'flex' : 'none';
      }
    });

    els.formAddSellerOverride?.addEventListener('submit', (e) => {
      e.preventDefault();
      const sName = String(els.overrideSellerName?.value || '').trim();
      if (!sName) return;

      const mode = els.overrideMode?.value || 'flat';
      const amount = mode === 'flat' ? Math.max(0, parseFloat(els.overrideAmount?.value) || 0) : 0;
      const taxable = els.overrideTaxable?.checked !== false;

      if (!appState.settings.sellerShipping) appState.settings.sellerShipping = {};
      appState.settings.sellerShipping[sName] = {
        mode,
        amount,
        taxable
      };

      els.overrideSellerName.value = '';
      if (els.overrideAmount) els.overrideAmount.value = '0.00';
      saveStateToServer(true);
      recalculateAndRender();
    });

    // Header Settings Listeners
    els.inputTaxRate?.addEventListener('change', () => {
      const rate = Math.max(0, parseFloat(els.inputTaxRate.value) || 0) / 100;
      appState.settings.taxRate = rate;
      saveStateToServer(false);
      recalculateAndRender();
    });

    els.inputZipCode?.addEventListener('change', () => {
      appState.settings.zipCode = String(els.inputZipCode.value || '08879').trim();
      saveStateToServer(false);
    });

    els.selectFilterListings?.addEventListener('change', renderListingsTable);

    // Dropdown toggle
    els.btnExportMenu?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = els.exportDropdownMenu?.classList.toggle('open');
      els.btnExportMenu?.setAttribute('aria-expanded', String(isOpen));
    });

    document.addEventListener('click', () => {
      els.exportDropdownMenu?.classList.remove('open');
      els.btnExportMenu?.setAttribute('aria-expanded', 'false');
    });

    // Modal openers
    els.btnOpenImportPartsModal?.addEventListener('click', () => {
      els.dialogImportParts?.showModal();
    });

    els.btnOpenBackupsModal?.addEventListener('click', async () => {
      els.dialogBackups?.showModal();
      await loadBackupsList();
    });

    // Dialog close buttons
    document.querySelectorAll('[data-close-dialog]').forEach(btn => {
      btn.addEventListener('click', () => {
        const dId = btn.getAttribute('data-close-dialog');
        const d = document.getElementById(dId);
        if (d && typeof d.close === 'function') d.close();
      });
    });

    // Dialog closedby="any" fallback from modern-web-guidance
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      const outside = (e, dialog) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      document.querySelectorAll('dialog[closedby="any"]').forEach(dialog => {
        let pressedOutside = false;
        dialog.addEventListener('pointerdown', (e) => { pressedOutside = outside(e, dialog); });
        dialog.addEventListener('pointerup', (e) => {
          if (pressedOutside && outside(e, dialog)) dialog.close();
        });
      });
    }

    // Import Parts Form
    els.formImportParts?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const mode = els.formImportParts.querySelector('input[name="importMode"]:checked')?.value || 'append';
      let content = els.importContent?.value || '';
      let format = 'csv';

      const file = els.importFile?.files?.[0];
      if (file) {
        content = await file.text();
        if (file.name.endsWith('.json')) format = 'json';
      }

      if (!content.trim()) {
        alert('Please select a file or paste CSV/JSON content.');
        return;
      }

      try {
        const targetId = activeProjectId || 'corvette-z51';
        const res = await fetch(`/api/projects/${encodeURIComponent(targetId)}/parts/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format, content, mode })
        });
        const data = await res.json();
        if (data.ok) {
          appState = data.state;
          els.dialogImportParts?.close();
          if (els.importContent) els.importContent.value = '';
          if (els.importFile) els.importFile.value = '';
          recalculateAndRender();
          alert(`Import successful! Added ${data.addedCount} parts.`);
        } else {
          alert('Import failed: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Import request failed: ' + err.message);
      }
    });

    // Mark Purchased Modal Form Submit
    els.formMarkPurchased?.addEventListener('submit', (e) => {
      e.preventDefault();
      const lid = els.purchasedListingId?.value;
      const listing = appState.listings.find(l => l.id === lid);
      if (!listing) return;

      const finalCost = Math.max(0, parseFloat(els.inputFinalCost?.value) || 0);
      const finalPrice = els.inputOfferPrice?.value !== '' ? Math.max(0, parseFloat(els.inputOfferPrice.value) || 0) : null;
      const finalShipping = els.inputOfferShipping?.value !== '' ? Math.max(0, parseFloat(els.inputOfferShipping.value) || 0) : null;
      const finalTax = els.inputOfferTax?.value !== '' ? Math.max(0, parseFloat(els.inputOfferTax.value) || 0) : null;
      const purchaseNotes = String(els.inputPurchaseNotes?.value || '').trim();

      listing.state = 'purchased';
      listing.finalCost = finalCost;
      if (finalPrice !== null) listing.finalPrice = finalPrice;
      if (finalShipping !== null) listing.finalShipping = finalShipping;
      if (finalTax !== null) listing.finalTax = finalTax;
      if (purchaseNotes) listing.purchaseNotes = purchaseNotes;

      els.dialogMarkPurchased?.close();
      saveStateToServer(true);
      recalculateAndRender();
    });

    // Unmark as Purchased button
    els.btnUnmarkPurchased?.addEventListener('click', () => {
      const lid = els.purchasedListingId?.value;
      const listing = appState.listings.find(l => l.id === lid);
      if (!listing) return;

      if (confirm(`Unmark "${listing.title}" as purchased and restore to normal solver selection?`)) {
        listing.state = 'normal';
        listing.finalCost = null;
        listing.finalPrice = null;
        listing.finalShipping = null;
        listing.finalTax = null;
        listing.purchaseNotes = '';

        els.dialogMarkPurchased?.close();
        saveStateToServer(true);
        recalculateAndRender();
      }
    });

    // Offer calculator inputs and buttons
    [els.inputOfferPrice, els.inputOfferShipping, els.inputOfferTax].forEach(input => {
      input?.addEventListener('input', () => updateOfferCalcPreview());
    });

    els.btnAutoCalcOfferTax?.addEventListener('click', () => {
      const taxRate = Number(appState.settings.taxRate) || 0.06625;
      const p = parseFloat(els.inputOfferPrice?.value) || 0;
      const s = parseFloat(els.inputOfferShipping?.value) || 0;
      const calculatedTax = window.PriceCompareCalc.round2((p + s) * taxRate);
      if (els.inputOfferTax) {
        els.inputOfferTax.value = calculatedTax.toFixed(2);
      }
      updateOfferCalcPreview();
    });

    els.btnApplyOfferCalc?.addEventListener('click', () => {
      const p = parseFloat(els.inputOfferPrice?.value) || 0;
      const s = parseFloat(els.inputOfferShipping?.value) || 0;
      const t = parseFloat(els.inputOfferTax?.value) || 0;
      const total = window.PriceCompareCalc.round2(p + s + t);
      if (els.inputFinalCost) {
        els.inputFinalCost.value = total.toFixed(2);
        els.inputFinalCost.focus();
      }
    });
  }

  function resetListingForm() {
    if (els.editListingId) els.editListingId.value = '';
    if (els.listingTitle) els.listingTitle.value = '';
    if (els.listingSeller) els.listingSeller.value = '';
    if (els.listingPrice) els.listingPrice.value = '';
    if (els.listingShippingMode) els.listingShippingMode.value = 'free';
    if (els.listingShippingAmount) els.listingShippingAmount.value = '0.00';
    if (els.listingTaxMode) els.listingTaxMode.value = 'rate';
    if (els.listingManualTax) els.listingManualTax.value = '0.00';
    if (els.listingState) els.listingState.value = 'normal';
    if (els.listingUrl) els.listingUrl.value = '';
    if (els.listingNotes) els.listingNotes.value = '';
    if (els.listingFinalCost) els.listingFinalCost.value = '';
    if (els.listingFinalPrice) els.listingFinalPrice.value = '';
    if (els.listingPurchaseNotes) els.listingPurchaseNotes.value = '';
    if (els.wrapPurchasedListingFields) els.wrapPurchasedListingFields.style.display = 'none';
    if (els.inputFetchUrl) els.inputFetchUrl.value = '';
    if (els.fetchStatusMsg) els.fetchStatusMsg.textContent = '';
    if (els.btnSubmitListing) els.btnSubmitListing.textContent = 'Save Listing';

    if (els.partsChecklistGrid) {
      els.partsChecklistGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
        cb.closest('.part-check-item')?.classList.remove('checked');
      });
    }

    if (els.wrapShippingAmount) els.wrapShippingAmount.style.display = 'none';
    if (els.wrapManualTax) els.wrapManualTax.style.display = 'none';
    updateListingTypeBadge();
  }

  async function loadBackupsList() {
    if (!els.backupsListContainer) return;
    els.backupsListContainer.innerHTML = 'Loading backups...';
    try {
      const targetId = activeProjectId || 'corvette-z51';
      const res = await fetch(`/api/projects/${encodeURIComponent(targetId)}/backups`);
      const data = await res.json();
      const backups = data.backups || [];
      els.backupsListContainer.innerHTML = '';

      if (backups.length === 0) {
        els.backupsListContainer.textContent = 'No snapshots available yet.';
        return;
      }

      backups.forEach(b => {
        const div = document.createElement('div');
        div.className = 'backup-row';

        const label = document.createElement('span');
        label.textContent = `${b.filename} (${new Date(b.updatedAt).toLocaleString()})`;
        div.appendChild(label);

        const btnRestore = document.createElement('button');
        btnRestore.type = 'button';
        btnRestore.className = 'btn btn-sm btn-secondary';
        btnRestore.textContent = 'Restore';
        btnRestore.addEventListener('click', async () => {
          if (confirm(`Restore snapshot "${b.filename}"? Current changes will be archived first.`)) {
            try {
              const rRes = await fetch(`/api/projects/${encodeURIComponent(targetId)}/backups/restore`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: b.filename })
              });
              const rData = await rRes.json();
              if (rData.ok) {
                appState = rData.state;
                els.dialogBackups?.close();
                recalculateAndRender();
                alert('Snapshot restored successfully!');
              }
            } catch (err) {
              alert('Restore failed: ' + err.message);
            }
          }
        });

        div.appendChild(btnRestore);
        els.backupsListContainer.appendChild(div);
      });
    } catch (err) {
      els.backupsListContainer.textContent = 'Error loading backups: ' + err.message;
    }
  }

  // --- Validate input after interaction: sync aria-invalid ---
  function setupAriaValidationSync() {
    const syncAria = (el) => {
      if (el && typeof el.getAttribute === 'function' && el.matches) {
        el.setAttribute('aria-invalid', el.matches(':user-invalid') ? 'true' : 'false');
      }
    };
    document.addEventListener('blur', (e) => syncAria(e.target), true);
    document.addEventListener('input', (e) => {
      if (e.target && e.target.hasAttribute && e.target.hasAttribute('aria-invalid')) {
        syncAria(e.target);
      }
    });
  }

  // --- Project Management Modal & Actions ---
  function renderManageProjectsList() {
    if (!els.manageProjectsListContainer) return;
    els.manageProjectsListContainer.innerHTML = '';

    if (projectsList.length === 0) {
      els.manageProjectsListContainer.textContent = 'No projects found.';
      return;
    }

    projectsList.forEach(p => {
      const card = document.createElement('div');
      card.className = `project-item-card ${p.id === activeProjectId ? 'active-project-card' : ''}`;

      const info = document.createElement('div');
      info.className = 'project-item-info';

      const titleRow = document.createElement('div');
      titleRow.className = 'project-item-title-row';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'project-item-name';
      nameSpan.textContent = p.name;
      titleRow.appendChild(nameSpan);

      if (p.id === activeProjectId) {
        const activeBadge = document.createElement('span');
        activeBadge.className = 'badge badge-primary';
        activeBadge.textContent = 'Active';
        titleRow.appendChild(activeBadge);
      }

      const metaSpan = document.createElement('span');
      metaSpan.className = 'project-item-meta';
      const dateStr = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : '';
      metaSpan.textContent = `${p.partsCount} parts • ${p.listingsCount} listings${dateStr ? ' • Updated ' + dateStr : ''}`;

      info.appendChild(titleRow);
      info.appendChild(metaSpan);
      card.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'project-item-actions';

      // Switch button (if not active)
      if (p.id !== activeProjectId) {
        const btnSwitch = document.createElement('button');
        btnSwitch.type = 'button';
        btnSwitch.className = 'btn btn-sm btn-outline-primary';
        btnSwitch.textContent = 'Switch';
        btnSwitch.addEventListener('click', async () => {
          setActiveProjectId(p.id, true);
          renderProjectSelector();
          await loadProjectState(p.id);
          els.dialogManageProjects?.close();
        });
        actions.appendChild(btnSwitch);
      }

      // Duplicate button
      const btnDuplicate = document.createElement('button');
      btnDuplicate.type = 'button';
      btnDuplicate.className = 'btn btn-sm btn-secondary';
      btnDuplicate.textContent = 'Duplicate';
      btnDuplicate.title = 'Duplicate this project';
      btnDuplicate.addEventListener('click', async () => {
        const copyName = prompt('Enter a name for the duplicated project:', `${p.name} (Copy)`);
        if (!copyName) return;
        try {
          const res = await fetch(`/api/projects/${encodeURIComponent(p.id)}/duplicate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: copyName.trim() })
          });
          const data = await res.json();
          if (data.ok) {
            await loadProjectsList(data.id);
            renderManageProjectsList();
          } else {
            alert('Duplicate failed: ' + (data.error || 'Unknown error'));
          }
        } catch (err) {
          alert('Duplicate error: ' + err.message);
        }
      });
      actions.appendChild(btnDuplicate);

      // Rename button
      const btnRename = document.createElement('button');
      btnRename.type = 'button';
      btnRename.className = 'btn btn-sm btn-secondary';
      btnRename.textContent = 'Rename';
      btnRename.title = 'Rename this project';
      btnRename.addEventListener('click', async () => {
        const newName = prompt('Enter new project name:', p.name);
        if (!newName || !newName.trim() || newName.trim() === p.name) return;
        try {
          const res = await fetch(`/api/projects/${encodeURIComponent(p.id)}/rename`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName.trim() })
          });
          const data = await res.json();
          if (data.ok) {
            await loadProjectsList(activeProjectId);
            renderManageProjectsList();
          } else {
            alert('Rename failed: ' + (data.error || 'Unknown error'));
          }
        } catch (err) {
          alert('Rename error: ' + err.message);
        }
      });
      actions.appendChild(btnRename);

      // Delete button (disabled if only 1 project left)
      const btnDelete = document.createElement('button');
      btnDelete.type = 'button';
      btnDelete.className = 'btn btn-sm btn-danger-outline';
      btnDelete.textContent = 'Delete';
      btnDelete.title = 'Delete this project';
      if (projectsList.length <= 1) {
        btnDelete.disabled = true;
        btnDelete.title = 'Cannot delete the only remaining project';
      } else {
        btnDelete.addEventListener('click', async () => {
          if (confirm(`Permanently delete project "${p.name}"? This cannot be undone.`)) {
            try {
              const res = await fetch(`/api/projects/${encodeURIComponent(p.id)}`, {
                method: 'DELETE'
              });
              const data = await res.json();
              if (data.ok) {
                const nextId = p.id === activeProjectId ? null : activeProjectId;
                await loadProjectsList(nextId);
                renderManageProjectsList();
              } else {
                alert('Delete failed: ' + (data.error || 'Unknown error'));
              }
            } catch (err) {
              alert('Delete error: ' + err.message);
            }
          }
        });
      }
      actions.appendChild(btnDelete);

      card.appendChild(actions);
      els.manageProjectsListContainer.appendChild(card);
    });
  }

  function setupProjectManager() {
    // Dropdown change
    els.projectSelect?.addEventListener('change', async (e) => {
      const selectedId = e.target.value;
      if (selectedId && selectedId !== activeProjectId) {
        setActiveProjectId(selectedId, true);
        await loadProjectState(activeProjectId);
      }
    });

    // Header "+ New"
    els.btnHeaderNewProject?.addEventListener('click', () => {
      if (els.inputNewProjectName) els.inputNewProjectName.value = '';
      els.dialogNewProject?.showModal();
    });

    // Modal "+ Create New Project"
    els.btnModalNewProject?.addEventListener('click', () => {
      els.dialogManageProjects?.close();
      if (els.inputNewProjectName) els.inputNewProjectName.value = '';
      els.dialogNewProject?.showModal();
    });

    // Header "⚙" Manage Projects
    els.btnHeaderManageProjects?.addEventListener('click', () => {
      renderManageProjectsList();
      els.dialogManageProjects?.showModal();
    });

    // Form submit: Create New Project
    els.formNewProject?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = String(els.inputNewProjectName?.value || '').trim();
      if (!name) return;

      const template = els.formNewProject.querySelector('input[name="newProjectTemplate"]:checked')?.value || 'blank';

      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, template })
        });
        const data = await res.json();
        if (data.ok && data.id) {
          els.dialogNewProject?.close();
          await loadProjectsList(data.id);
        } else {
          alert('Failed to create project: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Create project error: ' + err.message);
      }
    });

    // Handle browser back/forward buttons
    window.addEventListener('popstate', async (e) => {
      const targetId = getActiveProjectIdFromUrl();
      if (targetId && targetId !== activeProjectId) {
        setActiveProjectId(targetId, false);
        renderProjectSelector();
        await loadProjectState(activeProjectId);
      }
    });
  }

  // --- Initialize App ---
  function init() {
    setupTabs();
    setupForms();
    setupProjectManager();
    setupAriaValidationSync();
    loadProjectsList();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
