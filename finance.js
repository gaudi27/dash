(function () {
  'use strict';

  const STORAGE_KEY = 'finance_dashboard_state';

  const defaultState = {
    accounts: [
      { id: 'bofa', name: 'Bank of America Debit', type: 'checking', balance: 0, connected: false, institution: 'Bank of America' },
      { id: 'fidelity', name: 'Fidelity Stock Portfolio', type: 'brokerage', balance: 0, connected: false, institution: 'Fidelity' },
      { id: 'western', name: 'Western Bank HYSA', type: 'savings', balance: 0, connected: false, institution: 'Western Bank' },
    ],
    customAssets: [
      { id: crypto.randomUUID(), name: 'Car', value: 0 },
      { id: crypto.randomUUID(), name: 'PC', value: 0 },
    ],
    customLiabilities: [],
    lastSync: null,
  };

  const balancesEl = document.getElementById('financeBalances');
  const networthEl = document.getElementById('financeNetworth');
  const connectedEl = document.getElementById('financeConnected');
  const accountsListEl = document.getElementById('financeAccountsList');
  const customAssetsListEl = document.getElementById('financeAssetsList');
  const addAssetForm = document.getElementById('financeAssetForm');
  const addAssetName = document.getElementById('financeAssetName');
  const addAssetValue = document.getElementById('financeAssetValue');
  const connectBtn = document.getElementById('financeConnectBtn');
  const refreshBtn = document.getElementById('financeRefreshBtn');
  const syncStatusEl = document.getElementById('financeSyncStatus');

  function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaultState);
    try {
      const parsed = JSON.parse(raw);
      return {
        ...structuredClone(defaultState),
        ...parsed,
        accounts: Array.isArray(parsed.accounts) && parsed.accounts.length ? parsed.accounts : structuredClone(defaultState.accounts),
        customAssets: Array.isArray(parsed.customAssets) && parsed.customAssets.length ? parsed.customAssets : structuredClone(defaultState.customAssets),
        customLiabilities: Array.isArray(parsed.customLiabilities) ? parsed.customLiabilities : [],
      };
    } catch (error) {
      return structuredClone(defaultState);
    }
  }

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function formatMoney(value) {
    const numeric = Number(value) || 0;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(numeric);
  }

  function sumAccounts(state) {
    return (state.accounts || []).reduce((sum, account) => sum + (Number(account.balance) || 0), 0);
  }

  function sumCustomAssets(state) {
    return (state.customAssets || []).reduce((sum, item) => sum + (Number(item.value) || 0), 0);
  }

  function totalNetworth(state) {
    return sumAccounts(state) + sumCustomAssets(state);
  }

  function renderAccounts(state) {
    if (!accountsListEl) return;
    accountsListEl.innerHTML = '';

    state.accounts.forEach((account) => {
      const row = document.createElement('div');
      row.className = 'finance-account-row';
      row.innerHTML = `
        <div class="finance-account-name-wrap">
          <div class="finance-account-name">${account.name}</div>
          <div class="finance-account-meta">${account.type}</div>
        </div>
        <div class="finance-account-balance-wrap">
          <div class="finance-account-balance ${account.connected ? 'connected' : ''}">${formatMoney(account.balance)}</div>
          <div class="finance-account-status">${account.connected ? 'Connected' : 'Not connected'}</div>
        </div>
      `;
      accountsListEl.appendChild(row);
    });
  }

  function renderCustomAssets(state) {
    if (!customAssetsListEl) return;
    customAssetsListEl.innerHTML = '';

    if (!state.customAssets.length) {
      const empty = document.createElement('div');
      empty.className = 'finance-empty';
      empty.textContent = 'No net worth items yet.';
      customAssetsListEl.appendChild(empty);
      return;
    }

    state.customAssets.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'finance-asset-row';
      row.innerHTML = `
        <div class="finance-asset-name">${item.name}</div>
        <div class="finance-asset-actions">
          <div class="finance-asset-value">${formatMoney(item.value)}</div>
          <button class="finance-remove-item" data-id="${item.id}" aria-label="Remove ${item.name}">×</button>
        </div>
      `;
      customAssetsListEl.appendChild(row);
    });
  }

  function renderSummary(state) {
    const accountsTotal = sumAccounts(state);
    const customAssetsTotal = sumCustomAssets(state);
    const total = totalNetworth(state);
    const connected = state.accounts.filter((account) => account.connected).length;

    if (balancesEl) {
      balancesEl.textContent = formatMoney(accountsTotal + customAssetsTotal);
    }
    if (networthEl) {
      networthEl.textContent = formatMoney(total);
    }
    if (connectedEl) {
      connectedEl.textContent = `${connected} / ${state.accounts.length} connected`;
    }
    if (syncStatusEl) {
      const lastSync = state.lastSync ? new Date(state.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Not synced';
      syncStatusEl.textContent = `Last synced: ${lastSync}`;
    }
  }

  function render(state) {
    renderAccounts(state);
    renderCustomAssets(state);
    renderSummary(state);
  }

  function updateStateAndRender(nextState) {
    saveState(nextState);
    render(nextState);
  }

  function findMatchingAccountName(institutionName) {
    const value = String(institutionName || '').toLowerCase();
    const rules = [
      ['bank of america', 'bofa'],
      ['fidelity', 'fidelity'],
      ['western bank', 'western'],
    ];

    for (const [needle, id] of rules) {
      if (value.includes(needle)) {
        return id;
      }
    }
    return null;
  }

  function hydratePlaidBalances(items) {
    const current = loadState();
    if (!Array.isArray(items)) return;

    items.forEach((item) => {
      const institutionKey = findMatchingAccountName(item.institution);
      if (!institutionKey) return;

      const matching = current.accounts.find((account) => account.id === institutionKey);
      if (!matching) return;

      const total = (item.accounts || []).reduce((sum, account) => sum + (Number(account.balance?.current ?? account.balance?.available ?? 0) || 0), 0);
      matching.balance = total;
      matching.connected = true;
      matching.lastSyncedAt = new Date().toISOString();
    });

    current.lastSync = new Date().toISOString();
    updateStateAndRender(current);
  }

  async function refreshPlaidBalances() {
    try {
      const response = await fetch('/api/plaid/accounts');
      if (!response.ok) {
        throw new Error('Unable to fetch account balances.');
      }
      const payload = await response.json();
      hydratePlaidBalances(payload.items || []);
    } catch (error) {
      console.error('Account refresh error:', error);
      const state = loadState();
      state.lastSync = new Date().toISOString();
      updateStateAndRender(state);
    }
  }

  async function connectPlaid() {
    try {
      if (!window.Plaid) {
        const script = document.createElement('script');
        script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
        script.async = true;
        await new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }

      const tokenResponse = await fetch('/api/plaid/link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!tokenResponse.ok) {
        throw new Error('Could not create a Plaid link token.');
      }

      const tokenPayload = await tokenResponse.json();
      const token = tokenPayload.link_token;
      if (!token) {
        throw new Error('No link token returned.');
      }

      const handler = window.Plaid.create({
        token,
        onSuccess: async (publicToken, metadata) => {
          const exchangeResponse = await fetch('/api/plaid/exchange-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              public_token: publicToken,
              institution: metadata?.institution?.name || 'Linked Account',
            }),
          });

          if (!exchangeResponse.ok) {
            throw new Error('Unable to save the linked account.');
          }

          await refreshPlaidBalances();
        },
        onExit: () => {
          refreshPlaidBalances();
        },
        onEvent: (eventName, metadata) => {
          console.log('Plaid event:', eventName, metadata);
        },
      });

      handler.open();
    } catch (error) {
      console.error('Plaid connect error:', error);
      alert('Plaid connection is not configured yet. The app will still keep the manual net worth section working.');
    }
  }

  function bindEvents() {
    if (connectBtn) {
      connectBtn.addEventListener('click', connectPlaid);
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', refreshPlaidBalances);
    }

    if (addAssetForm) {
      addAssetForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = addAssetName.value.trim();
        const value = Number(addAssetValue.value || 0);
        if (!name || Number.isNaN(value)) return;

        const state = loadState();
        state.customAssets.push({
          id: crypto.randomUUID(),
          name,
          value,
        });
        updateStateAndRender(state);
        addAssetForm.reset();
      });
    }

    document.addEventListener('click', (event) => {
      const button = event.target.closest('.finance-remove-item');
      if (!button) return;
      const state = loadState();
      state.customAssets = state.customAssets.filter((item) => item.id !== button.dataset.id);
      updateStateAndRender(state);
    });
  }

  function initializeSync() {
    if (window.initCloudSync) {
      window.initCloudSync({
        appKey: 'finance-dashboard',
        syncedKeys: [STORAGE_KEY],
        onApplied: () => {
          const state = loadState();
          render(state);
        },
      });
    }
  }

  function boot() {
    const state = loadState();
    render(state);
    bindEvents();
    initializeSync();
    refreshPlaidBalances();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
