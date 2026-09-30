/**
 * charts-page.js
 * =====================================================================
 * Halaman grafik (charts.html). Menampilkan semua data yang sudah ada:
 *   - Harga 48J + harian & HV20   -> DataLayer.fetchHourly/fetchDaily (Worker + cache)
 *   - NOCTUA barrier & safe levels -> ./data/noctua.json
 *   - Takut & Serakah              -> ./data/fg.json
 *   - Musiman volatilitas          -> ./data/vol_seasonality.json
 *
 * Tiap grafik dirender independen (Promise.allSettled): kalau satu sumber
 * gagal, hanya kartu itu yang menampilkan pesan kosong, sisanya tetap jalan.
 * Semua teks dari data ditulis lewat textContent (tanpa innerHTML).
 */
const ChartsPage = (() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const inst = {};
  const C = {};
  const GRID = 'rgba(255,255,255,0.05)';

  function readPalette() {
    const s = getComputedStyle(document.documentElement);
    const g = (n, f) => s.getPropertyValue(n).trim() || f;
    C.accent = g('--accent', '#d1a350');
    C.cyan   = g('--cyan',   '#4fb8ac');
    C.green  = g('--green',  '#35c46a');
    C.red    = g('--red',    '#e6483f');
    C.amber  = g('--amber',  '#e8973a');
    C.muted  = g('--muted',  '#71717a');
    Chart.defaults.color = C.muted;
    Chart.defaults.borderColor = GRID;
    Chart.defaults.font.family = g('--font-mono', 'monospace');
    Chart.defaults.font.size = 10;
  }

  // '#rrggbb' + alpha -> '#rrggbbaa'; non-hex colours pass through unchanged.
  const tint = (c, a) => /^#[0-9a-f]{6}$/i.test(c)
    ? c + Math.round(a * 255).toString(16).padStart(2, '0')
    : c;

  function mk(id, cfg) {
    if (inst[id]) { inst[id].destroy(); delete inst[id]; }
    const canvas = $(id);
    if (!canvas) return;
    inst[id] = new Chart(canvas, cfg);
  }

  function setEmpty(boxId, msg) {
    const box = $(boxId);
    if (!box) return;
    box.classList.add('is-empty');
    box.setAttribute('data-msg', msg);
  }
  function clearEmpty(boxId) {
    const box = $(boxId);
    if (!box) return;
    box.classList.remove('is-empty');
    box.removeAttribute('data-msg');
  }

  async function loadJson(name) {
    const r = await fetch(`./data/${name}.json?_=${Date.now()}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`${name}.json: HTTP ${r.status}`);
    return r.json();
  }

  const baseOpts = extra => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 600, easing: 'easeOutQuart' },
    ...extra,
  });

  const fmtUsd = v => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const fmtK   = v => '$' + (v / 1000).toFixed(0) + 'K';
  const fmtPct = (v, d = 1) => Number(v).toFixed(d) + '%';

  // ---------------------------------------------------------------- PRICE
  async function renderHourly() {
    const data = await DataLayer.fetchHourly();
    const rows = (Array.isArray(data) ? data : []).slice(-48).filter(c => c && c.c != null);
    if (!rows.length) return setEmpty('boxHourly', 'Data harga per jam belum tersedia.');
    clearEmpty('boxHourly');
    const labels = rows.map(c => new Date(c.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    mk('cHourly', {
      type: 'line',
      data: { labels, datasets: [{
        label: 'BTC/USDT 1J', data: rows.map(c => c.c),
        borderColor: C.cyan, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 12,
        tension: 0.3, fill: true, backgroundColor: tint(C.cyan, 0.10),
      }] },
      options: baseOpts({
        interaction: { mode: 'index', axis: 'x', intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtUsd(c.parsed.y) } } },
        scales: {
          x: { ticks: { maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } },
          y: { ticks: { callback: fmtK } },
        },
      }),
    });
  }

  async function renderDaily() {
    const data = await DataLayer.fetchDaily();
    const all = (Array.isArray(data) ? data : []).filter(c => c && c.c != null);
    if (all.length < 2) return setEmpty('boxDaily', 'Data harga harian belum tersedia.');
    clearEmpty('boxDaily');
    const hvMap = new Map(DataLayer.computeHV20Series(all).map(p => [p.t, p.hv20]));
    const rows = all.slice(-120);
    const labels = rows.map(c => new Date(c.t).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }));
    const hasHv = rows.some(c => hvMap.has(c.t));
    const datasets = [{
      label: 'Penutupan', data: rows.map(c => c.c), yAxisID: 'y',
      borderColor: C.accent, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 10,
      tension: 0.25, fill: true, backgroundColor: tint(C.accent, 0.08),
    }];
    if (hasHv) datasets.push({
      label: 'HV20 (%)', data: rows.map(c => hvMap.has(c.t) ? hvMap.get(c.t) : null), yAxisID: 'y2',
      borderColor: C.cyan, borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0.25, spanGaps: true,
    });
    mk('cDaily', {
      type: 'line',
      data: { labels, datasets },
      options: baseOpts({
        interaction: { mode: 'index', axis: 'x', intersect: false },
        plugins: {
          legend: { display: hasHv, labels: { boxWidth: 10, boxHeight: 2 } },
          tooltip: { callbacks: { label: c => c.dataset.yAxisID === 'y2'
            ? `HV20: ${fmtPct(c.parsed.y)}` : `Close: ${fmtUsd(c.parsed.y)}` } },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } },
          y: { position: 'left', ticks: { callback: fmtK } },
          y2: { position: 'right', display: hasHv, grid: { drawOnChartArea: false }, ticks: { callback: v => v + '%' } },
        },
      }),
    });
  }

  // --------------------------------------------------------------- NOCTUA
  function renderNoctua(n) {
    $('noctuaTag').textContent = `${n.model || 'NOCTUA'} · horizon ${n.H_hours ?? '?'}j · anchor ${String(n.anchor_utc || '').slice(0, 16)} UTC`;

    const up = n.barrier_curves?.up || [];
    const dn = n.barrier_curves?.dn || [];
    if (up.length && dn.length) {
      clearEmpty('boxBarrier');
      const labels = up.map(p => '±' + Math.abs(p.pct) + '%');
      mk('cBarrier', {
        type: 'line',
        data: { labels, datasets: [
          { label: 'Naik (call)', data: up.map(p => p.touch_prob * 100), borderColor: C.green, backgroundColor: tint(C.green, 0.10), borderWidth: 2, pointRadius: 3, tension: 0.3, fill: true },
          { label: 'Turun (put)', data: dn.map(p => p.touch_prob * 100), borderColor: C.red, backgroundColor: tint(C.red, 0.10), borderWidth: 2, pointRadius: 3, tension: 0.3, fill: true },
        ] },
        options: baseOpts({
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { boxWidth: 10, boxHeight: 2 } },
            tooltip: { callbacks: {
              label: c => {
                const src = c.datasetIndex === 0 ? up : dn;
                const p = src[c.dataIndex];
                return `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%  (${fmtUsd(p.price)})`;
              },
            } },
          },
          scales: {
            x: { title: { display: true, text: 'jarak dari spot' }, grid: { display: false } },
            y: { min: 0, max: 100, title: { display: true, text: 'P(sentuh)' }, ticks: { callback: v => v + '%' } },
          },
        }),
      });
    } else {
      setEmpty('boxBarrier', 'barrier_curves tidak ada di payload NOCTUA.');
    }

    const safe = n.safe_levels || [];
    if (safe.length) {
      clearEmpty('boxSafe');
      mk('cSafe', {
        type: 'bar',
        data: { labels: safe.map(s => 'α ' + (s.alpha * 100).toFixed(0) + '%'), datasets: [
          { label: 'Level call (%)', data: safe.map(s => s.call_pct), backgroundColor: tint(C.green, 0.7), borderRadius: 4 },
          { label: 'Level put (%)',  data: safe.map(s => s.put_pct),  backgroundColor: tint(C.red, 0.7),   borderRadius: 4 },
        ] },
        options: baseOpts({
          plugins: {
            legend: { labels: { boxWidth: 10, boxHeight: 8 } },
            tooltip: { callbacks: {
              label: c => {
                const s = safe[c.dataIndex];
                const price = c.datasetIndex === 0 ? s.call_strike : s.put_strike;
                return `${c.dataset.label}: ${c.parsed.y.toFixed(2)}%  (${fmtUsd(price)})`;
              },
            } },
          },
          scales: {
            x: { grid: { display: false } },
            y: { ticks: { callback: v => v + '%' } },
          },
        }),
      });
    } else {
      setEmpty('boxSafe', 'safe_levels tidak ada di payload NOCTUA.');
    }

    // summary strip
    if (n.spot != null) {
      $('sSpot').textContent = fmtUsd(n.spot);
      $('sSpotSub').textContent = n.source || '—';
    }
    if (n.sigma_window_pct != null) {
      $('sSigma').textContent = fmtPct(n.sigma_window_pct, 2);
      $('sSigmaSub').textContent = n.sigma_annualized_pct != null
        ? `tahunan ${fmtPct(n.sigma_annualized_pct)} · RV trailing ${fmtPct(n.trailing_rv_pct, 2)}` : '—';
    }
    if (n.p_vol_amplify != null) {
      const p = n.p_vol_amplify * 100;
      const el = $('sAmp');
      el.textContent = fmtPct(p, 0);
      el.style.color = p >= 70 ? C.red : p >= 55 ? C.amber : C.green;
    }
  }

  // ------------------------------------------------------------ FEAR&GREED
  function fgZone(v) {
    if (v < 25) return { c: C.red,   t: 'Extreme Fear' };
    if (v < 45) return { c: C.amber, t: 'Fear' };
    if (v < 55) return { c: C.muted, t: 'Neutral' };
    if (v < 75) return { c: C.cyan,  t: 'Greed' };
    return { c: C.green, t: 'Extreme Greed' };
  }

  function renderFg(fg) {
    const v = Number(fg.value);
    if (!Number.isFinite(v)) return;
    const z = fgZone(v);
    $('fgNum').textContent = String(v);
    $('fgNum').style.color = z.c;
    $('fgLbl').textContent = fg.label || z.t;
    $('sFg').textContent = String(v);
    $('sFg').style.color = z.c;
    $('sFgSub').textContent = fg.label || z.t;

    if (fg.prev != null) {
      const d = v - Number(fg.prev);
      $('fgPrev').textContent = String(fg.prev);
      $('fgDelta').textContent = (d > 0 ? '+' : '') + d;
      $('fgDelta').style.color = d > 0 ? C.green : d < 0 ? C.red : C.muted;
    }
    const ts = fg.srcTs || fg.ts;
    if (ts) $('fgTs').textContent = 'Sumber: ' + new Date(ts).toLocaleString('id-ID');

    mk('cFg', {
      type: 'doughnut',
      data: { datasets: [{ data: [v, 100 - v], backgroundColor: [z.c, 'rgba(255,255,255,0.06)'], borderWidth: 0 }] },
      options: baseOpts({
        rotation: -90, circumference: 180, cutout: '74%',
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
      }),
    });
  }

  // ---------------------------------------------------------- SEASONALITY
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  // dowDailyRv: indeks 0..6 = Senin..Minggu (konvensi pandas; dua nilai
  // terendah ada di indeks 5-6 = Sabtu/Minggu, sejalan dengan weekendVolRatio).
  const DOW = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

  function barChart(id, labels, values, colors, unit, extra = {}) {
    mk(id, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 3 }] },
      options: baseOpts({
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.parsed.y.toFixed(1) + unit } } },
        scales: { x: { grid: { display: false }, ticks: extra.xTicks || {} }, y: { beginAtZero: true, ticks: { callback: v => v + unit } } },
      }),
    });
  }

  function renderSeason(s) {
    $('seasonTag').textContent = s.built ? `dibangun ${s.built}` : '—';

    const years = Object.keys(s.yearlyRv || {}).sort();
    if (years.length) {
      clearEmpty('boxYear');
      const last = years[years.length - 1];
      barChart('cYear', years, years.map(y => s.yearlyRv[y]),
        years.map(y => y === last ? C.accent : tint(C.accent, 0.45)), '%');
      if (s.eras) {
        $('eraNote').textContent =
          `Rata-rata 2020–2023: ${s.eras.preEtf2020_2023}% · pasca-ETF: ${s.eras.postEtf}%. Tahun terakhir ditandai (parsial).`;
      }
    } else setEmpty('boxYear', 'yearlyRv tidak tersedia.');

    if (s.monthRv) {
      clearEmpty('boxMonth');
      const vals = MONTHS.map((_, i) => s.monthRv[String(i + 1)] ?? null);
      const max = Math.max(...vals.filter(v => v != null));
      const min = Math.min(...vals.filter(v => v != null));
      barChart('cMonth', MONTHS, vals,
        vals.map(v => v === max ? C.red : v === min ? C.cyan : tint(C.accent, 0.6)), '%');
    } else setEmpty('boxMonth', 'monthRv tidak tersedia.');

    if (s.dowDailyRv) {
      clearEmpty('boxDow');
      const vals = DOW.map((_, i) => s.dowDailyRv[String(i)] ?? null);
      barChart('cDow', DOW, vals, vals.map((_, i) => i >= 5 ? C.cyan : tint(C.accent, 0.6)), '%');
      if (s.weekendVolRatio != null) {
        $('dowNote').textContent = `Akhir pekan ≈ ${Math.round(s.weekendVolRatio * 100)}% dari vol hari kerja.`;
      }
    } else setEmpty('boxDow', 'dowDailyRv tidak tersedia.');

    if (s.hourVolBpsPostEtf) {
      clearEmpty('boxHour');
      const hours = Array.from({ length: 24 }, (_, i) => i);
      const quiet = new Set(s.quietHoursUtc || []);
      const loud = new Set(s.loudHoursUtc || []);
      barChart('cHour', hours.map(h => String(h).padStart(2, '0')),
        hours.map(h => s.hourVolBpsPostEtf[String(h)] ?? null),
        hours.map(h => loud.has(h) ? C.red : quiet.has(h) ? C.cyan : tint(C.accent, 0.6)), ' bps',
        { xTicks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } });
    } else setEmpty('boxHour', 'hourVolBpsPostEtf tidak tersedia.');

    if (s.current30dRv != null) {
      $('sRv').textContent = fmtPct(s.current30dRv);
      $('sRvSub').textContent = s.current30dPctilePostEtf != null
        ? `persentil ke-${s.current30dPctilePostEtf} (pasca-ETF)` : '—';
    }
  }

  // ------------------------------------------------------------------ MAIN
  async function loadAll() {
    const status = $('status');
    status.textContent = 'memuat…';
    const tasks = [
      ['harga 1J',   renderHourly()],
      ['harga 1H',   renderDaily()],
      ['NOCTUA',     loadJson('noctua').then(renderNoctua)],
      ['F&G',        loadJson('fg').then(renderFg)],
      ['musiman',    loadJson('vol_seasonality').then(renderSeason)],
    ];
    const res = await Promise.allSettled(tasks.map(t => t[1]));
    const failed = [];
    res.forEach((r, i) => {
      if (r.status === 'rejected') {
        failed.push(tasks[i][0]);
        console.error('[charts]', tasks[i][0], r.reason);
      }
    });

    // Sumber yang gagal dimuat -> kartu terkait tampil kosong dengan pesan.
    const boxesFor = {
      'harga 1J': ['boxHourly'], 'harga 1H': ['boxDaily'],
      'NOCTUA': ['boxBarrier', 'boxSafe'],
      'musiman': ['boxYear', 'boxMonth', 'boxDow', 'boxHour'],
    };
    failed.forEach(name => (boxesFor[name] || []).forEach(b => setEmpty(b, 'Gagal memuat data. Coba segarkan.')));

    const t = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    status.textContent = failed.length ? `sebagian gagal · ${t}` : `diperbarui ${t}`;
  }

  function init() {
    if (typeof Chart === 'undefined') {
      $('status').textContent = 'Chart.js gagal dimuat';
      return;
    }
    readPalette();
    $('btnRefresh').addEventListener('click', loadAll);
    loadAll();
  }

  return { init, loadAll };
})();

document.addEventListener('DOMContentLoaded', ChartsPage.init);
