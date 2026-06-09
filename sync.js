// =============================================================
// Shared cloud-sync helper. Each page calls initCloudSync({...}).
// Replace the two placeholders with your Supabase project URL +
// publishable key (same ones you used in topbar.js/gym.html).
// =============================================================
(function () {
  'use strict';
  const SUPABASE_URL = 'https://jvdxtaosxicsvpskpflb.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_TuBx-uqMoGKOZJmYJDqvMw_80G5Bk4h';

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    // Optional per-key merge functions: { 'someKey': (localValue, remoteValue) => mergedValue }.
    // Keys listed here are NEVER blindly overwritten or deleted by a remote pull — the merge
    // result is kept and pushed back, so concurrent/stale devices can't destroy local data.
    const mergeFns = (config && config.merge) || {};
    if (!appKey || !window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa = null, pushTimer = null, suppressSync = false, lastSyncedJson = null;

    function matches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      return out;
    }
    const origSet = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };
    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
      suppressSync = true;
      let changed = false;
      let diverged = false; // a merge produced something different from remote → push the union back
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          let value = remote[k];
          if (mergeFns[k]) {
            let localVal = null;
            try { const lv = localStorage.getItem(k); localVal = lv == null ? null : JSON.parse(lv); } catch (e) {}
            try { value = mergeFns[k](localVal, remote[k]); } catch (e) { value = remote[k]; }
            if (JSON.stringify(value) !== JSON.stringify(remote[k])) diverged = true;
          }
          const incoming = JSON.stringify(value);
          const local = localStorage.getItem(k);
          if (local !== incoming) { try { origSet(k, incoming); changed = true; } catch (e) {} }
        }
        for (const k of listAllKeys()) {
          if (k in remote) continue;
          // Merge keys present locally but missing from remote are kept (and pushed up),
          // never deleted — this is what stops a stale remote from wiping local history.
          if (mergeFns[k]) { diverged = true; continue; }
          try { origRemove(k); changed = true; } catch (e) {}
        }
      } finally { suppressSync = false; }
      if (changed && typeof onApplied === 'function') { try { onApplied(); } catch (e) {} }
      if (diverged) schedulePush();
      return changed;
    }
    async function pushNow() {
      if (!supa) return;
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) {
          lastSyncedJson = json;
          window.__syncStatus = { dir: 'push', ok: true, at: Date.now(), appKey: appKey };
        } else {
          window.__syncStatus = { dir: 'push', ok: false, at: Date.now(), appKey: appKey, error: error.message || JSON.stringify(error) };
          console.error('[sync] push failed for "' + appKey + '":', error);
        }
      } catch (e) {
        window.__syncStatus = { dir: 'push', ok: false, at: Date.now(), appKey: appKey, error: String(e && e.message || e) };
        console.error('[sync] push threw for "' + appKey + '":', e);
      }
    }
    function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 250); }
    function flushOnUnload() {
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        lastSyncedJson = json;
      } catch (e) {}
    }
    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const { data, error } = await supa.from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (!error && data && data.data && Object.keys(data.data).length > 0) {
          lastSyncedJson = JSON.stringify(data.data);
          applyRemote(data.data);
        } else if (Object.keys(collect()).length > 0) {
          schedulePush();
        }
      } catch (e) {}
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          applyRemote(payload.new.data);
        })
        .subscribe();
    })();
    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => { if (e.key && matches(e.key)) schedulePush(); });

    // Re-pull from Supabase whenever the tab becomes visible again (e.g. switching
    // from phone to browser, or returning to the tab after logging on another device).
    // This is a reliable fallback when Supabase real-time isn't enabled on the table.
    async function pullNow() {
      if (!supa) return;
      try {
        const { data, error } = await supa.from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (error) {
          window.__syncStatus = { dir: 'pull', ok: false, at: Date.now(), appKey: appKey, error: error.message || JSON.stringify(error) };
          console.error('[sync] pull failed for "' + appKey + '":', error);
          return;
        }
        if (data && data.data) {
          const incoming = JSON.stringify(data.data);
          if (incoming !== lastSyncedJson) {
            lastSyncedJson = incoming;
            applyRemote(data.data);
          }
        }
        window.__syncStatus = { dir: 'pull', ok: true, at: Date.now(), appKey: appKey };
      } catch (e) {
        window.__syncStatus = { dir: 'pull', ok: false, at: Date.now(), appKey: appKey, error: String(e && e.message || e) };
        console.error('[sync] pull threw for "' + appKey + '":', e);
      }
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pullNow();
    });
    window.addEventListener('focus', pullNow);
    // Poll every 8 s as a guaranteed fallback when real-time isn't enabled,
    // so an already-open tab on another device catches changes quickly.
    setInterval(() => { if (!document.hidden) pullNow(); }, 8000);
  };
})();
