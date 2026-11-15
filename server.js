/*
 * 사설구급차 이송 콜 서버 (Node.js + Express)
 *
 * 카카오T처럼 동작합니다:
 *   1) 보호자가 이송 요청을 접수하면 → "배차대기" 콜이 생깁니다.
 *   2) 가입·승인된 서울 이송단들의 콜 화면(provider.html)에 콜이 뜨고, 문자도 갑니다.
 *   3) 가장 먼저 "수락"을 누른 이송단 1곳만 배정됩니다. (동시에 눌러도 서버가 1곳만 통과시킴)
 *   4) 보호자는 진행 화면(track.html)에서 배정된 이송단·전화번호·차량번호를 봅니다.
 *   5) 관리자(admin.html)는 이송단 가입을 승인하고 전체 콜을 봅니다.
 *
 * 실행: npm start  →  브라우저에서 http://localhost:3000
 */
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const er = require("./er-api"); // 국립중앙의료원 응급실 병상 API
const transport = require("./transport-api"); // 행정안전부 응급환자이송업 API
const sms = require("./sms"); // 솔라피 문자
const Fee = require("./public/fee"); // 법정 이송처치료 계산 (화면과 같은 파일)

try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {
  /* .env 파일이 없어도 서버는 켜짐 */
}

const app = express();
const PORT = process.env.PORT || 3000;
const STATUSES = ["배차대기", "배차완료", "이송중", "완료", "취소"];

// =====================================================================
// 저장소: 인터넷(Vercel)에서는 Upstash Redis, 내 컴퓨터에서는 data/db.json
// =====================================================================
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const P = "ambulance:"; // 키 앞머리

function makeStore() {
  if (REDIS_URL && REDIS_TOKEN) {
    const { Redis } = require("@upstash/redis");
    const r = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
    return {
      get: (k) => r.get(P + k),
      set: (k, v) => r.set(P + k, v),
      setNX: async (k, v) => (await r.set(P + k, v, { nx: true })) === "OK",
      setNXEx: async (k, v, sec) => (await r.set(P + k, v, { nx: true, ex: sec })) === "OK",
      del: (k) => r.del(P + k),
      mget: async (keys) => (keys.length ? r.mget(...keys.map((k) => P + k)) : []),
      lpush: (k, v) => r.lpush(P + k, v),
      lrange: (k, n) => r.lrange(P + k, 0, n - 1),
      lrem: (k, v) => r.lrem(P + k, 0, v),
      sadd: (k, v) => r.sadd(P + k, v),
      srem: (k, v) => r.srem(P + k, v),
      smembers: (k) => r.smembers(P + k),
      incr: (k) => r.incr(P + k),
    };
  }
  // 내 컴퓨터용: 서버 하나만 돌기 때문에 순서대로 처리되어 "먼저 수락" 판정도 안전
  const DIR = path.join(__dirname, "data");
  const FILE = path.join(DIR, "db.json");
  fs.mkdirSync(DIR, { recursive: true });
  let db = { kv: {}, lists: {}, sets: {} };
  try {
    db = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {}
  const persist = () => {
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(db));
    fs.renameSync(FILE + ".tmp", FILE);
  };
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  return {
    get: async (k) => clone(db.kv[k]),
    set: async (k, v) => ((db.kv[k] = clone(v)), persist()),
    setNX: async (k, v) => {
      if (k in db.kv) return false;
      db.kv[k] = v;
      persist();
      return true;
    },
    setNXEx: async (k, v, sec) => {
      const exp = (db.exp ||= {});
      if (k in db.kv && (exp[k] || Infinity) > Date.now()) return false;
      db.kv[k] = v;
      exp[k] = Date.now() + sec * 1000;
      persist();
      return true;
    },
    del: async (k) => (delete db.kv[k], persist()),
    mget: async (keys) => keys.map((k) => clone(db.kv[k])),
    lpush: async (k, v) => ((db.lists[k] ||= []).unshift(v), persist()),
    lrange: async (k, n) => (db.lists[k] || []).slice(0, n),
    lrem: async (k, v) => ((db.lists[k] = (db.lists[k] || []).filter((x) => x !== v)), persist()),
    sadd: async (k, v) => ((db.sets[k] = [...new Set([...(db.sets[k] || []), v])]), persist()),
    srem: async (k, v) => ((db.sets[k] = (db.sets[k] || []).filter((x) => x !== v)), persist()),
    smembers: async (k) => [...(db.sets[k] || [])],
    incr: async (k) => ((db.kv[k] = (Number(db.kv[k]) || 0) + 1), persist(), db.kv[k]),
  };
}
const store = makeStore();
// 이송업 공공데이터 목록을 저장소에 12시간 보관 (서버가 여러 대여도 공유)
transport.setCache({ get: () => store.get("cache:transport"), set: (v) => store.set("cache:transport", v) });
require("./seoul-ambulances").setCache({ get: () => store.get("cache:seoulAmbl"), set: (v) => store.set("cache:seoulAmbl", v) });

// 키 이름 모음
const K = {
  req: (id) => `req:${id}`,
  reqIndex: "req:index", // 전체 콜 id (최신순)
  open: "req:open", // 배차대기 중인 콜 id
  claim: (id) => `req:claim:${id}`, // "먼저 잡은 사람" 표시 (한 번만 써짐)
  prov: (id) => `prov:${id}`,
  provIndex: "prov:index",
  provPhone: (digits) => `prov:phone:${digits}`,
  provCalls: (id) => `prov:calls:${id}`, // 이송단이 잡은 콜 id
  ver: "ver", // 콜 판이 바뀔 때마다 1씩 증가 → 이송단 화면이 바뀐 게 있을 때만 새로 받음
};
const bump = () => store.incr(K.ver);

// =====================================================================
// 오래 대기 콜 알림: 정해진 시간 동안 아무도 수락하지 않으면 관리자·이송단에게 다시 알림
//   기준(분): 긴급 3 / 일반 10 / 예약 30  — 환경변수 STALE_MIN_URGENT / STALE_MIN_NORMAL / STALE_MIN_RESERVED 로 변경
//   관리자 문자 받을 번호: 환경변수 ADMIN_PHONE (여러 개면 쉼표로)
// Vercel에는 상시 돌아가는 타이머가 없어서, 보호자·이송단·관리자 화면이 서버에 물어볼 때
// 함께 점검합니다(최대 1분에 1번). 외부 cron 서비스로 /api/cron/stale 을 불러도 됩니다.
// =====================================================================
const STALE_MIN = {
  urgent: Number(process.env.STALE_MIN_URGENT) || 3,
  normal: Number(process.env.STALE_MIN_NORMAL) || 10,
  reserved: Number(process.env.STALE_MIN_RESERVED) || 30,
};
const staleLimit = (r) => (r.when === "예약" ? STALE_MIN.reserved : r.urgency === "긴급" ? STALE_MIN.urgent : STALE_MIN.normal);
const waitingMin = (r) => Math.floor((Date.now() - new Date(r.waitingSince || r.createdAt)) / 60000);
const isStale = (r) => r.status === "배차대기" && waitingMin(r) >= staleLimit(r);

async function checkStale(host) {
  if (!(await store.setNXEx("lock:stale", 1, 60))) return { skipped: true }; // 1분에 1번만
  const ids = await store.smembers(K.open);
  const calls = (await store.mget(ids.map(K.req))).filter((r) => r && isStale(r) && !r.staleAlertedAt);
  if (!calls.length) return { alerted: 0 };
  for (const r of calls) {
    r.staleAlertedAt = new Date().toISOString();
    await store.set(K.req(r.id), r);
  }
  await bump();

  const line = (r) =>
    `${r.urgency === "긴급" ? "긴급 " : ""}${waitingMin(r)}분째 미배정: ${area(r.fromAddr)} → ${area(r.toAddr)} (${r.id})`;
  const adminPhones = String(process.env.ADMIN_PHONE || "").split(",").map((s) => s.trim()).filter(Boolean);
  const results = {};
  try {
    results.admin = await sms.sendMany(adminPhones, `[대기 콜 알림]\n${calls.map(line).join("\n")}\n관리: ${host}/admin.html`);
  } catch (e) {
    console.error("관리자 문자 실패:", e.message);
  }
  try {
    const pids = await store.lrange(K.provIndex, 500);
    const provs = (await store.mget(pids.map(K.prov))).filter((p) => p && p.status === "approved");
    results.providers = await sms.sendMany(
      provs.map((p) => p.phone),
      `[콜 재알림] 아직 아무도 수락하지 않았습니다\n${calls.map(line).join("\n")}\n${host}/provider.html`
    );
  } catch (e) {
    console.error("이송단 재알림 문자 실패:", e.message);
  }
  console.log(`오래 대기 콜 ${calls.length}건 알림`, JSON.stringify(results));
  return { alerted: calls.length, results };
}
// 화면 요청 처리 중 점검 (실패해도 원래 응답에는 영향 없음)
const hostOf = (req) => `${req.protocol}://${req.get("host")}`;
const staleCheck = (req) => checkStale(hostOf(req)).catch((e) => console.error("대기 콜 점검 실패:", e.message));

// =====================================================================
// 도우미
// =====================================================================
const digits = (s) => String(s || "").replace(/\D/g, "");
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const randomId = (bytes = 12) => crypto.randomBytes(bytes).toString("hex");
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

function makeTicketNo() {
  // 한국 시간 기준 접수번호 예) 261115-1842-317
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const rand = Math.floor(Math.random() * 900 + 100);
  return `${String(d.getUTCFullYear()).slice(2)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}-${rand}`;
}

// 주소의 앞 두 덩어리만 (예: "서울특별시 중구 세종대로 110" → "서울특별시 중구")
const area = (addr) => String(addr || "").trim().split(/\s+/).slice(0, 2).join(" ");

// 비밀번호 저장: 원문 대신 scrypt 해시만 보관
function hashPassword(pw) {
  const salt = randomId(16);
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 32), Buffer.from(hash, "hex"));
}

// 이송단 로그인 토큰 (서명된 꼬리표, 30일 유효)
const SESSION_SECRET =
  process.env.SESSION_SECRET || sha256(`${process.env.ADMIN_PASSWORD}|${REDIS_TOKEN}|ambulance`).toString("hex");
const sign = (data) => crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
function makeToken(providerId) {
  const body = Buffer.from(JSON.stringify({ pid: providerId, exp: Date.now() + 30 * 86400 * 1000 })).toString("base64url");
  return `${body}.${sign(body)}`;
}
function readToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || !sameSecret(sig, sign(body))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    return data.exp > Date.now() ? data.pid : null;
  } catch {
    return null;
  }
}

// 접수 내용에서 받을 항목만 골라 저장 (모르는 항목·너무 긴 글은 버림)
function cleanRequest(b) {
  return {
    urgency: b.urgency === "긴급" ? "긴급" : "일반",
    when: b.when === "예약" ? "예약" : "즉시",
    reserveAt: str(b.reserveAt, 30),
    roundTrip: Boolean(b.roundTrip),
    reqName: str(b.reqName, 30),
    reqPhone: str(b.reqPhone, 20),
    reqRelation: str(b.reqRelation, 30),
    ptName: str(b.ptName, 30),
    ptAge: str(b.ptAge, 3),
    ptSex: str(b.ptSex, 2),
    ptWeight: str(b.ptWeight, 4),
    guardianRide: Boolean(b.guardianRide),
    fromType: str(b.fromType, 20),
    fromAddr: str(b.fromAddr, 200),
    fromDetail: str(b.fromDetail, 100),
    fromGeo: str(b.fromGeo, 40),
    elevator: str(b.elevator, 20),
    ptCondition: str(b.ptCondition, 1000),
    conscious: str(b.conscious, 20),
    mobility: str(b.mobility, 20),
    equip: Array.isArray(b.equip) ? b.equip.slice(0, 12).map((e) => str(e, 30)) : [],
    o2Flow: str(b.o2Flow, 5),
    vitals: {
      bp: str(b.vitals?.bp, 10),
      hr: str(b.vitals?.hr, 4),
      spo2: str(b.vitals?.spo2, 4),
      bt: str(b.vitals?.bt, 5),
    },
    toAddr: str(b.toAddr, 200),
    toDept: str(b.toDept, 50),
    toTime: str(b.toTime, 10),
    memo: str(b.memo, 1000),
    ambType: b.ambType === "특수" ? "특수" : "일반",
    distanceKm: Math.min(500, Math.max(0, Math.round(Number(b.distanceKm) * 10) / 10 || 0)),
    holiday: Boolean(b.holiday),
  };
}

// 예상 요금 (서버에서 다시 계산해 저장 → 화면에서 숫자를 고쳐 보내도 반영 안 됨)
function feeOf(r) {
  const at = r.when === "예약" && r.reserveAt ? new Date(`${r.reserveAt}:00+09:00`) : new Date(r.createdAt || Date.now());
  return Fee.estimate({ type: r.ambType, km: r.distanceKm, at: isNaN(at) ? new Date() : at, holiday: r.holiday });
}

// 수락 전 이송단에게 보여 줄 "요약" (이름·전화·상세주소·증상 없음)
function teaser(r) {
  return {
    id: r.id,
    createdAt: r.createdAt,
    urgency: r.urgency,
    when: r.when,
    reserveAt: r.reserveAt,
    roundTrip: r.roundTrip,
    fromType: r.fromType,
    fromArea: area(r.fromAddr),
    toArea: area(r.toAddr),
    ptSex: r.ptSex,
    ptAge: r.ptAge,
    ptWeight: r.ptWeight,
    mobility: r.mobility,
    conscious: r.conscious,
    equip: r.equip,
    elevator: r.elevator,
    guardianRide: r.guardianRide,
    waitingMin: waitingMin(r),
    stale: isStale(r),
    ambType: r.ambType || "일반",
    distanceKm: r.distanceKm || 0,
    fee: r.fee || null,
  };
}
// 공개해도 되는 이송단 정보
const publicProvider = (p) => ({
  id: p.id,
  bizName: p.bizName,
  contactName: p.contactName,
  phone: p.phone,
  vehicleNo: p.vehicleNo,
});
// 관리자용 (비밀번호 해시 제외)
const adminProvider = ({ passwordHash, ...p }) => p;

// =====================================================================
// 공통 설정
// =====================================================================
app.use(express.json({ limit: "100kb" }));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.path}`);
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// 비동기 오류를 500으로 돌려줌
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- 관리자 비밀번호 ----------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    if (!process.env.VERCEL) return next(); // 내 컴퓨터에서 비밀번호를 안 정했으면 통과
    return res.status(503).json({ error: "관리자 비밀번호가 설정되지 않았습니다. (Vercel 환경변수 ADMIN_PASSWORD)" });
  }
  if (!sameSecret(req.get("x-admin-password") || "", ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "관리자 비밀번호가 틀렸습니다." });
  }
  next();
}

// ---------- 이송단 로그인 확인 ----------
const requireProvider = wrap(async (req, res, next) => {
  const pid = readToken((req.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  if (!pid) return res.status(401).json({ error: "다시 로그인해 주세요." });
  const p = await store.get(K.prov(pid));
  if (!p) return res.status(401).json({ error: "다시 로그인해 주세요." });
  if (p.status !== "approved") {
    return res.status(403).json({ error: p.status === "pending" ? "관리자 승인 대기 중입니다." : "콜을 받을 수 없는 계정입니다.", provider: adminProvider(p) });
  }
  req.provider = p;
  next();
});

// =====================================================================
// 보호자: 이송 요청 접수 · 진행 상황
// =====================================================================
const REQUIRED = ["reqName", "reqPhone", "ptName", "ptAge", "ptSex", "fromAddr", "ptCondition", "toAddr"];

app.post("/api/requests", wrap(async (req, res) => {
  const data = cleanRequest(req.body || {});
  const missing = REQUIRED.filter((k) => !data[k]);
  if (missing.length) return res.status(400).json({ error: "필수 항목이 비어 있습니다.", missing });

  const item = {
    ...data,
    id: makeTicketNo(),
    trackToken: randomId(16), // 보호자만 진행 화면을 볼 수 있는 열쇠
    createdAt: new Date().toISOString(),
    status: "배차대기",
    provider: null,
  };
  item.fee = feeOf(item);
  await store.set(K.req(item.id), item);
  await store.lpush(K.reqIndex, item.id);
  await store.sadd(K.open, item.id);
  await bump();

  // 승인된 이송단 전체에게 문자 (설정돼 있을 때만, 실패해도 접수는 유지)
  let notified = 0;
  try {
    const ids = await store.lrange(K.provIndex, 500);
    const provs = (await store.mget(ids.map(K.prov))).filter((p) => p && p.status === "approved");
    const host = `${req.protocol}://${req.get("host")}`;
    const text =
      `[구급차 콜] ${item.urgency === "긴급" ? "긴급 " : ""}${item.when === "예약" ? "예약 " + item.reserveAt.replace("T", " ") : "즉시"}\n` +
      `${area(item.fromAddr)} → ${area(item.toAddr)} / ${item.mobility}${item.equip.length ? " / " + item.equip.join(",") : ""}\n` +
      `먼저 수락한 이송단이 배정됩니다: ${host}/provider.html`;
    const r = await sms.sendMany(provs.map((p) => p.phone), text);
    notified = r.count;
  } catch (e) {
    console.error("문자 발송 실패:", e.message);
  }

  res.status(201).json({ id: item.id, trackToken: item.trackToken, createdAt: item.createdAt, notified });
}));

// 보호자 진행 화면
async function loadTracked(req, res) {
  const r = await store.get(K.req(req.params.id));
  if (!r || !sameSecret(String(req.query.t || req.body?.t || ""), r.trackToken)) {
    res.status(404).json({ error: "접수 건을 찾을 수 없습니다." });
    return null;
  }
  return r;
}
app.get("/api/track/:id", wrap(async (req, res) => {
  await staleCheck(req);
  const r = await loadTracked(req, res);
  if (!r) return;
  res.json({
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    waitingMin: waitingMin(r),
    stale: isStale(r),
    staleAlerted: Boolean(r.staleAlertedAt),
    ambType: r.ambType || "일반",
    distanceKm: r.distanceKm || 0,
    fee: r.fee || null,
    assignedAt: r.assignedAt || null,
    provider: r.provider,
    ptName: r.ptName,
    fromAddr: r.fromAddr,
    toAddr: r.toAddr,
    urgency: r.urgency,
    when: r.when,
    reserveAt: r.reserveAt,
  });
}));

// 보호자 취소: 아직 아무도 안 잡았을 때만 (이송단 수락과 동시에 눌러도 한쪽만 성공)
app.post("/api/track/:id/cancel", wrap(async (req, res) => {
  const r = await loadTracked(req, res);
  if (!r) return;
  if (r.status !== "배차대기" || !(await store.setNX(K.claim(r.id), "cancel"))) {
    return res.status(409).json({ error: "이미 이송단이 배정되었습니다. 배정된 이송단에 전화로 취소해 주세요." });
  }
  r.status = "취소";
  r.canceledAt = new Date().toISOString();
  await store.set(K.req(r.id), r);
  await store.srem(K.open, r.id);
  await bump();
  res.json({ ok: true });
}));

// =====================================================================
// 이송단: 업체 확인 · 가입 · 로그인 · 콜 받기
// =====================================================================
// 수도권 이송업체 검색 (서울시 민간구급차 파일 + 행정안전부 전국 API의 서울·경기·인천)
app.get("/api/providers/lookup", wrap(async (req, res) => {
  const name = str(req.query.name, 30);
  try {
    res.json(await transport.search(name));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

app.post("/api/providers/signup", wrap(async (req, res) => {
  const b = req.body || {};
  const p = {
    bizName: str(b.bizName, 50),
    mngNo: str(b.mngNo, 60),
    contactName: str(b.contactName, 20),
    phone: str(b.phone, 20),
    vehicleNo: str(b.vehicleNo, 20),
  };
  const pw = String(b.password || "");
  if (!p.bizName || !p.contactName || digits(p.phone).length < 9) {
    return res.status(400).json({ error: "업체명, 담당자 이름, 휴대폰 번호를 확인해 주세요." });
  }
  if (pw.length < 6) return res.status(400).json({ error: "비밀번호는 6자 이상으로 정해 주세요." });

  // 공공데이터로 허가·영업 상태 확인 (실패해도 가입은 받고, 관리자가 보고 판단)
  let verification;
  if (p.mngNo) {
    try {
      const v = await transport.verify(p.mngNo, p.vehicleNo);
      verification = { ok: v.ok, reason: v.reason || "", company: v.company || null, vehicle: v.vehicle || "" };
    } catch (e) {
      verification = { ok: false, reason: e.message, company: null };
    }
  } else {
    verification = { ok: false, reason: "공공데이터 업체를 선택하지 않고 직접 입력함", company: null };
  }

  const id = randomId(8);
  // 같은 휴대폰 번호로 두 번 가입하지 못하게 (먼저 자리를 잡은 쪽만 성공)
  if (!(await store.setNX(K.provPhone(digits(p.phone)), id))) {
    return res.status(409).json({ error: "이미 가입된 휴대폰 번호입니다. 로그인해 주세요." });
  }
  const provider = {
    ...p,
    id,
    passwordHash: hashPassword(pw),
    status: "pending",
    verification,
    createdAt: new Date().toISOString(),
  };
  await store.set(K.prov(id), provider);
  await store.lpush(K.provIndex, id);
  res.status(201).json({ token: makeToken(id), provider: adminProvider(provider) });
}));

app.post("/api/providers/login", wrap(async (req, res) => {
  const phone = digits(req.body?.phone);
  const pw = String(req.body?.password || "");
  const id = phone && (await store.get(K.provPhone(phone)));
  const p = id && (await store.get(K.prov(id)));
  if (!p || !checkPassword(pw, p.passwordHash)) {
    return res.status(401).json({ error: "휴대폰 번호 또는 비밀번호가 틀렸습니다." });
  }
  res.json({ token: makeToken(p.id), provider: adminProvider(p) });
}));

// 콜 판: 대기 중인 콜(요약) + 내가 잡은 콜(전체 내용)
// ?ver=숫자 를 보내면, 그 뒤로 바뀐 게 없을 때 짧게 "변화 없음"만 돌려줌 (저장소 사용량 절약)
app.get("/api/provider/board", requireProvider, wrap(async (req, res) => {
  await staleCheck(req);
  const ver = Number(await store.get(K.ver)) || 0;
  if (req.query.ver !== undefined && Number(req.query.ver) === ver) return res.json({ ver, unchanged: true });

  const openIds = await store.smembers(K.open);
  const open = (await store.mget(openIds.map(K.req)))
    .filter((r) => r && r.status === "배차대기")
    .sort((a, b) => (a.urgency === b.urgency ? a.createdAt.localeCompare(b.createdAt) : a.urgency === "긴급" ? -1 : 1))
    .map(teaser);
  const myIds = await store.lrange(K.provCalls(req.provider.id), 30);
  const mine = (await store.mget(myIds.map(K.req)))
    .filter((r) => r && r.provider?.id === req.provider.id)
    .map(({ trackToken, ...r }) => r);
  res.json({ ver, open, mine, me: publicProvider(req.provider) });
}));

// 콜 수락: 먼저 누른 1곳만 성공
app.post("/api/provider/calls/:id/accept", requireProvider, wrap(async (req, res) => {
  const r = await store.get(K.req(req.params.id));
  if (!r) return res.status(404).json({ error: "콜을 찾을 수 없습니다." });
  if (r.status !== "배차대기" || !(await store.setNX(K.claim(r.id), req.provider.id))) {
    return res.status(409).json({ error: "다른 이송단이 먼저 수락했거나 취소된 콜입니다." });
  }
  r.status = "배차완료";
  r.assignedAt = new Date().toISOString();
  r.provider = publicProvider(req.provider);
  await store.set(K.req(r.id), r);
  await store.srem(K.open, r.id);
  await store.lpush(K.provCalls(req.provider.id), r.id);
  await bump();
  const { trackToken, ...full } = r;
  res.json(full);
}));

// 내 콜 진행 상태 변경 (이송중 / 완료) 또는 배차 반납
app.post("/api/provider/calls/:id/status", requireProvider, wrap(async (req, res) => {
  const r = await store.get(K.req(req.params.id));
  if (!r || r.provider?.id !== req.provider.id) return res.status(404).json({ error: "내 콜이 아닙니다." });
  const next = String(req.body?.status || "");
  if (next === "반납") {
    // 사정상 못 가게 됨 → 다시 다른 이송단이 잡을 수 있게 되돌림
    if (r.status !== "배차완료") return res.status(400).json({ error: "출발 전(배차완료)에만 반납할 수 있습니다." });
    r.status = "배차대기";
    r.provider = null;
    r.assignedAt = null;
    r.waitingSince = new Date().toISOString(); // 대기 시간 다시 계산
    r.staleAlertedAt = null;
    r.releasedBy = [...(r.releasedBy || []), req.provider.bizName];
    await store.set(K.req(r.id), r);
    await store.del(K.claim(r.id));
    await store.sadd(K.open, r.id);
    await store.lrem(K.provCalls(req.provider.id), r.id);
    await bump();
    return res.json({ ok: true });
  }
  const order = { 배차완료: ["이송중"], 이송중: ["완료"] };
  if (!(order[r.status] || []).includes(next)) return res.status(400).json({ error: `'${r.status}'에서 '${next}'(으)로 바꿀 수 없습니다.` });
  r.status = next;
  r[next === "이송중" ? "departedAt" : "completedAt"] = new Date().toISOString();
  await store.set(K.req(r.id), r);
  await bump();
  const { trackToken, ...full } = r;
  res.json(full);
}));

// =====================================================================
// 관리자
// =====================================================================
app.post("/api/admin/login", requireAdmin, (req, res) =>
  res.json({
    ok: true,
    sms: sms.isConfigured(),
    transportApi: transport.hasKey(),
    adminPhone: Boolean(process.env.ADMIN_PHONE),
    staleMin: STALE_MIN,
  })
);

// 공공데이터 이송업 목록 점검 (관리자만). ?refresh=1 이면 새로 받아 옴
app.get("/api/admin/transport-test", requireAdmin, wrap(async (req, res) => {
  try {
    res.json(await transport.stats(req.query.refresh === "1"));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

app.get("/api/admin/requests", requireAdmin, wrap(async (req, res) => {
  await staleCheck(req);
  const ids = await store.lrange(K.reqIndex, 300);
  res.json(
    (await store.mget(ids.map(K.req)))
      .filter(Boolean)
      .map(({ trackToken, ...r }) => ({ ...r, waitingMin: waitingMin(r), stale: isStale(r), staleLimit: staleLimit(r) }))
  );
}));

// 외부 cron 서비스용 점검 주소 (예: cron-job.org 에서 1분마다 호출)
// 환경변수 CRON_SECRET 을 정하고 ?key=그값 으로 부르면 됩니다.
app.get("/api/cron/stale", wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET || "";
  const given = String(req.query.key || (req.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  if (!secret || !sameSecret(given, secret)) return res.status(401).json({ error: "인증 실패" });
  res.json(await checkStale(hostOf(req)));
}));

app.post("/api/admin/requests/:id/cancel", requireAdmin, wrap(async (req, res) => {
  const r = await store.get(K.req(req.params.id));
  if (!r) return res.status(404).json({ error: "접수 건을 찾을 수 없습니다." });
  if (r.status === "완료" || r.status === "취소") return res.status(400).json({ error: `이미 '${r.status}' 상태입니다.` });
  await store.setNX(K.claim(r.id), "cancel"); // 대기 중이면 아무도 못 잡게
  r.status = "취소";
  r.canceledAt = new Date().toISOString();
  await store.set(K.req(r.id), r);
  await store.srem(K.open, r.id);
  await bump();
  res.json({ ok: true });
}));

app.delete("/api/admin/requests/:id", requireAdmin, wrap(async (req, res) => {
  const r = await store.get(K.req(req.params.id));
  if (!r) return res.status(404).json({ error: "접수 건을 찾을 수 없습니다." });
  await store.del(K.req(r.id));
  await store.del(K.claim(r.id));
  await store.lrem(K.reqIndex, r.id);
  await store.srem(K.open, r.id);
  if (r.provider) await store.lrem(K.provCalls(r.provider.id), r.id);
  await bump();
  res.status(204).end();
}));

app.get("/api/admin/providers", requireAdmin, wrap(async (req, res) => {
  const ids = await store.lrange(K.provIndex, 500);
  res.json((await store.mget(ids.map(K.prov))).filter(Boolean).map(adminProvider));
}));

app.post("/api/admin/providers/:id/:action", requireAdmin, wrap(async (req, res) => {
  const map = { approve: "approved", reject: "rejected", suspend: "suspended" };
  const status = map[req.params.action];
  if (!status) return res.status(404).json({ error: "없는 주소입니다." });
  const p = await store.get(K.prov(req.params.id));
  if (!p) return res.status(404).json({ error: "이송단을 찾을 수 없습니다." });
  p.status = status;
  p.reviewedAt = new Date().toISOString();
  await store.set(K.prov(p.id), p);
  res.json(adminProvider(p));
}));

app.delete("/api/admin/providers/:id", requireAdmin, wrap(async (req, res) => {
  const p = await store.get(K.prov(req.params.id));
  if (!p) return res.status(404).json({ error: "이송단을 찾을 수 없습니다." });
  await store.del(K.prov(p.id));
  await store.del(K.provPhone(digits(p.phone)));
  await store.lrem(K.provIndex, p.id);
  res.status(204).end();
}));

// =====================================================================
// 외부 API 대신 호출: 좌표 → 주소, 응급실 병상
// =====================================================================
app.get("/api/geocode/reverse", async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: "좌표가 올바르지 않습니다." });
  }
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ko&lat=${lat}&lon=${lng}`;
    const r = await fetch(url, { headers: { "User-Agent": "ambulance-request-demo/1.0" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    res.json({ address: data.display_name || "" });
  } catch (e) {
    console.error("주소 검색 실패:", e.message);
    res.status(502).json({ error: "주소를 가져오지 못했습니다." });
  }
});

app.get("/api/er/beds", async (req, res) => {
  const sido = String(req.query.sido || "").trim();
  const sigungu = String(req.query.sigungu || "").trim();
  if (!er.SIDO.includes(sido)) return res.status(400).json({ error: "시·도를 선택해 주세요." });
  try {
    res.json(await er.getErBeds(sido, sigungu));
  } catch (e) {
    console.error("응급실 조회 실패:", e.message);
    res.status(502).json({ error: e.message });
  }
});

app.use("/api", (req, res) => res.status(404).json({ error: "없는 주소입니다." }));
app.use((err, req, res, next) => {
  console.error("서버 오류:", err);
  res.status(500).json({ error: "서버 오류가 났습니다. 잠시 후 다시 시도해 주세요." });
});

module.exports = app;

const HOST = "127.0.0.1";
if (!process.env.VERCEL) app.listen(PORT, HOST, (err) => {
  if (err) {
    if (err.code === "EADDRINUSE") {
      console.log(`❌ ${PORT}번 포트를 이미 다른 프로그램(아마 이미 켜 둔 이 서버)이 쓰고 있습니다.`);
      console.log("   새로 켜고 싶으면, 먼저 켜 둔 터미널에서 Ctrl + C로 끄고 다시 npm start 하세요.");
    } else {
      console.log("❌ 서버를 켜지 못했습니다:", err.message);
    }
    process.exit(1);
  }
  console.log(`서버가 켜졌습니다 → http://localhost:${PORT}`);
  console.log(`  보호자 접수: http://localhost:${PORT}/`);
  console.log(`  이송단 콜:   http://localhost:${PORT}/provider.html`);
  console.log(`  관리자:      http://localhost:${PORT}/admin.html`);
  console.log(er.hasKey() ? "공공데이터 API 키: 확인됨 ✅" : "공공데이터 API 키: 아직 없음 ⚠️");
  console.log(sms.isConfigured() ? "문자 발송: 켜짐 ✅" : "문자 발송: 꺼짐 (SOLAPI_* 환경변수 없음)");
  console.log("끄려면 이 터미널에서 Ctrl + C");
});
