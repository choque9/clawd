import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const TOTALS_PATH = path.join(DATA_DIR, 'daily-totals.json');

export function getBogotaDayKey(date = new Date()) {
  // Returns YYYY-MM-DD in America/Bogota.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(date);
}

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const ensureCsv = (file, header) => {
    if (!fs.existsSync(file)) fs.writeFileSync(file, header + '\n', 'utf8');
  };
  ensureCsv(path.join(DATA_DIR, 'facturas.csv'), 'date_iso,source,sender,category,value_cop,currency,notes,media_ref');
  ensureCsv(path.join(DATA_DIR, 'transacciones.csv'), 'date_iso,source,sender,category,value_cop,currency,notes,media_ref');
  ensureCsv(path.join(DATA_DIR, 'no_clasificadas.csv'), 'date_iso,source,sender,category,value_cop,currency,notes,media_ref');
  if (!fs.existsSync(TOTALS_PATH)) {
    fs.writeFileSync(TOTALS_PATH, JSON.stringify({ timezone: 'America/Bogota', days: {} }, null, 2) + '\n', 'utf8');
  }
}

export function readTotals() {
  ensureDataFiles();
  try {
    return JSON.parse(fs.readFileSync(TOTALS_PATH, 'utf8'));
  } catch {
    return { timezone: 'America/Bogota', days: {} };
  }
}

export function writeTotals(totals) {
  ensureDataFiles();
  fs.writeFileSync(TOTALS_PATH, JSON.stringify(totals, null, 2) + '\n', 'utf8');
}

export function appendCsv(kind, row) {
  ensureDataFiles();
  const file = kind === 'FACTURA'
    ? path.join(DATA_DIR, 'facturas.csv')
    : kind === 'TRANSACCION'
      ? path.join(DATA_DIR, 'transacciones.csv')
      : path.join(DATA_DIR, 'no_clasificadas.csv');

  fs.appendFileSync(file, row + '\n', 'utf8');
}

export function recordItem({
  kind, // FACTURA | TRANSACCION | UNKNOWN
  valueCop, // number | null
  source = 'unknown',
  sender = 'unknown',
  notes = '',
  mediaRef = ''
}) {
  ensureDataFiles();

  const now = new Date();
  const dayKey = getBogotaDayKey(now);
  const totals = readTotals();
  totals.days[dayKey] ??= { facturas: 0, transacciones: 0, unknown: 0, count: { facturas: 0, transacciones: 0, unknown: 0 } };

  const v = typeof valueCop === 'number' && Number.isFinite(valueCop) ? Math.abs(valueCop) : 0;

  if (kind === 'FACTURA') {
    totals.days[dayKey].facturas += v;
    totals.days[dayKey].count.facturas += 1;
  } else if (kind === 'TRANSACCION') {
    totals.days[dayKey].transacciones += v;
    totals.days[dayKey].count.transacciones += 1;
  } else {
    totals.days[dayKey].unknown += v;
    totals.days[dayKey].count.unknown += 1;
  }

  writeTotals(totals);

  const dateIso = now.toISOString();
  const currency = 'COP';
  const safe = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '""');
  const csvField = (s) => `"${safe(s)}"`;
  const row = [
    csvField(dateIso),
    csvField(source),
    csvField(sender),
    csvField(kind),
    csvField(valueCop == null ? '' : String(Math.abs(valueCop))),
    csvField(currency),
    csvField(notes),
    csvField(mediaRef)
  ].join(',');

  appendCsv(kind, row);

  return { dayKey, totals: totals.days[dayKey] };
}
