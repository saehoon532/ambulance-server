/* 보호자 진행 상황 화면: 5초마다 서버에 상태를 물어봅니다. */
(function () {
  "use strict";
  const { $, $$, api, toast, escapeHtml, formatPhone, formatDateTime, ago, tel, storage } = window.U;
  const qs = new URLSearchParams(location.search);
  const id = qs.get("id");
  const t = qs.get("t");
  const ORDER = ["배차대기", "배차완료", "이송중", "완료"];
  let timer = null;
  let lastStatus = null;

  if (!id || !t) {
    $("#headline").textContent = "주소가 올바르지 않습니다.";
    return;
  }
  $("#ticket").textContent = `접수번호 ${id}`;

  async function refresh() {
    let r;
    try {
      r = await api(`/api/track/${encodeURIComponent(id)}?t=${encodeURIComponent(t)}`);
    } catch (e) {
      $("#headline").textContent = e.status === 404 ? "접수 건을 찾을 수 없습니다." : "연결이 원활하지 않습니다. 다시 시도 중…";
      if (e.status === 404) {
        storage.set("ambulance:lastTrack", null);
        return stop();
      }
      return;
    }
    render(r);
    if (r.status === "완료" || r.status === "취소") {
      storage.set("ambulance:lastTrack", null);
      stop();
    }
  }

  function render(r) {
    const idx = ORDER.indexOf(r.status);
    $$(".step-item").forEach((el, i) => {
      el.classList.toggle("done", r.status !== "취소" && i < idx);
      el.classList.toggle("now", r.status !== "취소" && i === idx);
    });
    $("#steps").classList.toggle("canceled", r.status === "취소");

    const head = {
      배차대기: "서울 이송단에 요청을 보냈습니다",
      배차완료: "이송단이 배정되었습니다",
      이송중: "환자를 이송하고 있습니다",
      완료: "이송이 완료되었습니다",
      취소: "요청이 취소되었습니다",
    }[r.status];
    $("#headline").textContent = head || r.status;
    $("#subline").textContent =
      r.status === "배차대기"
        ? `가장 먼저 수락한 이송단이 배정됩니다 · 접수 ${ago(r.createdAt)}`
        : r.status === "배차완료"
        ? `배정 ${formatDateTime(r.assignedAt)} · 이송단이 곧 연락드립니다`
        : "";

    // 오래 대기 중이면 안내
    $("#staleBox").hidden = !r.stale;
    if (r.stale) $("#staleTitle").textContent = `${r.waitingMin}분째 수락한 이송단이 없습니다`;

    const p = r.provider;
    $("#providerBox").hidden = !p;
    if (p) {
      $("#pvName").textContent = p.bizName;
      $("#pvMeta").innerHTML = [
        p.contactName && `담당 ${escapeHtml(p.contactName)}`,
        p.vehicleNo && `차량 ${escapeHtml(p.vehicleNo)}`,
        p.phone && escapeHtml(formatPhone(p.phone)),
      ].filter(Boolean).join(" · ");
      $("#pvCall").href = tel(p.phone);
    }

    $("#info").innerHTML = [
      ["환자", r.ptName],
      ["출동", r.when === "예약" ? `예약 ${String(r.reserveAt).replace("T", " ")}` : r.urgency === "긴급" ? "즉시 (긴급)" : "즉시"],
      ["출발", r.fromAddr],
      ["도착", r.toAddr],
      r.fee && ["예상 요금", `${window.U.feeLine(r)}\n실제 탑승 거리·대기시간으로 정산됩니다.`],
    ]
      .filter(Boolean)
      .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v).replace(/\n/g, "<br><small class=\"hint\">")}${v.includes("\n") ? "</small>" : ""}</dd>`)
      .join("");

    $("#cancelBtn").hidden = r.status !== "배차대기";

    // 배정되는 순간 알림
    if (lastStatus === "배차대기" && r.status === "배차완료") {
      toast("이송단이 배정되었습니다!");
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }
    lastStatus = r.status;
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  $("#cancelBtn").addEventListener("click", async () => {
    if (!confirm("이송 요청을 취소할까요?")) return;
    try {
      await api(`/api/track/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { t } });
      toast("요청을 취소했습니다.");
    } catch (e) {
      toast(e.message);
    }
    refresh();
  });

  refresh();
  timer = setInterval(() => {
    if (!document.hidden) refresh();
  }, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && timer) refresh();
  });
})();
