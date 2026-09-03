/**
 * ui.js (v4)  — decision-focused UI bindings
 * =====================================================================
 * Renders the hero decision card, pulse strip, regime dial, session ribbon,
 * retail plan, odds table, kronos card, signal list, and rate limit grid.
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

  // ── CLOCK / TIMESTAMP ────────────────────────────────────────────────
  function updateClock() {
    const ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    set('clockIST', ist.split(',').pop().trim().slice(0,8) + ' IST');
    set('footerTs', 'Updated ' + new Date().toLocaleTimeString());
  }

  // ── KRONOS BADGE (header) ────────────────────────────────────────────
  function updateKronosBadge(kronos) {
    const el = $('kronosBadge');
    if (!el) return;
    if (!kronos) { el.className = 'pill-sm err'; el.textContent = 'Kronos: offline'; return; }
    const cls = kronos.freshness === 'fresh'   ? 'ok'
              : kronos.freshness === 'recent'  ? 'ok'
              : kronos.freshness === 'stale'   ? 'warn'
              :                                   'err';
    const age = kronos.ageHrs == null ? '?' : kronos.ageHrs < 1 ? '<1h' : kronos.ageHrs.toFixed(0)+'h';
    el.className = 'pill-sm ' + cls;
    el.textContent = `Kronos ${kronos.upside.toFixed(1)}% · ${age} ago`;
  }

  // ── HERO DECISION CARD ───────────────────────────────────────────────
  function updateHero(decision) {
    if (!decision) return;
    const card = $('heroCard');
    if (card) card.className = 'hero ' + (decision.verdictClass || 'nt');

    const icon = decision.verdictClass === 'go'  ? '✓'
               : decision.verdictClass === 'cau' ? '⚠'
               :                                    '✕';
    set('heroIcon', icon);
    set('heroVerdict', decision.verdict || '—');
    set('heroSub', decision.tradeStructure
      ? `${decision.direction?.toUpperCase() || 'NEUTRAL'} bias · ${decision.reasons.length} signals aligned, ${decision.blockers.length} blockers`
      : decision.blockers[0] || 'Evaluating all signals…');
    set('heroConf', Math.round(decision.confidence) + '%');
    const bar = $('heroConfBar');
    if (bar) {
      const color = decision.verdictClass === 'go' ? 'var(--green)'
                  : decision.verdictClass === 'cau' ? 'var(--amber)' : 'var(--red)';
      bar.style.background = color;
      // v4.1: stale-closure fix — rapid consecutive updateHero calls (slider
      // drags) used to queue overlapping 120ms timeouts, each re-animating
      // from 0% with a possibly outdated confidence value. Cancel the prior
      // timer and read the latest value inside the callback.
      bar.style.width = '0%';
      clearTimeout(bar._animTimer);
      bar._targetConf = decision.confidence;
      bar._animTimer = setTimeout(() => { bar.style.width = bar._targetConf + '%'; }, 120);
    }

    setH('heroReasons', (decision.reasons || []).map(r =>
      `<div class="hero-reason pos"><span class="hero-reason-dot"></span><span>${escape(r)}</span></div>`
    ).join('') || '<div style="font-size:11px;color:var(--muted);padding:4px 0">None yet.</div>');

    setH('heroBlockers', (decision.blockers || []).map(r =>
      `<div class="hero-reason neg"><span class="hero-reason-dot"></span><span>${escape(r)}</span></div>`
    ).join('') || '<div style="font-size:11px;color:var(--muted);padding:4px 0">All clear.</div>');

    const sb = $('heroStructure');
    if (decision.tradeStructure) {
      if (sb) sb.style.display = 'flex';
      set('heroStructText', decision.tradeStructure);
      set('heroStructSub', `Direction: ${decision.direction} · Confidence ${Math.round(decision.confidence)}%`);
    } else if (sb) sb.style.display = 'none';
  }

  // ── MARKET PULSE STRIP ───────────────────────────────────────────────
  function updatePulseStrip({ price, hv20, atmInfo, funding, fg, kronos }) {
    if (price) {
      set('psPrice',  '$' + fmt(Math.round(price.price)));
      const chg = (price.change * 100);
      const chgEl = $('psChange');
      if (chgEl) {
        chgEl.textContent = (chg >= 0 ? '▲' : '▼') + ' ' + Math.abs(chg).toFixed(2) + '%';
        chgEl.style.color = chg >= 0 ? 'var(--green)' : 'var(--red)';
      }
      set('psHigh',    '$' + fmt(Math.round(price.high)));
      set('psHighPct', '+' + ((price.high - price.price) / price.price * 100).toFixed(2) + '% above');
      set('psLow',     '$' + fmt(Math.round(price.low)));
      set('psLowPct',  ((price.low - price.price) / price.price * 100).toFixed(2) + '% from');
      set('psPriceSub', 'Binance · vol ' + fmtS(price.volUsd));
    }
    if (hv20) {
      set('psHv20',    hv20.annualised.toFixed(1) + '%');
      set('psHv20Sub', '1-day: ' + hv20.oneDay.toFixed(2) + '%');
    }
    if (atmInfo) {
      set('psAtmIv',    atmInfo.atmIv.toFixed(1) + '%');
      set('psAtmIvSub', atmInfo.expiry + ' · ' + atmInfo.daysToExpiry.toFixed(1) + 'd');
    }
    if (funding) {
      const el = $('psFunding');
      if (el) {
        el.textContent = funding.ratePct.toFixed(4) + '%';
        el.className = 'pc-val ' + (funding.flag.includes('extreme') ? 'neg' : funding.flag === 'neutral' ? 'neu' : 'cyan');
      }
      set('psFundingSub', 'ann ' + funding.annualizedPct.toFixed(1) + '% · ' + funding.flag);
    }
    if (fg) {
      const el = $('psFg');
      if (el) {
        el.textContent = fg.value;
        el.className = 'pc-val ' + (fg.value < 30 ? 'neg' : fg.value < 55 ? 'neu' : 'pos');
      }
      set('psFgSub', fg.label);
    }
    if (kronos) {
      const el = $('psKronos');
      if (el) {
        el.textContent = kronos.upside.toFixed(1) + '%';
        el.className = 'pc-val ' + (kronos.upside < 45 ? 'neg' : kronos.upside < 55 ? 'neu' : 'pos');
      }
      set('psKronosSub', 'vol-amp ' + kronos.volAmp.toFixed(1) + '%');
    }
  }

  // ── SESSION RIBBON ───────────────────────────────────────────────────
  function updateSessionRibbon(session) {
    if (!session) return;
    const phaseEl = $('srPhase');
    if (phaseEl) {
      phaseEl.textContent = session.phase;
      phaseEl.className = 'sr-phase ' + session.tier;
    }
    set('srAdvice', session.advice);
    set('srClock', 'IST ' + Math.floor(session.istHour) + ':' + String(Math.floor((session.istHour % 1) * 60)).padStart(2,'0'));

    // Bar
    const segs = [
      { w: 22.9, bg: 'rgba(96,165,250,0.15)',  lbl: '00–05:30' },
      { w: 12.5, bg: 'rgba(74,222,128,0.2)',   lbl: '05:30–08:30' },
      { w: 16.7, bg: 'rgba(74,222,128,0.5)',   lbl: '⭐ 08:30–12:30' },
      { w: 6.3,  bg: 'rgba(74,222,128,0.2)',   lbl: '12:30–14' },
      { w: 14.6, bg: 'rgba(251,191,36,0.25)',  lbl: '14–17:30' },
      { w: 4.2,  bg: 'rgba(248,113,113,0.35)', lbl: '17:30–18:30' },
      { w: 22.8, bg: 'rgba(248,113,113,0.25)', lbl: '18:30–00:00' },
    ];
    const nowPct = (session.istHour / 24) * 100;
    const wrap = $('srBarWrap');
    if (wrap) {
      let barHtml = '<div class="session-bar">';
      let cum = 0;
      for (const s of segs) {
        barHtml += `<div class="session-seg" style="width:${s.w}%;background:${s.bg}">${s.lbl}</div>`;
        cum += s.w;
      }
      barHtml += '</div>';
      barHtml += `<div style="position:relative;margin-top:-17px;height:14px;z-index:3;pointer-events:none"><div style="position:absolute;left:${nowPct}%;top:-3px;width:2px;height:26px;background:#fff;box-shadow:0 0 8px rgba(255,255,255,.5);transform:translateX(-50%)"></div><div style="position:absolute;left:${nowPct}%;top:-18px;font-size:9px;font-family:var(--font-mono);color:#fff;transform:translateX(-50%);background:var(--accent);padding:1px 4px;border-radius:3px">NOW</div></div>`;
      wrap.innerHTML = barHtml;
    }
  }

  // ── REGIME DIAL ──────────────────────────────────────────────────────
  function updateRegimeDial(regime, hv20, atmInfo) {
    if (!regime) return;
    set('rdRatio',  regime.ratio ? regime.ratio.toFixed(2) : '—');
    const lbl = $('rdLabel');
    if (lbl) {
      lbl.textContent = regime.label || '—';
      lbl.className = 'rd-label ' + regime.regime;
    }
    set('rdIvHv', atmInfo && hv20 ? `IV ${atmInfo.atmIv.toFixed(1)}% / HV20 ${hv20.annualised.toFixed(1)}%` : 'IV — / HV20 —');

    // Dial arc: ratio 0 → 2.0 maps to 0° → 180°
    const arc = $('rdArc');
    if (arc && regime.ratio) {
      const clamped = Math.min(2.0, Math.max(0, regime.ratio));
      const frac = clamped / 2.0;
      const total = 157;   // arc length from SVG path
      arc.style.strokeDashoffset = total - (total * frac);
      const color = regime.regime === 'green' ? 'var(--green)'
                  : regime.regime === 'amber' ? 'var(--amber)'
                  : regime.regime === 'amber-dark' ? '#fb923c'
                  :                              'var(--red)';
      arc.style.stroke = color;
    }

    set('rdSize', (regime.sizing * 100).toFixed(0) + '%');
    set('rdSizeNote', regime.allowTrade ? `of base position (${regime.label})` : 'Skip today');
  }

  // ── RETAIL PLAN BODY ─────────────────────────────────────────────────
  function updateRetailPlan(plan, price, hv20, regime, atmInfo) {
    const body = $('retailBody');
    if (!body) return;

    // Expiry pill
    const exp = $('retailExpiry');
    if (exp) exp.textContent = atmInfo ? 'Expiry: ' + atmInfo.expiry : '—';

    if (!plan) {
      body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px">Waiting for price / options / HV20…</div>`;
      return;
    }

    let html = '';

    if (!plan.ok) {
      html += `<div class="rc-warn red">
        <div class="rc-warn-title">⛔ NO-TRADE today</div>
        <div class="rc-warn-body">${escape(plan.reason)}</div>
      </div>`;
      if (plan.candidates?.length) {
        html += `<div style="font-size:10px;color:var(--muted);margin:10px 0 6px">Premium-viable strikes and their touch probabilities:</div>`;
        html += `<table class="odds-table"><thead><tr><th>Strike</th><th>Distance</th><th>Premium/lot</th><th>Touch prob</th></tr></thead><tbody>` +
          plan.candidates.map(c => {
            const tp = c.touchProb ?? DataLayer.touchProbability(c.absDist, hv20?.oneDay);
            return `<tr><td>$${fmt(c.strike)}</td><td>${c.absDist?.toFixed(2)}%</td><td>$${fmt(c.premium, 2)}</td><td>${tp ? (tp*100).toFixed(0)+'%' : '—'}</td></tr>`;
          }).join('') + `</tbody></table>`;
      }
      body.innerHTML = html;
      return;
    }

    // OK case
    const netCreditClass = plan.netCredit > 0 ? 'pos' : 'neg';
    const distSafety = plan.shortDistancePct > 15 ? 'Very safe' : plan.shortDistancePct > 10 ? 'Safe' : 'Moderate';
    const kMultiplier = (plan.shortDistancePct / (hv20?.oneDay || 1));

    html += `<div class="rc-legs">
      <div class="leg go">
        <div class="leg-type">LEG 1 · Buy (long gamma)</div>
        <div class="leg-action">1× ATM $${fmt(plan.atmInfo.atmStrike)} STRADDLE</div>
        <div class="leg-detail">Cost: <b>$${fmt(plan.straddleCost, 0)}</b> · ${plan.atmInfo.expiry} · ${plan.atmInfo.daysToExpiry.toFixed(1)}d</div>
      </div>
      <div class="leg go">
        <div class="leg-type">LEG 2 · Sell ${plan.shortLots}× (financing)</div>
        <div class="leg-action">${plan.shortLots}× $${fmt(plan.shortStrike)} ${plan.sellSide === 'P' ? 'PUTS' : 'CALLS'}</div>
        <div class="leg-detail">Premium/lot: <b>$${fmt(plan.shortPremiumPerLot, 2)}</b> · Total: <b>$${fmt(plan.totalShortPremium, 0)}</b></div>
      </div>
    </div>`;

    html += `<div class="rc-metrics">
      <div class="rcm"><div class="rcm-l">Distance</div><div class="rcm-v">${plan.shortDistancePct.toFixed(2)}%</div><div class="rcm-s">${distSafety} · ${kMultiplier.toFixed(1)}× hv20_1d</div></div>
      <div class="rcm"><div class="rcm-l">Touch probability</div><div class="rcm-v">${(plan.touchProb*100).toFixed(0)}%</div><div class="rcm-s">per PDF backtest</div></div>
      <div class="rcm"><div class="rcm-l">Net credit</div><div class="rcm-v ${netCreditClass}">${plan.netCredit >= 0 ? '+' : ''}$${fmt(plan.netCredit, 0)}</div><div class="rcm-s">after financing</div></div>
      <div class="rcm"><div class="rcm-l">Req/lot</div><div class="rcm-v">$${plan.reqPremPerLot.toFixed(2)}</div><div class="rcm-s">×${((plan.shortPremiumPerLot/plan.reqPremPerLot)*100).toFixed(0)}% coverage</div></div>
    </div>`;

    html += `<div class="rc-risk-note">
      ⚠️ <b>Risk:</b> Shorting ${plan.shortLots}× uncapped is extreme-gamma. If BTC touches $${fmt(plan.shortStrike)} (${plan.shortDistancePct.toFixed(1)}% move) the wing blows up. Use Delta's <b>strategy builder</b> to add cheap long protection 1–2× further OTM and cap max loss to &lt;10% of equity.
    </div>`;

    if (plan.alternatives?.length) {
      html += `<div style="font-size:10px;color:var(--muted);margin:12px 0 4px">Alternative strikes (also valid, closer to spot):</div>`;
      html += `<table class="odds-table"><thead><tr><th>Strike</th><th>Distance</th><th>Premium</th><th>Touch</th><th>Net credit</th></tr></thead><tbody>` +
        plan.alternatives.map(a => {
          const nc = (a.premium * plan.shortLots) - plan.straddleCost;
          return `<tr><td>$${fmt(a.strike)}</td><td>${a.absDist.toFixed(2)}%</td><td>$${fmt(a.premium,2)}</td><td>${(a.touchProb*100).toFixed(0)}%</td><td style="color:${nc>=0?'var(--green)':'var(--red)'}">$${fmt(nc, 0)}</td></tr>`;
        }).join('') + `</tbody></table>`;
    }

    body.innerHTML = html;
  }

  // ── ODDS TABLE (conditional on regime) ───────────────────────────────
  function updateOddsTable(odds, hv20, price) {
    set('oddsIntro', odds ? odds.description : 'Waiting for regime classification…');
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

  // ── KRONOS DETAIL CARD ───────────────────────────────────────────────
  function updateKronosCard(kronos) {
    const body = $('kronosCardBody');
    if (!body) return;
    if (!kronos) { body.innerHTML = '<div style="font-size:11px;color:var(--muted)">Kronos data unavailable.</div>'; return; }
    const freshCls = kronos.freshness === 'fresh' || kronos.freshness === 'recent' ? 'fresh'
                  : kronos.freshness === 'stale' ? 'stale' : 'very-stale';

    body.innerHTML = `
      <div class="kc-head">
        <div>
          <div class="kc-title">BTC/USDT · Next 24h</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px">
            Source ts: ${kronos.sourceTs || 'unknown'} ${kronos.ageHrs != null ? `(${kronos.ageHrs < 1 ? '<1' : kronos.ageHrs.toFixed(0)}h ago)` : ''}
          </div>
        </div>
        <span class="kc-fresh ${freshCls}">${kronos.freshness.toUpperCase()}</span>
      </div>
      <div class="kc-row">
        <div class="kc-metric">
          <div class="kc-metric-l">Upside probability</div>
          <div class="kc-metric-v" style="color:${kronos.upside < 45 ? 'var(--red)' : kronos.upside < 55 ? 'var(--amber)' : 'var(--green)'}">${kronos.upside.toFixed(1)}%</div>
          <div class="kc-metric-s">${kronos.upside < 45 ? 'Bearish lean' : kronos.upside < 55 ? 'Neutral' : 'Bullish lean'}</div>
        </div>
        <div class="kc-metric">
          <div class="kc-metric-l">Vol amplification</div>
          <div class="kc-metric-v" style="color:${kronos.volAmp > 70 ? 'var(--red)' : kronos.volAmp > 50 ? 'var(--amber)' : 'var(--green)'}">${kronos.volAmp.toFixed(1)}%</div>
          <div class="kc-metric-s">${kronos.volAmp > 70 ? 'High vol expected' : kronos.volAmp > 50 ? 'Elevated' : 'Calm'}</div>
        </div>
      </div>
      <div style="font-size:10px;color:var(--muted);margin-top:10px;line-height:1.5">
        Via ${kronos.proxy || 'proxy'}. Model: Kronos-mini (4M params) · Context: last 360h · N=30 Monte-Carlo paths.
      </div>`;
  }

  // ── RANGER RANGE DISPLAY ─────────────────────────────────────────────
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
    if (safeZ) { safeZ.style.left=putPct+'%'; safeZ.style.width=(callPct-putPct)+'%'; safeZ.style.background='rgba(74,222,128,0.08)'; safeZ.style.border='1px solid rgba(74,222,128,0.22)'; safeZ.style.color='#4ade80'; safeZ.textContent='SAFE'; }
    if (bullZ) { bullZ.style.left=callPct+'%'; bullZ.style.width=(100-callPct)+'%'; bullZ.style.background='rgba(248,113,113,0.12)'; bullZ.style.border='1px solid rgba(248,113,113,0.25)'; bullZ.style.color='#f87171'; bullZ.textContent='BULL'; }
    if (needle) needle.style.left = curPct + '%';
    const pmPut = $('pmPut'), pmCall = $('pmCall'), pmCur = $('pmCur');
    if (pmPut)  { pmPut.style.left = putPct+'%';  pmPut.textContent  = '$' + putStrike.toLocaleString(); }
    if (pmCall) { pmCall.style.left = callPct+'%'; pmCall.textContent = '$' + callStrike.toLocaleString(); }
    if (pmCur)  { pmCur.style.left = curPct+'%'; pmCur.textContent = '▼ $' + Math.round(price).toLocaleString(); }
  }

  function computeStrikes(price, ranger, kronosUpside) {
    const halfSafe = ranger.safe / 2 / 100 * price;
    const bullAdj  = kronosUpside < 45 ? 0.85 : kronosUpside > 55 ? 1.15 : 1.0;
    const bearAdj  = kronosUpside < 45 ? 1.15 : kronosUpside > 55 ? 0.85 : 1.0;
    const callStrike = Math.round((price + halfSafe * bullAdj) / 500) * 500;
    const putStrike  = Math.round((price - halfSafe * bearAdj) / 500) * 500;
    return { callStrike, putStrike };
  }

  // ── SIGNAL CONFLUENCE LIST ───────────────────────────────────────────
  function updateSignals({ kronos, hv20, regime, ranger, fg, funding, sentiment, session }) {
    const rows = [
      ['Kronos direction',   kronos ? kronos.upside.toFixed(1) + '% upside'
                                    : '—',
       kronos ? (kronos.upside < 45 ? 'neg' : kronos.upside < 55 ? 'neu' : 'pos') : 'neu'],
      ['Kronos vol-amp',     kronos ? kronos.volAmp.toFixed(1) + '%' : '—',
       kronos ? (kronos.volAmp > 70 ? 'neg' : kronos.volAmp > 50 ? 'neu' : 'pos') : 'neu'],
      ['HV20 (annualised)',  hv20 ? hv20.annualised.toFixed(1) + '%' : '—',
       hv20 ? (hv20.annualised > 70 ? 'neu' : 'pos') : 'neu'],
      ['IV/HV20 ratio',      regime?.ratio ? regime.ratio.toFixed(2) + '×' : '—',
       regime?.regime === 'green' ? 'pos' : regime?.regime === 'red' ? 'neg' : 'neu'],
      ['Regime',             regime?.label || '—',
       regime?.regime === 'green' ? 'pos' : regime?.regime === 'red' ? 'neg' : 'neu'],
      ['Funding 8h',         funding ? funding.ratePct.toFixed(4) + '%' : '—',
       funding?.flag?.includes('extreme') ? 'neg' : 'pos'],
      ['Fear & Greed',       fg ? `${fg.value} · ${fg.label}` : '—',
       fg?.value >= 40 && fg?.value <= 70 ? 'pos' : 'neu'],
      ['Session',            session?.phase || '—',
       session?.tier === 'best' ? 'pos' : session?.tier === 'skip' ? 'neg' : 'neu'],
      ['RANGER raw',         ranger ? ranger.raw.toFixed(2) + '%' : '—', 'neu'],
      ['News sentiment',     sentiment ? sentiment.newsScore + '/100' : '—',
       sentiment?.newsScore < 40 ? 'neg' : sentiment?.newsScore > 60 ? 'pos' : 'neu'],
    ];
    const list = rows.map(([l, v, cls]) => {
      const color = cls === 'pos' ? 'var(--green)' : cls === 'neg' ? 'var(--red)' : 'var(--amber)';
      return `<div class="ir"><span class="ir-l">${escape(l)}</span><span class="ir-v" style="color:${color}">${escape(v)}</span></div>`;
    }).join('');
    setH('signalList', list);
  }

  // ── NEWS FEED ────────────────────────────────────────────────────────
  function updateNewsFeed(news) {
    const el = $('newsFeed');
    if (!el) return;
    const items = news?.items || [];
    // v4.1: surface data provenance — ● fresh · ◐ snapshot · ○ stale/offline
    const fr = news?._freshness || 'offline';
    const glyph = fr === 'fresh' ? '●' : fr.includes('snapshot') ? '◐' : '○';
    const glyphColor = fr === 'fresh' || fr === 'fresh-snapshot' ? 'var(--green)'
                     : fr === 'stale-snapshot' ? 'var(--amber)' : 'var(--red)';
    const ageMin = news?.ts ? Math.round((Date.now() - news.ts) / 60000) : null;
    const ageStr = ageMin != null ? ` · ${ageMin < 1 ? 'just now' : ageMin + 'm ago'}` : '';
    const header = `<div style="font-size:10px;color:var(--muted);margin-bottom:8px"><span style="color:${glyphColor}" title="${escape(fr)}">${glyph}</span> Source: ${escape(news?.source || 'offline')} · ${items.length} items${ageStr}</div>`;
    if (!items.length) { el.innerHTML = header + '<div style="font-size:11px;color:var(--muted)">No news loaded.</div>'; return; }
    el.innerHTML = header + items.slice(0, 8).map(item => {
      const dot = item.sent === 'pos' ? 'var(--green)' : item.sent === 'neg' ? 'var(--red)' : 'var(--amber)';
      const link = item.url ? `<a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">` : '<div>';
      const end  = item.url ? `</a>` : '</div>';
      return `<div class="ni">
        <div class="ni-dot" style="background:${dot}"></div>
        <div style="flex:1">${link}<div class="ni-hl">${escape(item.headline)}</div>${end}
          <div class="ni-src">${escape(item.src || 'Unknown')}</div></div>
      </div>`;
    }).join('');
  }

  // ── RATE LIMIT DISPLAY ───────────────────────────────────────────────
  function updateRateLimits(stats) {
    const grid = $('rlGrid');
    if (!grid) return;
    const order = ['binance', 'deribit', 'kronos', 'fearGreed', 'exa'];
    grid.innerHTML = order.map(key => {
      const s = stats[key]; if (!s) return '';
      const dayPct = s.dayLimit ? (s.daily / s.dayLimit * 100) : 0;
      const color = dayPct > 80 ? 'var(--red)' : dayPct > 50 ? 'var(--amber)' : 'var(--green)';
      const dayStr = s.dayLimit ? `${s.daily}/${s.dayLimit}/day` : `${s.daily}`;
      const hrStr  = s.hourLimit ? `${s.hourly}/${s.hourLimit}/hr` : '∞';
      return `<div class="rl-card">
        <div class="rl-name">${s.label}</div>
        <div class="rl-bar-bg"><div class="rl-bar-fill" style="width:${Math.min(100,dayPct)}%;background:${color}"></div></div>
        <div class="rl-nums"><span>${dayStr}</span><span>${hrStr}</span></div>
      </div>`;
    }).join('');
  }

  // ── util ────────────────────────────────────────────────────────────
  function escape(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  return {
    updateClock, updateKronosBadge, updateHero, updatePulseStrip,
    updateSessionRibbon, updateRegimeDial, updateRetailPlan,
    updateOddsTable, updateKronosCard, updateRanger,
    renderRangeVisual, computeStrikes, updateSignals,
    updateNewsFeed, updateRateLimits,
  };
})();
