// Consulta las APIs de granos y petróleo y guarda el resultado en site/data.json.
// Lo ejecuta GitHub Actions cada 30 minutos (ver .github/workflows/update.yml).

import { readFile, writeFile } from 'node:fs/promises';

/* ========================= CONFIGURACIÓN ========================= */
const CONFIG = {
  grainsUrl: 'https://granosar.lfcaucino.workers.dev/api/v1/pizarra',
  oilCode: 'WTI_USD',                      // o BRENT_CRUDE_USD
  oilApiKey: process.env.OIL_API_KEY ?? '', // se carga como Secret en GitHub
  file: 'site/data.json',
};
/* ================================================================= */

const OIL_URL = 'https://api.oilpriceapi.com/v1/prices/latest';
const pct = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const trendOf = (price, prev) =>
  prev == null || price === prev ? 'flat' : price > prev ? 'up' : 'down';

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
      typeof v === 'number' && `${v > 0 ? '+' : ''}${pct.format(v)}% vs. rueda anterior`,
    ].filter(Boolean).join(' · ');
    return [{ id, price: g.usd_tn, at, note }];
  });
}

async function fetchOil() {
  if (!CONFIG.oilApiKey) throw new Error('Falta el Secret OIL_API_KEY');
  const json = await getJson(
    `${OIL_URL}?by_code=${encodeURIComponent(CONFIG.oilCode)}`,
    { headers: { Authorization: `Token ${CONFIG.oilApiKey}` } },
    'OilPriceAPI',
  );
  const price = Number(json.data?.price);
  if (!Number.isFinite(price)) throw new Error('OilPriceAPI no devolvió un precio válido');
  return [{
    id: 'petroleo',
    price,
    at: json.data.created_at ?? new Date().toISOString(),
    label: CONFIG.oilCode.startsWith('BRENT') ? 'Petróleo Brent' : 'Petróleo WTI',
    note: '',
  }];
}

async function main() {
  let old = { items: {} };
  try { old = JSON.parse(await readFile(CONFIG.file, 'utf8')); } catch { /* primera vez */ }

  const items = { ...old.items };
  const errors = [];

  const [grains, oil] = await Promise.allSettled([fetchGrains(), fetchOil()]);
  for (const r of [grains, oil]) {
    if (r.status === 'rejected') {
      errors.push(r.reason.message);
      console.log(`::warning::${r.reason.message}`);
      continue;
    }
    for (const { id, price, at, note, label } of r.value) {
      const prev = old.items?.[id]?.price ?? null;
      items[id] = { price, at, prev, trend: trendOf(price, prev), note, ...(label && { label }) };
    }
  }

  if (errors.length === 2) {
    console.error('No se pudo actualizar ninguna fuente.');
    process.exitCode = 1;
    return;
  }

  await writeFile(CONFIG.file, JSON.stringify({ updatedAt: new Date().toISOString(), items, errors }, null, 2) + '\n');
  console.log('Datos guardados en', CONFIG.file);
}

main();
