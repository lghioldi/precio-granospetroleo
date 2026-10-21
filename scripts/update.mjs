// Consulta granos y petróleo y guarda el resultado en site/data.json.
// Lo ejecuta GitHub Actions (ver .github/workflows/update.yml).
//
// GRANOS: fuente principal = pizarra de la Cámara Arbitral de Cereales (BCR Rosario).
//         Respaldo = API de granos.ar (si la página de la BCR no responde o cambia).
// PETRÓLEO: OilPriceAPI.
//
// Colores de las tarjetas (comparación diaria):
//  - Granos: precio de la rueda actual contra la rueda anterior guardada en el historial.
//            Si todavía no hay historial, usa la variación que informa granos.ar (si es de la misma rueda).
//  - Petróleo: precio actual contra el último precio guardado del día anterior.

import { readFile, writeFile } from 'node:fs/promises';

/* ========================= CONFIGURACIÓN ========================= */
const CONFIG = {
  bcrUrl: 'https://www.cac.bcr.com.ar/es/precios-de-pizarra',
  grainsApiUrl: 'https://granosar.lfcaucino.workers.dev/api/v1/pizarra',   // respaldo
  oilCode: 'WTI_USD',                      // o BRENT_CRUDE_USD
  oilApiKey: process.env.OIL_API_KEY ?? '', // se carga como Secret en GitHub
  file: 'site/data.json',
  timeZone: 'America/Argentina/Buenos_Aires',
  historyDays: 10,                          // fechas de historial que se conservan
};
/* ================================================================= */

const OIL_URL = 'https://api.oilpriceapi.com/v1/prices/latest';
// Rueda inicial de referencia (valores reales del 19/10/2026: la BCR y granos.ar coinciden).
// Permite comparar desde la primera rueda nueva sin esperar a juntar historial propio.
const SEED = { '2026-10-19': { soja: 364.24, maiz: 185.95, trigo: 233.98 } };
const UA = 'tablero-mercados (GitHub Actions)';
const GRAINS = [
  { id: 'soja',  re: 'Soja' },
  { id: 'maiz',  re: 'Ma[ií]z' },
  { id: 'trigo', re: 'Trigo' },
];
const num = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: CONFIG.timeZone }); // AAAA-MM-DD
const withSign = (v) => `${v > 0 ? '+' : ''}${num.format(v)}%`;
const trendFromPct = (v) =>
  typeof v !== 'number' || Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'up' : 'down';
const dmy = (iso) => iso.split('-').reverse().join('/');
const parseAr = (s) => Number(s.replace(/\./g, '').replace(',', '.'));   // "233,98" -> 233.98

async function getJson(url, options, name) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${name}: respondió HTTP ${res.status}`);
  return res.json();
}

/* ---------- Granos: pizarra de la BCR (lee el texto de la página) ---------- */
function htmlToText(html) {
  const named = { nbsp: ' ', amp: '&', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ' };
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ');
}

async function fetchBcr() {
  const res = await fetch(CONFIG.bcrUrl, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`BCR: respondió HTTP ${res.status}`);
  const text = htmlToText(await res.text());

  const d = text.match(/Precios\s+Pizarra\s+del\s+d[ií]a\s+(\d{2})\/(\d{2})\/(\d{4})/i);
  if (!d) throw new Error('BCR: no se encontró la fecha de la pizarra (la página pudo haber cambiado)');
  const fecha = `${d[3]}-${d[2]}-${d[1]}`;

  const grains = {};
  for (const { id, re } of GRAINS) {
    // Ej.: "Trigo $354.600,00 US$ 233,98"  (puede traer "S/C" y "(E)" en otros granos)
    const m = text.match(new RegExp(`${re}\\s+(?:S/C\\s*)?(?:\\(E\\)\\s*)?\\$\\s*[\\d.]+,\\d+\\s+US\\$\\s*(?:\\(E\\)\\s*)?([\\d.]+,\\d+)`, 'i'));
    if (!m) throw new Error(`BCR: no se encontró el precio de ${id} (la página pudo haber cambiado)`);
    grains[id] = parseAr(m[1]);
  }
  return { fecha, grains, source: 'BCR' };
}

/* ---------- Granos: API de granos.ar (respaldo) ---------- */
async function fetchGrainsApi() {
  const json = await getJson(CONFIG.grainsApiUrl, {}, 'API de granos');
  const data = json.data ?? json;
  const grains = {}, pct = {};
  for (const { id } of GRAINS) {
    const g = data.granos?.[id];
    if (!g || typeof g.usd_tn !== 'number') continue;
    grains[id] = g.usd_tn;
    pct[id] = g.variacion_pct_vs_rueda_anterior;
  }
  if (!data.fecha || !Object.keys(grains).length) throw new Error('API de granos: respuesta sin cotizaciones');
  return { fecha: data.fecha, grains, pct, source: 'granos.ar' };
}

async function getGrains(history) {
  const [b, a] = await Promise.allSettled([fetchBcr(), fetchGrainsApi()]);
  if (b.status === 'rejected') console.log(`::warning::${b.reason.message}. Se usa granos.ar como respaldo.`);
  if (b.status === 'rejected' && a.status === 'rejected') {
    throw new Error(`Granos: ${b.reason.message}; ${a.reason.message}`);
  }
  const src = b.status === 'fulfilled' ? b.value : a.value;
  const api = a.status === 'fulfilled' ? a.value : null;
  const at = new Date().toISOString();

  return Object.entries(src.grains).map(([id, price]) => {
    const hist = history[id] ?? (history[id] = {});
    for (const [f, vals] of Object.entries(SEED)) if (vals[id] != null && hist[f] == null) hist[f] = vals[id];
    const prevDates = Object.keys(hist).filter((f) => f < src.fecha).sort();
    let pct = null;
    if (prevDates.length) {
      const ref = hist[prevDates.at(-1)];
      pct = ((price - ref) / ref) * 100;
    } else if (api && api.fecha === src.fecha && typeof api.pct?.[id] === 'number') {
      pct = api.pct[id];            // aún sin historial propio: usa la variación de granos.ar
    }
    hist[src.fecha] = price;
    const cmp = pct == null ? 'sin rueda anterior para comparar' : `${withSign(pct)} vs. rueda anterior`;
    return { id, price, at, trend: trendFromPct(pct), note: `Pizarra del ${dmy(src.fecha)} (${src.source}) · ${cmp}` };
  });
}

/* ---------- Petróleo ---------- */
async function fetchOil(history) {
  if (!CONFIG.oilApiKey) throw new Error('Falta el Secret OIL_API_KEY');
  const json = await getJson(
    `${OIL_URL}?by_code=${encodeURIComponent(CONFIG.oilCode)}`,
    { headers: { Authorization: `Token ${CONFIG.oilApiKey}` } },
    'OilPriceAPI',
  );
  const price = Number(json.data?.price);
  if (!Number.isFinite(price)) throw new Error('OilPriceAPI no devolvió un precio válido');

  const days = Object.keys(history).filter((d) => d < today()).sort();
  const ref = days.length ? history[days.at(-1)] : null;
  const pct = ref ? ((price - ref) / ref) * 100 : null;
  history[today()] = price;          // último precio visto hoy

  return [{
    id: 'petroleo',
    price,
    at: json.data.created_at ?? new Date().toISOString(),
    label: CONFIG.oilCode.startsWith('BRENT') ? 'Petróleo Brent' : 'Petróleo WTI',
    note: pct == null ? 'Sin dato de ayer todavía' : `${withSign(pct)} vs. ayer (US$ ${num.format(ref)})`,
    trend: trendFromPct(pct),
  }];
}

const prune = (obj) =>
  Object.fromEntries(Object.keys(obj).sort().slice(-CONFIG.historyDays).map((k) => [k, obj[k]]));

async function main() {
  let old = { items: {} };
  try { old = JSON.parse(await readFile(CONFIG.file, 'utf8')); } catch { /* primera vez */ }

  const items = { ...old.items };
  const history = {
    petroleo: { ...(old.history?.petroleo ?? {}) },
    granos: Object.fromEntries(Object.entries(old.history?.granos ?? {}).map(([k, v]) => [k, { ...v }])),
  };
  const errors = [];

  const [grains, oil] = await Promise.allSettled([getGrains(history.granos), fetchOil(history.petroleo)]);
  for (const r of [grains, oil]) {
    if (r.status === 'rejected') {
      errors.push(r.reason.message);
      console.log(`::warning::${r.reason.message}`);
      continue;
    }
    for (const { id, price, at, note, label, trend } of r.value) {
      items[id] = { price, at, trend, note, ...(label && { label }) };
    }
  }

  if (errors.length === 2) {
    console.error('No se pudo actualizar ninguna fuente.');
    process.exitCode = 1;
    return;
  }

  history.petroleo = prune(history.petroleo);
  for (const id of Object.keys(history.granos)) history.granos[id] = prune(history.granos[id]);

  await writeFile(CONFIG.file, JSON.stringify({ updatedAt: new Date().toISOString(), items, history, errors }, null, 2) + '\n');
  console.log('Datos guardados en', CONFIG.file);
}

main();
