const express = require('express');

const PORT = Number(process.env.PORT || 4002);
const DELAY_MS = Number(process.env.DELAY_MS || 0);
const FAIL_RATE = Number(process.env.FAIL_RATE || 0);
const DROP_RATE = Number(process.env.DROP_RATE || 0);
const LIMIT = 20_000_000;
const QUIET = process.env.QUIET === '1';

const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };
const idempotency = new Map();
const chargedRefs = new Map();
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();
app.use(express.json());
app.use('/charges', (req, res, next) => { stats.requests++; next(); });

app.get('/stats', (req, res) => res.json(stats));

app.post('/stats/reset', (req, res) => {
  Object.assign(stats, { connections: 0, requests: 0, charges: 0, duplicates: 0 });
  idempotency.clear();
  chargedRefs.clear();
  res.json(stats);
});

async function processCharge(reference, amount) {
  if (DELAY_MS > 0) await sleep(DELAY_MS);

  if (typeof reference !== 'string' || !reference ||
      typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return { status: 400, body: { error: 'INVALID_AMOUNT', message: 'Số tiền hoặc reference không hợp lệ' } };
  }
  if (amount > LIMIT) {
    return { status: 402, body: { error: 'LIMIT_EXCEEDED', message: `Vượt hạn mức ${LIMIT}đ` } };
  }
  if (Math.random() < FAIL_RATE) {
    return { status: 500, body: { error: 'INTERNAL_ERROR', message: 'Lỗi tạm thời' }, retryable: true };
  }

  const n = (chargedRefs.get(reference) || 0) + 1;
  chargedRefs.set(reference, n);
  if (n > 1) stats.duplicates++;
  stats.charges++;
  const chargeId = `CH${++seq}`;
  return { status: 201, body: { chargeId, reference, amount, status: 'SUCCEEDED' }, fresh: true };
}

app.post('/charges', async (req, res) => {
  const { reference, amount } = req.body || {};
  const key = req.get('Idempotency-Key');

  let result;
  if (key && idempotency.has(key)) {
    result = { ...(await idempotency.get(key)), fresh: false };
  } else {
    const p = processCharge(reference, amount);
    if (key) idempotency.set(key, p);
    result = await p;
    if (key && result.retryable) idempotency.delete(key);
  }

  if (result.fresh && Math.random() < DROP_RATE) {
    if (!QUIET) console.log(`[bank] DROP sau khi trừ tiền ${reference}`);
    req.socket.destroy();
    return;
  }
  res.status(result.status).json(result.body);
});

const server = app.listen(PORT, () => {
  console.log(`[bank] listening :${PORT} DELAY_MS=${DELAY_MS} FAIL_RATE=${FAIL_RATE} DROP_RATE=${DROP_RATE}`);
});
server.on('connection', (socket) => {
  stats.connections++;
  if (!QUIET) console.log(`[bank] kết nối TCP mới #${stats.connections} từ ${socket.remotePort}`);
});
