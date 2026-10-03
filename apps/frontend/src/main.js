/**
 * main.js (v4)
 * =====================================================================
 * Parallel-fetching orchestrator. Builds the master Decision object
 * that drives the hero card. Slider changes trigger local recomputation
 * only (no API calls).
 *
 * Encoding note: ASCII-only on purpose (special characters are written as
 * \uXXXX escapes) so it passes scripts/check-encoding.js.
 */

let state = {
  price: null, hourly: null, daily: null, fg: null, BGTC: null, news: null,
  options: null, ranger: null, sentiment: null, hv20: null, atmInfo: null, noctuaExport: null,
  regime: null, retailPlan: null, funding: null, session: null, decision: null,
};

let refreshInFlight = false;

async function refreshAll() {
  if (refreshInFlight) { console.warn('[v4] refreshAll skipped \u2014 already running'); return; }
  refreshInFlight = true;
  try {
    await doRefreshAll();
  } finally {
    refreshInFlight = false;
  }
}

async function fetchNoctuaExport() {
  try {
    const r = await fetch('/api/noctua/data', { signal: AbortSignal.timeout(7000), cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    console.warn('[NOCTUA export] metadata unavailable:', e.message);
    return null;
  }
}

function renderNoctuaExport(meta) {
  const status = document.getElementById('noctuaExportStatus');
  const pqMeta = document.getElementById('noctuaParquetMeta');
  const csvMeta = document.getElementById('noctuaCsvMeta');
  const updated = document.getElementById('noctuaExportUpdated');
  const pqBtn = document.getElementById('noctuaParquetBtn');
  const csvBtn = document.getElementById('noctuaCsvBtn');
  if (!status || !pqMeta || !csvMeta) return;

  const DOT = ' \u00b7 ';
  const fmtSize = bytes => {
    if (!Number.isFinite(bytes)) return '\u2014';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  };
  const fmtDate = iso => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime())
      ? d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
      : '\u2014';
  };
  const enable = (el, href) => {
    if (!el || !href) return;
    el.href = href;
    el.classList.add('ready');
  };

  const count = [meta?.parquet, meta?.csv].filter(Boolean).length;
  if (!meta || !count) {
    status.className = 'pill-sm err';
    status.textContent = 'R2 OFFLINE';
    pqMeta.textContent = 'Belum tersedia';
    csvMeta.textContent = 'Belum tersedia';
    if (updated) updated.textContent = 'Export belum tersedia';
    return;
  }

  status.className = count === 2 ? 'pill-sm ok' : 'pill-sm warn';
  status.textContent = count === 2 ? 'R2 READY' : 'R2 PARTIAL';

  if (meta.parquet) {
    pqMeta.textContent = fmtSize(meta.parquet.size_bytes) + DOT + fmtDate(meta.parquet.uploaded);
    enable(pqBtn, meta.download_parquet || '/api/noctua/download?format=parquet');
  } else pqMeta.textContent = 'Belum tersedia';

  if (meta.csv) {
    csvMeta.textContent = fmtSize(meta.csv.size_bytes) + DOT + fmtDate(meta.csv.uploaded);
    enable(csvBtn, meta.download_csv || '/api/noctua/download?format=csv');
  } else csvMeta.textContent = 'Belum tersedia';

  const latest = [meta.parquet?.uploaded, meta.csv?.uploaded].filter(Boolean).sort().pop();
  if (updated) updated.textContent = latest ? 'Update terakhir' + DOT + fmtDate(latest) : 'Metadata tersedia';
}

async function doRefreshAll() {
  console.log('[v4] refreshAll start');
  UI.updateClock();

  const [price, hourly, daily, fg, options, BGTC, funding, noctuaExport] = await Promise.all([
    DataLayer.fetchPrice().catch(e => (console.error('price fail', e), null)),
    DataLayer.fetchHourly().catch(e => (console.error('hourly fail', e), null)),
    DataLayer.fetchDaily().catch(e => (console.error('daily fail', e), null)),
    DataLayer.fetchFearGreed().catch(e => (console.error('fg fail', e), null)),
    DataLayer.fetchOptions().catch(e => (console.error('options fail', e), null)),
    DataLayer.fetchBGTC().catch(e => (console.error('BGTC fail', e), null)),
    DataLayer.fetchFunding().catch(e => (console.error('funding fail', e), null)),
    fetchNoctuaExport(),
  ]);
  Object.assign(state, { price, hourly, daily, fg, options, BGTC, funding, noctuaExport });
  // Recompute derived values from this refresh only, including failures.
  Object.assign(state, { hv20: null, atmInfo: null, regime: null, retailPlan: null, ranger: null });
  renderNoctuaExport(noctuaExport);

  state.news = await DataLayer.fetchNewsSentiment().catch(e => (console.error('news fail', e), null));

  if (state.daily?.length >= 21) state.hv20 = DataLayer.computeHV20(state.daily);
  if (state.options && state.price) state.atmInfo = DataLayer.findAtmIv(state.options, state.price.price);
  if (state.atmInfo && state.hv20) state.regime = DataLayer.classifyRegime(state.atmInfo.atmIv, state.hv20.annualised);
  state.session = DataLayer.computeSessionContext();
  if (state.daily?.length && state.price) state.ranger = DataLayer.computeRanger(state.daily, state.fg, state.regime?.ratio);
  state.sentiment = DataLayer.computeSentiment(state.news, state.BGTC, state.fg, state.regime);

  if (state.price && state.options && state.atmInfo && state.hv20 && state.regime && state.BGTC) {
    state.retailPlan = DataLayer.buildRetailPlan({
      price:          state.price.price,
      options:        state.options,
      atmInfo:        state.atmInfo,
      hv20:           state.hv20,
      BGTCUpside:     state.BGTC.upside,
      regime:         state.regime,
      shortLots:      parseInt(document.getElementById('rpLots')?.value) || 60,
      touchThreshold: parseFloat(document.getElementById('rpTouch')?.value || '0.10'),
      safetyFactor:   parseFloat(document.getElementById('rpSafety')?.value || '1.15'),
    });
  }

  state.decision = DataLayer.buildDecision({
    price: state.price, hv20: state.hv20, regime: state.regime, BGTC: state.BGTC,
    retailPlan: state.retailPlan, session: state.session, funding: state.funding,
    sentiment: state.sentiment,
  });

  UI.updateHero(state.decision);
  UI.updatePulseStrip(state);
  UI.updateBGTCBadge(state.BGTC);
  UI.updateSessionRibbon(state.session);
  UI.updateRegimeDial(state.regime, state.hv20, state.atmInfo);
  UI.updateRetailPlan(state.retailPlan, state.price?.price, state.hv20, state.regime, state.atmInfo);
  UI.updateOddsTable(DataLayer.nextDayMoveOdds(state.regime?.ratio), state.hv20, state.price?.price);
  UI.updateBGTCCard(state.BGTC);

  if (state.ranger && state.price) {
    UI.updateRanger(state.ranger, state.price.price);
    const { callStrike, putStrike } = UI.computeStrikes(state.price.price, state.ranger, state.BGTC?.upside || 50);
    UI.renderRangeVisual(state.price.price, putStrike, callStrike);
  }

  if (state.hourly?.length) Charts.renderPriceChart(state.hourly);

  UI.updateSignals(state);
  UI.updateNewsFeed(state.news);

  // Fase 4 checklist (checklist-upgrade-pro-btc-desk.md): jaring pengaman
  // skeleton shimmer. Sebagian besar field sudah berhenti berkedip sendiri-
  // sendiri lewat set()/setH()/animateValue() di ui.js begitu menerima nilai
  // pertamanya, tapi field yang datanya tetap null pada load pertama (mis.
  // API sumbernya gagal) tidak akan pernah memanggil salah satu dari itu --
  // clearSkeletons() di sini melepas sisa class "skel" apa pun begitu satu
  // putaran refresh selesai, supaya tidak ada placeholder yang shimmer
  // selamanya. Aman dipanggil berulang (tidak melakukan apa-apa kalau
  // sudah tidak ada elemen ".skel" tersisa).
  if (typeof clearSkeletons === 'function') clearSkeletons();

  console.log('[v4] refreshAll done', {
    price: state.price?.price,
    BGTC: state.BGTC ? `${state.BGTC.upside}/${state.BGTC.volAmp} (${state.BGTC.freshness})` : 'null',
    hv20: state.hv20?.annualised?.toFixed(1),
    regime: state.regime?.label,
    verdict: state.decision?.verdict,
  });
}

async function refreshPrice() {
  const price = await DataLayer.fetchPrice();
  if (!price) return;
  state.price = price;
  UI.updatePulseStrip(state);
  UI.updateClock();
  if (state.ranger) {
    const { callStrike, putStrike } = UI.computeStrikes(price.price, state.ranger, state.BGTC?.upside || 50);
    UI.renderRangeVisual(price.price, putStrike, callStrike);
  }
}

let sliderDebounce = null;
function onRetailSliderChange() {
  clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(doRetailSliderChange, 80);
}

function doRetailSliderChange() {
  if (!state.price || !state.options || !state.atmInfo || !state.hv20 || !state.regime || !state.BGTC) return;
  state.retailPlan = DataLayer.buildRetailPlan({
    price:          state.price.price,
    options:        state.options,
    atmInfo:        state.atmInfo,
    hv20:           state.hv20,
    BGTCUpside:     state.BGTC.upside,
    regime:         state.regime,
    shortLots:      parseInt(document.getElementById('rpLots')?.value) || 60,
    touchThreshold: parseFloat(document.getElementById('rpTouch')?.value || '0.10'),
    safetyFactor:   parseFloat(document.getElementById('rpSafety')?.value || '1.15'),
  });
  state.decision = DataLayer.buildDecision({
    price: state.price, hv20: state.hv20, regime: state.regime, BGTC: state.BGTC,
    retailPlan: state.retailPlan, session: state.session, funding: state.funding,
    sentiment: state.sentiment,
  });
  UI.updateHero(state.decision);
  UI.updateRetailPlan(state.retailPlan, state.price.price, state.hv20, state.regime, state.atmInfo);
}

function startLoops() {
  setInterval(refreshPrice, 60_000);
  setInterval(refreshAll,   30 * 60_000);
  setInterval(UI.updateClock, 10_000);
}

(async function boot() {
  console.log('[v4] Booting BGTC/HV20 Retail desk\u2026');
  UI.updateClock();
  await refreshAll();
  startLoops();
  console.log('[v4] Ready \u00b7 price 60s \u00b7 full 30m');
})();

/* NOCTUA DATA EXPLORER - client-side subset export.
 * The dashboard keeps the full CSV download on-demand only. Range filtering
 * happens locally after an explicit SCAN, so normal refreshes stay lightweight.
 */
function initNoctuaExplorer() {
  if (document.getElementById('noctuaExplorer')) return;
  const anchor = document.querySelector('.noctua-export');
  if (!anchor) return;

  const DASH = '\\u2014';
  const wrap = document.createElement('section');
  wrap.id = 'noctuaExplorer';
  wrap.className = 'noctua-export';
  wrap.style.cssText = 'margin-top:12px;padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--surface);box-shadow:var(--shadow-sm)';
  wrap.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px">' +
      '<div><div style="font-size:13px;font-weight:700">Data Explorer</div><div style="font-size:10px;color:var(--muted);margin-top:2px">NOCTUA hourly history &middot; pilih rentang lalu download CSV</div></div>' +
      '<span id="noctuaScanStatus" class="pill-sm">READY</span>' +
    '</div>' +
    '<div id="noctuaExplorerStats" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:12px">' +
      '<div class="kc-metric"><div class="kc-metric-l">Rows</div><div id="nxRows" class="kc-metric-v">&mdash;</div></div>' +
      '<div class="kc-metric"><div class="kc-metric-l">Range WIB</div><div id="nxRange" style="font-family:var(--font-mono);font-size:11px;font-weight:600;line-height:1.35">&mdash;</div></div>' +
      '<div class="kc-metric"><div class="kc-metric-l">Columns</div><div id="nxCols" class="kc-metric-v">&mdash;</div></div>' +
    '</div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' +
      '<button class="btn nx-preset" data-hours="24" type="button">1 HARI</button>' +
      '<button class="btn nx-preset" data-hours="168" type="button">7 HARI</button>' +
      '<button class="btn nx-preset" data-hours="336" type="button">14 HARI</button>' +
      '<button class="btn nx-preset" data-hours="720" type="button">30 HARI</button>' +
      '<button class="btn nx-preset" data-hours="2160" type="button">90 HARI</button>' +
      '<button class="btn nx-preset" data-hours="8760" type="button">1 TAHUN</button>' +
      '<button class="btn nx-preset" data-custom="1" type="button">CUSTOM</button>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end">' +
      '<label style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">Mulai WIB<input id="nxFrom" type="datetime-local" style="display:block;width:100%;margin-top:5px;padding:9px;border-radius:7px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font:12px var(--font-mono)"></label>' +
      '<label style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">Sampai WIB<input id="nxTo" type="datetime-local" style="display:block;width:100%;margin-top:5px;padding:9px;border-radius:7px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font:12px var(--font-mono)"></label>' +
      '<div style="display:flex;gap:7px"><button id="nxScan" class="btn" type="button">SCAN DATASET</button><button id="nxExport" class="btn" type="button" disabled>DOWNLOAD CSV</button></div>' +
    '</div>' +
    '<div id="nxHint" style="font-size:10px;color:var(--muted);margin-top:9px">Scan membaca dataset CSV dari R2 sekali; setelah itu preset tidak perlu scan ulang.</div>';
  anchor.insertAdjacentElement('afterend', wrap);

  const scanBtn = document.getElementById('nxScan');
  const exportBtn = document.getElementById('nxExport');
  const fromEl = document.getElementById('nxFrom');
  const toEl = document.getElementById('nxTo');
  const statusEl = document.getElementById('noctuaScanStatus');
  const hintEl = document.getElementById('nxHint');
  const presetBtns = [...wrap.querySelectorAll('.nx-preset')];
  let dataset = null;

  const csvLine = (line) => {
    const out = []; let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; }
      else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur); return out;
  };
  const esc = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

  // HTML datetime-local has no timezone. These helpers deliberately interpret
  // the UI value as Asia/Jakarta (WIB), independent of the device timezone.
  const toWibInput = iso => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const w = new Date(d.getTime() + 7 * 3600_000);
    return w.toISOString().slice(0, 16);
  };
  const parseWibInput = value => {
    const m = String(value || '').match(/^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})$/);
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 7 * 3600_000;
  };
  const fmtWib = iso => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return DASH;
    const w = new Date(d.getTime() + 7 * 3600_000);
    return w.toISOString().replace('T', ' ').replace('.000Z', ' WIB');
  };
  const setPresetActive = active => {
    presetBtns.forEach(b => {
      const on = b === active;
      b.style.borderColor = on ? 'var(--accent)' : '';
      b.style.color = on ? 'var(--accent)' : '';
    });
  };

  function applyPreset(hours, activeBtn) {
    if (!dataset?.rows?.length) return;
    const latest = dataset.rows[dataset.rows.length - 1].t;
    const earliest = dataset.rows[0].t;
    const from = Math.max(earliest, latest - hours * 3600_000);
    fromEl.value = toWibInput(from);
    toEl.value = toWibInput(latest);
    setPresetActive(activeBtn);
    hintEl.textContent = 'Rentang ' + (hours >= 8760 ? '1 tahun' : hours + ' jam') + ' WIB siap di-download.';
  }

  scanBtn.addEventListener('click', async () => {
    if (dataset) { hintEl.textContent = 'Dataset sudah di-scan; pilih rentang lalu download.'; return; }
    scanBtn.disabled = true; statusEl.className = 'pill-sm warn'; statusEl.textContent = 'SCANNING'; hintEl.textContent = 'Mengambil CSV dari R2...';
    try {
      const res = await fetch('/api/noctua/download?format=csv', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const lines = text.replace(/^\\uFEFF/, '').trim().split(/\\r?\\n/);
      if (lines.length < 2) throw new Error('CSV kosong');
      const headers = csvLine(lines[0]);
      const tsIndex = headers.indexOf('hour_ts');
      if (tsIndex < 0) throw new Error('Kolom hour_ts tidak ditemukan');
      const rows = []; let first = '', last = '';
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cells = csvLine(lines[i]); const ts = cells[tsIndex];
        const t = Date.parse(ts); if (Number.isNaN(t)) continue;
        rows.push({ cells, t });
      }
      rows.sort((a, b) => a.t - b.t);
      if (!rows.length) throw new Error('Tidak ada timestamp valid');
      first = new Date(rows[0].t).toISOString();
      last = new Date(rows[rows.length - 1].t).toISOString();
      dataset = { headers, rows };
      document.getElementById('nxRows').textContent = rows.length.toLocaleString('en-US');
      document.getElementById('nxRange').textContent = fmtWib(first) + ' \u2192 ' + fmtWib(last);
      document.getElementById('nxCols').textContent = headers.length;
      statusEl.className = 'pill-sm ok'; statusEl.textContent = 'SCANNED'; exportBtn.disabled = false;
      applyPreset(168, presetBtns.find(b => b.dataset.hours === '168'));
      hintEl.textContent = 'Dataset siap. Pilih preset atau CUSTOM, lalu DOWNLOAD CSV.';
    } catch (e) {
      statusEl.className = 'pill-sm err'; statusEl.textContent = 'ERROR'; hintEl.textContent = 'Scan gagal: ' + e.message;
    } finally { scanBtn.disabled = false; }
  });

  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (!dataset) {
        hintEl.textContent = 'Scan dataset terlebih dahulu.';
        return;
      }
      if (btn.dataset.custom) {
        setPresetActive(btn);
        hintEl.textContent = 'Masukkan tanggal mulai dan akhir dalam WIB, lalu DOWNLOAD CSV.';
        return;
      }
      applyPreset(Number(btn.dataset.hours), btn);
    });
  });

  exportBtn.addEventListener('click', () => {
    if (!dataset) return;
    const from = parseWibInput(fromEl.value);
    const to = parseWibInput(toEl.value);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      hintEl.textContent = 'Rentang WIB tidak valid.';
      return;
    }
    const selected = dataset.rows.filter(r => r.t >= from && r.t <= to);
    if (!selected.length) {
      hintEl.textContent = 'Tidak ada data pada rentang WIB tersebut.';
      return;
    }
    const csv = [dataset.headers.map(esc).join(','), ...selected.map(r => r.cells.map(esc).join(','))].join('\n') + '\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'noctua_' + fromEl.value.replace(/[:T]/g, '-') + '_to_' + toEl.value.replace(/[:T]/g, '-') + '_WIB.csv';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    hintEl.textContent = 'Download selesai: ' + selected.length.toLocaleString('en-US') + ' row (WIB).';
  });
}

setTimeout(initNoctuaExplorer, 0);
setTimeout(initNoctuaExplorer, 0);
