const express = require('express');
const { charge, BANK_URL, NAIVE } = require('./bankClient');

const PORT = Number(process.env.PORT || 4001);
const RECONCILE_MS = Number(process.env.RECONCILE_MS || 10000);

const students = new Map([
  ['1', { id: '1', debt: 50_000_000 }],
  ['2', { id: '2', debt: 0 }],
  ['3', { id: '3', debt: 3_200_000 }],
]);
const payments = new Map();
let seq = 0;

function reserved(studentId) {
  let sum = 0;
  for (const p of payments.values()) {
    if (p.studentId === studentId && (p.status === 'PROCESSING' || p.status === 'PENDING')) sum += p.amount;
  }
  return sum;
}

function markPaid(p, chargeBody) {
  if (p.status === 'PAID') return;
  p.status = 'PAID';
  p.chargeId = chargeBody && chargeBody.chargeId;
  p.updatedAt = new Date().toISOString();
  students.get(p.studentId).debt -= p.amount;
}

const publicPayment = (p) => ({
  paymentId: p.id, studentId: p.studentId, amount: p.amount, status: p.status,
  chargeId: p.chargeId, error: p.error, createdAt: p.createdAt, updatedAt: p.updatedAt,
});

const app = express();
app.use(express.json());

app.get('/students/:id/fees', (req, res) => {
  const s = students.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy sinh viên' });
  res.json({ studentId: s.id, debt: s.debt, pending: reserved(s.id) });
});

app.post('/students/:id/payments', async (req, res) => {
  const s = students.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy sinh viên' });
  const amount = req.body && req.body.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Số tiền không hợp lệ' });
  }
  if (amount > s.debt - reserved(s.id)) {
    return res.status(400).json({ error: 'Số tiền vượt quá công nợ', debt: s.debt, pending: reserved(s.id) });
  }

  const p = {
    id: `P${++seq}`, studentId: s.id, amount, status: 'PROCESSING',
    createdAt: new Date().toISOString(), updatedAt: null,
  };
  payments.set(p.id, p);

  const r = await charge(p.id, amount);
  p.updatedAt = new Date().toISOString();

  switch (r.outcome) {
    case 'PAID':
      markPaid(p, r.charge);
      return res.status(201).json(publicPayment(p));
    case 'DECLINED':
      p.status = 'FAILED';
      p.error = (r.body && (r.body.message || r.body.error)) || 'Ngân hàng từ chối';
      return res.status(r.httpStatus).json({ error: p.error, paymentId: p.id, status: p.status, bankError: r.body });
    case 'UNAVAILABLE':
      p.status = 'FAILED';
      p.error = 'Không kết nối được tới ngân hàng';
      return res.status(503).json({ error: p.error, paymentId: p.id, status: p.status, detail: r.error });
    default:
      if (NAIVE) {
        p.status = 'FAILED'; p.error = r.error;
        return res.status(500).json({ error: r.error, paymentId: p.id, status: p.status });
      }
      p.status = 'PENDING';
      p.error = 'Chưa rõ kết quả trừ tiền, hệ thống sẽ đối soát lại';
      return res.status(504).json({ error: p.error, paymentId: p.id, status: p.status, detail: r.error });
  }
});

app.get('/payments', (req, res) => {
  const list = [...payments.values()];
  const count = (st) => list.filter((p) => p.status === st).length;
  res.json({
    total: list.length, PAID: count('PAID'), FAILED: count('FAILED'),
    PENDING: count('PENDING'), PROCESSING: count('PROCESSING'),
    paidAmount: list.filter((p) => p.status === 'PAID').reduce((a, p) => a + p.amount, 0),
  });
});

app.get('/payments/:id', (req, res) => {
  const p = payments.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Không tìm thấy lệnh' });
  res.json(publicPayment(p));
});

let reconciling = false;
async function reconcile() {
  if (reconciling || NAIVE) return;
  reconciling = true;
  try {
    const pend = [...payments.values()].filter((p) => p.status === 'PENDING');
    await Promise.all(pend.map(async (p) => {
      const r = await charge(p.id, p.amount, { reconcile: true, deadlineMs: 15000 });
      if (p.status !== 'PENDING') return;
      if (r.outcome === 'PAID') markPaid(p, r.charge);
      else if (r.outcome === 'DECLINED') { p.status = 'FAILED'; p.error = 'Ngân hàng từ chối (đối soát)'; p.updatedAt = new Date().toISOString(); }
    }));
  } finally {
    reconciling = false;
  }
}
if (RECONCILE_MS > 0) setInterval(reconcile, RECONCILE_MS).unref();

app.listen(PORT, () => {
  console.log(`[fee] listening :${PORT} BANK_URL=${BANK_URL} mode=${NAIVE ? 'naive' : 'fixed'}`);
});
