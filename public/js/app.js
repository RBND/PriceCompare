(function () {
  'use strict';

  const Calc = window.PriceCompareCalc;
  const LOCAL_STORAGE_KEY = 'corvette_z51_price_compare_v1';

  let appState = null;
  let evaluated = null;
  let saveTimer = null;

  // Formatters
  const fmtCurrency = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  });

  function money(val) {
    return fmtCurrency.format(Number(val) || 0);
  }

  function uid() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  }

  // Safe DOM creation helper (never uses innerHTML with untrusted data)
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (v === null || v === undefined) return;
      if (k === 'className') {
        node.className = v;
      } else if (k === 'textContent') {
        node.textContent = v;
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(node.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'checked' || k === 'disabled' || k === 'selected') {
        node[k] = Boolean(v);
      } else {
        node.setAttribute(k, String(v));
      }
    });
    const childList = Array.isArray(children) ? children : [children];
    childList.forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      if (c instanceof Node) {
        node.appendChild(c);
      } else {
        node.appendChild(document.createTextNode(String(c)));
      }
    });
    return node;
  }

  function clearChildren(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  // Fallback for <dialog closedby="any"> on browsers without native closedBy support
  // (Per modern-web-guidance `light-dismiss-a-dialog`)
  function setupDialogFallbacks() {
    const dialogs = document.querySelectorAll('dialog.app-dialog');
    dialogs.forEach((dialog) => {
      if (!('closedBy' in HTMLDialogElement.prototype)) {
        dialog.addEventListener('click', (event) => {
          if (event.target !== dialog) return;
          const rect = dialog.getBoundingClientRect();
          const isDialogContent =
            rect.top <= event.clientY &&
            event.clientY <= rect.top + rect.height &&
            rect.left <= event.clientX &&
            event.clientX <= rect.left + rect.width;
          if (isDialogContent) return;
          dialog.close();
        });
      }
    });

    document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-close-dialog');
        const dlg = document.getElementById(targetId);
        if (dlg) dlg.close();
      });
    });
  }

  function setSyncStatus(mode, text) {
    const ind = document.getElementById('syncIndicator');
    if (!ind) return;
    ind.className = 'sync-indicator ' + (mode || '');
    ind.textContent = text;
  }

  // Persistence: Instant localStorage mirror + debounced PUT /api/state
  function persistState(immediate = false, createSnapshot = true) {
    if (!appState) return;
    evaluated = Calc.evaluateState(appState);

    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(appState));
    } catch (_) {}

    renderAll();

    setSyncStatus('saving', '● Saving to HEXnas...');
    if (saveTimer) clearTimeout(saveTimer);

    const doSave = async () => {
      try {
        const res = await fetch('/api/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: appState, createSnapshot })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        appState = data.state;
        evaluated = data.evaluated;
        setSyncStatus('', '● Synced to Disk');
      } catch (err) {
        console.warn('[Sync] Offline or server unreachable, cached in browser:', err);
        setSyncStatus('error', '● Saved in Browser (Offline)');
      }
    };

    if (immediate) {
      doSave();
    } else {
      saveTimer = setTimeout(doSave, 250);
    }
  }

  function statusClass(status) {
    const s = String(status || '').toLowerCase();
    if (s.includes('need')) return 'status-badge status-need';
    if (s.includes('watch') || s.includes('quot')) return 'status-badge status-watch';
    if (s.includes('order')) return 'status-badge status-order';
    if (s.includes('ship')) return 'status-badge status-ship';
    if (s.includes('deliver') || s.includes('shop') || s.includes('exist')) {
      return 'status-badge status-done';
    }
    return 'status-badge status-watch';
  }

  // Render Top KPI Cards & Controls
  function renderKPIs() {
    const s = evaluated.summary;

    const lblBase = document.getElementById('lblBaselineTitle');
    lblBase.textContent = s.includeLaborAndPaint
      ? 'Original Shop Estimate (Out-The-Door)'
      : 'Original OEM Parts Quote (w/ Tax)';

    document.getElementById('valBaselineTotal').textContent = money(
      s.originalEstimateGrandTotal
    );
    document.getElementById('subBaselineDetail').textContent = s.includeLaborAndPaint
      ? `Parts: ${money(s.oemPartsTotal)} • Labor & Paint: ${money(s.baseFixedShopTotal)}`
      : `${s.replaceableCount} Replaceable Items (${money(s.oemPartsPreTax)} + ${money(s.oemPartsTax)} tax)`;

    document.getElementById('valProjectedTotal').textContent = money(
      s.projectedGrandTotal
    );
    document.getElementById('subProjectedDetail').textContent =
      `Parts: ${money(s.projectedPartsTotal)} (${s.unsourcedCount} unsourced at OEM fallback)`;

    const savSign = s.totalProjectedSavings >= 0 ? '' : '-';
    document.getElementById('valTotalSavings').textContent =
      `${savSign}${money(Math.abs(s.totalProjectedSavings))} (${s.totalSavingsPct.toFixed(1)}%)`;
    document.getElementById('subTotalSavingsDetail').textContent =
      `Parts Saved: ${money(s.savingsOnSourcedParts)} + Paint Credit: ${money(s.totalPaintSavings)}`;

    document.getElementById('valSourcedSavings').textContent = money(
      s.savingsOnSourcedParts
    );
    document.getElementById('subSourcedDetail').textContent =
      `${s.sourcedCount} of ${s.replaceableCount} parts sourced (${money(s.sourcedUsedTotal)} used vs ${money(s.sourcedOemTotal)} OEM)`;

    document.getElementById('valPaintSavings').textContent = money(
      s.totalPaintSavings
    );
    document.getElementById('subPaintDetail').textContent = s.includeLaborAndPaint
      ? 'Same-color panel refinish & paint material credit'
      : 'Enable "Include Fixed Labor & Paint" to apply credit';

    // Sync control toggles with state
    const currentScope = appState.settings.viewScope || 'all_new';
    document.querySelectorAll('.seg-btn[data-scope]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-scope') === currentScope);
    });
    document.getElementById('chkIncludeLaborPaint').checked =
      appState.settings.includeLaborAndPaint !== false;
    document.getElementById('chkIncludeTires').checked =
      appState.settings.includeTiresInTotals !== false;
  }

  // Populate category filter options once
  function populateCategoryDropdown() {
    const sel = document.getElementById('selectCategory');
    if (sel.options.length > 1) return;
    const cats = Array.from(
      new Set((appState.lineItems || []).map((i) => i.category).filter(Boolean))
    );
    cats.forEach((c) => {
      sel.appendChild(el('option', { value: c, textContent: c }));
    });
    sel.value = appState.settings.categoryFilter || 'ALL';
  }

  // Render Proportional Bundles Section
  function renderBundles() {
    const container = document.getElementById('bundlesContainer');
    clearChildren(container);

    const bundles = evaluated.evaluatedBundles || [];
    if (bundles.length === 0) {
      container.appendChild(
        el(
          'div',
          {
            className: 'vehicle-meta',
            style: { gridColumn: '1 / -1', padding: '0.5rem 0' }
          },
          [
            'No part bundles created yet. Click ',
            el('strong', { textContent: '"+ New Part Bundle / Assembly"' }),
            ' or ',
            el('strong', {
              textContent: '"⚡ Quick-Create Rear Suspension Assembly Bundle"'
            }),
            ' to group multiple parts into a single combined price + shipping order with automatic OEM % cost splitting.'
          ]
        )
      );
      return;
    }

    bundles.forEach((bundle) => {
      const activeOpt = bundle.activeOption;
      const usedTotalText = activeOpt
        ? money(activeOpt.computed.total)
        : 'No quote yet';
      const savingsVal = activeOpt ? activeOpt.computed.savingsVsOem : 0;

      const memberItemsNodes = (bundle.lineNumbers || []).map((ln) => {
        const line = evaluated.evaluatedLines.find((l) => l.lineNumber === Number(ln));
        const alloc = bundle.memberAllocations[ln];
        if (!line || !alloc) return null;

        const allocText =
          alloc.allocatedTotal !== null
            ? `${money(alloc.allocatedTotal)} used (saves ${money(alloc.allocatedSavings)})`
            : 'Pending quote';

        return el('li', { className: 'bundle-member-item' }, [
          el('span', {}, [
            el('strong', { textContent: `#${line.lineNumber} ` }),
            `${line.description} `,
            el('span', {
              className: 'vehicle-meta',
              textContent: `(OEM ${money(line.oemPreTax)} → ${alloc.weightPct.toFixed(1)}% of bundle)`
            })
          ]),
          el('span', { className: 'savings-pos', textContent: allocText })
        ]);
      });

      const card = el('article', { className: 'bundle-card' }, [
        el('div', { className: 'bundle-card-header' }, [
          el('div', {}, [
            el('h3', { className: 'bundle-title', textContent: bundle.name }),
            el('div', {
              className: 'vehicle-meta',
              textContent: activeOpt
                ? `Active Vendor: ${activeOpt.vendor || 'Unnamed'} (${bundle.evaluatedOptions.length} option${bundle.evaluatedOptions.length === 1 ? '' : 's'} saved)`
                : 'No vendor quote entered yet — click Edit / Quotes to add price'
            })
          ]),
          el('div', { className: 'header-actions no-print' }, [
            el(
              'button',
              {
                type: 'button',
                className: 'btn btn-sm btn-primary',
                onClick: () => openBundleModal(bundle.id)
              },
              'Edit / Quotes (' + bundle.evaluatedOptions.length + ')'
            ),
            el(
              'button',
              {
                type: 'button',
                className: 'btn btn-sm btn-danger',
                onClick: () => deleteBundle(bundle.id)
              },
              '✕'
            )
          ])
        ]),
        el('div', { className: 'bundle-stats-row' }, [
          el('div', {}, [
            el('div', { className: 'kpi-label', textContent: 'Grouped OEM New (w/ Tax)' }),
            el('strong', { textContent: money(bundle.oemBundleTotal) })
          ]),
          el('div', {}, [
            el('div', { className: 'kpi-label', textContent: 'Active Bundle Used Total' }),
            el('strong', { textContent: usedTotalText })
          ]),
          el('div', {}, [
            el('div', { className: 'kpi-label', textContent: 'Bundle Net Savings' }),
            el('strong', {
              className: savingsVal > 0 ? 'savings-pos' : 'savings-zero',
              textContent: activeOpt ? money(savingsVal) : '$0.00'
            })
          ])
        ]),
        el('ul', { className: 'bundle-member-list' }, memberItemsNodes)
      ]);

      container.appendChild(card);
    });
  }

  // Render Main Parts Comparison Table
  function renderTable() {
    const tbody = document.getElementById('partsTableBody');
    clearChildren(tbody);

    const scope = appState.settings.viewScope || 'all_new';
    const q = (appState.settings.searchQuery || '').toLowerCase().trim();
    const catFilter = appState.settings.categoryFilter || 'ALL';
    const statusFilter = appState.settings.statusFilter || 'ALL';

    const filtered = evaluated.evaluatedLines.filter((item) => {
      if (scope === 'all_new' && !item.isReplaceablePart) return false;
      if (scope === 'oem_only' && (!item.isReplaceablePart || item.isTireItem)) {
        return false;
      }
      if (catFilter !== 'ALL' && item.category !== catFilter) return false;
      if (statusFilter !== 'ALL' && item.effectiveStatus !== statusFilter) return false;

      if (q) {
        const hay = [
          item.description,
          item.oemPartNumber,
          item.category,
          item.notes,
          item.activeSourceSummary?.vendor,
          item.activeSourceSummary?.bundleName,
          item.activeSourceSummary?.trackingNumber
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      tbody.appendChild(
        el('tr', {}, [
          el(
            'td',
            {
              colSpan: 11,
              style: { textAlign: 'center', padding: '2rem' },
              className: 'vehicle-meta'
            },
            'No line items match your current filter criteria.'
          )
        ])
      );
      return;
    }

    filtered.forEach((item) => {
      const isRep = item.isReplaceablePart;
      const src = item.activeSourceSummary;

      // Column 1: Line # & Description + Same-Color Paint Toggle (if painted panel)
      const descChildren = [
        el('div', {}, [
          el('span', {
            className: 'part-line-badge',
            textContent: `#${item.lineNumber}`
          }),
          el('span', { textContent: item.description })
        ])
      ];

      if (item.notes) {
        descChildren.push(
          el('div', {
            className: 'vehicle-meta',
            style: { fontSize: '0.75rem', marginTop: '0.2rem' },
            textContent: item.notes
          })
        );
      }

      if (item.isPaintedPanel) {
        const chk = el('input', {
          type: 'checkbox',
          checked: Boolean(item.skipRepaint),
          onChange: (e) => toggleSkipRepaint(item.lineNumber, e.target.checked)
        });
        descChildren.push(
          el('label', { className: 'paint-toggle-box no-print' }, [
            chk,
            el('span', {
              textContent: `Same Paint Color? (Skip Repaint: saves ${money(
                (item.refinishLaborUnits * 60 + item.paintMaterialUnits * 37) * 1.06625
              )})`
            })
          ])
        );
      }

      // Column 4: OEM Quote
      const oemCol = isRep
        ? el('div', {}, [
            el('div', {
              style: { fontWeight: '700' },
              textContent: money(item.oemTotal)
            }),
            el('div', {
              className: 'vehicle-meta',
              style: { fontSize: '0.73rem' },
              textContent: `${money(item.oemPreTax)} + ${money(item.oemTax)} tax`
            })
          ])
        : el('span', {
            className: 'vehicle-meta',
            textContent: `${item.operation} (${item.laborUnits}h ${item.laborType})`
          });

      // Column 5: Sourcing Mode Selector
      let modeCol = el('span', { className: 'vehicle-meta', textContent: item.partType || 'Shop Op' });
      if (isRep) {
        const modeSelect = el(
          'select',
          {
            className: 'select-field no-print',
            style: { fontSize: '0.78rem', padding: '0.3rem 0.45rem' },
            ariaLabel: `Sourcing mode for ${item.description}`,
            onChange: (e) => handleModeChange(item.lineNumber, e.target.value)
          },
          [
            el('option', {
              value: 'shop_new',
              selected: item.sourcingMode === 'shop_new',
              textContent: 'Shop OEM New'
            }),
            el('option', {
              value: 'standalone',
              selected: item.sourcingMode === 'standalone',
              textContent: `Standalone Used (${item.quotes.length})`
            }),
            ...evaluated.evaluatedBundles.map((b) =>
              el('option', {
                value: `bundle:${b.id}`,
                selected:
                  item.sourcingMode === 'bundle' && item.activeBundleId === b.id,
                textContent: `Bundle: ${b.name}`
              })
            )
          ]
        );
        modeCol = modeSelect;
      }

      // Column 6: Active Used Source / Bundle Details
      let sourceCol = el('span', { className: 'vehicle-meta', textContent: '—' });
      if (isRep) {
        if (src && src.type === 'bundle') {
          sourceCol = el('div', {}, [
            el('div', {
              style: { fontWeight: '600', color: '#c7d2fe' },
              textContent: `📦 ${src.bundleName}`
            }),
            el('div', {
              className: 'vehicle-meta',
              style: { fontSize: '0.75rem' },
              textContent: `${src.vendor} • ${src.weightPct.toFixed(1)}% of ${money(src.bundleTotal)}`
            }),
            src.listingUrl
              ? el(
                  'a',
                  {
                    href: src.listingUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    className: 'ext-link'
                  },
                  '🔗 Open Listing ↗'
                )
              : null
          ]);
        } else if (src && src.type === 'bundle_pending') {
          sourceCol = el('div', {
            className: 'vehicle-meta',
            textContent: `📦 ${src.bundleName} (${src.weightPct.toFixed(1)}% share — add bundle price)`
          });
        } else if (src && src.type === 'standalone') {
          sourceCol = el('div', {}, [
            el('div', {
              style: { fontWeight: '600' },
              textContent: src.vendor || 'Used Quote'
            }),
            src.listingUrl
              ? el(
                  'a',
                  {
                    href: src.listingUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    className: 'ext-link'
                  },
                  '🔗 Open Listing ↗'
                )
              : null
          ]);
        } else {
          sourceCol = el('span', {
            className: 'vehicle-meta',
            textContent: 'Fallback: Shop OEM New'
          });
        }
      }

      // Column 7: Used Breakdown
      let usedBreakdownCol = el('span', { className: 'vehicle-meta', textContent: '—' });
      if (isRep && item.isSourcedUsed) {
        usedBreakdownCol = el('div', {}, [
          el('div', {
            style: { fontWeight: '700' },
            textContent: money(item.projectedTotal)
          }),
          el('div', {
            className: 'vehicle-meta',
            style: { fontSize: '0.73rem' },
            textContent: `${money(item.projectedPreTax)} + ${money(item.projectedShipping)} ship + ${money(item.projectedTax)} tax`
          })
        ]);
      }

      // Column 8: Projected Cost
      const projCol = isRep
        ? el('strong', { textContent: money(item.projectedTotal) })
        : el('span', { className: 'vehicle-meta', textContent: 'In Labor/Paint' });

      // Column 9: Net Savings
      let savCol = el('span', { className: 'savings-zero', textContent: '$0.00' });
      if (isRep) {
        const totalItemPlusPaintSavings = Calc.round2(
          item.savingsOnItem + (item.paintSavingsTotal || 0)
        );
        const cls =
          totalItemPlusPaintSavings > 0
            ? 'savings-pos'
            : totalItemPlusPaintSavings < 0
            ? 'savings-neg'
            : 'savings-zero';
        savCol = el('div', {}, [
          el('div', {
            className: cls,
            textContent: money(totalItemPlusPaintSavings)
          }),
          item.paintSavingsTotal > 0
            ? el('div', {
                className: 'vehicle-meta',
                style: { fontSize: '0.72rem', color: '#fcd34d' },
                textContent: `(Incl. ${money(item.paintSavingsTotal)} paint credit)`
              })
            : null
        ]);
      }

      // Column 10: Status & Carrier Tracking
      const statusChildren = [
        el('span', {
          className: statusClass(item.effectiveStatus),
          textContent: item.effectiveStatus
        })
      ];
      if (src && src.trackingNumber) {
        statusChildren.push(
          el('div', { style: { marginTop: '0.25rem' } }, [
            el(
              'a',
              {
                href: src.trackingUrl || '#',
                target: '_blank',
                rel: 'noopener noreferrer',
                className: 'ext-link'
              },
              `🚚 ${src.carrier ? src.carrier + ': ' : ''}${src.trackingNumber} ↗`
            )
          ])
        );
      }

      // Column 11: Actions
      let actionCol = el('span', { className: 'vehicle-meta', textContent: '—' });
      if (isRep) {
        actionCol = el('div', { className: 'header-actions' }, [
          el(
            'button',
            {
              type: 'button',
              className: 'btn btn-sm btn-primary',
              onClick: () => openPartQuotesModal(item.lineNumber)
            },
            item.quotes.length > 0
              ? `Quotes (${item.quotes.length})`
              : '+ Add Quote'
          )
        ]);
      }

      const tr = el(
        'tr',
        { className: isRep ? '' : 'row-existing' },
        [
          el('th', { scope: 'row' }, descChildren),
          el('td', { textContent: item.category }),
          el('td', {}, [
            item.oemPartNumber
              ? el('span', {
                  className: 'oem-part-code',
                  textContent: item.oemPartNumber
                })
              : el('span', { className: 'vehicle-meta', textContent: '—' })
          ]),
          el('td', { className: 'num-col' }, [oemCol]),
          el('td', {}, [modeCol]),
          el('td', {}, [sourceCol]),
          el('td', { className: 'num-col' }, [usedBreakdownCol]),
          el('td', { className: 'num-col' }, [projCol]),
          el('td', { className: 'num-col' }, [savCol]),
          el('td', {}, statusChildren),
          el('td', { className: 'action-col' }, [actionCol])
        ]
      );

      tbody.appendChild(tr);
    });
  }

  function renderAll() {
    if (!appState || !evaluated) return;
    populateCategoryDropdown();
    renderKPIs();
    renderBundles();
    renderTable();
  }

  // Interactive Handlers
  function toggleSkipRepaint(lineNumber, checked) {
    const line = appState.lineItems.find((l) => l.lineNumber === Number(lineNumber));
    if (!line) return;
    line.skipRepaint = Boolean(checked);
    persistState();
  }

  function handleModeChange(lineNumber, value) {
    const line = appState.lineItems.find((l) => l.lineNumber === Number(lineNumber));
    if (!line) return;

    if (value.startsWith('bundle:')) {
      const bId = value.slice('bundle:'.length);
      line.sourcingMode = 'bundle';
      line.activeBundleId = bId;
      // Ensure lineNumber is in that bundle's member list
      const b = appState.bundles.find((x) => x.id === bId);
      if (b && !b.lineNumbers.includes(Number(lineNumber))) {
        b.lineNumbers.push(Number(lineNumber));
      }
    } else if (value === 'standalone') {
      line.sourcingMode = 'standalone';
      const quotesForLine = appState.partQuotes.filter(
        (q) => Number(q.lineNumber) === Number(lineNumber)
      );
      if (quotesForLine.length === 0) {
        openPartQuotesModal(lineNumber);
      } else if (!line.activeQuoteId) {
        line.activeQuoteId = quotesForLine[0].id;
      }
    } else {
      line.sourcingMode = 'shop_new';
    }
    persistState();
  }

  // =========================================================================
  // Modal 1: Standalone Competing Quotes per Part
  // =========================================================================
  function openPartQuotesModal(lineNumber) {
    const line = evaluated.evaluatedLines.find(
      (l) => l.lineNumber === Number(lineNumber)
    );
    if (!line) return;

    document.getElementById('pqLineNumber').value = String(line.lineNumber);
    document.getElementById('dialogPartTitle').textContent =
      `Line #${line.lineNumber}: ${line.description}`;
    document.getElementById('dialogPartSub').textContent =
      `OEM Part #: ${line.oemPartNumber || 'N/A'} • Shop OEM Quote: ${money(line.oemPreTax)} (+ ${money(line.oemTax)} tax = ${money(line.oemTotal)})`;

    resetPartQuoteForm(line.lineNumber);
    renderPartQuotesModalList(line.lineNumber);

    const dlg = document.getElementById('dialogPartQuotes');
    if (!dlg.open) dlg.showModal();
  }

  function resetPartQuoteForm(lineNumber) {
    document.getElementById('pqLineNumber').value = String(lineNumber);
    document.getElementById('pqQuoteId').value = '';
    document.getElementById('pqFormHeading').textContent = 'Add New Competing Quote';
    document.getElementById('pqVendor').value = '';
    document.getElementById('pqListingUrl').value = '';
    document.getElementById('pqPrice').value = '';
    document.getElementById('pqShipping').value = '0';
    document.getElementById('pqTaxMode').value = 'rate';
    document.getElementById('pqManualTax').value = '0';
    document.getElementById('pqStatus').value = 'Watching / Quoted';
    document.getElementById('pqCarrier').value = '';
    document.getElementById('pqTracking').value = '';
    document.getElementById('pqNotes').value = '';
  }

  function renderPartQuotesModalList(lineNumber) {
    const container = document.getElementById('partQuotesList');
    clearChildren(container);

    const line = evaluated.evaluatedLines.find(
      (l) => l.lineNumber === Number(lineNumber)
    );
    if (!line || line.quotes.length === 0) {
      container.appendChild(
        el(
          'div',
          { className: 'vehicle-meta', style: { padding: '0.5rem 0' } },
          'No used quotes entered for this part yet. Add one below!'
        )
      );
      return;
    }

    line.quotes.forEach((q) => {
      const isActive =
        line.sourcingMode === 'standalone' &&
        (line.activeQuoteId === q.id || (!line.activeQuoteId && line.quotes[0].id === q.id));
      const sav = Calc.round2(line.oemTotal - q.computed.total);

      const card = el(
        'div',
        { className: 'quote-option-card' + (isActive ? ' active-quote' : '') },
        [
          el('div', {}, [
            el('div', { style: { fontWeight: '700' } }, [
              q.vendor || 'Used Quote',
              isActive ? ' ✓ (ACTIVE)' : ''
            ]),
            el('div', {
              className: 'vehicle-meta',
              textContent: `Price: ${money(q.computed.price)} + Ship: ${money(q.computed.shipping)} + Tax: ${money(q.computed.tax)} = Total: ${money(q.computed.total)} (Saves ${money(sav)})`
            }),
            q.notes
              ? el('div', {
                  className: 'vehicle-meta',
                  style: { fontSize: '0.76rem' },
                  textContent: `Notes: ${q.notes}`
                })
              : null
          ]),
          el('div', { className: 'header-actions' }, [
            !isActive
              ? el(
                  'button',
                  {
                    type: 'button',
                    className: 'btn btn-sm btn-emerald',
                    onClick: () => {
                      const rawLine = appState.lineItems.find(
                        (l) => l.lineNumber === Number(lineNumber)
                      );
                      rawLine.sourcingMode = 'standalone';
                      rawLine.activeQuoteId = q.id;
                      rawLine.status = q.status;
                      persistState();
                      renderPartQuotesModalList(lineNumber);
                    }
                  },
                  'Set Active'
                )
              : null,
            el(
              'button',
              {
                type: 'button',
                className: 'btn btn-sm',
                onClick: () => populatePartQuoteFormForEdit(q)
              },
              'Edit'
            ),
            el(
              'button',
              {
                type: 'button',
                className: 'btn btn-sm btn-danger',
                onClick: () => {
                  appState.partQuotes = appState.partQuotes.filter(
                    (x) => x.id !== q.id
                  );
                  const rawLine = appState.lineItems.find(
                    (l) => l.lineNumber === Number(lineNumber)
                  );
                  if (rawLine && rawLine.activeQuoteId === q.id) {
                    const remaining = appState.partQuotes.filter(
                      (x) => Number(x.lineNumber) === Number(lineNumber)
                    );
                    rawLine.activeQuoteId = remaining[0]?.id || null;
                    if (!rawLine.activeQuoteId) rawLine.sourcingMode = 'shop_new';
                  }
                  persistState();
                  renderPartQuotesModalList(lineNumber);
                }
              },
              'Delete'
            )
          ])
        ]
      );
      container.appendChild(card);
    });
  }

  function populatePartQuoteFormForEdit(q) {
    document.getElementById('pqQuoteId').value = q.id;
    document.getElementById('pqFormHeading').textContent = `Editing Quote: ${q.vendor}`;
    document.getElementById('pqVendor').value = q.vendor || '';
    document.getElementById('pqListingUrl').value = q.listingUrl || '';
    document.getElementById('pqPrice').value = String(q.price ?? 0);
    document.getElementById('pqShipping').value = String(q.shipping ?? 0);
    document.getElementById('pqTaxMode').value = q.taxMode || 'rate';
    document.getElementById('pqManualTax').value = String(q.manualTax ?? 0);
    document.getElementById('pqStatus').value = q.status || 'Watching / Quoted';
    document.getElementById('pqCarrier').value = q.carrier || '';
    document.getElementById('pqTracking').value = q.trackingNumber || '';
    document.getElementById('pqNotes').value = q.notes || '';
  }

  // =========================================================================
  // Modal 2: Proportional Bundles / Combined Orders
  // =========================================================================
  function openBundleModal(bundleId = null) {
    const existing = bundleId
      ? evaluated.evaluatedBundles.find((b) => b.id === bundleId)
      : null;

    document.getElementById('bndId').value = existing ? existing.id : '';
    document.getElementById('bndName').value = existing ? existing.name : '';

    // Build checklist of all 15 replaceable parts
    const checklist = document.getElementById('bndPartsChecklist');
    clearChildren(checklist);

    const selectedSet = new Set(existing ? existing.lineNumbers : []);
    const replaceable = evaluated.evaluatedLines.filter((l) => l.isReplaceablePart);

    replaceable.forEach((line) => {
      const chk = el('input', {
        type: 'checkbox',
        value: String(line.lineNumber),
        checked: selectedSet.has(line.lineNumber),
        onChange: updateBundleWeightsPreview
      });
      checklist.appendChild(
        el('label', { className: 'part-check-item' }, [
          chk,
          el(
            'span',
            {},
            `#${line.lineNumber} ${line.description} (${money(line.oemPreTax)})`
          )
        ])
      );
    });

    // Clear option form
    resetBundleOptionForm();
    updateBundleWeightsPreview();
    renderBundleOptionsList(existing ? existing.id : null);

    const dlg = document.getElementById('dialogBundle');
    if (!dlg.open) dlg.showModal();
  }

  function resetBundleOptionForm() {
    document.getElementById('bndOptId').value = '';
    document.getElementById('bndOptHeading').textContent =
      'Add New Competing Quote for This Bundle (Optional if editing existing)';
    document.getElementById('bndVendor').value = '';
    document.getElementById('bndListingUrl').value = '';
    document.getElementById('bndPrice').value = '';
    document.getElementById('bndShipping').value = '0';
    document.getElementById('bndTaxMode').value = 'rate';
    document.getElementById('bndManualTax').value = '0';
    document.getElementById('bndStatus').value = 'Watching / Quoted';
    document.getElementById('bndCarrier').value = '';
    document.getElementById('bndTracking').value = '';
    document.getElementById('bndNotes').value = '';
  }

  function getCheckedBundleLines() {
    const boxes = document.querySelectorAll(
      '#bndPartsChecklist input[type="checkbox"]:checked'
    );
    return Array.from(boxes).map((b) => Number(b.value));
  }

  function updateBundleWeightsPreview() {
    const preview = document.getElementById('bndWeightsPreview');
    const selectedNums = getCheckedBundleLines();
    if (selectedNums.length === 0) {
      preview.textContent = 'Select at least 2 parts above to see their proportional OEM % split.';
      return;
    }

    const lines = selectedNums
      .map((ln) => evaluated.evaluatedLines.find((l) => l.lineNumber === ln))
      .filter(Boolean);
    const totalOem = lines.reduce((sum, l) => sum + l.oemPreTax, 0);

    const breakdownText = lines
      .map((l) => {
        const pct = totalOem > 0 ? ((l.oemPreTax / totalOem) * 100).toFixed(1) : '0.0';
        return `#${l.lineNumber}: ${pct}%`;
      })
      .join(' • ');

    preview.textContent = `Grouped OEM New Pre-Tax Total: ${money(totalOem)} — Proportional Weights: [ ${breakdownText} ]`;
  }

  function renderBundleOptionsList(bundleId) {
    const sec = document.getElementById('bndExistingOptionsSection');
    const list = document.getElementById('bndOptionsList');
    clearChildren(list);

    if (!bundleId) {
      sec.style.display = 'none';
      return;
    }

    const b = evaluated.evaluatedBundles.find((x) => x.id === bundleId);
    if (!b || b.evaluatedOptions.length === 0) {
      sec.style.display = 'none';
      return;
    }

    sec.style.display = 'block';
    b.evaluatedOptions.forEach((opt) => {
      const isAct = b.activeOption && b.activeOption.id === opt.id;
      const card = el(
        'div',
        { className: 'quote-option-card' + (isAct ? ' active-quote' : '') },
        [
          el('div', {}, [
            el('div', { style: { fontWeight: '700' } }, [
              opt.vendor || 'Bundle Quote',
              isAct ? ' ✓ (ACTIVE)' : ''
            ]),
            el('div', {
              className: 'vehicle-meta',
              textContent: `Price: ${money(opt.computed.price)} + Ship: ${money(opt.computed.shipping)} + Tax: ${money(opt.computed.tax)} = Total: ${money(opt.computed.total)} (Saves ${money(opt.computed.savingsVsOem)})`
            })
          ]),
          el('div', { className: 'header-actions' }, [
            !isAct
              ? el(
                  'button',
                  {
                    type: 'button',
                    className: 'btn btn-sm btn-emerald',
                    onClick: () => {
                      const rawB = appState.bundles.find((x) => x.id === bundleId);
                      if (rawB) rawB.activeOptionId = opt.id;
                      persistState();
                      renderBundleOptionsList(bundleId);
                    }
                  },
                  'Set Active'
                )
              : null,
            el(
              'button',
              {
                type: 'button',
                className: 'btn btn-sm',
                onClick: () => {
                  document.getElementById('bndOptId').value = opt.id;
                  document.getElementById('bndOptHeading').textContent =
                    `Editing Bundle Quote: ${opt.vendor}`;
                  document.getElementById('bndVendor').value = opt.vendor || '';
                  document.getElementById('bndListingUrl').value = opt.listingUrl || '';
                  document.getElementById('bndPrice').value = String(opt.price ?? 0);
                  document.getElementById('bndShipping').value = String(opt.shipping ?? 0);
                  document.getElementById('bndTaxMode').value = opt.taxMode || 'rate';
                  document.getElementById('bndManualTax').value = String(opt.manualTax ?? 0);
                  document.getElementById('bndStatus').value = opt.status || 'Watching / Quoted';
                  document.getElementById('bndCarrier').value = opt.carrier || '';
                  document.getElementById('bndTracking').value = opt.trackingNumber || '';
                  document.getElementById('bndNotes').value = opt.notes || '';
                }
              },
              'Edit'
            ),
            el(
              'button',
              {
                type: 'button',
                className: 'btn btn-sm btn-danger',
                onClick: () => {
                  const rawB = appState.bundles.find((x) => x.id === bundleId);
                  if (!rawB) return;
                  rawB.options = rawB.options.filter((x) => x.id !== opt.id);
                  if (rawB.activeOptionId === opt.id) {
                    rawB.activeOptionId = rawB.options[0]?.id || null;
                  }
                  persistState();
                  renderBundleOptionsList(bundleId);
                }
              },
              'Delete'
            )
          ])
        ]
      );
      list.appendChild(card);
    });
  }

  function deleteBundle(bundleId) {
    appState.bundles = appState.bundles.filter((b) => b.id !== bundleId);
    appState.lineItems.forEach((line) => {
      if (line.activeBundleId === bundleId) {
        line.activeBundleId = null;
        line.sourcingMode = 'shop_new';
      }
    });
    persistState();
  }

  // Quick-Create Rear Suspension Knee Assembly Bundle (Lines 16, 17, 18, 19)
  function quickCreateSuspensionBundle() {
    const existing = appState.bundles.find((b) =>
      b.name.toLowerCase().includes('suspension')
    );
    if (existing) {
      openBundleModal(existing.id);
      return;
    }

    const newBundle = {
      id: uid(),
      name: 'Right Rear Suspension Knee Assembly (Lines 16–19)',
      lineNumbers: [16, 17, 18, 19],
      activeOptionId: null,
      options: []
    };
    appState.bundles.push(newBundle);
    [16, 17, 18, 19].forEach((ln) => {
      const item = appState.lineItems.find((l) => l.lineNumber === ln);
      if (item) {
        item.sourcingMode = 'bundle';
        item.activeBundleId = newBundle.id;
      }
    });
    persistState();
    openBundleModal(newBundle.id);
  }

  // =========================================================================
  // Modal 3: Backups & JSON Restore
  // =========================================================================
  async function openBackupsModal() {
    const dlg = document.getElementById('dialogBackups');
    if (!dlg.open) dlg.showModal();

    const list = document.getElementById('backupsList');
    clearChildren(list);
    list.appendChild(
      el('div', { className: 'vehicle-meta', textContent: 'Loading snapshots...' })
    );

    try {
      const res = await fetch('/api/backups');
      const data = await res.json();
      clearChildren(list);

      if (!data.backups || data.backups.length === 0) {
        list.appendChild(
          el(
            'div',
            { className: 'vehicle-meta' },
            'No snapshots created yet. Every edit automatically saves a rolling snapshot.'
          )
        );
        return;
      }

      data.backups.forEach((b) => {
        list.appendChild(
          el('div', { className: 'quote-option-card' }, [
            el('div', {}, [
              el('div', { style: { fontWeight: '600' }, textContent: b.filename }),
              el('div', {
                className: 'vehicle-meta',
                textContent: `${new Date(b.createdAt).toLocaleString()} • ${(b.sizeBytes / 1024).toFixed(1)} KB`
              })
            ]),
            el(
              'button',
              {
                type: 'button',
                className: 'btn btn-sm btn-primary',
                onClick: async () => {
                  const r = await fetch('/api/backups/restore', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: b.filename })
                  });
                  if (r.ok) {
                    const restored = await r.json();
                    appState = restored.state;
                    evaluated = restored.evaluated;
                    renderAll();
                    dlg.close();
                  }
                }
              },
              'Restore This Snapshot'
            )
          ])
        );
      });
    } catch (err) {
      clearChildren(list);
      list.appendChild(
        el('div', { className: 'vehicle-meta' }, 'Could not load server backups.')
      );
    }
  }

  // =========================================================================
  // Initialization & Event Listeners
  // =========================================================================
  async function init() {
    setupDialogFallbacks();

    try {
      const res = await fetch('/api/state');
      if (!res.ok) throw new Error('Failed to load server state');
      const data = await res.json();
      appState = data.state;
      evaluated = data.evaluated;
      setSyncStatus('', '● Synced to Disk');
    } catch (err) {
      console.warn('[Init] Falling back to localStorage cache:', err);
      const cached = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (cached) {
        appState = JSON.parse(cached);
        evaluated = Calc.evaluateState(appState);
        setSyncStatus('error', '● Loaded from Browser Cache');
      }
    }

    renderAll();

    // Scope buttons
    document.querySelectorAll('.seg-btn[data-scope]').forEach((btn) => {
      btn.addEventListener('click', () => {
        appState.settings.viewScope = btn.getAttribute('data-scope');
        persistState(false, false);
      });
    });

    // Toggles
    document
      .getElementById('chkIncludeLaborPaint')
      .addEventListener('change', (e) => {
        appState.settings.includeLaborAndPaint = e.target.checked;
        persistState(false, false);
      });

    document.getElementById('chkIncludeTires').addEventListener('change', (e) => {
      appState.settings.includeTiresInTotals = e.target.checked;
      persistState(false, false);
    });

    // Search & Filters
    document.getElementById('inputSearch').addEventListener('input', (e) => {
      appState.settings.searchQuery = e.target.value;
      renderTable();
    });

    document.getElementById('selectCategory').addEventListener('change', (e) => {
      appState.settings.categoryFilter = e.target.value;
      renderTable();
    });

    document.getElementById('selectStatus').addEventListener('change', (e) => {
      appState.settings.statusFilter = e.target.value;
      renderTable();
    });

    // Header Buttons
    document
      .getElementById('btnNewBundle')
      .addEventListener('click', () => openBundleModal(null));
    document
      .getElementById('btnQuickSuspBundle')
      .addEventListener('click', quickCreateSuspensionBundle);
    document
      .getElementById('btnPrintShop')
      .addEventListener('click', () => window.print());
    document
      .getElementById('btnBackups')
      .addEventListener('click', openBackupsModal);

    // Clear Part Quote Form
    document.getElementById('btnResetPqForm').addEventListener('click', () => {
      const ln = Number(document.getElementById('pqLineNumber').value);
      resetPartQuoteForm(ln);
    });

    // Submit Standalone Part Quote
    document.getElementById('formPartQuote').addEventListener('submit', (e) => {
      e.preventDefault();
      const lineNumber = Number(document.getElementById('pqLineNumber').value);
      const quoteId = document.getElementById('pqQuoteId').value || uid();

      const quoteObj = {
        id: quoteId,
        lineNumber,
        vendor: document.getElementById('pqVendor').value.trim(),
        listingUrl: document.getElementById('pqListingUrl').value.trim(),
        price: Number(document.getElementById('pqPrice').value) || 0,
        shipping: Number(document.getElementById('pqShipping').value) || 0,
        taxMode: document.getElementById('pqTaxMode').value,
        manualTax: Number(document.getElementById('pqManualTax').value) || 0,
        status: document.getElementById('pqStatus').value,
        carrier: document.getElementById('pqCarrier').value,
        trackingNumber: document.getElementById('pqTracking').value.trim(),
        notes: document.getElementById('pqNotes').value.trim(),
        createdAt: new Date().toISOString()
      };

      const existingIdx = appState.partQuotes.findIndex((q) => q.id === quoteId);
      if (existingIdx >= 0) {
        appState.partQuotes[existingIdx] = quoteObj;
      } else {
        appState.partQuotes.push(quoteObj);
      }

      const rawLine = appState.lineItems.find((l) => l.lineNumber === lineNumber);
      if (rawLine) {
        rawLine.sourcingMode = 'standalone';
        rawLine.activeQuoteId = quoteId;
        rawLine.status = quoteObj.status;
      }

      persistState(true, true);
      resetPartQuoteForm(lineNumber);
      renderPartQuotesModalList(lineNumber);
    });

    // Submit Bundle Form
    document.getElementById('formBundle').addEventListener('submit', (e) => {
      e.preventDefault();
      const bId = document.getElementById('bndId').value || uid();
      const name = document.getElementById('bndName').value.trim();
      const lineNumbers = getCheckedBundleLines();

      let bundle = appState.bundles.find((b) => b.id === bId);
      if (!bundle) {
        bundle = {
          id: bId,
          name,
          lineNumbers,
          activeOptionId: null,
          options: []
        };
        appState.bundles.push(bundle);
      } else {
        bundle.name = name;
        bundle.lineNumbers = lineNumbers;
      }

      // Check if user entered a vendor or price in the option fields
      const vendor = document.getElementById('bndVendor').value.trim();
      const priceStr = document.getElementById('bndPrice').value.trim();
      if (vendor || priceStr !== '') {
        const optId = document.getElementById('bndOptId').value || uid();
        const optObj = {
          id: optId,
          vendor: vendor || name,
          listingUrl: document.getElementById('bndListingUrl').value.trim(),
          price: Number(priceStr) || 0,
          shipping: Number(document.getElementById('bndShipping').value) || 0,
          taxMode: document.getElementById('bndTaxMode').value,
          manualTax: Number(document.getElementById('bndManualTax').value) || 0,
          status: document.getElementById('bndStatus').value,
          carrier: document.getElementById('bndCarrier').value,
          trackingNumber: document.getElementById('bndTracking').value.trim(),
          notes: document.getElementById('bndNotes').value.trim(),
          createdAt: new Date().toISOString()
        };

        const idx = bundle.options.findIndex((o) => o.id === optId);
        if (idx >= 0) {
          bundle.options[idx] = optObj;
        } else {
          bundle.options.push(optObj);
        }
        bundle.activeOptionId = optId;
      }

      // Assign checked line items to this bundle
      appState.lineItems.forEach((line) => {
        if (lineNumbers.includes(line.lineNumber)) {
          line.sourcingMode = 'bundle';
          line.activeBundleId = bId;
        } else if (line.activeBundleId === bId) {
          line.activeBundleId = null;
          line.sourcingMode = 'shop_new';
        }
      });

      persistState(true, true);
      document.getElementById('dialogBundle').close();
    });

    // Import JSON File
    document.getElementById('inputImportJson').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          appState = parsed;
          persistState(true, true);
          document.getElementById('dialogBackups').close();
        } catch (err) {
          alert('Invalid JSON backup file: ' + err.message);
        }
      };
      reader.readAsText(file);
    });

    // Reset to Baseline
    document
      .getElementById('btnResetBaseline')
      .addEventListener('click', async () => {
        const res = await fetch('/api/reset', { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          appState = data.state;
          evaluated = data.evaluated;
          renderAll();
          document.getElementById('dialogBackups').close();
        }
      });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
