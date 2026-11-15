/*
 * API 키가 잘 동작하는지 확인하는 도구
 * 실행: npm run check-key
 * 서울특별시 양천구 응급실 병상을 한 번 조회해 보고 결과를 알려 줍니다. (키 값은 화면에 출력하지 않습니다)
 */
const path = require("path");
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {
  console.log("❌ .env 파일을 찾지 못했습니다.");
  process.exit(1);
}
const er = require("./er-api");

(async () => {
  if (!er.hasKey()) {
    console.log("❌ .env 파일에 아직 키가 없습니다. DATA_GO_KR_KEY= 뒤에 키를 붙여넣고 저장하세요.");
    process.exit(1);
  }
  console.log("키를 찾았습니다. 국립중앙의료원에 시험 조회 중… (서울특별시 양천구)");
  try {
    const list = await er.getErBeds("서울특별시", "양천구");
    console.log(`✅ 성공! 응급실 ${list.length}곳을 받아 왔습니다.`);
    list.slice(0, 5).forEach((h) =>
      console.log(`   - ${h.name}: ${h.erBeds > 0 ? `남은 병상 ${h.erBeds}` : "포화"} (${h.updatedAt} 기준)`)
    );
  } catch (e) {
    console.log(`❌ 실패: ${e.message}`);
    process.exit(1);
  }
})();
