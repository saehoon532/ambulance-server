/*
 * 구급차 이송처치료(법정요금) 계산 — 서버(Node)와 화면(브라우저)이 같이 씁니다.
 * 근거: 「응급의료에 관한 법률 시행규칙」 제11조 및 [별표 3] 이송처치료의 기준 (개정 2026. 7. 13.)
 *   - 기본요금: 이송거리 10km 이내
 *   - 추가요금: 10km 초과 1km당
 *   - 할증: 평일 18:00~다음날 09:00, 토요일, 공휴일 → 기본·추가요금에 각각 20% 가산
 *   - 대기요금: 병원 도착 후 30분 경과 시부터 10분당 6,000원 (미리 알 수 없어 예상요금에는 넣지 않음)
 *   - 이송거리 = 환자가 구급차에 실제로 탑승한 거리
 *   - 공휴일 = 「관공서의 공휴일에 관한 규정」 (일요일 포함)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Fee = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TABLE = {
    // 법 제44조제1항제1호~제4호: 의료기관·이송업체 등 (이 사이트의 이송단 기준)
    provider: {
      일반: { base: 40000, perKm: 1500 },
      특수: { base: 95500, perKm: 2300 },
    },
    // 법 제44조제1항제5호: 비영리법인
    nonprofit: {
      일반: { base: 26600, perKm: 1000 },
      특수: { base: 63600, perKm: 1500 },
    },
  };
  const BASE_KM = 10;
  const SURCHARGE = 0.2;
  const WAIT_FEE = { afterMin: 30, per10Min: 6000 };
  const SOURCE = "「응급의료에 관한 법률 시행규칙」 제11조 [별표 3] (2026. 7. 13. 개정)";

  // 한국 시간(KST) 기준 요일·시각
  function kstParts(date) {
    const d = new Date(new Date(date).getTime() + 9 * 3600 * 1000);
    return { day: d.getUTCDay(), hour: d.getUTCHours() };
  }

  // 할증 시간대인지: 평일 18~09시, 토요일, 일요일·공휴일
  function surchargeReason(date, isHoliday) {
    const { day, hour } = kstParts(date || Date.now());
    if (isHoliday) return "공휴일";
    if (day === 0) return "일요일(공휴일)";
    if (day === 6) return "토요일";
    if (hour >= 18 || hour < 9) return "야간(18시~09시)";
    return "";
  }

  /**
   * @param {object} o
   *   type: "일반" | "특수"
   *   km: 예상 이송거리 (없으면 기본요금만)
   *   at: 출동 시각 (Date/ISO, 없으면 지금)
   *   holiday: 공휴일 여부 (일요일은 자동)
   *   operator: "provider"(기본) | "nonprofit"
   */
  function estimate(o) {
    const type = o.type === "특수" ? "특수" : "일반";
    const rate = TABLE[o.operator === "nonprofit" ? "nonprofit" : "provider"][type];
    const kmRaw = Number(o.km);
    const km = Number.isFinite(kmRaw) && kmRaw > 0 ? kmRaw : 0;
    const extraKm = Math.max(0, Math.ceil(km - BASE_KM)); // 10km 초과분, 1km 단위 올림(추정)
    const base = rate.base;
    const extra = extraKm * rate.perKm;
    const reason = surchargeReason(o.at, o.holiday);
    const surcharge = reason ? Math.round((base + extra) * SURCHARGE) : 0;
    return {
      type,
      km,
      kmKnown: km > 0,
      extraKm,
      base,
      perKm: rate.perKm,
      extra,
      surcharge,
      surchargeReason: reason,
      total: base + extra + surcharge,
    };
  }

  const won = (n) => `${Math.round(n).toLocaleString("ko-KR")}원`;

  return { TABLE, BASE_KM, SURCHARGE, WAIT_FEE, SOURCE, estimate, surchargeReason, won };
});
