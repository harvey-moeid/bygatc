/**
 * charts.js (v4) — simplified. Only the 48h price chart now; sentiment
 * gauges are absorbed into the pulse strip; theta chart is dropped as
 * the PDF analysis showed theta decay is deterministic and not worth
 * screen real estate on the decision desk.
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

    if (priceChart) { priceChart.destroy(); priceChart = null; }

    priceChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'BTC/USDT 1H',
          data: hourlyData.map(c => c.c),
          borderColor: '#818cf8', borderWidth: 2, pointRadius: 0, tension: 0.35, fill: true,
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
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => '$' + c.parsed.y.toLocaleString() } },
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
