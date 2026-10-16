'use strict';

/* ========================= CONFIGURACIÓN ========================= */
const CONFIG = {
  dataUrl: 'data.json',      // lo genera GitHub Actions
  intervalMs: 1800000,       // 30 minutos
};
/* ================================================================= */

const STORAGE_KEY = 'mercados.ultimos';
const $ = (sel) => document.querySelector(sel);

const load = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {}; } catch { return {}; } };
const save = (v) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };

const fmtPrice = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const formatStamp = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? 'Sin fecha' : fmtDate.format(d); };

const svg = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const ICONS = {
  soja: svg('<ellipse cx="9" cy="9.5" rx="4" ry="5.5" transform="rotate(-25 9 9.5)"/><ellipse cx="15.5" cy="15" rx="4" ry="5.5" transform="rotate(-25 15.5 15)"/>'),
  maiz: svg('<path d="M12 3c3 2 4 6 4 9s-1 6-4 8c-3-2-4-5-4-8s1-7 4-9z"/><path d="M12 3v17M8.5 9h7M8 13h8"/><path d="M5 21c0-4 3-6 7-6M19 21c0-4-3-6-7-6"/>'),
  trigo: svg('<path d="M12 21V8"/><path d="M12 8c-2.5-.5-3.5-2.5-3.5-4.5 2.5.5 3.5 2.5 3.5 4.5zM12 8c2.5-.5 3.5-2.5 3.5-4.5-2.5.5-3.5 2.5-3.5 4.5z"/><path d="M12 13c-2.5-.5-3.5-2.5-3.5-4.5 2.5.5 3.5 2.5 3.5 4.5zM12 13c2.5-.5 3.5-2.5 3.5-4.5-2.5.5-3.5 2.5-3.5 4.5z"/><path d="M12 18c-2.5-.5-3.5-2.5-3.5-4.5 2.5.5 3.5 2.5 3.5 4.5zM12 18c2.5-.5 3.5-2.5 3.5-4.5-2.5.5-3.5 2.5-3.5 4.5z"/>'),
  petroleo: svg('<path d="M12 3c3.2 4.2 6 7 6 11a6 6 0 0 1-12 0c0-4 2.8-6.8 6-11z"/><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5"/>'),
};
const TRENDS = {
  up:   { symbol: '▲', label: 'Subió' },
  down: { symbol: '▼', label: 'Bajó' },
  flat: { symbol: '●', label: 'Sin cambios' },
};
const ASSETS = [
  { id: 'soja',     name: 'Soja',     unit: 'USD por tonelada' },
  { id: 'maiz',     name: 'Maíz',     unit: 'USD por tonelada' },
  { id: 'trigo',    name: 'Trigo',    unit: 'USD por tonelada' },
  { id: 'petroleo', name: 'Petróleo', unit: 'USD por barril' },
];

let shown = load();       // últimos valores recibidos (también quedan en localStorage)
let busy = false;

function buildCards() {
  $('#grid').innerHTML = ASSETS.map((a) => `
    <article class="card" id="card-${a.id}" data-trend="flat">
      <div class="card-head">
        <span class="icon">${ICONS[a.id]}</span>
        <h2>${a.name}</h2>
        <span class="trend" role="img" aria-label="Sin cambios">●</span>
      </div>
      <p class="price"><span class="cur">US$</span><span class="val">--</span></p>
      <p class="unit">${a.unit}</p>
      <p class="note"></p>
      <p class="stamp">Sin datos todavía</p>
    </article>`).join('');
}

function renderCard(id, { animate = false, error = '' } = {}) {
  const card = $(`#card-${id}`);
  const data = shown[id];
  const trend = TRENDS[data?.trend] ? data.trend : 'flat';

  card.dataset.trend = trend;
  const t = card.querySelector('.trend');
  t.textContent = TRENDS[trend].symbol;
  t.setAttribute('aria-label', TRENDS[trend].label);

  if (data?.label) card.querySelector('h2').textContent = data.label;
  card.querySelector('.val').textContent = data ? fmtPrice.format(data.price) : '--';
  card.querySelector('.stamp').textContent = data ? `Actualizado: ${formatStamp(data.at)}` : 'Sin datos todavía';

  const note = card.querySelector('.note');
  note.classList.toggle('err', Boolean(error));
  note.textContent = error || data?.note || '';

  if (animate) {
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
  }
}

function setLoading(on) {
  document.body.classList.toggle('loading', on);
  $('#refreshBtn').disabled = on;
  $('#refreshLabel').textContent = on ? 'Actualizando…' : 'Actualizar ahora';
}

function showAlert(msg) {
  const box = $('#alert');
  box.hidden = !msg;
  box.textContent = msg;
}

async function refresh() {
  if (busy) return;
  busy = true;
  setLoading(true);
  showAlert('');

  try {
    const res = await fetch(`${CONFIG.dataUrl}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const items = json.items ?? {};

    for (const a of ASSETS) {
      if (items[a.id]) { shown[a.id] = items[a.id]; renderCard(a.id, { animate: true }); }
      else renderCard(a.id, { error: shown[a.id] ? 'Sin dato nuevo. Se muestra el último valor guardado.' : 'Todavía no hay datos para esta cotización.' });
    }
    save(shown);
    if (json.errors?.length) showAlert('Alguna fuente no respondió en la última actualización. Se muestran los últimos valores disponibles.');
  } catch {
    ASSETS.forEach((a) => renderCard(a.id, { error: shown[a.id] ? 'No se pudo actualizar. Se muestra el último valor guardado.' : 'No se pudo cargar el dato.' }));
    showAlert('No se pudieron cargar las cotizaciones. Revisá tu conexión y probá de nuevo.');
  } finally {
    setLoading(false);
    busy = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  buildCards();
  ASSETS.forEach((a) => renderCard(a.id));
  $('#refreshBtn').addEventListener('click', refresh);
  refresh();
  setInterval(refresh, CONFIG.intervalMs);
});
