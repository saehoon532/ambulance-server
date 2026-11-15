/*
 * 서울시 「민간구급차 현황」 파일 읽기 (서울 열린데이터광장 OA-21292)
 *
 * 서울 업체는 행정안전부 전국 이송업 API에 없어서, 서울시가 공개한 CSV 파일을 함께 씁니다.
 * 파일 위치: 프로젝트 맨 위 폴더의 seoul-ambulances.csv
 *   - 열린데이터광장에서 내려받은 파일을 이 이름으로 바꿔 넣고 다시 배포하면 갱신됩니다.
 *   - UTF-8 / EUC-KR(엑셀 저장) 둘 다 읽습니다.
 * 열 이름은 "기관명", "주소", "차량번호"가 들어간 열을 자동으로 찾습니다.
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "seoul-ambulances.csv");
let cache = null;

function decode(buf) {
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("�")) return utf8.replace(/^﻿/, "");
  return new TextDecoder("euc-kr").decode(buf); // 엑셀에서 저장한 한글 CSV
}

// 따옴표·쉼표를 처리하는 간단한 CSV 읽기
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

// 차량번호 비교용: 공백·하이픈 제거, 옛 번호판의 지역명(예: "서울70자1234"의 "서울") 제거
const normPlate = (s) => String(s || "").replace(/[\s-]/g, "").replace(/^[가-힣]{2}(?=\d)/, "");

function load() {
  if (cache) return cache;
  if (!fs.existsSync(FILE)) return (cache = { available: false, agencies: [] });
  const rows = parseCsv(decode(fs.readFileSync(FILE)));
  const header = (rows.shift() || []).map((h) => h.trim());
  // 앞에 적은 이름부터 차례로 찾음 (예: "등록구분코드명"을 "등록구분코드"보다 먼저)
  const col = (...names) => {
    for (const n of names) {
      const i = header.findIndex((h) => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const iName = col("기관명", "업체명", "사업장명", "상호");
  const iAddr = col("주소", "소재지");
  const iPlate = col("차량번호", "자동차등록번호");
  const iPhone = col("전화번호");
  const iKind = col("등록구분코드명", "등록구분");
  if (iName < 0) return (cache = { available: false, agencies: [], error: `열 이름을 찾지 못함: ${header.join(",")}` });

  const map = new Map();
  for (const r of rows) {
    const name = (r[iName] || "").trim();
    if (!name) continue;
    // "통보사"는 보건소 등 공공기관 구급차 → 이송단 후보에서 제외 ("신고사"만 사용)
    if (iKind >= 0 && /통보/.test(r[iKind] || "")) continue;
    const a = map.get(name) || { mngNo: `seoul:${name}`, name, address: "", phone: "", plates: [] };
    if (!a.address && iAddr >= 0) a.address = (r[iAddr] || "").trim();
    if (!a.phone && iPhone >= 0) a.phone = (r[iPhone] || "").trim();
    if (iPlate >= 0 && r[iPlate]) a.plates.push(r[iPlate].trim());
    map.set(name, a);
  }
  return (cache = { available: true, agencies: [...map.values()], rows: rows.length });
}

// ---------- 서울 열린데이터광장 Open API (tvAmblInfoInqire, 매일 1회 갱신) ----------
// 환경변수 SEOUL_API_KEY 가 있으면 API로 최신 목록을 받아 12시간 보관하고,
// 키가 없거나 API가 실패하면 위의 CSV 파일을 씁니다.
const API_CACHE_MS = 12 * 3600 * 1000;
let apiCache = null;
let apiStore = null; // 서버가 Redis 저장소를 넘겨주면 여러 서버가 같이 씀
const setCache = (s) => (apiStore = s);
const hasApiKey = () => Boolean((process.env.SEOUL_API_KEY || "").trim());

function buildAgencies(rows) {
  const map = new Map();
  for (const r of rows) {
    const name = String(r.DUTYNAME || "").trim();
    if (!name) continue;
    if (String(r.AMBLRESCD) === "1" || /통보/.test(r.AMBLRESCDNM || "")) continue; // 보건소 등 제외
    const a = map.get(name) || { mngNo: `seoul:${name}`, name, address: "", phone: "", plates: [] };
    if (!a.address) a.address = String(r.DUTYADDR || "").trim();
    if (!a.phone) a.phone = String(r.ONRTEL || "").trim();
    if (r.CARSEQ) a.plates.push(String(r.CARSEQ).trim());
    map.set(name, a);
  }
  return [...map.values()];
}

async function fetchApi() {
  const key = encodeURIComponent((process.env.SEOUL_API_KEY || "").trim());
  const rows = [];
  for (let start = 1; start <= 5000; start += 1000) {
    const url = `http://openapi.seoul.go.kr:8088/${key}/json/tvAmblInfoInqire/${start}/${start + 999}/`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    const body = data && data.tvAmblInfoInqire;
    if (!body) {
      // 오류는 JSON을 요청해도 XML로 옴: <RESULT><CODE>INFO-100</CODE><MESSAGE><![CDATA[...]]></MESSAGE></RESULT>
      const m = text.match(/<CODE>([^<]+)<\/CODE>[\s\S]*?<MESSAGE>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/MESSAGE>/);
      const msg = m ? `${m[1]} ${m[2].split("\n")[0]}` : data?.RESULT?.MESSAGE || `HTTP ${r.status}`;
      throw new Error(`서울시 구급차 API 오류: ${msg}`);
    }
    rows.push(...(body.row || []));
    if (rows.length >= Number(body.list_total_count || 0)) break;
  }
  return { at: Date.now(), rows: rows.length, agencies: buildAgencies(rows) };
}

// API 우선, 실패 시 CSV. 반환 모양은 load()와 같음 (+ source)
async function loadLatest() {
  if (hasApiKey()) {
    try {
      if (!apiCache || Date.now() - apiCache.at > API_CACHE_MS) {
        const c = apiStore && (await apiStore.get().catch(() => null));
        if (c && Date.now() - c.at < API_CACHE_MS) apiCache = c;
        else {
          apiCache = await fetchApi();
          if (apiStore) await apiStore.set(apiCache).catch(() => {});
        }
      }
      return { available: true, source: "api", ...apiCache };
    } catch (e) {
      const file = load();
      return { ...file, source: "csv", apiError: e.message };
    }
  }
  return { ...load(), source: "csv" };
}

module.exports = { load, loadLatest, setCache, hasApiKey, normPlate };
