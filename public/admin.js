/* 관리자 화면: 이송단 가입 승인 · 전체 콜 현황 */
(function () {
  "use strict";
  const { $, $$, api, toast, escapeHtml, formatPhone, formatDateTime, tel, summarize, storage } = window.U;
  const PW_KEY = "ambulance:adminPw";
  let pw = storage.get(PW_KEY, sessionStorage) || "";
  let calls = [];
  let providers = [];
  let timer = null;

  const admin = (path, opts = {}) => api(path, { ...opts, headers: { "X-Admin-Password": pw } });

  function showLogin() {
    pw = "";
    storage.set(PW_KEY, null, sessionStorage);
    clearInterval(timer);
    $("#loginForm").hidden = false;
    $("#adminView").hidden = true;
    $("#logoutBtn").hidden = true;
  }

  async function enter() {
    try {
      const info = await admin("/api/admin/login", { method: "POST" });
      const m = info.staleMin || {};
      $("#sysLine").textContent =
        `문자 ${info.sms ? "켜짐" : "꺼짐"}${info.sms && !info.adminPhone ? "(관리자 번호 없음)" : ""} · ` +
        `대기 알림 긴급 ${m.urgent}분/일반 ${m.normal}분/예약 ${m.reserved}분`;
    } catch (e) {
      if (e.status === 401 || e.status === 503) {
        showLogin();
        if (pw || e.status === 503) toast(e.message);
        return;
      }
      toast(e.message);
      return;
    }
    $("#loginForm").hidden = true;
    $("#adminView").hidden = false;
    $("#logoutBtn").hidden = false;
    await loadAll();
    clearInterval(timer);
    timer = setInterval(() => {
      if (!document.hidden) loadAll();
    }, 10000);
  }

  // ---------- 오래 대기 콜 알림 (소리 · 브라우저 알림) ----------
  let audioCtx = null;
  let knownStale = null;
  function unlockSound() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume();
    } catch {}
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  }
  function beep() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    [0, 0.3, 0.6, 0.9].forEach((t) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 660;
      g.gain.setValueAtTime(0.0001, now + t);
      g.gain.exponentialRampToValueAtTime(0.4, now + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.22);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + t);
      o.stop(now + t + 0.25);
    });
  }
  function checkStaleCalls() {
    const stale = calls.filter((r) => r.stale);
    const banner = $("#staleBanner");
    banner.hidden = !stale.length;
    banner.innerHTML = stale.length
      ? `⏰ <strong>${stale.length}건</strong>이 오래 대기 중입니다: ` +
        stale.map((r) => `${escapeHtml(r.ptName)} ${r.waitingMin}분째${r.urgency === "긴급" ? "(긴급)" : ""}`).join(", ") +
        ` — 이송단에 직접 전화하거나 보호자에게 연락해 주세요.`
      : "";
    const ids = new Set(stale.map((r) => r.id));
    if (knownStale) {
      const fresh = stale.filter((r) => !knownStale.has(r.id));
      if (fresh.length) {
        beep();
        toast(`오래 대기 콜 ${fresh.length}건`);
        if ("Notification" in window && Notification.permission === "granted") {
          try {
            new Notification("오래 대기 중인 콜", { body: fresh.map((r) => `${r.ptName} ${r.waitingMin}분째`).join(", "), tag: "stale-call" });
          } catch {}
        }
      }
    }
    knownStale = ids;
  }
  document.addEventListener("click", unlockSound, { once: true });

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    unlockSound();
    pw = $("#adminPassword").value;
    $("#adminPassword").value = "";
    storage.set(PW_KEY, pw, sessionStorage);
    await enter();
  });
  $("#logoutBtn").addEventListener("click", showLogin);

  $$(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
      $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${t.dataset.tab}`));
    })
  );

  async function loadAll() {
    try {
      [calls, providers] = await Promise.all([admin("/api/admin/requests"), admin("/api/admin/providers")]);
    } catch (e) {
      if (e.status === 401) return showLogin();
      return toast(e.message);
    }
    renderCalls();
    renderProviders();
    checkStaleCalls();
  }

  // ---------- 콜 현황 ----------
  function renderCalls() {
    $("#callCount").textContent = calls.filter((r) => r.status === "배차대기" || r.status === "배차완료" || r.status === "이송중").length;
    const filter = $("#statusFilter").value;
    const list = calls.filter((r) => !filter || r.status === filter);
    $("#callEmpty").hidden = list.length > 0;
    $("#callList").innerHTML = list
      .map(
        (r) => `
      <article class="req ${r.urgency === "긴급" ? "urgent" : ""}" data-id="${escapeHtml(r.id)}">
        <div class="req-head">
          <div>
            <strong>${escapeHtml(r.ptName)}</strong>
            <span class="req-meta">${escapeHtml(r.ptSex)}/${escapeHtml(r.ptAge)}세 · ${escapeHtml(r.id)} · 접수 ${formatDateTime(r.createdAt)}</span>
          </div>
          <span class="status status-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>
        </div>
        <div class="req-route">${escapeHtml(r.fromAddr)} <span class="arrow">→</span> ${escapeHtml(r.toAddr)}</div>
        ${r.fee ? `<div class="fee-chip">💳 ${escapeHtml(window.U.feeLine(r))}</div>` : ""}
        <div class="req-meta">${
          r.provider
            ? `배정: <strong>${escapeHtml(r.provider.bizName)}</strong> ${escapeHtml(r.provider.contactName)} · <a href="${tel(r.provider.phone)}">${escapeHtml(formatPhone(r.provider.phone))}</a>${r.provider.vehicleNo ? " · " + escapeHtml(r.provider.vehicleNo) : ""} · ${formatDateTime(r.assignedAt)}`
            : r.status === "배차대기"
            ? `아직 수락한 이송단 없음 · ${r.waitingMin}분째 대기${r.stale ? ` <span class="tag red">⏰ 기준 ${r.staleLimit}분 초과</span>` : ""}${r.staleAlertedAt ? " · 재알림 보냄" : ""}`
            : ""
        }${r.releasedBy && r.releasedBy.length ? ` · 반납: ${escapeHtml(r.releasedBy.join(", "))}` : ""}</div>
        <details><summary class="hint">전체 내용</summary><pre>${escapeHtml(summarize(r))}</pre></details>
        <div class="req-actions">
          <a class="btn ghost sm" href="${tel(r.reqPhone)}">보호자 전화</a>
          ${r.status !== "완료" && r.status !== "취소" ? `<button class="btn ghost sm" data-act="cancel" type="button">콜 취소</button>` : ""}
          <button class="btn text sm" data-act="delete" type="button">삭제</button>
        </div>
      </article>`
      )
      .join("");
  }
  $("#statusFilter").addEventListener("change", renderCalls);

  $("#callList").addEventListener("click", async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    const id = e.target.closest(".req").dataset.id;
    const r = calls.find((x) => x.id === id);
    try {
      if (act === "cancel" && confirm(`${r.ptName} 님 콜을 취소할까요?${r.provider ? "\n배정된 이송단에도 꼭 전화로 알려 주세요." : ""}`)) {
        await admin(`/api/admin/requests/${encodeURIComponent(id)}/cancel`, { method: "POST" });
        toast("콜을 취소했습니다.");
      }
      if (act === "delete" && confirm(`${r.ptName} 님 기록을 완전히 삭제할까요? 되돌릴 수 없습니다.`)) {
        await admin(`/api/admin/requests/${encodeURIComponent(id)}`, { method: "DELETE" });
        toast("삭제했습니다.");
      }
    } catch (err) {
      toast(err.message);
    }
    loadAll();
  });

  // ---------- 이송단 ----------
  const P_LABEL = { pending: "승인 대기", approved: "승인됨", rejected: "거절됨", suspended: "정지됨" };
  function renderProviders() {
    const order = { pending: 0, approved: 1, suspended: 2, rejected: 3 };
    const list = providers.slice().sort((a, b) => order[a.status] - order[b.status]);
    $("#pendingCount").textContent = providers.filter((p) => p.status === "pending").length;
    $("#providerEmpty").hidden = list.length > 0;
    $("#providerList").innerHTML = list
      .map((p) => {
        const v = p.verification || {};
        const c = v.company;
        return `
      <article class="req" data-id="${escapeHtml(p.id)}">
        <div class="req-head">
          <div>
            <strong>${escapeHtml(p.bizName)}</strong>
            <span class="req-meta">${escapeHtml(p.contactName)} · <a href="${tel(p.phone)}">${escapeHtml(formatPhone(p.phone))}</a>${p.vehicleNo ? " · " + escapeHtml(p.vehicleNo) : ""} · 가입 ${formatDateTime(p.createdAt)}</span>
          </div>
          <span class="status pv-${escapeHtml(p.status)}">${P_LABEL[p.status] || escapeHtml(p.status)}</span>
        </div>
        <div class="verify ${v.ok ? "ok" : "warn"}">
          ${
            v.ok
              ? `✅ 공공데이터 확인 (${escapeHtml(c.source || "")}): ${escapeHtml(c.status)}${c.licensedAt ? " · 인허가 " + escapeHtml(c.licensedAt) : ""} · ${escapeHtml(c.address)}${c.phone ? " · " + escapeHtml(c.phone) : ""}${v.vehicle ? " · 차량: " + escapeHtml(v.vehicle) : ""}`
              : `⚠️ 공공데이터 확인 안 됨: ${escapeHtml(v.reason || "정보 없음")} — 허가증·차량등록증을 직접 확인한 뒤 승인하세요.`
          }
        </div>
        <div class="req-actions">
          ${p.status !== "approved" ? `<button class="btn primary sm" data-act="approve" type="button">승인</button>` : ""}
          ${p.status === "pending" ? `<button class="btn ghost sm" data-act="reject" type="button">거절</button>` : ""}
          ${p.status === "approved" ? `<button class="btn ghost sm" data-act="suspend" type="button">콜 수신 정지</button>` : ""}
          <button class="btn text sm" data-act="delete" type="button">삭제</button>
        </div>
      </article>`;
      })
      .join("");
  }

  $("#providerList").addEventListener("click", async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    const id = e.target.closest(".req").dataset.id;
    const p = providers.find((x) => x.id === id);
    try {
      if (act === "delete") {
        if (!confirm(`${p.bizName} 계정을 삭제할까요?`)) return;
        await admin(`/api/admin/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
      } else {
        await admin(`/api/admin/providers/${encodeURIComponent(id)}/${act}`, { method: "POST" });
      }
      toast({ approve: "승인했습니다.", reject: "거절했습니다.", suspend: "정지했습니다.", delete: "삭제했습니다." }[act]);
    } catch (err) {
      toast(err.message);
    }
    loadAll();
  });

  // ---------- CSV (엑셀 한글 깨짐 방지 BOM 포함) ----------
  $("#exportBtn").addEventListener("click", () => {
    if (!calls.length) return toast("내보낼 기록이 없습니다.");
    const cols = [
      ["접수번호", (r) => r.id],
      ["접수시각", (r) => r.createdAt],
      ["상태", (r) => r.status],
      ["배정 이송단", (r) => (r.provider ? r.provider.bizName : "")],
      ["배정시각", (r) => r.assignedAt || ""],
      ["긴급도", (r) => r.urgency],
      ["출동", (r) => (r.when === "예약" ? r.reserveAt : "즉시")],
      ["환자명", (r) => r.ptName],
      ["성별", (r) => r.ptSex],
      ["나이", (r) => r.ptAge],
      ["상태/증상", (r) => r.ptCondition],
      ["이동", (r) => r.mobility],
      ["장비", (r) => (r.equip || []).join("/")],
      ["출발지", (r) => `${r.fromAddr} ${r.fromDetail}`.trim()],
      ["도착지", (r) => r.toAddr],
      ["요청자", (r) => r.reqName],
      ["연락처", (r) => r.reqPhone],
      ["메모", (r) => r.memo],
      ["구급차", (r) => r.ambType || ""],
      ["예상거리km", (r) => (r.fee && r.fee.kmKnown ? r.fee.km : "")],
      ["예상요금", (r) => (r.fee ? r.fee.total : "")],
      ["할증", (r) => (r.fee ? r.fee.surchargeReason : "")],
    ];
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [cols.map((c) => cell(c[0])).join(",")].concat(calls.map((r) => cols.map((c) => cell(c[1](r))).join(","))).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = `이송콜_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  if (pw) enter();
  else showLogin();
})();
