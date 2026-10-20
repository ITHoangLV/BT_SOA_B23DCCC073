# Lab 3 — Kết nối và duy trì kết nối giữa các service

Hệ thống thanh toán học phí: **Fee Service** (cổng 4001) gọi **Ngân hàng giả lập** (cổng 4002). Node.js + Express, dữ liệu trong bộ nhớ.

## 1. Cấu trúc thư mục

```
bank-service/server.js       Ngân hàng giả lập (4002): /charges, /stats, DELAY_MS, FAIL_RATE, DROP_RATE
fee-service/server.js        Fee Service (4001): công nợ, lệnh thanh toán, đối soát nền
fee-service/bankClient.js    Client gọi ngân hàng: keep-alive, timeout, retry, Idempotency-Key
scripts/run-scenarios.js     Script tự dựng service và đo 4 tình huống (trước/sau khi sửa)
results/results.json         Số liệu đo thực tế
postman/Lab3.postman_collection.json
```

## 2. Cách chạy

```bash
npm install
npm run start:bank          # terminal 1 (PowerShell: $env:DELAY_MS=5000; npm run start:bank)
npm run start:fee           # terminal 2
npm run measure             # đo tự động cả bản "trước" (naive) và "sau" (fixed)
```

Biến môi trường:

| Service | Biến | Ý nghĩa |
|---|---|---|
| Bank | `DELAY_MS`, `FAIL_RATE`, `DROP_RATE` | Trễ thêm; tỉ lệ lỗi 500 trước khi trừ; tỉ lệ trừ xong rồi cắt kết nối |
| Fee | `BANK_URL` | Địa chỉ ngân hàng, mặc định `http://localhost:4002` |
| Fee | `FEE_MODE=naive` | Bản "trước khi sửa": kết nối mới mỗi lần, không timeout, không retry |
| Fee | `BANK_DEADLINE_MS` | Thời gian tối đa chờ ngân hàng, mặc định 4000 ms |
| Fee | `RECONCILE_MS` | Chu kỳ đối soát lệnh PENDING, mặc định 10000 ms (0 = tắt) |

## 3. API

**Fee Service**
- `GET /students/{id}/fees` → `{studentId, debt, pending}` (SV1: 50.000.000đ, SV2: 0, SV3: 3.200.000đ)
- `POST /students/{id}/payments {"amount": 100000}` → tạo lệnh `P1, P2…`, gọi ngân hàng
- `GET /payments` (tổng hợp), `GET /payments/{id}` (trạng thái một lệnh)

**Ngân hàng**
- `POST /charges {reference, amount}` + header `Idempotency-Key` → 201 `{chargeId}`, 400 số tiền sai, 402 vượt hạn mức 20.000.000đ
- `GET /stats` → `{connections, requests, charges, duplicates}`; in log mỗi kết nối TCP mới; giữ kết nối nhàn rỗi 5 giây (mặc định Node.js)

Quy ước phản hồi thanh toán:

| Tình trạng | HTTP | status |
|---|---|---|
| Ngân hàng xác nhận đã trừ tiền | 201 | PAID |
| Ngân hàng từ chối rõ ràng (vd. vượt hạn mức) | giữ mã ngân hàng (402) | FAILED |
| Không kết nối được tới ngân hàng (chắc chắn chưa trừ) | 503 | FAILED |
| Hết thời gian chờ / đứt kết nối khi đang chờ (không biết đã trừ chưa) | 504 | PENDING |

Lỗi luôn là JSON có `error`, `paymentId`, `status`.

## 4. Các kỹ thuật đã áp dụng (bản fixed)

1. **Timeout theo deadline tổng 4 giây** cho mỗi lệnh (gồm cả thời gian chờ trong hàng đợi socket và các lần thử lại) → luôn trả lời ≤ 4,5 giây.
2. **Connect timeout 300 ms** + phân loại lỗi: lỗi chưa kết nối được (`ECONNREFUSED`, `CONNECT_TIMEOUT`…) chắc chắn chưa trừ tiền → 503 FAILED; lỗi sau khi đã gửi (đứt kết nối, hết giờ) → không biết → 504 PENDING. (Trên Windows, kết nối tới cổng đóng có thể mất ~2 giây vì hệ điều hành thử lại SYN, nên connect timeout là bắt buộc để đạt < 1,5 giây.)
3. **Không giữ trạng thái "hỏng" cố định**: mỗi lệnh tự tạo/lấy kết nối từ pool, nên khi ngân hàng chạy lại thì lệnh tiếp theo thành công ngay, không cần khởi động lại Fee Service.
4. **Keep-alive connection pool** (`http.Agent({keepAlive:true, maxSockets:10, timeout:4000})`): tái sử dụng kết nối TCP; tự đóng socket nhàn rỗi sau 4 giây — *trước* khi ngân hàng đóng ở 5 giây — để tránh dùng phải socket đã chết.
5. **Retry an toàn bằng Idempotency-Key = paymentId**: thử lại tối đa 5 lần, backoff mũ có jitter, với lỗi 5xx và lỗi đứt kết nối. Ngân hàng nhận lại cùng khóa thì trả giao dịch cũ → không bao giờ trừ hai lần. **Không thử lại 4xx** (402, 400).
6. **Đối soát nền (reconciliation)**: lệnh PENDING được gửi lại định kỳ với cùng Idempotency-Key (pool kết nối riêng) để chốt PAID/FAILED; công nợ chỉ giảm khi chốt PAID.
7. **Giữ chỗ công nợ**: số tiền của lệnh đang xử lý/PENDING được trừ tạm khi kiểm tra "không vượt công nợ" → tránh thanh toán vượt nợ khi gọi song song.
8. Gọi ngân hàng hoàn toàn **bất đồng bộ** → các API xem công nợ không bị chặn dù ngân hàng chậm/sập.

## 5. Kết quả đo (trước = `FEE_MODE=naive`, sau = bản fixed)

Số liệu lấy từ [results/results.json](results/results.json), đo trên máy Windows 11, Node.js v24.

### Tình huống 1 — Ngân hàng không kết nối được, rồi hoạt động lại

| Chỉ số | Trước | Sau | Yêu cầu |
|---|---|---|---|
| Thanh toán khi ngân hàng tắt | **500**, `error` rỗng | **503** FAILED, có `error` | 503 + JSON error |
| Thời gian trả lời | 51 ms | 243 ms | < 1,5 s ✅ |
| `GET /students/1/fees` khi ngân hàng tắt | 200, 1 ms | 200, 2 ms | 200 nhanh ✅ |
| Fee Service còn sống | Có | Có | ✅ |
| Ngân hàng chạy lại, gọi tiếp (không restart Fee) | 201 | 201 (20 ms) | 201 ✅ |
| `BANK_URL=http://localhost:4999` | 500, 30 ms | 503, 103 ms | giống như tắt ✅ |

### Tình huống 2 — Ngân hàng phản hồi rất chậm (`DELAY_MS=5000`)

| Chỉ số | Trước | Sau | Yêu cầu |
|---|---|---|---|
| Một thanh toán | 201 sau **5053 ms** | **504 PENDING** sau 4043 ms | 504 PENDING, ≤ 4,5 s ✅ |
| 20 thanh toán cùng lúc — thời gian lâu nhất | 5082 ms | 4021 ms | ≤ 4,5 s ✅ |
| 20 thanh toán — kết quả | 20 × 201 | 20 × 504 PENDING | ✅ |
| `GET /fees` trong lúc 20 lệnh chờ (5 lần đo) | 1–8 ms | 1–4 ms | < 300 ms ✅ |

Kiểm tra đối soát (`DELAY_MS=5000`, `RECONCILE_MS=3000`, 3 lệnh đều trả 504 PENDING): sau ~14 s cả 3 lệnh được chốt PAID, công nợ giảm đúng 300.000đ; ngân hàng ghi `requests=6, charges=3, duplicates=0` — lần gửi lại theo Idempotency-Key trả giao dịch cũ, không trừ thêm.

### Tình huống 3 — Duy trì kết nối (200 thanh toán × 1.000đ, 10 song song)

| Chỉ số | Trước | Sau | Yêu cầu |
|---|---|---|---|
| Thành công | 200/200 | 200/200 | 200/200 ✅ |
| Tổng thời gian | 219 ms | 166 ms | — |
| `connections` ở ngân hàng | **201** | **11** (10 của Fee + 1 của script đọc /stats) | ≤ 20 ✅ |
| Nhàn rỗi 6 s rồi gửi 5 lệnh | 5/5, thêm 6 kết nối (5 lệnh + 1 lần đọc /stats) | 5/5, chỉ thêm 2 kết nối (1 mở lại pool + 1 đọc /stats) | thành công ✅ |
| `duplicates` | 0 | 0 | 0 ✅ |

### Tình huống 4 — Đứt giữa chừng, lỗi tạm thời, bị từ chối (60 lệnh × 100.000đ, tuần tự)

**(a) `DROP_RATE=0.3`**

| Chỉ số | Trước | Sau | Yêu cầu |
|---|---|---|---|
| Thành công | 41/60 | **60/60** | ≥ 54/60 ✅ |
| Lệnh không thành công | 19 × **500 FAILED** | 0 (nếu có sẽ là 504 PENDING) | 504 + PENDING ✅ |
| Bank `charges` / lệnh PAID | **60 / 41** — 19 sinh viên bị trừ tiền nhưng công nợ không giảm, lệnh ghi FAILED | 60 / 60 | khớp ✅ |
| `requests` ở ngân hàng | 60 | 77 (17 lần gửi lại cùng khóa) | — |
| `duplicates` | 0 | 0 | 0 ✅ |
| Công nợ giảm = tổng tiền lệnh PAID | 4.100.000 = 4.100.000 | 6.000.000 = 6.000.000 | ✅ |
| Thời gian lâu nhất | 36 ms | 91 ms | ≤ 4,5 s ✅ |

**(b) `FAIL_RATE=0.3`**

| Chỉ số | Trước | Sau | Yêu cầu |
|---|---|---|---|
| Thành công | 46/60 | **60/60** | ≥ 54/60 ✅ |
| `requests` / `charges` / `duplicates` | 60 / 46 / 0 | 81 / 60 / 0 | không trừ 2 lần ✅ |
| Thời gian lâu nhất | 40 ms | 231 ms | ≤ 4,5 s ✅ |

**(c) Thanh toán 25.000.000đ**

| Chỉ số | Trước | Sau | Yêu cầu |
|---|---|---|---|
| Mã trả về | 402 FAILED | 402 FAILED (giữ mã ngân hàng) | 402 ✅ |
| `requests` ở ngân hàng | 1 | **1** (không thử lại lỗi bị từ chối) | đúng 1 ✅ |

## 6. Nhận xét / trình bày ngắn

- **Phân biệt "chắc chắn chưa trừ" và "không biết"** là mấu chốt: chưa kết nối được → 503 FAILED, an toàn cho sinh viên bấm lại; đã gửi mà mất phản hồi → 504 PENDING, không được báo thất bại (bản naive báo 500 FAILED trong khi tiền đã bị trừ — sai nghiệp vụ nghiêm trọng).
- **Timeout là bắt buộc**: không có timeout thì người dùng phải chờ theo tốc độ của ngân hàng (5 s+), và tài nguyên (socket, bộ nhớ) bị giữ suốt thời gian đó.
- **Keep-alive** giảm số kết nối TCP từ 201 xuống 10–11, nhanh hơn nhờ bỏ bước bắt tay; cần đặt idle timeout phía client nhỏ hơn phía server (4 s < 5 s) và retry khi gặp socket cũ bị đóng.
- **Retry chỉ an toàn khi có idempotency**: Idempotency-Key = paymentId giúp gửi lại bao nhiêu lần cũng chỉ trừ tiền một lần (`duplicates = 0`). Không thử lại 4xx vì đó là quyết định nghiệp vụ, không phải lỗi tạm thời.
- **Đối soát nền** đưa lệnh PENDING về trạng thái cuối cùng, đảm bảo công nợ khớp với số tiền ngân hàng thực sự đã trừ.
