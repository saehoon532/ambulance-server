/* 이송단 화면: 가입 · 로그인 · 콜 받기
 * 4초마다 콜 판을 확인하고, 새 콜이 들어오면 소리·진동·알림으로 알려 줍니다.
 * "수락"을 가장 먼저 누른 이송단 1곳만 배정됩니다. */
(function () {
  "use strict";
  const { $, $$, api, toast, escapeHtml, formatPhone, formatDateTime, ago, tel, mapLink, summarize, storage } = window.U;
  const TOKEN_KEY = "ambulance:providerToken";
  let token = storage.get(TOKEN_KEY) || "";
  let ver = null;
  let knownOpen = null; // 처음 불러온 뒤부터 새 콜 감지
  let timer = null;
  let board = { open: [], mine: [] };

  const authed = (path, opts = {}) => api(path, { ...opts, headers: { Authorization: `Bearer ${token}` } });

  function show(view) {
    ["authView", "pendingView", "boardView"].forEach((v) => ($("#" + v).hidden = v !== view));
    $("#logoutBtn").hidden = view === "authView";
  }

  // ---------- 로그인 · 가입 ----------
  $$("[data-auth]").forEach((b) =>
    b.addEventListener("click", () => {
      $$("[data-auth]").forEach((x) => x.classList.toggle("active", x === b));
      $("#loginForm").hidden = b.dataset.auth !== "login";
      $("#signupForm").hidden = b.dataset.auth !== "signup";
    })
  );
  ["#loginPhone", "#signPhone"].forEach((s) => $(s).addEventListener("input", (e) => (e.target.value = formatPhone(e.target.value))));

  function afterAuth(res) {
    token = res.token;
    storage.set(TOKEN_KEY, token);
    start();
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      afterAuth(await api("/api/providers/login", { method: "POST", body: { phone: $("#loginPhone").value, password: $("#loginPw").value } }));
      $("#loginPw").value = "";
    } catch (err) {
      toast(err.message);
    }
  });

  async function searchBiz() {
    const name = $("#bizSearch").value.trim();
    const list = $("#bizList");
    $("#bizStatus").textContent = "검색 중…";
    list.innerHTML = "";
    try {
      const rows = await api(`/api/providers/lookup?name=${encodeURIComponent(name)}`);
      $("#bizStatus").textContent = rows.length
        ? `${rows.length}곳 · 우리 업체를 선택하세요.`
        : "등록 업체 중 찾지 못했습니다. 업체명을 직접 입력해도 가입 신청은 됩니다.";
      list.innerHTML = rows
        .map(
          (c, i) => `<li><button type="button" class="biz-item" data-i="${i}">
            <strong>${escapeHtml(c.name)}</strong>
            <span>${escapeHtml(c.address)}${c.phone ? " · " + escapeHtml(c.phone) : ""} · ${escapeHtml(c.status)}${c.ambulances ? ` · 구급차 ${c.ambulances}대` : ""} · 출처: ${escapeHtml(c.source || "")}</span>
          </button></li>`
        )
        .join("");
      list.onclick = (e) => {
        const btn = e.target.closest(".biz-item");
        if (!btn) return;
        const c = rows[btn.dataset.i];
        $("#bizName").value = c.name;
        $("#mngNo").value = c.mngNo;
        $("#bizPicked").textContent = `✅ 등록 업체 선택됨 (${c.source})${c.licensedAt ? " · 인허가 " + c.licensedAt : ""} · ${c.address}${
          c.mngNo.startsWith("seoul:") ? " — 차량번호를 입력하면 이 업체 등록 차량인지도 확인합니다." : ""
        }`;
        $$(".biz-item", list).forEach((x) => x.classList.toggle("picked", x === btn));
      };
    } catch (err) {
      $("#bizStatus").textContent = `${err.message} — 업체명을 직접 입력해도 가입 신청은 됩니다.`;
    }
  }
  $("#bizSearchBtn").addEventListener("click", searchBiz);
  $("#bizSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      searchBiz();
    }
  });
  // 업체명을 손으로 고치면 선택 해제
  $("#bizName").addEventListener("input", () => {
    $("#mngNo").value = "";
    $("#bizPicked").textContent = "직접 입력: 관리자가 허가 여부를 확인한 뒤 승인합니다.";
  });

  $("#signupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      afterAuth(
        await api("/api/providers/signup", {
          method: "POST",
          body: {
            bizName: $("#bizName").value,
            mngNo: $("#mngNo").value,
            contactName: $("#contactName").value,
            vehicleNo: $("#vehicleNo").value,
            phone: $("#signPhone").value,
            password: $("#signPw").value,
          },
        })
      );
      toast("가입 신청이 접수되었습니다.");
    } catch (err) {
      toast(err.message);
    }
  });

  $("#logoutBtn").addEventListener("click", () => {
    token = "";
    storage.set(TOKEN_KEY, null);
    stopPolling();
    show("authView");
  });
  $("#recheckBtn").addEventListener("click", () => start());

  // ---------- 알림 (소리 · 진동 · 브라우저 알림) ----------
  let audioCtx = null;
  $("#alertBtn").addEventListener("click", async () => {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.resume();
      beep();
    } catch {}
    if ("Notification" in window && Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch {}
    }
    $("#alertBtn").textContent = "🔔 알림 켜짐";
    $("#alertBtn").disabled = true;
  });
  function beep() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    [0, 0.35, 0.7].forEach((t) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, now + t);
      g.gain.exponentialRampToValueAtTime(0.4, now + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + t);
      o.stop(now + t + 0.3);
    });
  }
  function alertNewCalls(calls) {
    beep();
    if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
    const c = calls[0];
    const text = `${c.urgency === "긴급" ? "🚨긴급 " : ""}${c.fromArea} → ${c.toArea}`;
    toast(`새 콜: ${text}`);
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification("새 이송 콜", { body: text, tag: "ambulance-call" });
      } catch {}
    }
  }

  // ---------- 콜 판 ----------
  async function poll(force) {
    try {
      const res = await authed(`/api/provider/board${!force && ver !== null ? `?ver=${ver}` : ""}`);
      $("#liveDot").classList.add("on");
      $("#liveText").textContent = `실시간 확인 중 · ${new Date().toLocaleTimeString()}`;
      if (res.unchanged) return "ok";
      ver = res.ver;
      board = res;
      $("#meLine").textContent = `${res.me.bizName} · ${res.me.contactName}`;
      const ids = res.open.map((c) => c.id);
      if (knownOpen) {
        const fresh = res.open.filter((c) => !knownOpen.has(c.id));
        if (fresh.length) alertNewCalls(fresh);
      }
      knownOpen = new Set(ids);
      render();
      return "ok";
    } catch (err) {
      $("#liveDot").classList.remove("on");
      if (err.status === 401) {
        token = "";
        storage.set(TOKEN_KEY, null);
        stopPolling();
        show("authView");
        toast(err.message);
        return "auth";
      }
      if (err.status === 403) {
        stopPolling();
        showPending(err);
        return "pending";
      }
      $("#liveText").textContent = "연결이 끊겼습니다. 다시 시도 중…";
      return "error";
    }
  }

  function tagsOf(c) {
    return [
      c.stale && `⏰ ${c.waitingMin}분째 대기`,
      c.when === "예약" ? `예약 ${String(c.reserveAt).replace("T", " ")}` : "즉시",
      c.mobility,
      c.conscious && `의식 ${c.conscious}`,
      ...(c.equip || []),
      c.roundTrip && "왕복",
      c.guardianRide && "보호자 동승",
      c.elevator && c.elevator !== "있음" && `엘리베이터 ${c.elevator}`,
    ].filter(Boolean);
  }

  function render() {
    const { open, mine } = board;
    $("#openCount").textContent = open.length;
    $("#openEmpty").hidden = open.length > 0;
    $("#openList").innerHTML = open
      .map(
        (c) => `
      <article class="req ${c.urgency === "긴급" ? "urgent" : ""}">
        <div class="req-head">
          <div>
            <strong>${c.urgency === "긴급" ? "🚨 긴급" : "일반"} · ${escapeHtml(c.ptSex)}/${escapeHtml(c.ptAge)}세${c.ptWeight ? "/" + escapeHtml(c.ptWeight) + "kg" : ""}</strong>
            <span class="req-meta">${ago(c.createdAt)} · ${escapeHtml(c.fromType)}</span>
          </div>
        </div>
        <div class="req-route">${escapeHtml(c.fromArea)} <span class="arrow">→</span> ${escapeHtml(c.toArea)}</div>
        ${c.fee ? `<div class="fee-chip">💳 ${escapeHtml(window.U.feeLine(c))}</div>` : ""}
        <div class="req-tags">${tagsOf(c).map((t) => `<span class="tag${t.startsWith("⏰") ? " red" : ""}">${escapeHtml(t)}</span>`).join("")}</div>
        <button class="btn primary accept-btn" data-accept="${escapeHtml(c.id)}" type="button">수락하기</button>
      </article>`
      )
      .join("");

    const active = mine.filter((r) => r.status !== "완료" && r.status !== "취소");
    const done = mine.filter((r) => r.status === "완료" || r.status === "취소").slice(0, 5);
    const list = active.concat(done);
    $("#mineEmpty").hidden = active.length > 0;
    $("#mineList").innerHTML = list
      .map(
        (r) => `
      <article class="req mine ${r.urgency === "긴급" ? "urgent" : ""}" data-id="${escapeHtml(r.id)}">
        <div class="req-head">
          <div>
            <strong>${escapeHtml(r.ptName)}</strong>
            <span class="req-meta">${escapeHtml(r.ptSex)}/${escapeHtml(r.ptAge)}세 · ${escapeHtml(r.id)} · 배정 ${formatDateTime(r.assignedAt)}</span>
          </div>
          <span class="status status-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>
        </div>
        <div class="req-route">${escapeHtml(r.fromAddr)} ${escapeHtml(r.fromDetail)} <span class="arrow">→</span> ${escapeHtml(r.toAddr)}</div>
        <div class="req-tags">${tagsOf(r).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>
        <details ${r.status === "배차완료" ? "open" : ""}><summary class="hint">전체 내용</summary><pre>${escapeHtml(summarize(r))}</pre></details>
        ${
          r.status === "완료" || r.status === "취소"
            ? ""
            : `<div class="req-actions">
          <a class="btn ghost sm" href="${tel(r.reqPhone)}">보호자 전화 ${escapeHtml(formatPhone(r.reqPhone))}</a>
          ${r.fromGeo ? `<a class="btn ghost sm" href="${mapLink(r.fromGeo)}" target="_blank" rel="noopener">출발지 지도</a>` : ""}
          ${r.status === "배차완료" ? `<button class="btn primary sm" data-status="이송중" type="button">환자 탑승 · 이송 시작</button>` : ""}
          ${r.status === "이송중" ? `<button class="btn primary sm" data-status="완료" type="button">이송 완료</button>` : ""}
          ${r.status === "배차완료" ? `<button class="btn text sm" data-status="반납" type="button">못 가게 됨 (콜 반납)</button>` : ""}
        </div>`
        }
      </article>`
      )
      .join("");
  }

  $("#openList").addEventListener("click", async (e) => {
    const id = e.target.dataset.accept;
    if (!id) return;
    e.target.disabled = true;
    e.target.textContent = "수락 중…";
    try {
      await authed(`/api/provider/calls/${encodeURIComponent(id)}/accept`, { method: "POST" });
      toast("배정되었습니다! 보호자에게 바로 전화해 주세요.");
      if (navigator.vibrate) navigator.vibrate(200);
    } catch (err) {
      toast(err.message);
    }
    await poll(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("#mineList").addEventListener("click", async (e) => {
    const status = e.target.dataset.status;
    if (!status) return;
    const id = e.target.closest(".req").dataset.id;
    if (status === "반납" && !confirm("이 콜을 반납할까요? 다른 이송단이 다시 수락할 수 있게 됩니다.")) return;
    try {
      await authed(`/api/provider/calls/${encodeURIComponent(id)}/status`, { method: "POST", body: { status } });
      toast(status === "반납" ? "콜을 반납했습니다." : `상태: ${status}`);
    } catch (err) {
      toast(err.message);
    }
    poll(true);
  });

  // ---------- 시작 ----------
  function showPending(err) {
    const p = err.data && err.data.provider;
    show("pendingView");
    $("#pendingText").textContent = p
      ? `${p.bizName} (${formatPhone(p.phone)}) · ${p.status === "pending" ? "관리자가 허가 정보를 확인한 뒤 승인합니다." : err.message}`
      : err.message;
  }
  function stopPolling() {
    clearInterval(timer);
    timer = null;
  }
  async function start() {
    if (!token) return show("authView");
    ver = null;
    knownOpen = null;
    const result = await poll(true);
    if (result === "auth" || result === "pending") return;
    show("boardView");
    stopPolling();
    timer = setInterval(() => {
      if (!document.hidden) poll(false);
    }, 4000);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && timer) poll(false);
  });
  // 경과 시간("3분 전") 갱신
  setInterval(() => {
    if (!$("#boardView").hidden) render();
  }, 30000);

  start();
})();
