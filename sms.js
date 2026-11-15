/*
 * 문자(SMS) 보내기 - 솔라피(SOLAPI, 구 CoolSMS) 사용
 *
 * 새 콜이 들어오면 승인된 이송단 전체에게 문자를 보냅니다.
 * 필요한 환경변수 (Vercel 프로젝트 설정 → Environment Variables):
 *   SOLAPI_API_KEY, SOLAPI_API_SECRET  : solapi.com 콘솔에서 발급
 *   SOLAPI_SENDER                      : 솔라피에 등록·인증한 발신번호 (예: 01012345678)
 * 셋 중 하나라도 없으면 문자는 건너뛰고, 이송단은 콜 화면 알림으로만 받습니다.
 */
const crypto = require("crypto");

const cfg = () => ({
  key: process.env.SOLAPI_API_KEY || "",
  secret: process.env.SOLAPI_API_SECRET || "",
  from: (process.env.SOLAPI_SENDER || "").replace(/\D/g, ""),
});
const isConfigured = () => {
  const c = cfg();
  return Boolean(c.key && c.secret && c.from);
};

async function sendMany(toList, text) {
  const c = cfg();
  const to = [...new Set(toList.map((n) => String(n).replace(/\D/g, "")).filter((n) => n.length >= 9))];
  if (!isConfigured() || !to.length) return { skipped: true, count: 0 };
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString("hex");
  const signature = crypto.createHmac("sha256", c.secret).update(date + salt).digest("hex");
  const r = await fetch("https://api.solapi.com/messages/v4/send-many/detail", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `HMAC-SHA256 apiKey=${c.key}, date=${date}, salt=${salt}, signature=${signature}`,
    },
    body: JSON.stringify({ messages: to.map((n) => ({ to: n, from: c.from, text })) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`문자 발송 실패 (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
  return { skipped: false, count: to.length };
}

module.exports = { sendMany, isConfigured };
