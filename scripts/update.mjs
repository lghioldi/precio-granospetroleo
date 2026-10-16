// Consulta las APIs de granos y petróleo y guarda el resultado en site/data.json.
// Lo ejecuta GitHub Actions cada 30 minutos (ver .github/workflows/update.yml).
//
// Colores de las tarjetas (comparación diaria):
//  - Granos: variación contra la rueda anterior que informa la propia API.
//  - Petróleo: precio actual contra el último precio guardado del día anterior.

import { readFile, writeFile } from 'node:fs/promises';

/* ========================= CONFIGURACIÓN ========================= */
const CONFIG = {
  grainsUrl: 'https://granosar.lfcaucino.workers.dev/api/v1/pizarra',
  oilCode: 'WTI_USD',                      // o BRENT_CRUDE_USD
  oilApiKey: process.env.OIL_API_KEY ?? '', // se carga como Secret en GitHub
  file: 'site/data.json',
  timeZone: 'America/Argentina/Buenos_Aires',
  historyDays: 7,                           // días de historial que se conservan
};
/* ================================================================= */

const OIL_URL = 'https://api.oilpriceapi.com/v1/prices/latest';
const num = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: CONFIG.timeZone }); // AAAA-MM-DD
const withSign = (v) => `${v > 0 ? '+' : ''}${num.format(v)}%`;
const trendFromPct = (v) =>
  typeof v !== 'number' || Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'up' : 'down';

async function getJson(url, options, name) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${name}: respondió HTTP ${res.status}`);
  return res.json();
}

async function fetchGrains() {
  const json = await getJson(CONFIG.grainsUrl, {}, 'API de granos');
  const data = json.data ?? json;
  const at = json.meta?.generado_en ?? new Date().toISOString();
  const rueda = data.fecha ? data.fecha.split('-').reverse().join('/') : null;

  return ['soja', 'maiz', 'trigo'].flatMap((id) => {
    const g = data.granos?.[id];
    if (!g || typeof g.usd_tn !== 'number') return [];
    const v = g.variacion_pct_vs_rueda_anterior;
    const note = [
      rueda && `Pizarra del ${rueda}`,
      typeof v === 'number' && `${withSign(v)} vs. rueda anterior`,
    ].filter(Boolean).join(' · ');
    return [{ id, price: g.usd_tn, at, note, trend: trendFromPct(v) }];
  });
}

async function fetchOil(history) {
  if (!CONFIG.oilApiKey) throw new Error('Falta el Secret OIL_API_KEY');
  const json = await getJson(
    `${OIL_URL}?by_code=${encodeURIComponent(CONFIG.oilCode)}`,
    { headers: { Authorization: `Token ${CONFIG.oilApiKey}` } },
    'OilPriceAPI',
  );
  const price = Number(json.data?.price);
  if (!Number.isFinite(price)) throw new Error('OilPriceAPI no devolvió un precio válido');

  // Referencia: último precio guardado de un día anterior a hoy
  const days = Object.keys(history).filter((d) => d < today()).sort();
  const ref = days.length ? history[days.at(-1)] : null;
  const pct = ref ? ((price - ref) / ref) * 100 : null;

  return [{
    id: 'petroleo',
    price,
    at: json.data.created_at ?? new Date().toISOString(),
    label: CONFIG.oilCode.startsWith('BRENT') ? 'Petróleo Brent' : 'Petróleo WTI',
    note: pct == null ? 'Sin dato de ayer todavía' : `${withSign(pct)} vs. ayer (US$ ${num.format(ref)})`,
    trend: trendFromPct(pct),
  }];
}

async function main() {
  let old = { items: {} };
  try { old = JSON.parse(await readFile(CONFIG.file, 'utf8')); } catch { /* primera vez */ }

  const items = { ...old.items };
  const history = { petroleo: { ...(old.history?.petroleo ?? {}) } };
  const errors = [];

  const [grains, oil] = await Promise.allSettled([fetchGrains(), fetchOil(history.petroleo)]);
  for (const r of [grains, oil]) {
    if (r.status === 'rejected') {
      errors.push(r.reason.message);
      console.log(`::warning::${r.reason.message}`);
      continue;
    }
    for (const { id, price, at, note, label, trend } of r.value) {
      items[id] = { price, at, trend, note, ...(label && { label }) };
      if (id === 'petroleo') history.petroleo[today()] = price;   // último precio visto hoy
    }
  }

  if (errors.length === 2) {
    console.error('No se pudo actualizar ninguna fuente.');
    process.exitCode = 1;
    return;
  }

  // Conservar solo los últimos días del historial
  const keep = Object.keys(history.petroleo).sort().slice(-CONFIG.historyDays);
  history.petroleo = Object.fromEntries(keep.map((d) => [d, history.petroleo[d]]));

  await writeFile(CONFIG.file, JSON.stringify({ updatedAt: new Date().toISOString(), items, history, errors }, null, 2) + '\n');
  console.log('Datos guardados en', CONFIG.file);
}

main();
