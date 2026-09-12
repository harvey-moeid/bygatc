/**
 * ui.js (v4.1) — decision-focused UI bindings
 * =====================================================================
 * Merender hero decision card, pulse strip, regime dial, session ribbon,
 * retail plan, odds table, BGTC card, signal list, dan rate limit grid.
 *
 * v4.1: Tambah tampilan `BGTC.p_up_raw` (probabilitas arah mentah dari
 *   model, sebelum dipin ke 50.0 -- lihat model/serve/predict.py::to_legacy)
 *   di BGTC card dan signal list, sebagai INFO SAJA. Tidak menyentuh
 *   buildDecision()/buildRetailPlan()/computeSentiment() di data.js --
 *   semua keputusan trade tetap pakai BGTC.upside (pinned 50), sesuai
 *   alasan yang didokumentasikan di docs/TRADE_FLOW.md §3 (walk-forward
 *   log-loss 0.6941 vs 0.6931 coin flip -- tidak ada validated directional
 *   skill di horizon ini).
 *
 * v4.2 (security): updateBGTCCard() dulu menaruh BGTC.sourceTs, BGTC.proxy,
 *   dan BGTC.freshness langsung ke innerHTML tanpa escape() -- beda dari
 *   hampir semua tempat lain di file ini. BGTC berasal dari model pipeline
 *   tepercaya lewat POST /api/noctua/push, tapi kalau NOCTUA_PUSH_SECRET
 *   pernah bocor ini jadi jalur stored-XSS langsung. Sekarang ketiganya
 *   di-escape juga. updateNewsFeed() juga sekarang menolak me-render
 *   item.url sebagai <a href> kecuali skemanya http/https -- item.url
 *   datang dari feed eksternal (CryptoPanic/GDELT/Exa) yang tidak
 *   terautentikasi, dan escape() saja tidak menghalangi `javascript:...`
 *   sebagai href yang bisa diklik.
 */
const UI = (() => {
  const fmt  = (n, d = 0) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  const fmtS = n => Math.abs(n) >= 1e6 ? '$' + fmt(n/1e6, 1) + 'M'
                 : Math.abs(n) >= 1e3 ? '$' + fmt(n/1e3, 1) + 'K'
                 : '$' + fmt(n, 0);
  const pct  = (n, d = 2) => (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
  const $    = id => document.getElementById(id);
  const set  = (id, t) => { const e = $(id); if (e) e.textContent = t; };
  const setH = (id, h) => { const e = $(id); if (e) e.innerHTML   = h; };

  // Premium inline SVG icon set (replaces emoji glyphs across the UI)
  const ICONS = {
    check:   '<svg class="ic ic-check" viewBox="0 0 20 20" fill="none" width="14" height="14"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M6 10.5l2.5 2.5L14 7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warning: '<svg class="ic ic-warn" viewBox="0 0 20 20" fill="none" width="14" height="14"><path d="M10 2.5l8.5 14.7H1.5L10 2.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="14.6" r="0.9" fill="currentColor"/></svg>',
    dash:    '<svg class="ic ic-dash" viewBox="0 0 20 20" fill="none" width="14" height="14"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M6 10h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    star:    '<svg class="ic ic-star" viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path d="M10 1.5l2.47 5.53 6.03.57-4.55 4.03 1.33 5.9L10 14.6l-5.28 2.93 1.33-5.9L1.5 7.6l6.03-.57L10 1.5z"/></svg>',
    clock:   '<svg class="ic ic-clock" viewBox="0 0 20 20" fill="none" width="12" height="12"><circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 5.5V10l3 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross:   '<svg class="ic ic-cross" viewBox="0 0 20 20" fill="none" width="12" height="12"><circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.5"/><path d="M7 7l6 6M13 7l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  };

  function updateClock() {
    const ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    set('clockIST', ist.split(',').pop().trim().slice(0,8) + ' IST');
    set('footerTs', 'Diperbarui ' + new Date().toLocaleTimeString());
  }

  // —— BGTC BADGE (header) —————————————————————————————————————————————————————————————————————————————————————
  function updateBGTCBadge(BGTC) {
    const el = $('BGTCBadge');
    if (!el) return;
    if (!BGTC) { el.className = 'pill-sm err'; el.textContent = 'BGTC: offline'; return; }
    const cls = BGTC.freshness === 'fresh'   ? 'ok'
              : BGTC.freshness === 'recent'  ? 'ok'
              : BGTC.freshness === 'stale'   ? 'warn'
              :                                   'err';
    const age = BGTC.ageHrs == null ? '?' : BGTC.ageHrs < 1 ? '<1j' : BGTC.ageHrs.toFixed(0)+'j';
    el.className = 'pill-sm ' + cls;
    el.textContent = `BGTC ${BGTC.upside.toFixed(1)}% · ${age} lalu`;
  }

  function updateHero(decision) {
    if (!decision) return;
    const card = $('heroCard');
    if (card) card.className = 'hero ' + (decision.verdictClass || 'nt');

    const icon = decision.verdictClass === 'go'  ? ICONS.check
               : decision.verdictClass === 'cau' ? ICONS.warning
               :                                    ICONS.dash;
    setH('heroIcon', icon);
    set('heroVerdict', decision.verdict || '—');
    set('heroSub', decision.tradeStructure
      ? `Bias ${decision.direction?.toUpperCase() || 'NETRAL'} · ${decision.reasons.length} sinyal selaras, ${decision.blockers.length} pemblokir`
      : decision.blockers[0] || 'Mengevaluasi semua sinyal…');
    set('heroConf', Math.round(decision.confidence) + '%');
    const bar = $('heroConfBar');
    if (bar) {
      const color = decision.verdictClass === 'go' ? 'var(--green)'
                  : decision.verdictClass === 'cau' ? 'var(--amber)' : 'var(--red)';
      bar.style.background = color;
      bar.style.width = '0%';
      clearTimeout(bar._animTimer);
      bar._targetConf = decision.confidence;
      bar._animTimer = setTimeout(() => { bar.style.width = bar._targetConf + '%'; }, 120);
    }

    setH('heroReasons', (decision.reasons || []).map(r =>
      `<div class="hero-reason pos"><span class="hero-reason-dot"></span><span>${escape(r)}</span></div>`
    ).join('') || '<div style="font-size:11px;color:var(--muted);padding:4px 0">Belum ada.</div>');

    setH('heroBlockers', (decision.blockers || []).map(r =>
      `<div class="hero-reason neg"><span class="hero-reason-dot"></span><span>${escape(r)}</span></div>`
    ).join('') || '<div style="font-size:11px;color:var(--muted);padding:4px 0">Semua aman.</div>');

    const sb = $('heroStructure');
    if (decision.tradeStructure) {
      if (sb) sb.style.display = 'flex';
      set('heroStructText', decision.tradeStructure);
      set('heroStructSub', `Arah: ${decision.direction} · Keyakinan ${Math.round(decision.confidence)}%`);
    } else if (sb) sb.style.display = 'none';
  }

  function updatePulseStrip({ price, hv20, atmInfo, funding, fg, BGTC }) {
    if (price) {
      set('psPrice',  '$' + fmt(Math.round(price.price)));
      const chg = (price.change * 100);
      const chgEl = $('psChange');
      if (chgEl) {
        chgEl.textContent = (chg >= 0 ? '▲' : '▼') + ' ' + Math.abs(chg).toFixed(2) + '%';
        chgEl.style.color = chg >= 0 ? 'var(--green)' : 'var(--red)';
      }
      set('psHigh',    '$' + fmt(Math.round(price.high)));
      set('psHighPct', '+' + ((price.high - price.price) / price.price * 100).toFixed(2) + '% di atas');
      set('psLow',     '$' + fmt(Math.round(price.low)));
      set('psLowPct',  ((price.low - price.price) / price.price * 100).toFixed(2) + '% dari');
      set('psPriceSub', 'Binance · vol ' + fmtS(price.volUsd));
    }
    if (hv20) {
      set('psHv20',    hv20.annualised.toFixed(1) + '%');
      set('psHv20Sub', '1-hari: ' + hv20.oneDay.toFixed(2) + '%');
    }
    if (atmInfo) {
      set('psAtmIv',    atmInfo.atmIv.toFixed(1) + '%');
      set('psAtmIvSub', atmInfo.expiry + ' · ' + atmInfo.daysToExpiry.toFixed(1) + 'h');
    }
    if (funding) {
      const el = $('psFunding');
      if (el) {
        el.textContent = funding.ratePct.toFixed(4) + '%';
        el.className = 'pc-val ' + (funding.flag.includes('extreme') ? 'neg' : funding.flag === 'neutral' ? 'neu' : 'cyan');
      }
      set('psFundingSub', 'tah ' + funding.annualizedPct.toFixed(1) + '% · ' + funding.flag);
    }
    if (fg) {
      const el = $('psFg');
      if (el) {
        el.textContent = fg.value;
        el.className = 'pc-val ' + (fg.value < 30 ? 'neg' : fg.value < 55 ? 'neu' : 'pos');
      }
      set('psFgSub', fg.label);
    }
    if (BGTC) {
      const el = $('psBGTC');
      if (el) {
        el.textContent = BGTC.upside.toFixed(1) + '%';
        el.className = 'pc-val ' + (BGTC.upside < 45 ? 'neg' : BGTC.upside < 55 ? 'neu' : 'pos');
      }
      set('psBGTCSub', 'vol-amp ' + BGTC.volAmp.toFixed(1) + '%');
    }
  }

  function updateSessionRibbon(session) {
    if (!session) return;
    const phaseEl = $('srPhase');
    if (phaseEl) {
      phaseEl.textContent = session.phase;
      phaseEl.className = 'sr-phase ' + session.tier;
    }
    set('srAdvice', session.advice);
    set('srClock', 'IST ' + Math.floor(session.istHour) + ':' + String(Math.floor((session.istHour % 1) * 60)).padStart(2,'0'));

    const segs = [
      { w: 22.9, bg: 'rgba(96,165,250,0.15)',  lbl: '00—05:30' },
      { w: 12.5, bg: 'rgba(74,222,128,0.2)',   lbl: '05:30—08:30' },
      { w: 16.7, bg: 'rgba(74,222,128,0.5)',   lbl: ICONS.star + ' 08:30—12:30' },
      { w: 6.3,  bg: 'rgba(74,222,128,0.2)',   lbl: '12:30—14' },
      { w: 14.6, bg: 'rgba(251,191,36,0.25)',  lbl: '14—17:30' },
      { w: 4.2,  bg: 'rgba(248,113,113,0.35)', lbl: '17:30—18:30' },
      { w: 22.8, bg: 'rgba(248,113,113,0.25)', lbl: '18:30—00:00' },
    ];
    const nowPct = (session.istHour / 24) * 100;
    const wrap = $('srBarWrap');
    if (wrap) {
      let barHtml = '<div class="session-bar">';
      for (const s of segs) {
        barHtml += `<div class="session-seg" style="width:${s.w}%;background:${s.bg}">${s.lbl}</div>`;
      }
      barHtml += '</div>';
      barHtml += `<div style="position:relative;margin-top:-17px;height:14px;z-index:3;pointer-events:none"><div style="position:absolute;left:${nowPct}%;top:-3px;width:2px;height:26px;background:#fff;box-shadow:0 0 8px rgba(255,255,255,.5);transform:translateX(-50%)"></div><div style="position:absolute;left:${nowPct}%;top:-18px;font-size:9px;font-family:var(--font-mono);color:#fff;transform:translateX(-50%);background:var(--accent);padding:1px 4px;border-radius:3px">KINI</div></div>`;
      wrap.innerHTML = barHtml;
    }
  }

  function updateRegimeDial(regime, hv20, atmInfo) {
    if (!regime) return;
    set('rdRatio',  regime.ratio ? regime.ratio.toFixed(2) : '—');
    const lbl = $('rdLabel');
    if (lbl) {
      lbl.textContent = regime.label || '—';
      lbl.className = 'rd-label ' + regime.regime;
    }
    set('rdIvHv', atmInfo && hv20 ? `IV ${atmInfo.atmIv.toFixed(1)}% / HV20 ${hv20.annualised.toFixed(1)}%` : 'IV — / HV20 —');

    const arc = $('rdArc');
    if (arc && regime.ratio) {
      const clamped = Math.min(2.0, Math.max(0, regime.ratio));
      const frac = clamped / 2.0;
      const total = 157;
      arc.style.strokeDashoffset = total - (total * frac);
      const color = regime.regime === 'green' ? 'var(--green)'
                  : regime.regime === 'amber' ? 'var(--amber)'
                  : regime.regime === 'amber-dark' ? '#fb923c'
                  :                              'var(--red)';
      arc.style.stroke = color;
    }

    set('rdSize', (regime.sizing * 100).toFixed(0) + '%');
    set('rdSizeNote', regime.allowTrade ? `dari posisi dasar (${regime.label})` : 'Lewati hari ini');
  }

  function updateRetailPlan(plan, price, hv20, regime, atmInfo) {
    const body = $('retailBody');
    if (!body) return;

    const exp = $('retailExpiry');
    if (exp) exp.textContent = atmInfo ? 'Kedaluwarsa: ' + atmInfo.expiry : '—';

    if (!plan) {
      body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px">Menunggu harga / opsi / HV20…</div>`;
      return;
    }

    let html = '';

    if (!plan.ok) {
      html += `<div class="rc-warn red">
        <div class="rc-warn-title">${ICONS.cross} TIDAK TRADING hari ini</div>
        <div class="rc-warn-body">${escape(plan.reason)}</div>
      </div>`;
      if (plan.candidates?.length) {
        html += `<div style="font-size:10px;color:var(--muted);margin:10px 0 6px">Strike layak premium dan probabilitas sentuhnya:</div>`;
        html += `<table class="odds-table"><thead><tr><th>Strike</th><th>Jarak</th><th>Premium/lot</th><th>Prob. sentuh</th></tr></thead><tbody>` +
          plan.candidates.map(c => {
            const tp = c.touchProb ?? DataLayer.touchProbability(c.absDist, hv20?.oneDay);
            return `<tr><td>$${fmt(c.strike)}</td><td>${c.absDist?.toFixed(2)}%</td><td>$${fmt(c.premium, 2)}</td><td>${tp ? (tp*100).toFixed(0)+'%' : '—'}</td></tr>`;
          }).join('') + `</tbody></table>`;
      }
      body.innerHTML = html;
      return;
    }

    const netCreditClass = plan.netCredit > 0 ? 'pos' : 'neg';
    const distSafety = plan.shortDistancePct > 15 ? 'Sangat aman' : plan.shortDistancePct > 10 ? 'Aman' : 'Sedang';
    const kMultiplier = (plan.shortDistancePct / (hv20?.oneDay || 1));

    html += `<div class="rc-legs">
      <div class="leg go">
        <div class="leg-type">LEG 1 · Beli (long gamma)</div>
        <div class="leg-action">1× ATM $${fmt(plan.atmInfo.atmStrike)} STRADDLE</div>
        <div class="leg-detail">Biaya: <b>$${fmt(plan.straddleCost, 0)}</b> · ${plan.atmInfo.expiry} · ${plan.atmInfo.daysToExpiry.toFixed(1)}h</div>
      </div>
      <div class="leg go">
        <div class="leg-type">LEG 2 · Jual ${plan.shortLots}× (pembiayaan)</div>
        <div class="leg-action">${plan.shortLots}× $${fmt(plan.shortStrike)} ${plan.sellSide === 'P' ? 'PUTS' : 'CALLS'}</div>
        <div class="leg-detail">Premium/lot: <b>$${fmt(plan.shortPremiumPerLot, 2)}</b> · Total: <b>$${fmt(plan.totalShortPremium, 0)}</b></div>
      </div>
    </div>`;

    html += `<div class="rc-metrics">
      <div class="rcm"><div class="rcm-l">Jarak</div><div class="rcm-v">${plan.shortDistancePct.toFixed(2)}%</div><div class="rcm-s">${distSafety} · ${kMultiplier.toFixed(1)}× hv20_1h</div></div>
      <div class="rcm"><div class="rcm-l">Probabilitas sentuh</div><div class="rcm-v">${(plan.touchProb*100).toFixed(0)}%</div><div class="rcm-s">per backtest PDF</div></div>
      <div class="rcm"><div class="rcm-l">Kredit bersih</div><div class="rcm-v ${netCreditClass}">${plan.netCredit >= 0 ? '+' : ''}$${fmt(plan.netCredit, 0)}</div><div class="rcm-s">setelah pembiayaan</div></div>
      <div class="rcm"><div class="rcm-l">Req/lot</div><div class="rcm-v">$${plan.reqPremPerLot.toFixed(2)}</div><div class="rcm-s">×${((plan.shortPremiumPerLot/plan.reqPremPerLot)*100).toFixed(0)}% cakupan</div></div>
    </div>`;

    html += `<div class="rc-risk-note">
      ${ICONS.warning} <b>Risiko:</b> Short ${plan.shortLots}× tanpa batas adalah extreme-gamma. Jika BTC menyentuh $${fmt(plan.shortStrike)} (gerakan ${plan.shortDistancePct.toFixed(1)}%) wing akan jebol. Gunakan <b>strategy builder</b> Delta untuk menambah proteksi long murah 1—2× lebih jauh OTM dan batasi max loss ke &lt;10% ekuitas.
    </div>`;

    if (plan.alternatives?.length) {
      html += `<div style="font-size:10px;color:var(--muted);margin:12px 0 4px">Strike alternatif (juga valid, lebih dekat ke spot):</div>`;
      html += `<table class="odds-table"><thead><tr><th>Strike</th><th>Jarak</th><th>Premium</th><th>Sentuh</th><th>Kredit bersih</th></tr></thead><tbody>` +
        plan.alternatives.map(a => {
          const nc = (a.premium * plan.shortLots) - plan.straddleCost;
          return `<tr><td>$${fmt(a.strike)}</td><td>${a.absDist.toFixed(2)}%</td><td>$${fmt(a.premium,2)}</td><td>${(a.touchProb*100).toFixed(0)}%</td><td style="color:${nc>=0?'var(--green)':'var(--red)'}">$${fmt(nc, 0)}</td></tr>`;
        }).join('') + `</tbody></table>`;
    }

    body.innerHTML = html;
  }

  function updateOddsTable(odds, hv20, price) {
    set('oddsIntro', odds ? odds.description : 'Menunggu klasifikasi rezim…');
    const tbody = $('oddsBody');
    if (!tbody) return;
    if (!odds) { tbody.innerHTML = ''; return; }

    tbody.innerHTML = odds.odds.map(row => {
      const barW = Math.round(row.prob * 100);
      const dollarNote = hv20 && price && odds.regimeType === 'normal' && row.move.includes('×') ? (() => {
        const m = row.move.match(/([\d.]+)\s*×/);
        if (!m) return '';
        const k = parseFloat(m[1]);
        const band = (hv20.oneDay / 100) * price * k;
        return `<span style="color:var(--muted);font-size:10px"> (~±$${fmt(Math.round(band))})</span>`;
      })() : '';
      return `<tr>
        <td>${row.move}${dollarNote}</td>
        <td style="text-align:right">
          <span class="odds-bar" style="width:${barW * 1.8}px;background:${row.prob > 0.5 ? 'var(--green)' : row.prob > 0.2 ? 'var(--amber)' : 'var(--red)'}"></span>
          <b style="font-family:var(--font-mono)">${(row.prob*100).toFixed(0)}%</b>
        </td>
      </tr>`;
    }).join('');
  }

  // —— BGTC DETAIL CARD —————————————————————————————————————————————————————
  function updateBGTCCard(BGTC) {
    const body = $('BGTCCardBody');
    if (!body) return;
    if (!BGTC) { body.innerHTML = '<div style="font-size:11px;color:var(--muted)">Data BGTC tidak tersedia.</div>'; return; }
    const freshCls = BGTC.freshness === 'fresh' || BGTC.freshness === 'recent' ? 'fresh'
                  : BGTC.freshness === 'stale' ? 'stale' : 'very-stale';

    // Semua field mentah dari BGTC (datang lewat POST /api/noctua/push,
    // lihat routes/noctua.ts) di-escape sebelum masuk innerHTML -- termasuk
    // sourceTs, freshness, dan proxy, yang sebelumnya lolos tanpa escape().
    const sourceTsSafe  = escape(BGTC.sourceTs || 'tidak diketahui');
    const freshLabelSafe = escape(String(BGTC.freshness || 'unknown').toUpperCase());
    const proxySafe     = escape(BGTC.proxy || 'proxy');

    // Arah mentah model (P(naik) sebelum dipin ke 50.0). Info diagnostik saja --
    // sengaja TIDAK diberi warna hijau/merah seperti metrik di atas, supaya
    // tidak terlihat seperti sinyal yang bisa ditradingkan. Lihat
    // model/serve/predict.py::to_legacy() dan docs/TRADE_FLOW.md §3 untuk
    // alasan kenapa "upside" di atas dipin, bukan angka ini.
    const rawNote = BGTC.p_up_raw != null
      ? `<div style="font-size:10px;color:var(--muted);margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.06);line-height:1.6">
          <b style="color:#94a3b8">Arah mentah model:</b> ${BGTC.p_up_raw.toFixed(1)}% ·
          <span style="color:#f59e0b">belum tervalidasi</span> (log-loss walk-forward 0.6941 vs 0.6931 lempar koin) —
          info saja, <b>tidak</b> dipakai untuk strike atau verdict di atas. Lihat docs/TRADE_FLOW.md §3.
        </div>`
      : '';

    body.innerHTML = `
      <div class="kc-head">
        <div>
          <div class="kc-title">BTC/USDT · 24j ke depan</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px">
            Timestamp sumber: ${sourceTsSafe} ${BGTC.ageHrs != null ? `(${BGTC.ageHrs < 1 ? '<1' : BGTC.ageHrs.toFixed(0)}j lalu)` : ''}
          </div>
        </div>
        <span class="kc-fresh ${freshCls}">${freshLabelSafe}</span>
      </div>
      <div class="kc-row">
        <div class="kc-metric">
          <div class="kc-metric-l">Probabilitas naik</div>
          <div class="kc-metric-v" style="color:${BGTC.upside < 45 ? 'var(--red)' : BGTC.upside < 55 ? 'var(--amber)' : 'var(--green)'}">${BGTC.upside.toFixed(1)}%</div>
          <div class="kc-metric-s">${BGTC.upside < 45 ? 'Cenderung bearish' : BGTC.upside < 55 ? 'Netral' : 'Cenderung bullish'}</div>
        </div>
        <div class="kc-metric">
          <div class="kc-metric-l">Amplifikasi volatilitas</div>
          <div class="kc-metric-v" style="color:${BGTC.volAmp > 70 ? 'var(--red)' : BGTC.volAmp > 50 ? 'var(--amber)' : 'var(--green)'}">${BGTC.volAmp.toFixed(1)}%</div>
          <div class="kc-metric-s">${BGTC.volAmp > 70 ? 'Vol tinggi diperkirakan' : BGTC.volAmp > 50 ? 'Meningkat' : 'Tenang'}</div>
        </div>
      </div>
      ${rawNote}
      <div style="font-size:10px;color:var(--muted);margin-top:10px;line-height:1.5">
        Via ${proxySafe}. Model: NOCTUA-v2 · Konteks: 360j terakhir.
      </div>`;
  }

  function updateRanger(ranger, price) {
    set('rangerRaw',  ranger.raw.toFixed(2) + '%');
    set('rangerSafe', ranger.safe.toFixed(2) + '%');
    set('rangerAtr',  ranger.atr7.toFixed(2) + '%');
  }

  function renderRangeVisual(price, putStrike, callStrike) {
    const track = $('rangeTrack');
    if (!track || !putStrike || !callStrike) return;
    const minP = putStrike  * 0.984;
    const maxP = callStrike * 1.016;
    const range = maxP - minP;
    const p = v => ((v - minP) / range * 100).toFixed(2);
    const putPct  = p(putStrike), callPct = p(callStrike), curPct = p(price);

    const bearZ  = $('bearZ'), safeZ = $('safeZ'), bullZ = $('bullZ');
    const needle = $('needleEl');
    if (bearZ) { bearZ.style.left='0'; bearZ.style.width=putPct+'%'; bearZ.style.background='rgba(248,113,113,0.12)'; bearZ.style.border='1px solid rgba(248,113,113,0.25)'; bearZ.style.color='#f87171'; bearZ.textContent='BEAR'; }
    if (safeZ) { safeZ.style.left=putPct+'%'; safeZ.style.width=(callPct-putPct)+'%'; safeZ.style.background='rgba(74,222,128,0.08)'; safeZ.style.border='1px solid rgba(74,222,128,0.22)'; safeZ.style.color='#4ade80'; safeZ.textContent='AMAN'; }
    if (bullZ) { bullZ.style.left=callPct+'%'; bullZ.style.width=(100-callPct)+'%'; bullZ.style.background='rgba(248,113,113,0.12)'; bullZ.style.border='1px solid rgba(248,113,113,0.25)'; bullZ.style.color='#f87171'; bullZ.textContent='BULL'; }
    if (needle) needle.style.left = curPct + '%';
    const pmPut = $('pmPut'), pmCall = $('pmCall'), pmCur = $('pmCur');
    if (pmPut)  { pmPut.style.left = putPct+'%';  pmPut.textContent  = '$' + putStrike.toLocaleString(); }
    if (pmCall) { pmCall.style.left = callPct+'%'; pmCall.textContent = '$' + callStrike.toLocaleString(); }
    if (pmCur)  { pmCur.style.left = curPct+'%'; pmCur.textContent = '▼ $' + Math.round(price).toLocaleString(); }
  }

  function computeStrikes(price, ranger, BGTCUpside) {
    const halfSafe = ranger.safe / 2 / 100 * price;
    const bullAdj  = BGTCUpside < 45 ? 0.85 : BGTCUpside > 55 ? 1.15 : 1.0;
    const bearAdj  = BGTCUpside < 45 ? 1.15 : BGTCUpside > 55 ? 0.85 : 1.0;
    const callStrike = Math.round((price + halfSafe * bullAdj) / 500) * 500;
    const putStrike  = Math.round((price - halfSafe * bearAdj) / 500) * 500;
    return { callStrike, putStrike };
  }

  function updateSignals({ BGTC, hv20, regime, ranger, fg, funding, sentiment, session }) {
    const rows = [
      ['Arah BGTC (dipakai)', BGTC ? BGTC.upside.toFixed(1) + '% naik' : '—',
       BGTC ? (BGTC.upside < 45 ? 'neg' : BGTC.upside < 55 ? 'neu' : 'pos') : 'neu'],
      // Info saja -- warna selalu netral (amber) supaya tidak dibaca sebagai
      // sinyal actionable seperti baris di atas. Tidak dipakai di buildDecision()
      // ataupun buildRetailPlan(); lihat docs/TRADE_FLOW.md §3.
      ['Arah mentah (belum tervalidasi)', BGTC?.p_up_raw != null ? BGTC.p_up_raw.toFixed(1) + '%' : '—', 'neu'],
      ['Vol-amp BGTC',       BGTC ? BGTC.volAmp.toFixed(1) + '%' : '—',
       BGTC ? (BGTC.volAmp > 70 ? 'neg' : BGTC.volAmp > 50 ? 'neu' : 'pos') : 'neu'],
      ['HV20 (tahunan)',     hv20 ? hv20.annualised.toFixed(1) + '%' : '—',
       hv20 ? (hv20.annualised > 70 ? 'neu' : 'pos') : 'neu'],
      ['Rasio IV/HV20',      regime?.ratio ? regime.ratio.toFixed(2) + '×' : '—',
       regime?.regime === 'green' ? 'pos' : regime?.regime === 'red' ? 'neg' : 'neu'],
      ['Rezim',              regime?.label || '—',
       regime?.regime === 'green' ? 'pos' : regime?.regime === 'red' ? 'neg' : 'neu'],
      ['Funding 8j',         funding ? funding.ratePct.toFixed(4) + '%' : '—',
       funding?.flag?.includes('extreme') ? 'neg' : 'pos'],
      ['Takut & Serakah',    fg ? `${fg.value} · ${fg.label}` : '—',
       fg?.value >= 40 && fg?.value <= 70 ? 'pos' : 'neu'],
      ['Sesi',               session?.phase || '—',
       session?.tier === 'best' ? 'pos' : session?.tier === 'skip' ? 'neg' : 'neu'],
      ['RANGER mentah',      ranger ? ranger.raw.toFixed(2) + '%' : '—', 'neu'],
      ['Sentimen berita',    sentiment ? sentiment.newsScore + '/100' : '—',
       sentiment?.newsScore < 40 ? 'neg' : sentiment?.newsScore > 60 ? 'pos' : 'neu'],
    ];
    const list = rows.map(([l, v, cls]) => {
      const color = cls === 'pos' ? 'var(--green)' : cls === 'neg' ? 'var(--red)' : 'var(--amber)';
      return `<div class="ir"><span class="ir-l">${escape(l)}</span><span class="ir-v" style="color:${color}">${escape(v)}</span></div>`;
    }).join('');
    setH('signalList', list);
  }

  function updateNewsFeed(news) {
    const el = $('newsFeed');
    if (!el) return;
    const items = news?.items || [];
    const fr = news?._freshness || 'offline';
    const glyph = fr === 'fresh' ? ICONS.check : fr.includes('snapshot') ? ICONS.clock : ICONS.cross;
    const glyphColor = fr === 'fresh' || fr === 'fresh-snapshot' ? 'var(--green)'
                     : fr === 'stale-snapshot' ? 'var(--amber)' : 'var(--red)';
    const ageMin = news?.ts ? Math.round((Date.now() - news.ts) / 60000) : null;
    const ageStr = ageMin != null ? ` · ${ageMin < 1 ? 'baru saja' : ageMin + 'm lalu'}` : '';
    const header = `<div style="font-size:10px;color:var(--muted);margin-bottom:8px"><span style="color:${glyphColor}" title="${escape(fr)}">${glyph}</span> Sumber: ${escape(news?.source || 'offline')} · ${items.length} item${ageStr}</div>`;
    if (!items.length) { el.innerHTML = header + '<div style="font-size:11px;color:var(--muted)">Tidak ada berita.</div>'; return; }
    el.innerHTML = header + items.slice(0, 8).map(item => {
      const dot = item.sent === 'pos' ? 'var(--green)' : item.sent === 'neg' ? 'var(--red)' : 'var(--amber)';
      // item.url datang dari feed eksternal (CryptoPanic/GDELT/Exa), tidak
      // terautentikasi. escape() saja tidak cukup -- itu cuma mencegah
      // keluar dari atribut href, bukan skema URL. "javascript:..." tetap
      // lolos escape() dan tetap bisa dieksekusi saat link diklik. Jadi cek
      // skema secara eksplisit dulu; kalau bukan http/https, render sebagai
      // teks biasa (bukan link).
      const isSafeUrl = typeof item.url === 'string' && /^https?:\/\//i.test(item.url);
      const link = isSafeUrl ? `<a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">` : '<div>';
      const end  = isSafeUrl ? `</a>` : '</div>';
      return `<div class="ni">
        <div class="ni-dot" style="background:${dot}"></div>
        <div style="flex:1">${link}<div class="ni-hl">${escape(item.headline)}</div>${end}
          <div class="ni-src">${escape(item.src || 'Tidak diketahui')}</div></div>
      </div>`;
    }).join('');
  }

  function updateRateLimits(stats) {
    const grid = $('rlGrid');
    if (!grid) return;
    const order = ['binance', 'deribit', 'BGTC', 'fearGreed', 'exa'];
    grid.innerHTML = order.map(key => {
      const s = stats[key]; if (!s) return '';
      const dayPct = s.dayLimit ? (s.daily / s.dayLimit * 100) : 0;
      const color = dayPct > 80 ? 'var(--red)' : dayPct > 50 ? 'var(--amber)' : 'var(--green)';
      const dayStr = s.dayLimit ? `${s.daily}/${s.dayLimit}/hari` : `${s.daily}`;
      const hrStr  = s.hourLimit ? `${s.hourly}/${s.hourLimit}/jam` : '—';
      return `<div class="rl-card">
        <div class="rl-name">${s.label}</div>
        <div class="rl-bar-bg"><div class="rl-bar-fill" style="width:${Math.min(100,dayPct)}%;background:${color}"></div></div>
        <div class="rl-nums"><span>${dayStr}</span><span>${hrStr}</span></div>
      </div>`;
    }).join('');
  }

  function escape(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  return {
    updateClock, updateBGTCBadge, updateHero, updatePulseStrip,
    updateSessionRibbon, updateRegimeDial, updateRetailPlan,
    updateOddsTable, updateBGTCCard, updateRanger,
    renderRangeVisual, computeStrikes, updateSignals,
    updateNewsFeed, updateRateLimits,
  };
})();
