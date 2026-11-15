/*
 * 국립중앙의료원 「전국 응급의료기관 정보 조회 서비스」를 부르는 파일
 *
 * 하는 일:
 *   1) .env 파일에 적힌 API 키를 붙여서 공공데이터포털에 질문을 보냅니다.
 *   2) 돌아온 답(XML이라는 형식의 글)을 읽기 쉬운 형태로 정리합니다.
 *   3) 화면에 필요한 것(병원 이름, 전화, 남은 응급실 병상)만 골라 돌려줍니다.
 */
const { XMLParser } = require("fast-xml-parser");

const BASE = "https://apis.data.go.kr/B552657/ErmctInfoInqireService";

// 공공데이터 API가 받아 주는 시·도 이름 (정확히 이 글자여야 함)
const SIDO = [
  "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시", "대전광역시",
  "울산광역시", "세종특별자치시", "경기도", "강원특별자치도", "충청북도", "충청남도",
  "전북특별자치도", "전라남도", "경상북도", "경상남도", "제주특별자치도",
];

const PLACEHOLDER = "여기에_키를_붙여넣으세요";

function getKey() {
  let key = (process.env.DATA_GO_KR_KEY || "").trim();
  if (!key || key === PLACEHOLDER) return "";
  // 실수로 "Encoding" 키(%가 들어간 키)를 넣었어도 동작하도록 풀어 줌
  if (key.includes("%")) {
    try {
      key = decodeURIComponent(key);
    } catch {}
  }
  return key;
}
const hasKey = () => Boolean(getKey());

const parser = new XMLParser({ parseTagValue: false });

// 공공데이터포털에 질문 보내기 (공통)
async function callApi(operation, params) {
  const key = getKey();
  if (!key) throw new Error("API 키가 없습니다. .env 파일에 키를 넣고 서버를 다시 켜 주세요.");

  const qs = new URLSearchParams({ serviceKey: key, pageNo: "1", numOfRows: "50", ...params });
  const res = await fetch(`${BASE}/${operation}?${qs}`, { signal: AbortSignal.timeout(10000) });
  const text = await res.text();

  const data = text.trim().startsWith("{") ? JSON.parse(text) : parser.parse(text);

  // 키 문제 등으로 거절당한 경우
  const auth = data?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (auth) throw new Error(explainKeyError(`${auth.errMsg || ""} ${auth.returnAuthMsg || ""}`));
  if (!res.ok) throw new Error(`공공데이터포털 응답 오류 (${res.status})`);

  const header = data?.response?.header;
  if (header && header.resultCode !== "00") {
    throw new Error(`공공데이터포털: ${header.resultMsg || header.resultCode}`);
  }
  let items = data?.response?.body?.items?.item ?? [];
  if (!Array.isArray(items)) items = [items]; // 결과가 1개면 목록이 아니라 하나로 와서 맞춰 줌
  return items;
}

function explainKeyError(msg = "") {
  if (msg.includes("NOT_REGISTERED")) {
    return "등록되지 않은 키입니다. 키를 정확히 붙여넣었는지 확인하세요. (발급 직후라면 1~2시간 뒤 다시 시도)";
  }
  if (msg.includes("LIMITED_NUMBER")) return "오늘 사용할 수 있는 호출 횟수를 다 썼습니다.";
  return `공공데이터포털이 요청을 거절했습니다: ${msg.trim()}`;
}

// 응급실 실시간 가용 병상 조회
async function getErBeds(sido, sigungu) {
  const params = { STAGE1: sido };
  if (sigungu) params.STAGE2 = sigungu;
  const items = await callApi("getEmrrmRltmUsefulSckbdInfoInqire", params);

  return items
    .map((it) => ({
      id: it.hpid,
      name: it.dutyName,
      phone: it.dutyTel3 || "", // 응급실 직통 전화
      erBeds: Number(it.hvec), // 응급실 남은 병상 (0 이하 = 꽉 참)
      ambulance: it.hvamyn === "Y", // 구급차 가용 여부
      updatedAt: formatTime(it.hvidate), // 병원이 마지막으로 알려 준 시각
    }))
    .sort((a, b) => b.erBeds - a.erBeds);
}

// "20261113192400" → "11/13 19:24"
function formatTime(s = "") {
  s = String(s);
  if (s.length < 12) return "";
  return `${Number(s.slice(4, 6))}/${Number(s.slice(6, 8))} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

module.exports = { SIDO, hasKey, getErBeds };
