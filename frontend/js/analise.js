// Análise (ADMIN): resultado do período, evolução, ponto de equilíbrio, gastos por categoria,
// receita por serviço e formas de pagamento. Os gráficos carregam só nesta tela.

import { session } from './app.js';
import { api } from './api.js';
import { formatCents, formatBasisPoints, formatInteger, formatDate } from './format.js';
import { el, stateView } from './ui.js';
import { periodPicker } from './periods.js';
import { PAYMENT_LABELS } from './entry-form.js';
import { renderChart, baseOptions, barStyle, lineStyle, themeColors } from './charts.js';

const root = document.getElementById('analysis');
let seq = 0;

const REASONS = {
  SEM_FATURAMENTO: 'Sem faturamento no período, não dá para calcular. Lance as receitas para ver o ponto de equilíbrio.',
  MARGEM_NAO_POSITIVA: 'Os custos variáveis igualam ou passam do faturamento: nenhum volume de vendas cobre as despesas fixas. Revise preços e custos.',
};

/* Blocos de layout ----------------------------------------------------------------- */

const section = (title, ...children) => el('section', { class: 'section' }, el('h2', { class: 'section-title' }, title), ...children);

function chartBox(label, height = 220) {
  const canvas = el('canvas', { role: 'img', 'aria-label': label });
  return { canvas, element: el('div', { class: 'chart-box' }, el('div', { class: 'chart-canvas', 'data-h': String(height) }, canvas)) };
}

/** Tabela recolhível com os mesmos dados do gráfico. */
function dataTable(headers, rows) {
  return el('details', { class: 'more table-view' },
    el('summary', {}, 'Ver em tabela'),
    el('div', { class: 'table-scroll' },
      el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {}, headers.map((h, i) => el('th', { class: i ? 'num' : '' }, h)))),
        el('tbody', {}, rows.map((r) => el('tr', {}, r.map((cell, i) => el('td', { class: i ? 'num' : '' }, cell))))))));
}

const statCard = (label, value, cls = '') => el('div', { class: 'card' },
  el('div', { class: 'stat-label' }, label), el('div', { class: `stat-value num ${cls}` }, value));

const bucketLabel = (bucket, granularity) => {
  if (granularity === 'day') return formatDate(bucket).slice(0, 5);
  const [y, m] = bucket.split('-');
  return `${m}/${y.slice(2)}`;
};

/* Seções ------------------------------------------------------------------------------ */

function resultSection({ totals }) {
  const loss = totals.result_cents < 0;
  return section('Resultado do período',
    el('div', { class: 'grid-2' },
      statCard('Faturamento', formatCents(totals.revenue_cents)),
      statCard('Custos', formatCents(totals.variable_costs_cents)),
      statCard('Despesas', formatCents(totals.expenses_cents)),
      statCard('Resultado', formatCents(totals.result_cents), loss ? 'text-danger' : 'text-success'),
      statCard('Margem', formatBasisPoints(totals.margin_bp), loss ? 'text-danger' : ''),
      statCard('Serviços', formatInteger(totals.services_count))));
}

function evolutionSection(fin, charts) {
  const chart = chartBox('Receita e resultado por período');
  const labels = fin.series.map((p) => bucketLabel(p.bucket, fin.granularity));
  charts.push(() => {
    const c = themeColors();
    return renderChart(chart.canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { type: 'bar', label: 'Receita', data: fin.series.map((p) => p.revenue_cents), ...barStyle(c.series1), order: 2 },
          { type: 'line', label: 'Resultado', data: fin.series.map((p) => p.result_cents), ...lineStyle(c.series2, c.surface), pointRadius: fin.series.length > 15 ? 0 : 4, order: 1 },
        ],
      },
      options: baseOptions(),
    });
  });
  return section(fin.granularity === 'day' ? 'Evolução diária' : 'Evolução mensal',
    el('div', { class: 'card' }, chart.element,
      dataTable(['Período', 'Receita', 'Custos', 'Despesas', 'Resultado'], fin.series.map((p) => [
        bucketLabel(p.bucket, fin.granularity), formatCents(p.revenue_cents), formatCents(p.variable_costs_cents), formatCents(p.expenses_cents), formatCents(p.result_cents),
      ]))));
}

function breakEvenSection(be, charts) {
  const facts = el('ul', { class: 'list' },
    el('li', { class: 'list-row' }, el('span', { class: 'muted' }, 'Despesas fixas e outras'), el('strong', {}, formatCents(be.fixed_expenses_cents + be.other_expenses_cents))),
    el('li', { class: 'list-row' }, el('span', { class: 'muted' }, 'Custos variáveis considerados'), el('strong', {}, formatCents(be.variable_costs_cents))),
    el('li', { class: 'list-row' }, el('span', { class: 'muted' }, 'Margem de contribuição'), el('strong', {}, formatBasisPoints(be.contribution_margin_bp))),
    el('li', { class: 'list-row' }, el('span', { class: 'muted' }, 'Faturamento no período'), el('strong', {}, formatCents(be.revenue_cents))));
  const note = el('p', { class: 'hint' }, be.variable_cost_basis === 'ESTIMADO'
    ? 'Estimativa: usa as despesas fixas lançadas e o custo estimado dos serviços vendidos (composição de custo de cada serviço). Depende dos dados cadastrados.'
    : 'Estimativa: usa as despesas fixas e os custos variáveis lançados no caixa. Cadastre a composição de custo dos serviços para um resultado mais fiel. Depende dos dados cadastrados.');

  if (be.break_even_cents === null) {
    return section('Ponto de equilíbrio', el('div', { class: 'card section' }, el('p', { class: 'be-reason' }, REASONS[be.reason]), facts, note));
  }

  const reached = be.remaining_cents === 0;
  const pct = Math.min(be.progress_bp ?? 0, 10_000) / 100;
  const progress = el('div', { class: 'be-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': 'Faturamento em relação ao ponto de equilíbrio' },
    el('div', { class: `be-progress-fill${reached ? ' is-reached' : ''}` }));
  progress.firstChild.style.width = `${pct}%`;

  const nodes = [
    el('div', { class: 'stat-label' }, 'Precisa faturar no período'),
    el('div', { class: 'stat-value num' }, formatCents(be.break_even_cents)),
    progress,
    el('p', { class: reached ? 'be-status is-ok' : 'be-status' },
      reached
        ? `Ponto de equilíbrio atingido (${formatBasisPoints(be.progress_bp)}). Daqui em diante, a margem de contribuição vira lucro.`
        : `Falta faturar ${formatCents(be.remaining_cents)}${be.services_needed
          ? ` — cerca de ${formatInteger(be.services_needed)} ${be.services_needed === 1 ? 'atendimento' : 'atendimentos'} ao ticket médio de ${formatCents(be.avg_ticket_cents)}`
          : ''}.`),
  ];

  if (be.cumulative?.length > 1) {
    const chart = chartBox('Faturamento acumulado comparado ao ponto de equilíbrio', 200);
    nodes.push(chart.element);
    charts.push(() => {
      const c = themeColors();
      return renderChart(chart.canvas, {
        type: 'line',
        data: {
          labels: be.cumulative.map((p) => formatDate(p.date).slice(0, 5)),
          datasets: [
            { label: 'Faturamento acumulado', data: be.cumulative.map((p) => p.revenue_cents), ...lineStyle(c.series1, c.surface), pointRadius: 0 },
            { label: 'Ponto de equilíbrio', data: be.cumulative.map(() => be.break_even_cents), ...lineStyle(c.series2, c.surface), pointRadius: 0, borderDash: [6, 4] },
          ],
        },
        options: baseOptions(),
      });
    });
  }
  return section('Ponto de equilíbrio', el('div', { class: 'card section' }, ...nodes, facts, note));
}

function horizontalBars(title, label, items, charts, { valueOf, nameOf, empty }) {
  if (!items.length) return section(title, el('div', { class: 'card' }, stateView({ title: empty })));
  const top = items.slice(0, 8);
  const chart = chartBox(label, Math.max(140, top.length * 40));
  charts.push(() => {
    const c = themeColors();
    return renderChart(chart.canvas, {
      type: 'bar',
      data: { labels: top.map(nameOf), datasets: [{ label, data: top.map(valueOf), ...barStyle(c.series1) }] },
      options: baseOptions({ horizontal: true, legend: false }),
    });
  });
  return { chart, top };
}

function categoriesSection(cat, charts) {
  const res = horizontalBars('Onde estou gastando', 'Gasto por categoria', cat.items, charts, {
    valueOf: (i) => i.total_cents, nameOf: (i) => i.name, empty: 'Nenhuma despesa no período',
  });
  if (!res.chart) return res;
  return section('Onde estou gastando',
    el('div', { class: 'card' }, res.chart.element,
      el('ul', { class: 'list rank-list' }, cat.items.map((i) => el('li', { class: 'list-row' },
        el('span', {}, el('strong', {}, i.name), el('small', { class: 'hint movement-meta' },
          [i.variable_costs_cents ? 'custo variável' : null, i.fixed_cents ? 'despesa fixa' : null, i.other_cents ? 'outra' : null].filter(Boolean).join(' · '))),
        el('span', { class: 'rank-value' }, el('strong', { class: 'num' }, formatCents(i.total_cents)), el('small', { class: 'hint' }, formatBasisPoints(i.share_bp))))))));
}

function servicesSection(svc, charts) {
  const res = horizontalBars('Por serviço', 'Receita por serviço', svc.items, charts, {
    valueOf: (i) => i.revenue_cents, nameOf: (i) => i.name, empty: 'Nenhuma receita no período',
  });
  if (!res.chart) return res;
  return section('Por serviço',
    el('div', { class: 'card' }, res.chart.element,
      el('ul', { class: 'list rank-list' }, svc.items.map((i) => el('li', { class: 'list-row' },
        el('span', {}, el('strong', {}, i.name),
          el('small', { class: 'hint movement-meta' }, `${formatInteger(i.count)} × média ${formatCents(i.avg_price_cents)}`
            + (i.estimated_cost_cents !== null ? ` · custo est. ${formatCents(i.estimated_cost_cents)}` : ''))),
        el('span', { class: 'rank-value' }, el('strong', { class: 'num' }, formatCents(i.revenue_cents)),
          el('small', { class: 'hint' }, i.estimated_margin_bp !== null ? `margem est. ${formatBasisPoints(i.estimated_margin_bp)}` : formatBasisPoints(i.share_bp)))))),
      el('p', { class: 'hint' }, 'Custo e margem por serviço são estimativas: usam o custo estimado gravado em cada venda.')));
}

function paymentsSection(fin) {
  const used = fin.payment_methods.filter((m) => m.count > 0);
  if (!used.length) return section('Formas de pagamento', el('div', { class: 'card' }, stateView({ title: 'Nenhuma receita no período' })));
  return section('Formas de pagamento',
    el('ul', { class: 'card list' }, used.map((m) => {
      const bar = el('div', { class: 'share-bar' }, el('div', { class: 'share-fill' }));
      bar.firstChild.style.width = `${(m.share_bp ?? 0) / 100}%`;
      return el('li', { class: 'share-row' },
        el('div', { class: 'list-row' }, el('span', {}, PAYMENT_LABELS[m.method]),
          el('span', {}, el('strong', { class: 'num' }, formatCents(m.total_cents)), ' ', el('small', { class: 'hint' }, formatBasisPoints(m.share_bp)))),
        bar);
    })));
}

/* Carregamento ------------------------------------------------------------------------- */

async function load(query) {
  const id = ++seq;
  root.replaceChildren(...[1, 2, 3].map(() => el('div', { class: 'card' }, el('div', { class: 'skeleton sk-line' }), el('div', { class: 'skeleton sk-value' }))));
  try {
    const [fin, be, cat, svc] = await Promise.all(
      ['financial', 'break-even', 'categories', 'services'].map((r) => api.get(`/reports/${r}?${query}`)),
    );
    if (id !== seq) return;
    const charts = [];
    root.replaceChildren(
      resultSection(fin),
      breakEvenSection(be, charts),
      evolutionSection(fin, charts),
      categoriesSection(cat, charts),
      servicesSection(svc, charts),
      paymentsSection(fin),
    );
    root.querySelectorAll('.chart-canvas').forEach((box) => { box.style.height = `${box.dataset.h}px`; });
    await Promise.all(charts.map((draw) => draw()));
  } catch (error) {
    if (id !== seq) return;
    root.replaceChildren(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: () => load(query) }));
  }
}

function init() {
  if (!session) return;
  if (session.user.role !== 'ADMIN') {
    document.getElementById('period-chips').hidden = true;
    root.replaceChildren(stateView({ title: 'Relatórios do administrador', message: 'Os relatórios financeiros ficam disponíveis apenas para o administrador do lava-jato.' }));
    return;
  }
  periodPicker({
    container: document.getElementById('period-chips'),
    storageKey: 'lj.analise.period',
    onChange: ({ label, query }) => {
      document.getElementById('period-label').textContent = label;
      load(query);
    },
  });
}

init();
