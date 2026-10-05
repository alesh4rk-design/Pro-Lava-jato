// Gráficos: carrega o Chart.js (arquivo local, sem CDN) só quando a tela precisa
// e aplica o padrão visual do app. Cores vêm dos tokens CSS (--series-1, --series-2),
// que mudam com o tema claro/escuro.

import { formatCents } from './format.js';

let loading;

/** Carrega js/vendor/chart.umd.min.js uma única vez. */
export function loadChartLib() {
  loading ??= new Promise((resolve, reject) => {
    if (window.Chart) { resolve(window.Chart); return; }
    const script = document.createElement('script');
    script.src = 'js/vendor/chart.umd.min.js';
    script.onload = () => resolve(window.Chart);
    script.onerror = () => { loading = null; reject(new Error('Não foi possível carregar os gráficos.')); };
    document.head.append(script);
  });
  return loading;
}

export function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return { series1: v('--series-1'), series2: v('--series-2'), text: v('--text-muted'), grid: v('--border'), surface: v('--surface'), ink: v('--text') };
}

/** Valor curto para eixos: R$ 1,2 mil, R$ 15 mil. */
const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
export const axisMoney = (cents) => `R$ ${compact.format(cents / 100)}`;

/** Opções comuns: uma escala, grade discreta, tooltip com valores em reais. */
export function baseOptions({ horizontal = false, legend = true } = {}) {
  const c = themeColors();
  const valueAxis = {
    beginAtZero: true,
    grid: { color: c.grid, drawTicks: false },
    border: { display: false },
    ticks: { color: c.text, callback: (value) => axisMoney(value), maxTicksLimit: horizontal ? 4 : 5, padding: 6 },
  };
  const categoryAxis = { grid: { display: false }, border: { color: c.grid }, ticks: { color: c.text, autoSkipPadding: 12, maxRotation: 0 } };
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    indexAxis: horizontal ? 'y' : 'x',
    interaction: { mode: horizontal ? 'nearest' : 'index', intersect: false, axis: horizontal ? 'y' : 'x' },
    scales: horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis },
    plugins: {
      legend: {
        display: legend,
        position: 'top',
        align: 'start',
        // Legenda na ordem dos dados, independente da ordem de desenho.
        labels: { color: c.ink, boxWidth: 12, boxHeight: 12, usePointStyle: true, pointStyle: 'rectRounded', sort: (a, b) => a.datasetIndex - b.datasetIndex },
      },
      tooltip: {
        backgroundColor: '#13222c',
        titleColor: '#ffffff',
        bodyColor: '#ffffff',
        padding: 10,
        cornerRadius: 8,
        callbacks: { label: (ctx) => `${ctx.dataset.label ? `${ctx.dataset.label}: ` : ''}${formatCents(ctx.raw)}` },
      },
    },
  };
}

/** Barras finas, cantos de 4px na ponta (não na base), 2px de espaço entre barras vizinhas. */
export const barStyle = (color) => ({
  backgroundColor: color,
  borderRadius: 4,
  borderSkipped: 'start',
  maxBarThickness: 28,
  categoryPercentage: 0.8,
  barPercentage: 0.9,
});

/** Linha de 2px com marcadores de 4px de raio (8px), anel na cor da superfície. */
export const lineStyle = (color, surface) => ({
  borderColor: color,
  backgroundColor: color,
  borderWidth: 2,
  pointRadius: 4,
  pointHoverRadius: 6,
  pointBorderColor: surface,
  pointBorderWidth: 2,
  tension: 0,
});

/** Cria (ou recria) um gráfico no canvas, destruindo o anterior. */
export async function renderChart(canvas, config) {
  const Chart = await loadChartLib();
  Chart.getChart(canvas)?.destroy();
  return new Chart(canvas, config);
}
