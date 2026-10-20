const http = require('http');
const https = require('https');

const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';
const NAIVE = process.env.FEE_MODE === 'naive';

const DEADLINE_MS = Number(process.env.BANK_DEADLINE_MS || 4000);
const CONNECT_TIMEOUT_MS = 300;
const MAX_ATTEMPTS = 5;

const lib = BANK_URL.startsWith('https') ? https : http;

function makeAgent() {
  return new lib.Agent({
    keepAlive: true,
    maxSockets: 10,
    maxFreeSockets: 10,
    timeout: 4000,
    scheduling: 'lifo',
  });
}
const agent = makeAgent();
const reconcileAgent = makeAgent();

const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'CONNECT_TIMEOUT']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(path, payload, headers, { timeoutMs, agentToUse }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BANK_URL);
    const data = JSON.stringify(payload);
    const req = lib.request(url, {
      method: 'POST',
      agent: NAIVE ? false : agentToUse,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    });
    let done = false;
    const fail = (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } };

    let timer = null;
    if (timeoutMs != null) {
      timer = setTimeout(() => {
        const e = new Error('Hết thời gian chờ ngân hàng');
        e.code = 'TIMEOUT';
        req.destroy(e);
      }, Math.max(1, timeoutMs));
    }

    req.on('socket', (socket) => {
      if (!NAIVE && socket.connecting) {
        const ct = setTimeout(() => {
          const e = new Error('Không kết nối được tới ngân hàng');
          e.code = 'CONNECT_TIMEOUT';
          req.destroy(e);
        }, CONNECT_TIMEOUT_MS);
        socket.once('connect', () => clearTimeout(ct));
        socket.once('close', () => clearTimeout(ct));
      }
    });

    req.on('response', (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (done) return;
        done = true; clearTimeout(timer);
        let body = null;
        try { body = buf ? JSON.parse(buf) : null; } catch { body = { raw: buf }; }
        resolve({ status: res.statusCode, body });
      });
      res.on('error', fail);
      res.on('aborted', () => { const e = new Error('Đứt kết nối khi đang nhận'); e.code = 'ECONNRESET'; fail(e); });
    });
    req.on('error', fail);
    req.end(data);
  });
}

async function charge(reference, amount, opts = {}) {
  const deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
  const agentToUse = opts.reconcile ? reconcileAgent : agent;
  const headers = { 'Idempotency-Key': reference };

  if (NAIVE) {
    try {
      const r = await once('/charges', { reference, amount }, {}, { timeoutMs: null });
      if (r.status === 201) return { outcome: 'PAID', charge: r.body };
      if (r.status >= 400 && r.status < 500) return { outcome: 'DECLINED', httpStatus: r.status, body: r.body };
      return { outcome: 'UNKNOWN', error: `HTTP ${r.status}` };
    } catch (e) {
      return { outcome: 'UNKNOWN', error: e.message };
    }
  }

  const start = Date.now();
  let uncertain = false;
  let lastError = '';
  let connectFailures = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadlineMs - (Date.now() - start);
    if (remaining <= 50) break;
    try {
      const r = await once('/charges', { reference, amount }, headers, { timeoutMs: remaining, agentToUse });
      if (r.status === 201) return { outcome: 'PAID', charge: r.body };
      if (r.status >= 400 && r.status < 500) {
        return { outcome: 'DECLINED', httpStatus: r.status, body: r.body };
      }
      lastError = `Ngân hàng trả HTTP ${r.status}`;
    } catch (e) {
      lastError = e.message || e.code;
      if (e.code === 'TIMEOUT') { uncertain = true; break; }
      if (!CONNECT_ERRORS.has(e.code)) uncertain = true;
      else if (++connectFailures >= 2) break;
    }
    const backoff = Math.min(400, 50 * 2 ** (attempt - 1)) * (0.5 + Math.random());
    if (deadlineMs - (Date.now() - start) <= backoff + 50) break;
    await sleep(backoff);
  }
  return uncertain ? { outcome: 'UNKNOWN', error: lastError } : { outcome: 'UNAVAILABLE', error: lastError };
}

module.exports = { charge, BANK_URL, NAIVE };
