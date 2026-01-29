import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { createWorker } from 'tesseract.js';

// Minimal, reliable implementation that does NOT depend on Clawdbot internal WhatsApp APIs.
// It classifies media files dropped into `inbox/` and emits notifications by writing
// `outbox/notify-william.txt` (to be sent by the main agent/runtime).
//
// Why: in this workspace we don't have the Clawdbot CLI/runtime sources. This module is
// designed to be callable from whatever inbound hook exists; it just needs:
//  - metadata: { source, sender, chatId, receivedAtIso }
//  - mediaPath: local file path to image/pdf
//
// The main agent can wire it into the correct hook once identified.

const TZ = 'America/Bogota';
const DATA_DIR = path.resolve('data');
const INBOX_DIR = path.resolve('inbox');
const OUTBOX_DIR = path.resolve('outbox');

const FACTURAS_CSV = path.join(DATA_DIR, 'facturas.csv');
const TRANSACCIONES_CSV = path.join(DATA_DIR, 'transacciones.csv');
const NO_CLASIFICADAS_CSV = path.join(DATA_DIR, 'no_clasificadas.csv');
const TOTALS_JSON = path.join(DATA_DIR, 'daily-totals.json');

const WILLIAM = '+573126027280';

function ensureDirsAndFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });

  if (!fs.existsSync(FACTURAS_CSV)) {
    fs.writeFileSync(
      FACTURAS_CSV,
      'date_iso,source,sender,category,value_cop,currency,notes,media_ref\n'
    );
  }
  if (!fs.existsSync(TRANSACCIONES_CSV)) {
    fs.writeFileSync(
      TRANSACCIONES_CSV,
      'date_iso,source,sender,category,value_cop,currency,notes,media_ref\n'
    );
  }
  if (!fs.existsSync(NO_CLASIFICADAS_CSV)) {
    fs.writeFileSync(
      NO_CLASIFICADAS_CSV,
      'date_iso,source,sender,category,value_cop,currency,notes,media_ref\n'
    );
  }

  if (!fs.existsSync(TOTALS_JSON)) {
    fs.writeFileSync(
      TOTALS_JSON,
      JSON.stringify({ timezone: TZ, days: {} }, null, 2) + '\n'
    );
  }
}

function bogotaDayKey(date = new Date()) {
  // Get YYYY-MM-DD in America/Bogota without Intl Temporal.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date); // en-CA gives YYYY-MM-DD
}

function nowBogotaIso() {
  return new Date().toISOString();
}

function sha1File(p) {
  const h = crypto.createHash('sha1');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function parseCOPAmount(raw) {
  if (!raw) return null;
  let s = String(raw)
    .toUpperCase()
    .replace(/COP/g, '')
    .replace(/\$/g, '')
    .replace(/\s+/g, ' ');

  // Capture common number formats: 1.234.567, 1,234,567, 1234567, 1.234,56
  const m = s.match(/([0-9]{1,3}([\.,][0-9]{3})+|[0-9]+)([\.,][0-9]{2})?/);
  if (!m) return null;

  let num = m[1];
  // If it contains both '.' and ',', decide decimal separator by last occurrence.
  const lastDot = num.lastIndexOf('.');
  const lastComma = num.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    if (lastDot > lastComma) {
      // dot decimal, commas thousand
      num = num.replace(/,/g, '');
    } else {
      // comma decimal, dots thousand
      num = num.replace(/\./g, '').replace(/,/g, '.');
    }
  } else {
    // Only one separator type. Assume thousands separators; remove them.
    num = num.replace(/[\.,](?=\d{3}(\D|$))/g, '');
    // Keep possible decimal part if any (rare in COP). If after removal still has '.' with 2 decimals, allow.
  }

  const val = Math.round(Number.parseFloat(num));
  if (!Number.isFinite(val) || val <= 0) return null;
  return val;
}

function extractInvoiceTotal(text) {
  const t = text.toUpperCase();
  const patterns = [
    /TOTAL\s*(A\s*PAGAR)?\s*[:\-]?\s*(\$?\s*[0-9][0-9\.,\s]{2,})/i,
    /VALOR\s*TOTAL\s*[:\-]?\s*(\$?\s*[0-9][0-9\.,\s]{2,})/i,
    /TOTAL\s*[:\-]?\s*(\$?\s*[0-9][0-9\.,\s]{2,})/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const amt = parseCOPAmount(m[m.length - 1]);
      if (amt) return amt;
    }
  }
  return null;
}

function extractTransactionAmount(text) {
  const t = text.toUpperCase();
  const patterns = [
    /(VALOR|MONTO|IMPORTE)\s*(DE\s*LA\s*TRANSACCI[ÓO]N)?\s*[:\-]?\s*(\$?\s*[0-9][0-9\.,\s]{2,})/i,
    /(ABONO|CREDITO|CR[ÉE]DITO|CONSIGNACI[ÓO]N|PAGO\s*RECIBIDO)\s*[:\-]?\s*(\$?\s*[0-9][0-9\.,\s]{2,})/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const amt = parseCOPAmount(m[m.length - 1]);
      if (amt) return Math.abs(amt);
    }
  }
  // fallback: largest amount in the doc
  const amounts = [];
  const re = /(\$?\s*[0-9]{1,3}([\.,][0-9]{3})+|\$?\s*[0-9]{4,})([\.,][0-9]{2})?/g;
  let mm;
  while ((mm = re.exec(t))) {
    const amt = parseCOPAmount(mm[0]);
    if (amt) amounts.push(amt);
  }
  if (amounts.length) return Math.max(...amounts);
  return null;
}

function classifyByKeywords(text) {
  const t = text.toUpperCase();

  const invoiceHints = ['FACTURA', 'NIT', 'IVA', 'SUBTOTAL', 'TOTAL', 'RESOLUCION', 'DIAN'];
  const txnHints = ['TRANSACCI', 'COMPROBANTE', 'NEQUI', 'DAVIPLATA', 'BANCO', 'ABONO', 'CREDITO', 'CONSIGNACI', 'PAGO RECIBIDO', 'REFERENCIA'];

  const invoiceScore = invoiceHints.reduce((acc, k) => acc + (t.includes(k) ? 1 : 0), 0);
  const txnScore = txnHints.reduce((acc, k) => acc + (t.includes(k) ? 1 : 0), 0);

  if (invoiceScore === 0 && txnScore === 0) return 'UNKNOWN';
  if (invoiceScore >= txnScore + 1) return 'FACTURA';
  if (txnScore >= invoiceScore + 1) return 'TRANSACCION';
  return 'UNKNOWN';
}

async function ocrImageToText(imagePath) {
  const worker = await createWorker('spa+eng');
  try {
    const { data } = await worker.recognize(imagePath);
    return data.text || '';
  } finally {
    await worker.terminate();
  }
}

function appendCsvRow(file, row) {
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[\n\r,\"]/g.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  fs.appendFileSync(file, row.map(esc).join(',') + '\n');
}

function loadTotals() {
  const raw = fs.readFileSync(TOTALS_JSON, 'utf8');
  const obj = JSON.parse(raw);
  if (!obj.days) obj.days = {};
  return obj;
}

function saveTotals(obj) {
  fs.writeFileSync(TOTALS_JSON, JSON.stringify(obj, null, 2) + '\n');
}

function bumpTotals(dayKey, category, amount) {
  const totals = loadTotals();
  totals.timezone = TZ;
  totals.days[dayKey] ||= { facturas_cop: 0, transacciones_cop: 0 };
  if (category === 'FACTURA') totals.days[dayKey].facturas_cop += amount;
  if (category === 'TRANSACCION') totals.days[dayKey].transacciones_cop += amount;
  saveTotals(totals);
  return totals.days[dayKey];
}

function queueNotifyWilliam(message) {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const p = path.join(OUTBOX_DIR, `notify-william-${Date.now()}.txt`);
  fs.writeFileSync(p, `TO:${WILLIAM}\n${message}\n`);
  return p;
}

export async function classifyInboundMedia({ mediaPath, meta }) {
  ensureDirsAndFiles();

  const receivedAtIso = meta?.receivedAtIso || nowBogotaIso();
  const receivedAt = new Date(receivedAtIso);
  const dayKey = bogotaDayKey(receivedAt);

  const source = meta?.source || 'unknown';
  const sender = meta?.sender || 'unknown';

  const mediaRef = sha1File(mediaPath).slice(0, 12) + ':' + path.basename(mediaPath);

  // OCR only images for now. PDFs typically require render; keep minimal & reliable.
  const ext = path.extname(mediaPath).toLowerCase();
  let text = '';
  let notes = '';

  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    text = await ocrImageToText(mediaPath);
  } else {
    notes = `unsupported_media_type:${ext || 'none'}`;
  }

  const keywordClass = classifyByKeywords(text);

  let category = keywordClass;
  let value = null;

  if (category === 'FACTURA') {
    value = extractInvoiceTotal(text);
  } else if (category === 'TRANSACCION') {
    value = extractTransactionAmount(text);
    if (value != null) value = Math.abs(value);
  }

  if (category === 'UNKNOWN' || value == null) {
    // uncertain: log to no_clasificadas and notify William.
    appendCsvRow(NO_CLASIFICADAS_CSV, [receivedAtIso, source, sender, category, value ?? '', 'COP', notes || 'no_valor_o_clasificacion', mediaRef]);

    const totals = loadTotals();
    totals.days[dayKey] ||= { facturas_cop: 0, transacciones_cop: 0 };
    const dayTotals = totals.days[dayKey];

    queueNotifyWilliam(
      `CLASIFICACION: NO_CLASIFICADA\n` +
        `Recibido: ${receivedAtIso}\n` +
        `Origen: ${source}\n` +
        `Remitente: ${sender}\n` +
        `Valor: no identificado\n` +
        `Totales hoy (${dayKey}): FACTURAS ${dayTotals.facturas_cop} COP | TRANSACCIONES ${dayTotals.transacciones_cop} COP\n` +
        `Media: ${mediaRef}`
    );

    return { category: 'UNKNOWN', value_cop: null, dayKey, mediaRef };
  }

  const dayTotals = bumpTotals(dayKey, category, value);

  const row = [receivedAtIso, source, sender, category, value, 'COP', notes, mediaRef];
  if (category === 'FACTURA') appendCsvRow(FACTURAS_CSV, row);
  if (category === 'TRANSACCION') appendCsvRow(TRANSACCIONES_CSV, row);

  queueNotifyWilliam(
    `CLASIFICACION: ${category}\n` +
      `Recibido: ${receivedAtIso}\n` +
      `Origen: ${source}\n` +
      `Remitente: ${sender}\n` +
      `Valor: ${value} COP\n` +
      `Totales hoy (${dayKey}): FACTURAS ${dayTotals.facturas_cop} COP | TRANSACCIONES ${dayTotals.transacciones_cop} COP\n` +
      `Media: ${mediaRef}`
  );

  return { category, value_cop: value, dayKey, mediaRef };
}

// Simple runner: process all files in inbox/ once.
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    ensureDirsAndFiles();
    const files = fs.readdirSync(INBOX_DIR).map((f) => path.join(INBOX_DIR, f));
    for (const f of files) {
      if (!fs.statSync(f).isFile()) continue;
      await classifyInboundMedia({ mediaPath: f, meta: { source: 'inbox', sender: 'manual' } });
      const doneDir = path.join(INBOX_DIR, 'processed');
      fs.mkdirSync(doneDir, { recursive: true });
      fs.renameSync(f, path.join(doneDir, path.basename(f)));
    }
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
