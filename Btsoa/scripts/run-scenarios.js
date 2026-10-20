const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const FEE = 'http://localhost:4001';
const BANK = 'http://localhost:4002';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clientAgent = new http.Agent({ keepAlive: true, maxSockets: 50, timeout: 4000 });
function request(method, url, body) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(url, {
      method, agent: clientAgent,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { json = buf; }
        resolve({ status: res.statusCode, body: json, ms: Math.round(performance.now() - t0) });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: e.message }, ms: Math.round(performance.now() - t0) }));
    req.end(data || undefined);
  });
}
const pay = (id, amount) => request('POST', `${FEE}/students/${id}/payments`, { amount });

const procs = [];
function start(name, script, env) {
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    env: { ...process.env, QUIET: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.logs = '';
  child.stdout.on('data', (d) => (child.logs += d));
  child.stderr.on('data', (d) => (child.logs += d));
  child.name = name;
  procs.push(child);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${name} không khởi động: ${child.logs}`)), 10000);
    const check = () => { if (child.logs.includes('listening')) { clearTimeout(t); resolve(child); } else setTimeout(check, 50); };
    check();
  });
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill();
  await done;
  procs.splice(procs.indexOf(child), 1);
}
async function stopAll() { for (const c of [...procs]) await stop(c); clientAgent.destroy(); await sleep(200); }
const startBank = (env = {}) => start('bank', 'bank-service/server.js', env);
const startFee = (mode, env = {}) => start('fee', 'fee-service/server.js', { FEE_MODE: mode, ...env });

async function pool(n, concurrency, fn) {
  const results = new Array(n);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < n) { const i = next++; results[i] = await fn(i); }
  }));
  return results;
}
const countBy = (arr) => arr.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});

async function scenario1(mode) {
  const out = {};
  let fee = await startFee(mode);
  const r1 = await pay(1, 100000);
  const f1 = await request('GET', `${FEE}/students/1/fees`);
  out.bankDown = { payStatus: r1.status, payMs: r1.ms, payBody: r1.body, feesStatus: f1.status, feesMs: f1.ms, feeAlive: fee.exitCode === null };
  const bank = await startBank();
  const r2 = await pay(1, 100000);
  out.bankBackUp = { payStatus: r2.status, payMs: r2.ms, payBody: r2.body };
  await stop(fee); await stop(bank);

  fee = await startFee(mode, { BANK_URL: 'http://localhost:4999' });
  const r3 = await pay(1, 100000);
  const f3 = await request('GET', `${FEE}/students/1/fees`);
  out.bankUrl4999 = { payStatus: r3.status, payMs: r3.ms, payBody: r3.body, feesStatus: f3.status, feesMs: f3.ms };
  await stopAll();
  return out;
}

async function scenario2(mode) {
  const out = {};
  await startBank({ DELAY_MS: '5000' });
  await startFee(mode, { RECONCILE_MS: '0' });
  const r = await pay(1, 100000);
  out.single = { status: r.status, ms: r.ms, body: r.body };

  const t0 = performance.now();
  const burst = Promise.all(Array.from({ length: 20 }, () => pay(1, 100000)));
  await sleep(300);
  const fees = [];
  for (let i = 0; i < 5; i++) { fees.push((await request('GET', `${FEE}/students/1/fees`)).ms); await sleep(200); }
  const res = await burst;
  out.burst20 = {
    statuses: countBy(res),
    maxMs: Math.max(...res.map((x) => x.ms)),
    totalMs: Math.round(performance.now() - t0),
    feesDuringBurstMs: fees,
    feesMaxMs: Math.max(...fees),
  };
  await stopAll();
  return out;
}

async function scenario3(mode) {
  const out = {};
  await startBank();
  await startFee(mode);
  const t0 = performance.now();
  const res = await pool(200, 10, () => pay(1, 1000));
  out.run200 = {
    statuses: countBy(res),
    totalMs: Math.round(performance.now() - t0),
    bankStats: (await request('GET', `${BANK}/stats`)).body,
  };
  await sleep(6000);
  const after = [];
  for (let i = 0; i < 5; i++) after.push(await pay(1, 1000));
  out.afterIdle6s = {
    statuses: countBy(after),
    bankStats: (await request('GET', `${BANK}/stats`)).body,
  };
  await stopAll();
  return out;
}

async function scenario4(mode) {
  const out = {};
  for (const [label, env] of [['a_drop', { DROP_RATE: '0.3' }], ['b_fail', { FAIL_RATE: '0.3' }]]) {
    await startBank(env);
    await startFee(mode, { RECONCILE_MS: '2000' });
    const debtBefore = (await request('GET', `${FEE}/students/1/fees`)).body.debt;
    const res = [];
    for (let i = 0; i < 60; i++) res.push(await pay(1, 100000));
    const nonOk = res.filter((r) => r.status !== 201);
    const stats = (await request('GET', `${BANK}/stats`)).body;
    const pays = (await request('GET', `${FEE}/payments`)).body;
    const debtAfter = (await request('GET', `${FEE}/students/1/fees`)).body.debt;
    const r = {
      statuses: countBy(res),
      success: res.filter((x) => x.status === 201).length,
      nonSuccessBodies: [...new Set(nonOk.map((x) => `${x.status} ${x.body && x.body.status}`))],
      maxMs: Math.max(...res.map((x) => x.ms)),
      bankStats: stats,
      feePayments: pays,
      debtDecrease: debtBefore - debtAfter,
      debtMatchesPaid: debtBefore - debtAfter === pays.paidAmount,
    };
    if (mode === 'fixed') {
      await sleep(5000);
      const pays2 = (await request('GET', `${FEE}/payments`)).body;
      const stats2 = (await request('GET', `${BANK}/stats`)).body;
      const debt2 = (await request('GET', `${FEE}/students/1/fees`)).body.debt;
      r.afterReconcile = { feePayments: pays2, bankStats: stats2, debtMatchesPaid: debtBefore - debt2 === pays2.paidAmount };
    }
    out[label] = r;
    await stopAll();
  }

  await startBank();
  await startFee(mode);
  const r = await pay(1, 25_000_000);
  out.c_declined = { status: r.status, ms: r.ms, body: r.body, bankStats: (await request('GET', `${BANK}/stats`)).body };
  await stopAll();
  return out;
}

const SCENARIOS = { 1: scenario1, 2: scenario2, 3: scenario3, 4: scenario4 };

(async () => {
  const modeArg = process.argv[2] || 'both';
  const which = process.argv.slice(3).length ? process.argv.slice(3) : ['1', '2', '3', '4'];
  const modes = modeArg === 'both' ? ['naive', 'fixed'] : [modeArg];
  const outFile = path.join(ROOT, 'results', 'results.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const all = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
  try {
    for (const mode of modes) {
      all[mode] = all[mode] || {};
      for (const s of which) {
        console.log(`\n=== [${mode}] Tình huống ${s} ===`);
        all[mode][`scenario${s}`] = await SCENARIOS[s](mode);
        console.log(JSON.stringify(all[mode][`scenario${s}`], null, 2));
        fs.writeFileSync(outFile, JSON.stringify(all, null, 2));
      }
    }
  } finally {
    await stopAll();
  }
  console.log(`\nĐã ghi ${outFile}`);
})().catch(async (e) => { console.error(e); await stopAll(); process.exit(1); });
