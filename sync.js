// =============================================================
// Shared cloud-sync helper for the dashboard.
// Each page calls initCloudSync({...}) once with its config:
//   appKey         — string row key in the public.app_state table
//   syncedKeys     — exact localStorage keys to mirror
//   syncedPrefixes — localStorage key prefixes to mirror (e.g. 'goals:')
//   onApplied      — optional callback after remote state has been applied
//   mergeFns       — optional { [localStorageKey]: (localRawJson, remoteRawJson) => mergedRawJson }
//                     combine local + remote instead of remote replacing
//                     local outright — use when two devices might create
//                     data offline before their first successful sync
//
// Requires:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="sync.js"></script>  (NOT defer — must run before each page's
//                                      own inline script calls initCloudSync)
// =============================================================
(function () {
  'use strict';

  // Prefer Vercel env vars (served via /api/config → window.DASH_*),
  // otherwise fall back to these defaults. IMPORTANT: only ever put a
  // public "publishable"/"anon" key here — never a secret/service_role
  // key, since this file ships to every visitor's browser.
  const SUPABASE_URL = (typeof window !== 'undefined' && window.DASH_SUPABASE_URL) || 'https://qasffxghajrshvmewlsh.supabase.co';
  const SUPABASE_KEY = (typeof window !== 'undefined' && window.DASH_SUPABASE_KEY) || 'sb_publishable_0RYrT2vohICINJplFwKSug_Y00krcCw';

  // --- tiny visible sync-status badge (tap for detail) ------------------
  // sync.js has no DOM dependency of its own, but this indicator does, so
  // it waits for the DOM even though the rest of this file runs eagerly.
  let badgeEl = null;
  function ensureBadge() {
    if (badgeEl || !document.body) return badgeEl;
    badgeEl = document.createElement('div');
    badgeEl.id = '__syncBadge';
    // z-index 90: above the sticky topbar (40) and normal page content, but
    // below every full-screen sheet/modal in the app (100+) — so an open
    // sheet naturally covers the badge instead of the badge floating on
    // top of the sheet's own close button.
    badgeEl.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top,0px) + 6px);left:8px;' +
      'z-index:90;font:600 10.5px -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:0.02em;' +
      'padding:5px 9px;border-radius:999px;background:rgba(20,20,22,0.75);color:#fff;cursor:pointer;' +
      'backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.14);display:flex;align-items:center;gap:5px;';
    badgeEl.innerHTML = '<span class="__syncDot" style="width:6px;height:6px;border-radius:50%;background:#F2C063;flex-shrink:0;"></span><span class="__syncText">syncing…</span>';
    badgeEl.addEventListener('click', function () {
      alert('Sync status (' + (badgeEl.dataset.appKey || '?') + '):\n\n' + (badgeEl.dataset.detail || 'no detail yet'));
    });
    document.body.appendChild(badgeEl);
    return badgeEl;
  }
  function setBadge(appKey, state, detail) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setBadge(appKey, state, detail); });
      return;
    }
    const el = ensureBadge();
    if (!el) return;
    el.dataset.appKey = appKey || '';
    el.dataset.detail = detail || '';
    const dot = el.querySelector('.__syncDot');
    const text = el.querySelector('.__syncText');
    if (state === 'ok') { dot.style.background = '#6BE3A4'; text.textContent = 'synced'; }
    else if (state === 'error') { dot.style.background = '#FF6B6B'; text.textContent = 'sync error'; }
    else { dot.style.background = '#F2C063'; text.textContent = 'syncing…'; }
    if (detail) console.log('[sync:' + appKey + '] ' + state + ' — ' + detail);
  }

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    // Optional: { [localStorageKey]: (localRawJson, remoteRawJson) => mergedRawJson }
    // Without this, a remote value always wins outright over local — fine for
    // most pages, but risks silently discarding data two devices each created
    // offline before ever syncing. Provide a merge fn to combine both instead.
    const mergeFns = (config && config.mergeFns) || {};
    if (!appKey) return;
    if (!window.supabase) { setBadge(appKey, 'error', 'supabase-js failed to load (CDN blocked or offline)'); return; }
    if (!SUPABASE_URL || !SUPABASE_KEY) { setBadge(appKey, 'error', 'missing Supabase URL/key config'); return; }
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) { setBadge(appKey, 'error', 'Supabase URL/key still set to placeholder'); return; }

    let supa = null;
    let pushTimer = null;
    let suppressSync = false;
    let lastSyncedJson = null;

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
      let mergedBeyondRemote = false; // true if a merge pulled in local-only data
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          let incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (typeof mergeFns[k] === 'function' && local != null) {
            try {
              const merged = mergeFns[k](local, incoming);
              if (typeof merged === 'string') {
                if (merged !== incoming) mergedBeyondRemote = true;
                incoming = merged;
              }
            } catch (e) {}
          }
          if (local !== incoming) {
            try { origSet(k, incoming); changed = true; } catch (e) {}
          }
        }
        for (const k of listAllKeys()) {
          if (!(k in remote)) {
            try { origRemove(k); changed = true; } catch (e) {}
          }
        }
      } finally { suppressSync = false; }
      if (changed && typeof onApplied === 'function') {
        try { onApplied(); } catch (e) {}
      }
      // A merge combined local-only data into what the remote had — push
      // the merged result back so the other device converges too.
      if (mergedBeyondRemote) schedulePush();
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
        if (!error) { lastSyncedJson = json; setBadge(appKey, 'ok', 'last push ' + new Date().toLocaleTimeString()); }
        else setBadge(appKey, 'error', 'push failed: ' + (error.message || JSON.stringify(error)));
      } catch (e) { setBadge(appKey, 'error', 'push threw: ' + (e && e.message || String(e))); }
    }
    function schedulePush() {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushNow, 250);
    }
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

    // Pull the latest saved state and apply it. This is the core sync
    // mechanism — it does NOT depend on the realtime websocket, only on
    // plain REST, so it works even on networks that block websockets.
    async function pullLatest(showBadgeOnError, isRetry) {
      // Snapshot local state before the (possibly slow) network round-trip.
      // If the user changes something locally WHILE this request is in
      // flight (e.g. drops a dragged tile right as a pull happens to be
      // out), the response below is now stale — applying it would silently
      // overwrite the fresher local change with older data. Push the local
      // change instead of applying the response in that case.
      const localBefore = JSON.stringify(collect());
      try {
        const { data, error } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (error) {
          if (!isRetry) { setTimeout(function () { pullLatest(showBadgeOnError, true); }, 3000); return; }
          if (showBadgeOnError) setBadge(appKey, 'error', 'read failed: ' + (error.message || JSON.stringify(error)));
          return;
        }
        const localNow = JSON.stringify(collect());
        if (localNow !== localBefore) {
          schedulePush();
        } else if (data && data.data && Object.keys(data.data).length > 0) {
          const incoming = JSON.stringify(data.data);
          if (incoming !== lastSyncedJson) { lastSyncedJson = incoming; applyRemote(data.data); }
        } else if (Object.keys(collect()).length > 0) {
          schedulePush();
        }
        setBadge(appKey, 'ok', 'connected — last check ' + new Date().toLocaleTimeString());
      } catch (e) {
        // TypeError: Failed to fetch is often a one-off blip — retry once
        // before surfacing it, instead of leaving a stale error showing.
        if (!isRetry) { setTimeout(function () { pullLatest(showBadgeOnError, true); }, 3000); return; }
        if (showBadgeOnError) setBadge(appKey, 'error', 'read threw: ' + (e && e.message || String(e)));
      }
    }

    (async function init() {
      setBadge(appKey, 'pending', 'connecting…');
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      await pullLatest(true);

      // Best-effort live updates while the page stays open. If this fails
      // (some networks block websockets) we still have the polling +
      // refresh-on-reopen fallback below, so don't flag it as a hard error.
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'app_state',
          filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          applyRemote(payload.new.data);
        })
        .subscribe((status, err) => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.log('[sync:' + appKey + '] realtime unavailable (' + status + '), relying on polling instead' + (err ? ': ' + err.message : ''));
          }
        });

      // Fallback sync: re-pull periodically and whenever the page/tab
      // becomes visible or focused again — covers the "open on the other
      // device" case even when realtime can't connect.
      setInterval(function () { pullLatest(false); }, 20000);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') pullLatest(false);
      });
      window.addEventListener('focus', function () { pullLatest(false); });
    })();

    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => {
      if (e.key && matches(e.key)) schedulePush();
    });
  };
})();
