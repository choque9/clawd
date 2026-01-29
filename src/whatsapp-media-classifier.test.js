import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

import { classifyInboundMedia } from './whatsapp-media-classifier.js';

// Minimal test: unsupported media routes to no_clasificadas.
const tmp = path.join('inbox', 'test.txt');
fs.mkdirSync('inbox', { recursive: true });
fs.writeFileSync(tmp, 'hello');

const res = await classifyInboundMedia({ mediaPath: tmp, meta: { source: 'dm', sender: 'tester', receivedAtIso: new Date().toISOString() } });
assert.equal(res.category, 'UNKNOWN');

console.log('ok');
