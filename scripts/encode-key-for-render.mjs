/**
 * Firebase 서비스 계정 JSON → Render용 Base64 환경변수 생성
 *
 * Usage:
 *   node scripts/encode-key-for-render.mjs path/to/service-account.json
 *
 * 출력된 MAIN_PRIVATE_KEY_B64 / BACKUP_PRIVATE_KEY_B64 값을 Render에 붙여넣으면
 * 줄바꿈·따옴표 이스케이프 문제를 피할 수 있습니다.
 */
import { readFileSync } from "node:fs";

const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error("Usage: node scripts/encode-key-for-render.mjs <service-account.json>");
  process.exit(1);
}

const json = JSON.parse(readFileSync(jsonPath, "utf8"));
const pem = String(json.private_key || "").trim();
if (!pem.includes("BEGIN PRIVATE KEY")) {
  console.error("JSON에 private_key(PEM)가 없습니다.");
  process.exit(1);
}

const b64 = Buffer.from(pem, "utf8").toString("base64");
console.log(`project_id=${json.project_id}`);
console.log(`client_email=${json.client_email}`);
console.log(`PRIVATE_KEY_B64=${b64}`);
