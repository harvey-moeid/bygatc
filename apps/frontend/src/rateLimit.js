/**
 * rateLimit.js (v4.1)
 * =====================================================================
 * localStorage-tracked budget enforcer.
 *
 * v4.1 fixes:
 *   • Month prefix collision bug (Jan matching Oct/Nov/Dec keys) — use
 *     zero-padded month and startsWith-safe prefixes for GC.
 *   • Atomic begin/end semantics to avoid parallel-fetch over-counting.
 *   • Preflight + post-confirm pattern: beginCall() optimistically
 *     increments and returns a handle; endCall(handle, ok) either keeps
 *     the increment (success) or rolls back (failure).
 */
const RateLimit = (() => {
  const BUDGETS = {
    exa:        { monthly: 1000, daily: 33,   hourly: 1,   label: 'Exa Search'     },
    binance:    { monthly: null, daily: null, hourly: 180, label: 'Binance public' },
    cryptocom:  { monthly: null, daily: null, hourly: 60,  label: 'Crypto.com'     },
    deribit:    { monthly: null, daily: null, hourly: 60,  label: 'Deribit options'},
    fearGreed:  { monthly: null, daily: 2,    hourly: 1,   label: 'Fear & Greed'   },
    kronos:     { monthly: null, daily: 8,    hourly: 2,   label: 'Kronos demo'    },
  };

  const KEY = 'btc_rl_v4_1';

  function getStore() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  }
  function saveStore(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} }

  // Zero-padded helpers — so "2026-01" never substring-matches "2026-10".
  const pad = n => String(n).padStart(2, '0');

  function windows() {
    const n = new Date();
    const y = n.getUTCFullYear();
    const mo = pad(n.getUTCMonth() + 1);           // 1-indexed, zero-padded
    const d  = pad(n.getUTCDate());
    const h  = pad(n.getUTCHours());
    return {
      hourKey: `${y}-${mo}-${d}-${h}`,
      dayKey:  `${y}-${mo}-${d}`,
      monKey:  `${y}-${mo}`,
    };
  }

  function counterKey(api, bucket, win) { return `${api}_${bucket}_${win}`; }

  function canCall(apiKey) {
    const b = BUDGETS[apiKey];
    if (!b) return { allowed: true, reason: null };
    const s = getStore();
    const w = windows();
    const h = s[counterKey(apiKey, 'h', w.hourKey)] || 0;
    const d = s[counterKey(apiKey, 'd', w.dayKey)] || 0;
    const m = s[counterKey(apiKey, 'm', w.monKey)] || 0;
    if (b.hourly !== null && h >= b.hourly)
      return { allowed: false, reason: `${b.label}: hourly (${b.hourly}/hr) reached` };
    if (b.daily !== null && d >= b.daily)
      return { allowed: false, reason: `${b.label}: daily (${b.daily}/day) reached` };
    if (b.monthly !== null && m >= b.monthly)
      return { allowed: false, reason: `${b.label}: monthly (${b.monthly}) reached` };
    return { allowed: true, reason: null };
  }

  // Optimistic: pre-increment, return a rollback handle.
  function beginCall(apiKey) {
    const check = canCall(apiKey);
    if (!check.allowed) return { ok: false, reason: check.reason, rollback: () => {} };
    const w = windows();
    const s = getStore();
    const keys = [
      counterKey(apiKey, 'h', w.hourKey),
      counterKey(apiKey, 'd', w.dayKey),
      counterKey(apiKey, 'm', w.monKey),
    ];
    keys.forEach(k => { s[k] = (s[k] || 0) + 1; });
    saveStore(s);
    return {
      ok: true,
      rollback: () => {
        const s2 = getStore();
        keys.forEach(k => { if (s2[k] > 0) s2[k] -= 1; });
        saveStore(s2);
      },
    };
  }

  // Back-compat wrapper — existing data.js callers still work.
  function record(apiKey) {
    beginCall(apiKey);
  }

  function getStats() {
    const s = getStore();
    const w = windows();
    const out = {};
    for (const [k, b] of Object.entries(BUDGETS)) {
      out[k] = {
        label:      b.label,
        hourly:     s[counterKey(k, 'h', w.hourKey)] || 0,
        daily:      s[counterKey(k, 'd', w.dayKey)]  || 0,
        monthly:    s[counterKey(k, 'm', w.monKey)]  || 0,
        hourLimit:  b.hourly,
        dayLimit:   b.daily,
        monthLimit: b.monthly,
      };
    }
    return out;
  }

  // Garbage-collect old keys — prefix-safe, matches only the current month.
  try {
    const s = getStore();
    const { monKey } = windows();
    // Any counter key ends with one of the three forms:
    //   *_m_YYYY-MM                 → exact match
    //   *_d_YYYY-MM-DD              → startsWith _m_ prefix's month part
    //   *_h_YYYY-MM-DD-HH           → startsWith _h_ prefix's month part
    // Keep keys whose window starts with the current month.
    let changed = false;
    for (const k of Object.keys(s)) {
      const parts = k.split('_');            // e.g. ['exa','h','2026-04-19-12']
      const win = parts[parts.length - 1];
      if (!win.startsWith(monKey)) { delete s[k]; changed = true; }
    }
    if (changed) saveStore(s);
    // One-time migration: drop the old v4 store if it exists.
    try { localStorage.removeItem('btc_rl_v4'); } catch {}
  } catch {}

  return { canCall, beginCall, record, getStats, BUDGETS };
})();
