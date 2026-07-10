/**
 * Render 대시보드에 붙여넣을 환경변수 파일 생성 (.env.render.local, gitignored)
 *
 * Usage:
 *   node scripts/generate-render-env.mjs \
 *     path/to/majeon-ws-backup-adminsdk.json \
 *     path/to/dongsim-backup-adminsdk.json \
 *     your-bridge-secret
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [mainJsonPath, backupJsonPath, bridgeSecret] = process.argv.slice(2);
if (!mainJsonPath || !backupJsonPath || !bridgeSecret) {
  console.error(
    "Usage: node scripts/generate-render-env.mjs <main-sa.json> <backup-sa.json> <BRIDGE_SECRET>"
  );
  process.exit(1);
}

function toServiceAccountB64(jsonPath) {
  const json = JSON.parse(readFileSync(resolve(jsonPath), "utf8"));
  if (!json.project_id || !json.client_email || !json.private_key) {
    throw new Error(`${jsonPath}: project_id, client_email, private_key 필요`);
  }
  return {
    projectId: json.project_id,
    clientEmail: json.client_email,
    serviceAccountB64: Buffer.from(JSON.stringify(json), "utf8").toString("base64"),
  };
}

const main = toServiceAccountB64(mainJsonPath);
const backup = toServiceAccountB64(backupJsonPath);

const lines = [
  "# Render 권장: 프로젝트당 SERVICE_ACCOUNT_B64 하나만 설정 (project/email/key 불일치 방지)",
  `MAIN_SERVICE_ACCOUNT_B64=${main.serviceAccountB64}`,
  "",
  `BACKUP_SERVICE_ACCOUNT_B64=${backup.serviceAccountB64}`,
  "",
  `BRIDGE_SECRET=${bridgeSecret}`,
  "",
  "# 아래 분리 변수는 삭제하거나 비워 두세요 (SERVICE_ACCOUNT_B64가 우선)",
  "# MAIN_PROJECT_ID / MAIN_CLIENT_EMAIL / MAIN_PRIVATE_KEY / MAIN_PRIVATE_KEY_B64",
  "# BACKUP_PROJECT_ID / BACKUP_CLIENT_EMAIL / BACKUP_PRIVATE_KEY / BACKUP_PRIVATE_KEY_B64",
  "",
  `# main: ${main.projectId} <${main.clientEmail}>`,
  `# backup: ${backup.projectId} <${backup.clientEmail}>`,
];

const outPath = resolve(import.meta.dirname, "..", ".env.render.local");
writeFileSync(outPath, lines.join("\n"), "utf8");
console.log(`Wrote ${outPath}`);
console.log("Render Dashboard → Environment:");
console.log("  1. MAIN_SERVICE_ACCOUNT_B64, BACKUP_SERVICE_ACCOUNT_B64, BRIDGE_SECRET 만 설정");
console.log("  2. 기존 MAIN_/BACKUP_ 분리 변수는 모두 삭제");
console.log("  3. Manual Deploy 후 GET /health 확인");
