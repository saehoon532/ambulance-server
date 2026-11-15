/* 여러 화면(보호자·이송단·관리자)이 같이 쓰는 도우미 */
(function () {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // 서버와 대화: 실패하면 서버가 보낸 오류 문구로 Error를 던짐 (e.status 에 HTTP 코드)
  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error((data && data.error) || `서버 오류 (${res.status})`);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  function toast(msg) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  const escapeHtml = (str) =>
    String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function formatPhone(value) {
    const d = String(value).replace(/\D/g, "").slice(0, 11);
    if (d.startsWith("02")) {
      if (d.length <= 2) return d;
      if (d.length <= 5) return `${d.slice(0, 2)}-${d.slice(2)}`;
      if (d.length <= 9) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
      return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6, 10)}`;
    }
    if (d.length <= 3) return d;
    if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
    if (d.length <= 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  }

  function formatDateTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return String(iso).replace("T", " ");
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function ago(iso) {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
    if (s < 60) return `${s}초 전`;
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    return `${Math.floor(s / 3600)}시간 전`;
  }

  const tel = (phone) => `tel:${String(phone || "").replace(/[^\d+]/g, "")}`;
  const mapLink = (geo) => {
    const [lat, lng] = String(geo).split(",");
    return `https://map.kakao.com/link/map/환자위치,${lat},${lng}`;
  };

  // 접수 내용 전체를 글로 정리 (수락한 이송단·관리자용)
  function summarize(r) {
    const lines = [];
    lines.push(`[구급차 이송 요청] ${r.urgency === "긴급" ? "🚨긴급" : "일반"}`);
    lines.push(`접수번호: ${r.id}`);
    lines.push(`출동: ${r.when === "예약" ? "예약 " + String(r.reserveAt).replace("T", " ") : "즉시"}${r.roundTrip ? " / 왕복" : ""}`);
    lines.push("");
    lines.push("■ 환자");
    lines.push(`${r.ptName} (${r.ptSex}/${r.ptAge}세${r.ptWeight ? "/" + r.ptWeight + "kg" : ""})` + (r.guardianRide ? " · 보호자 동승" : ""));
    lines.push(`상태: ${r.ptCondition}`);
    lines.push(`의식: ${r.conscious} · 이동: ${r.mobility}`);
    if (r.equip && r.equip.length) {
      lines.push(`장비: ${r.equip.map((e) => (e === "산소" && r.o2Flow ? `산소 ${r.o2Flow}L/min` : e)).join(", ")}`);
    }
    const v = r.vitals || {};
    const vit = [v.bp && `BP ${v.bp}`, v.hr && `HR ${v.hr}`, v.spo2 && `SpO2 ${v.spo2}%`, v.bt && `BT ${v.bt}℃`].filter(Boolean);
    if (vit.length) lines.push(`활력: ${vit.join(" / ")}`);
    lines.push("");
    lines.push(`■ 출발지 (${r.fromType})`);
    lines.push(`${r.fromAddr}${r.fromDetail ? " " + r.fromDetail : ""}`);
    lines.push(`엘리베이터: ${r.elevator}`);
    if (r.fromGeo) lines.push(`위치: ${mapLink(r.fromGeo)}`);
    lines.push("");
    lines.push("■ 도착지");
    lines.push(`${r.toAddr}${r.toDept ? " / " + r.toDept : ""}${r.toTime ? " (예약 " + r.toTime + ")" : ""}`);
    lines.push("");
    lines.push(`■ 요청자: ${r.reqName} (${r.reqRelation}) ${r.reqPhone}`);
    if (r.memo) lines.push(`■ 메모: ${r.memo}`);
    if (r.fee) {
      lines.push("");
      lines.push(`■ 구급차·요금: ${feeLine(r)}`);
    }
    return lines.join("\n");
  }

  // 예상 요금 한 줄 요약 (서버가 저장한 fee 사용)
  const won = (n) => `${Math.round(Number(n) || 0).toLocaleString("ko-KR")}원`;
  function feeLine(r) {
    const f = r.fee;
    if (!f) return "";
    return [
      `${f.type}구급차`,
      f.kmKnown ? `약 ${f.km}km` : "거리 미입력(10km 이내 기준)",
      `예상 ${won(f.total)}${f.kmKnown ? "" : "~"}`,
      f.surchargeReason && `할증: ${f.surchargeReason}`,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  // 브라우저 저장소는 막혀 있을 수 있으므로 항상 try/catch
  const storage = {
    get(k, area = localStorage) {
      try {
        return area.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v, area = localStorage) {
      try {
        if (v === null || v === undefined || v === "") area.removeItem(k);
        else area.setItem(k, v);
      } catch {}
    },
  };

  window.U = { $, $$, api, toast, escapeHtml, formatPhone, formatDateTime, ago, tel, mapLink, summarize, storage, won, feeLine };
})();
