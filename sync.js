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
      let state = collect();
      // Read-merge-write: for keys with a merge function, pull the LATEST remote first
      // and merge it into what we're about to write. This guarantees a push can only add
      // to / update the union — it can never delete data another device wrote that this
      // client hasn't merged yet (the root cause of "opening my computer deleted phone logs").
      if (Object.keys(mergeFns).length) {
        try {
          const { data, error } = await supa.from('app_state').select('data').eq('key', appKey).maybeSingle();
          if (!error && data && data.data) {
            const remote = data.data;
            let localChanged = false;
            suppressSync = true;
            try {
              for (const k of Object.keys(mergeFns)) {
                const lv = (k in state)  ? state[k]  : null;
                const rv = (k in remote) ? remote[k] : null;
                if (lv === null && rv === null) continue;
                let merged;
                try { merged = mergeFns[k](lv, rv); } catch (e) { merged = (lv != null ? lv : rv); }
                state[k] = merged;
                const mergedStr = JSON.stringify(merged);
                if (localStorage.getItem(k) !== mergedStr) { try { origSet(k, mergedStr); localChanged = true; } catch (e) {} }
              }
            } finally { suppressSync = false; }
            if (localChanged && typeof onApplied === 'function') { try { onApplied(); } catch (e) {} }
          }
        } catch (e) { /* read failed — fall through and push local as-is */ }
      }
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
      // For merge-enabled pages (e.g. food), never do a raw blind POST before we've
      // completed at least one pull+merge this session — otherwise unloading right after
      // load could overwrite the cloud with a not-yet-merged local state.
      if (Object.keys(mergeFns).length && lastSyncedJson === null) return;
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
        if (error) {
          // Pull failed — do NOT push. Pushing our local now could clobber good remote
          // data. The poll + visibility handlers will retry shortly.
          window.__syncStatus = { dir: 'pull', ok: false, at: Date.now(), appKey: appKey, error: error.message || JSON.stringify(error) };
          console.error('[sync] initial pull failed for "' + appKey + '":', error);
        } else if (data && data.data && Object.keys(data.data).length > 0) {
          lastSyncedJson = JSON.stringify(data.data);
          applyRemote(data.data);
        } else if (Object.keys(collect()).length > 0) {
          // Remote genuinely empty — safe to seed it from local (pushNow re-checks/merges).
          schedulePush();
        }
      } catch (e) {
        // Network error — do NOT push (same clobber risk as above).
        console.error('[sync] initial pull threw for "' + appKey + '":', e);
      }
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
