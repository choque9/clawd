#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { classifyInboundMedia } from './whatsapp-media-classifier.js';
import { recordItem } from './wa-ledger.js';

// Usage:
//   node src/wa-process-media.js <mediaPath> [--source dm|group] [--sender +57...] [--messageId ...]
// Outputs JSON to stdout:
//   { kind, valueCop, totals, dayKey, notifyText, mediaRef, dedup }

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

function sha1File(p) {
  const h = crypto.createHash('sha1');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function fmtCop(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'no identificado';
  return n.toLocaleString('es-CO');
}

const mediaPath = process.argv[2];
if (!mediaPath) {
  console.error('Missing <mediaPath>');
  process.exit(2);
}

const source = arg('source', 'unknown');
const sender = arg('sender', 'unknown');
const messageId = arg('messageId', '');

const mediaAbs = path.resolve(mediaPath);
const mediaName = path.basename(mediaAbs);
const mediaRef = `${sha1File(mediaAbs).slice(0, 12)}:${mediaName}`;

// Dedup by mediaRef
const seenPath = path.resolve('data/seen.json');
let seen = { seen: {} };
try { seen = JSON.parse(fs.readFileSync(seenPath, 'utf8')); } catch {}
seen.seen ??= {};
if (seen.seen[mediaRef]) {
  const out = {
    dedup: true,
    kind: 'DUPLICATE',
    valueCop: null,
    dayKey: null,
    totals: null,
    notifyText: null,
    mediaRef,
    firstSeenAt: seen.seen[mediaRef]
  };
  console.log(JSON.stringify(out));
  process.exit(0);
}
seen.seen[mediaRef] = new Date().toISOString();
fs.mkdirSync(path.dirname(seenPath), { recursive: true });
fs.writeFileSync(seenPath, JSON.stringify(seen, null, 2) + '\n');

const res = await classifyInboundMedia({ mediaPath: mediaAbs, meta: { source, sender, messageId } });

const kind = res.category === 'FACTURA' ? 'FACTURA' : res.category === 'TRANSACCION' ? 'TRANSACCION' : 'UNKNOWN';
const valueCop = (typeof res.value_cop === 'number' && Number.isFinite(res.value_cop)) ? Math.abs(res.value_cop) : null;

const notes = res.notes || '';
const ledger = recordItem({ kind, valueCop, source, sender, notes, mediaRef });

const totals = ledger.totals;
const notifyText = [
  `${kind === 'UNKNOWN' ? 'NO CLASIFICADA' : kind} detectada`,
  `Valor: ${valueCop == null ? 'no identificado' : fmtCop(valueCop)} COP`,
  `Totales hoy (${ledger.dayKey}): FACTURAS ${fmtCop(totals.facturas)} COP | TRANSACCIONES ${fmtCop(totals.transacciones)} COP`,
  `Remitente: ${sender}`,
  `Media: ${mediaName}`
].join('\n');

console.log(JSON.stringify({
  dedup: false,
  kind,
  valueCop,
  dayKey: ledger.dayKey,
  totals,
  notifyText,
  mediaRef
}));
