/* 보호자 화면: 이송 요청 접수
 * 접수하면 서버가 서울 이송단들에게 콜을 띄우고, 이 화면은 진행 상황 화면(track.html)으로 넘어갑니다. */
(function () {
  "use strict";
  const { $, $$, api, toast, escapeHtml, formatPhone, mapLink, storage } = window.U;
  const form = $("#requestForm");

  // 진행 중인 접수가 있으면 바로가기 표시
  const last = storage.get("ambulance:lastTrack");
  if (last) {
    const box = $("#lastTrack");
    box.innerHTML = `진행 중인 요청이 있나요? <a href="${escapeHtml(last)}">내 이송 요청 진행 상황 보기 →</a>`;
    box.hidden = false;
  }

  // ---------- 폼 동작 ----------
  $("#reqPhone").addEventListener("input", (e) => (e.target.value = formatPhone(e.target.value)));

  form.addEventListener("change", (e) => {
    if (e.target.name === "when") $("#reserveField").hidden = form.when.value !== "예약";
    if (e.target.name === "equip") {
      $("#o2Field").hidden = !$$('input[name="equip"]').some((c) => c.value === "산소" && c.checked);
    }
    e.target.classList.remove("invalid");
    const group = e.target.closest(".field");
    if (group) group.classList.remove("invalid-group");
  });
  form.addEventListener("input", (e) => e.target.classList.remove("invalid"));

  // 현재 위치 (GPS)
  $("#geoBtn").addEventListener("click", () => {
    const status = $("#geoStatus");
    if (!navigator.geolocation) {
      status.textContent = "이 기기는 위치 확인을 지원하지 않습니다.";
      return;
    }
    status.textContent = "위치 확인 중…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const geo = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
        $("#fromGeo").value = geo;
        const mapA = `<a href="${mapLink(geo)}" target="_blank" rel="noopener">지도에서 확인</a>`;
        status.innerHTML = `좌표 첨부됨 (오차 약 ${Math.round(accuracy)}m) · ${mapA} · 주소 찾는 중…`;
        api(`/api/geocode/reverse?lat=${latitude}&lng=${longitude}`)
          .then(({ address }) => {
            const addrInput = $("#fromAddr");
            if (address && !addrInput.value.trim()) addrInput.value = address;
            status.innerHTML = `좌표 첨부됨 (오차 약 ${Math.round(accuracy)}m) · ${mapA} — 자동 입력된 주소를 꼭 확인해 주세요.`;
          })
          .catch(() => {
            status.innerHTML = `좌표 첨부됨 (오차 약 ${Math.round(accuracy)}m) · ${mapA} — 주소를 직접 적어 주세요.`;
          });
      },
      (err) => {
        status.textContent =
          err.code === err.PERMISSION_DENIED
            ? "위치 권한이 거부되었습니다. 주소를 직접 입력해 주세요."
            : "위치를 가져오지 못했습니다. 주소를 직접 입력해 주세요.";
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  $("#resetBtn").addEventListener("click", () => {
    if (!confirm("입력한 내용을 모두 지울까요?")) return;
    form.reset();
    $("#reserveField").hidden = true;
    $("#o2Field").hidden = true;
    $("#fromGeo").value = "";
    $("#geoStatus").textContent = "";
    $$(".invalid", form).forEach((el) => el.classList.remove("invalid"));
    $$(".invalid-group", form).forEach((el) => el.classList.remove("invalid-group"));
  });

  // ---------- 검증 ----------
  function validate() {
    let firstBad = null;
    const mark = (el) => {
      el.classList.add("invalid");
      if (!firstBad) firstBad = el;
    };
    $$("[required]", form).forEach((el) => {
      if (el.type === "radio") {
        if (!form[el.name].value) {
          el.closest(".field").classList.add("invalid-group");
          if (!firstBad) firstBad = el.closest(".field");
        }
      } else if (el.type === "checkbox") {
        if (!el.checked) mark(el.closest("label"));
      } else if (!el.value.trim()) {
        mark(el);
      }
    });
    const phoneDigits = form.reqPhone.value.replace(/\D/g, "");
    if (phoneDigits && (phoneDigits.length < 9 || phoneDigits.length > 11)) mark(form.reqPhone);
    if (form.when.value === "예약" && !form.reserveAt.value) mark(form.reserveAt);

    if (firstBad) {
      firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
      if (firstBad.focus) firstBad.focus({ preventScroll: true });
      toast("필수 항목(*)을 확인해 주세요.");
      return false;
    }
    return true;
  }

  // ---------- 접수 ----------
  function collect() {
    const f = form;
    return {
      urgency: f.urgency.value,
      when: f.when.value,
      reserveAt: f.when.value === "예약" ? f.reserveAt.value : "",
      roundTrip: f.roundTrip.checked,
      reqName: f.reqName.value.trim(),
      reqPhone: f.reqPhone.value.trim(),
      reqRelation: f.reqRelation.value,
      ptName: f.ptName.value.trim(),
      ptAge: f.ptAge.value,
      ptSex: f.ptSex.value,
      ptWeight: f.ptWeight.value,
      guardianRide: f.guardianRide.checked,
      fromType: f.fromType.value,
      fromAddr: f.fromAddr.value.trim(),
      fromDetail: f.fromDetail.value.trim(),
      fromGeo: f.fromGeo.value,
      elevator: f.elevator.value,
      ptCondition: f.ptCondition.value.trim(),
      conscious: f.conscious.value,
      mobility: f.mobility.value,
      equip: $$('input[name="equip"]:checked').map((c) => c.value),
      o2Flow: f.o2Flow.value,
      vitals: { bp: f.bp.value.trim(), hr: f.hr.value, spo2: f.spo2.value, bt: f.bt.value },
      toAddr: f.toAddr.value.trim(),
      toDept: f.toDept.value.trim(),
      toTime: f.toTime.value,
      memo: f.memo.value.trim(),
      ambType: f.ambType.value,
      distanceKm: f.distanceKm.value,
      holiday: f.holiday.checked,
    };
  }

  // ---------- 예상 요금 (법정 이송처치료) ----------
  const { estimate, won } = window.Fee;
  function departureTime() {
    if (form.when.value === "예약" && form.reserveAt.value) return new Date(form.reserveAt.value);
    return new Date();
  }
  function updateFee() {
    const f = estimate({
      type: form.ambType.value,
      km: form.distanceKm.value,
      at: departureTime(),
      holiday: form.holiday.checked,
    });
    const rows = [
      [`${f.type}구급차 기본요금 (10km 이내)`, won(f.base)],
      f.extraKm ? [`추가 ${f.extraKm}km × ${won(f.perKm)}`, won(f.extra)] : null,
      f.surcharge ? [`할증 20% · ${f.surchargeReason}`, won(f.surcharge)] : null,
    ].filter(Boolean);
    $("#feeBox").innerHTML = `
      <div class="fee-total"><span>예상 요금${f.kmKnown ? "" : " (10km 이내 기준)"}</span><strong>${won(f.total)}${f.kmKnown ? "" : " ~"}</strong></div>
      <ul class="fee-lines">${rows.map(([k, v]) => `<li><span>${escapeHtml(k)}</span><span>${v}</span></li>`).join("")}</ul>
      <p class="hint">실제 요금은 환자가 실제 탑승한 거리로 정산되며, 병원 도착 후 30분이 넘게 대기하면 10분당 6,000원이 더해집니다.${
        f.kmKnown ? "" : " 거리를 입력하면 더 정확해집니다."
      }</p>`;
    // 장비·의식 상태를 보고 특수구급차 권유
    const heavy = $$('input[name="equip"]:checked').some((c) => c.value === "인공호흡기") || form.conscious.value === "반응없음";
    $("#ambSuggest").hidden = !(heavy && form.ambType.value !== "특수");
    $("#ambSuggest").textContent = "인공호흡기 사용 또는 의식이 없는 환자는 특수구급차가 필요할 수 있습니다.";
  }
  form.addEventListener("change", updateFee);
  form.addEventListener("input", (e) => {
    if (e.target.name === "distanceKm") updateFee();
  });
  form.addEventListener("reset", () => setTimeout(updateFee, 0));
  updateFee();
  setInterval(updateFee, 60000); // 시간이 지나 야간 할증 구간에 들어가면 반영

  // 출발지·도착지가 있으면 카카오맵 길찾기로 연결 (거리 확인용)
  $("#distanceLink").addEventListener("click", (e) => {
    const from = form.fromAddr.value.trim();
    const to = form.toAddr.value.trim();
    if (from && to) e.currentTarget.href = `https://map.kakao.com/?sName=${encodeURIComponent(from)}&eName=${encodeURIComponent(to)}`;
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validate()) return;
    const submitBtn = $('button[type="submit"]', form);
    submitBtn.disabled = true;
    submitBtn.textContent = "접수 중…";
    try {
      const saved = await api("/api/requests", { method: "POST", body: collect() });
      const url = `track.html?id=${encodeURIComponent(saved.id)}&t=${encodeURIComponent(saved.trackToken)}`;
      storage.set("ambulance:lastTrack", url);
      location.href = url;
    } catch (err) {
      toast(`접수 실패: ${err.message} — 119 또는 이송업체에 전화해 주세요.`);
      submitBtn.disabled = false;
      submitBtn.textContent = "이송 요청 접수";
    }
  });

  // ---------- 응급실 실시간 남은 병상 (우리 서버 → 국립중앙의료원) ----------
  const SIDO = [
    "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시", "대전광역시",
    "울산광역시", "세종특별자치시", "경기도", "강원특별자치도", "충청북도", "충청남도",
    "전북특별자치도", "전라남도", "경상북도", "경상남도", "제주특별자치도",
  ];
  $("#erSido").innerHTML = SIDO.map((s) => `<option>${s}</option>`).join("");

  $(".er-box").addEventListener("toggle", (e) => {
    if (!e.target.open || $("#erSigungu").value) return;
    const addr = $("#fromAddr").value;
    const gu = addr.match(/(\S+[구군])(?=\s|,|$)/) || addr.match(/(\S+시)(?=\s|,|$)/);
    if (gu) $("#erSigungu").value = gu[1].replace(/,$/, "");
    const sido = SIDO.find((s) => addr.includes(s) || addr.startsWith(s.slice(0, 2)));
    if (sido) $("#erSido").value = sido;
  });

  async function searchEr() {
    const status = $("#erStatus");
    const box = $("#erList");
    status.textContent = "조회 중…";
    box.innerHTML = "";
    try {
      const qs = new URLSearchParams({ sido: $("#erSido").value, sigungu: $("#erSigungu").value.trim() });
      const list = await api(`/api/er/beds?${qs}`);
      if (!list.length) {
        status.textContent = "해당 지역에 조회된 응급실이 없습니다. 구·시·군 이름을 확인해 주세요.";
        return;
      }
      status.textContent = `${list.length}곳 · 병원이 알려 온 시각 기준이며, 출발 전 전화로 꼭 확인하세요.`;
      box.innerHTML = list
        .map(
          (h) => `
        <li>
          <div class="er-info">
            <strong>${escapeHtml(h.name)}</strong>
            <span>${h.phone ? `<a href="tel:${escapeHtml(h.phone.replace(/[^\d]/g, ""))}">${escapeHtml(h.phone)}</a> · ` : ""}${escapeHtml(h.updatedAt)} 기준</span>
          </div>
          <span class="er-beds ${h.erBeds > 0 ? "" : "full"}">${h.erBeds > 0 ? `여유 ${h.erBeds}` : "포화"}</span>
          <button type="button" class="btn ghost sm" data-er-name="${escapeHtml(h.name)}">선택</button>
        </li>`
        )
        .join("");
    } catch (err) {
      status.textContent = err.message;
    }
  }
  $("#erBtn").addEventListener("click", searchEr);
  $("#erSigungu").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      searchEr();
    }
  });
  $("#erList").addEventListener("click", (e) => {
    const name = e.target.dataset.erName;
    if (!name) return;
    $("#toAddr").value = `${name} 응급실`;
    $("#toAddr").classList.remove("invalid");
    toast(`도착지: ${name}`);
  });
})();
