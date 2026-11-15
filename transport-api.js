/*
 * 행정안전부 「건강_응급환자이송업 조회서비스」를 부르는 파일
 *
 * 하는 일: 이송단이 가입할 때, 정말 지자체 허가를 받고 "영업 중"인 업체인지 공공데이터로 확인합니다.
 * 주소: https://apis.data.go.kr/1741000/emergency_patient_transport/info
 * 키: 응급실 API와 같은 공공데이터포털 키(DATA_GO_KR_KEY). 이 서비스도 "활용신청"이 되어 있어야 합니다.
 *
 * 전국 업체 수가 수백 곳뿐이고 하루 한 번 갱신되므로, 전체 목록을 받아 12시간 보관(캐시)해 두고
 * 우리 서버 안에서 검색합니다. (공공데이터의 이름 검색은 10초 넘게 걸려서 쓰지 않음)
 */
const seoul = require("./seoul-ambulances");
const BASE = "https://apis.data.go.kr/1741000/emergency_patient_transport/info";
const CACHE_MS = 12 * 3600 * 1000;

function getKey() {
  let key = (process.env.DATA_GO_KR_KEY || "").trim();
  if (key.includes("%")) {
    try {
      key = decodeURIComponent(key);
    } catch {}
  }
  return key;
}

function pick(it) {
  return {
    mngNo: String(it.MNG_NO || ""),
    name: String(it.BPLC_NM || ""),
    address: String(it.ROAD_NM_ADDR || it.LOTNO_ADDR || ""),
    phone: String(it.TELNO || ""),
    status: String(it.SALS_STTS_NM || ""),
    detailStatus: String(it.DTL_SALS_STTS_NM || ""),
    licensedAt: String(it.LCPMT_YMD || ""),
    ambulances: Number(it.ABLNC_GNRL || 0) + Number(it.ABLNC_SPCL || 0),
  };
}

// 영업 중인지: 영업상태에 "영업"/"정상"이 있고 폐업·휴업 등이 아님
const isOpen = (c) => /영업|정상/.test(c.status + c.detailStatus) && !/폐업|휴업|취소|말소/.test(c.status + c.detailStatus);
const isSeoul = (c) => /^서울/.test(c.address.trim());
// 수도권: 서울·경기·인천 (서울 업체는 전국 API에 없고, 경기·인천 업체도 서울 이송을 많이 함)
const isCapital = (c) => /^(서울|경기|인천)/.test(c.address.trim());

// 공공데이터 한 페이지 받기
async function fetchPage(pageNo) {
  const key = getKey();
  if (!key) throw new Error("공공데이터 API 키(DATA_GO_KR_KEY)가 없습니다.");
  const qs = new URLSearchParams({ serviceKey: key, pageNo: String(pageNo), numOfRows: "100", returnType: "json" });
  const r = await fetch(`${BASE}?${qs}`, { signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`이송업 API 응답 오류 (HTTP ${r.status})`);
  }
  // 키 오류는 이런 모양으로 옴: { OpenAPI_ServiceResponse: { cmmMsgHeader: { errMsg } } }
  const gwErr = data.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (gwErr || !r.ok) {
    const msg = gwErr?.errMsg || "";
    throw new Error(/NOT_REGISTERED|SERVICE_KEY/.test(msg)
      ? "공공데이터포털에서 '응급환자이송업 조회서비스' 활용신청이 필요합니다."
      : `이송업 API 오류: ${gwErr?.returnAuthMsg || msg || "HTTP " + r.status}`);
  }
  const res = data.response || data;
  const code = res?.header?.resultCode;
  if (code && code !== "00" && code !== "0") throw new Error(`이송업 API 오류: ${res.header.resultMsg || code}`);
  let items = res?.body?.items?.item ?? [];
  if (!Array.isArray(items)) items = [items];
  return { items: items.map(pick), total: Number(res?.body?.totalCount) || 0 };
}

// 캐시: 서버가 저장소(Redis)를 넘겨주면 서버가 여러 대여도 같이 씀
let cacheStore = null;
let memCache = null;
const setCache = (s) => (cacheStore = s);

async function loadAll(force = false) {
  if (!force && memCache && Date.now() - memCache.at < CACHE_MS) return memCache.list;
  if (!force && cacheStore) {
    const c = await cacheStore.get().catch(() => null);
    if (c && Date.now() - c.at < CACHE_MS) {
      memCache = c;
      return c.list;
    }
  }
  const first = await fetchPage(1);
  let list = first.items;
  const pages = Math.min(20, Math.ceil(first.total / 100));
  if (pages > 1) {
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => fetchPage(i + 2)));
    list = list.concat(...rest.map((p) => p.items));
  }
  memCache = { at: Date.now(), list };
  if (cacheStore) await cacheStore.set(memCache).catch(() => {});
  return list;
}

const norm = (s) => String(s).replace(/\s|\(주\)|주식회사|㈜/g, "").toLowerCase();

// 수도권 업체 검색 (가입 화면용): 서울시 구급차 파일 + 전국 API(서울·경기·인천, 영업 중). 이름이 비면 전체.
async function search(name) {
  const q = norm(name || "");
  const hit = (n) => !q || norm(n).includes(q);
  const seoulData = await seoul.loadLatest(); // 서울시 API(키 있으면) → 없으면 CSV
  const fromSeoul = seoulData.agencies
    .filter((a) => hit(a.name))
    .map((a) => ({
      mngNo: a.mngNo,
      name: a.name,
      address: a.address,
      phone: a.phone,
      status: "서울시 등록",
      licensedAt: "",
      ambulances: a.plates.length,
      source: "서울시 민간구급차 현황",
    }));
  let fromNation = [];
  let nationError = "";
  try {
    fromNation = (await loadAll())
      .filter((c) => isCapital(c) && isOpen(c) && hit(c.name))
      .map((c) => ({ ...c, source: "행정안전부 응급환자이송업" }));
  } catch (e) {
    nationError = e.message;
  }
  if (!fromSeoul.length && nationError) throw new Error(nationError);
  return fromSeoul.concat(fromNation);
}

// 업체 확인 (가입 저장 직전, 조작 방지). 서울시 업체면 차량번호도 대조
async function verify(mngNo, vehicleNo) {
  if (String(mngNo).startsWith("seoul:")) {
    const a = (await seoul.loadLatest()).agencies.find((x) => x.mngNo === mngNo);
    if (!a) return { ok: false, reason: "서울시 민간구급차 현황에서 업체를 찾지 못했습니다." };
    const company = {
      name: a.name,
      address: a.address,
      status: "서울시 등록",
      licensedAt: "",
      phone: a.phone,
      ambulances: a.plates.length,
      source: "서울시 민간구급차 현황",
    };
    const plate = seoul.normPlate(vehicleNo);
    if (!plate) return { ok: true, company, vehicle: "차량번호 미입력" };
    return a.plates.some((p) => seoul.normPlate(p) === plate)
      ? { ok: true, company, vehicle: "✅ 이 업체 등록 차량" }
      : { ok: false, company, reason: `차량번호 ${vehicleNo}이(가) 이 업체의 등록 구급차 목록에 없습니다.` };
  }
  const found = (await loadAll()).find((c) => c.mngNo === mngNo);
  if (!found) return { ok: false, reason: "공공데이터에서 업체를 찾지 못했습니다." };
  const company = { ...found, source: "행정안전부 응급환자이송업" };
  if (!isOpen(found)) return { ok: false, reason: `영업 상태가 '${found.status}'입니다.`, company };
  if (!isCapital(found)) return { ok: false, reason: "서울·경기·인천 소재 업체가 아닙니다.", company };
  return { ok: true, company };
}

// 관리자 점검용 요약
async function stats(force) {
  const list = await loadAll(force);
  const open = list.filter(isOpen);
  return {
    total: list.length,
    open: open.length,
    seoulOpen: open.filter(isSeoul).length,
    capitalOpen: open.filter(isCapital).length,
    seoulData: (({ source, available, rows, error, apiError, agencies, at }) => ({
      source,
      available,
      rows,
      agencies: agencies.length,
      error,
      apiError,
      fetchedAt: at ? new Date(at).toISOString() : undefined,
    }))(await seoul.loadLatest()),
    seoulApiKey: seoul.hasApiKey(),
    cachedAt: new Date(memCache.at).toISOString(),
    byRegion: open.reduce((m, c) => ((m[c.address.trim().split(/\s+/)[0] || "(주소없음)"] = (m[c.address.trim().split(/\s+/)[0] || "(주소없음)"] || 0) + 1), m), {}),
    sampleSeoul: open.filter(isSeoul).slice(0, 5).map((c) => `${c.name} | ${c.address}`),
  };
}

module.exports = { search, verify, stats, setCache, hasKey: () => Boolean(getKey()) };
