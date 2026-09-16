/**
 * charts.js (v5) \u2014 simplified. Only the 48h price chart now; sentiment
 * gauges are absorbed into the pulse strip; theta chart is dropped as
 * the PDF analysis showed theta decay is deterministic and not worth
 * screen real estate on the decision desk.
 *
 * v5 (Fase 5 checklist -- checklist-upgrade-pro-btc-desk.md):
 *   renderPriceChart() used to destroy() the whole Chart.js instance and
 *   build a brand new one on every 5-minute refresh -- the chart would
 *   blink out and reappear instantly with the new data, since a freshly
 *   constructed chart has no "previous" frame to animate from. Now the
 *   chart is created once; subsequent calls just replace .data.labels /
 *   .data.datasets[0].data on the existing instance and call .update(),
 *   which lets Chart.js's own animation tween each point from its old
 *   position to its new one (its default easeOutQuart, ~1s) instead of
 *   a jump cut. Also widened the hit/hover radius so the on-hover
 *   tooltip (already present via options.plugins.tooltip below) is easy
 *   to trigger anywhere along the line, not just by pixel-hunting a
 *   0-radius point, and switched the interaction mode to 'index' so
 *   moving the mouse anywhere over the chart width shows the nearest
 *   candle's tooltip instead of requiring a precise hover over the line.
 */
const Charts = (() => {
  let priceChart = null;

  function renderPriceChart(hourlyData) {
    const ctx = document.getElementById('priceC');
    if (!ctx || !hourlyData?.length) return;

    const labels = hourlyData.map(c => {
      const d = new Date(c.t);
      const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      return ist.getHours() + ':' + String(ist.getMinutes()).padStart(2, '0');
    });
    const values = hourlyData.map(c => c.c);

    if (priceChart) {
      // Fase 5: update in place instead of destroy+recreate, so the line
      // tweens smoothly between refreshes instead of vanishing/reappearing.
      priceChart.data.labels = labels;
      priceChart.data.datasets[0].data = values;
      priceChart.update();
      return;
    }

    priceChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'BTC/USDT 1H',
          data: values,
          borderColor: '#818cf8', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 12, tension: 0.35, fill: true,
          backgroundColor: (context) => {
            const { ctx: c, chartArea } = context.chart;
            if (!chartArea) return 'transparent';
            const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            g.addColorStop(0, 'rgba(129,140,248,0.15)');
            g.addColorStop(1, 'rgba(129,140,248,0.01)');
            return g;
          },
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 700, easing: 'easeOutQuart' },
        interaction: { mode: 'index', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index', intersect: false,
            callbacks: {
              title: items => items.length ? 'Jam ' + items[0].label + ' IST' : '',
              label: c => '$' + c.parsed.y.toLocaleString(),
            },
          },
        },
        scales: {
          x: { ticks: { font: { size: 8 }, maxRotation: 45, color: '#71717a', maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,0.03)' } },
          y: { ticks: { font: { size: 9 }, callback: v => '$' + Math.round(v / 1000) + 'K', color: '#71717a' }, grid: { color: 'rgba(255,255,255,0.03)' } },
        },
      },
    });
  }

  return { renderPriceChart };
})();
