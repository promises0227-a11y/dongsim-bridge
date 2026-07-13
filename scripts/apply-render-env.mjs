/**
 * Render dongsim-bridge 환경변수를 .env.render.local 기준으로 갱신 후 배포
 *
 * Usage:
 *   set RENDER_API_KEY=rnd_...
 *   node scripts/apply-render-env.mjs
 *
 * Optional:
 *   RENDER_SERVICE_NAME=dongsim-bridge
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env.render.local");
const apiKey = process.env.RENDER_API_KEY?.trim();
const serviceName = process.env.RENDER_SERVICE_NAME?.trim() || "dongsim-bridge";

const REMOVE_KEYS = [
  "MAIN_PROJECT_ID",
  "MAIN_CLIENT_EMAIL",
  "MAIN_PRIVATE_KEY",
  "MAIN_PRIVATE_KEY_B64",
  "BACKUP_PROJECT_ID",
  "BACKUP_CLIENT_EMAIL",
  "BACKUP_PRIVATE_KEY",
  "BACKUP_PRIVATE_KEY_B64",
];

const SET_KEYS = [
  "MAIN_SERVICE_ACCOUNT_B64",
  "BACKUP_SERVICE_ACCOUNT_B64",
  "BRIDGE_SECRET",
];

if (!apiKey) {
  console.error("RENDER_API_KEY 가 필요합니다.");
  console.error("Render Dashboard → Account Settings → API Keys 에서 발급 후:");
  console.error('  $env:RENDER_API_KEY="rnd_..."');
  console.error("  node scripts/apply-render-env.mjs");
  process.exit(1);
}

function parseEnvFile(path) {
  const text = readFileSync(path, "utf8");
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return out;
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.render.com/v1${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${init.method || "GET"} ${path} → ${res.status}: ${text}`);
  }
  return body;
}

async function findServiceId() {
  let cursor;
  for (;;) {
    const q = new URLSearchParams({ limit: "100" });
    if (cursor) q.set("cursor", cursor);
    const page = await api(`/services?${q}`);
    for (const item of page) {
      const svc = item.service ?? item;
      if (svc?.name === serviceName) return svc.id;
    }
    cursor = page?.[page.length - 1]?.cursor;
    if (!cursor) break;
  }
  throw new Error(`서비스를 찾을 수 없습니다: ${serviceName}`);
}

async function listEnvVars(serviceId) {
  const rows = await api(`/services/${serviceId}/env-vars`);
  return rows.map((row) => row.envVar ?? row);
}

async function upsertEnvVar(serviceId, key, value) {
  await api(`/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

async function deleteEnvVar(serviceId, key) {
  await api(`/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

async function triggerDeploy(serviceId) {
  return api(`/services/${serviceId}/deploys`, {
    method: "POST",
    body: JSON.stringify({ clearCache: "clear" }),
  });
}

function decodeMainProjectId(b64) {
  const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  return json.project_id;
}

const local = parseEnvFile(envPath);
for (const key of SET_KEYS) {
  if (!local[key]) {
    throw new Error(`.env.render.local 에 ${key} 가 없습니다.`);
  }
}

console.log(`대상 서비스: ${serviceName}`);
console.log(
  `MAIN project (local): ${decodeMainProjectId(local.MAIN_SERVICE_ACCOUNT_B64)}`
);

const serviceId = await findServiceId();
console.log(`serviceId: ${serviceId}`);

const existing = await listEnvVars(serviceId);
const existingKeys = new Set(existing.map((e) => e.key));

for (const key of REMOVE_KEYS) {
  if (!existingKeys.has(key)) continue;
  console.log(`삭제: ${key}`);
  await deleteEnvVar(serviceId, key);
}

for (const key of SET_KEYS) {
  console.log(`설정: ${key}`);
  await upsertEnvVar(serviceId, key, local[key]);
}

console.log("배포 트리거...");
const deploy = await triggerDeploy(serviceId);
const deployId = deploy?.id ?? deploy?.deploy?.id ?? "(unknown)";
console.log(`배포 시작: ${deployId}`);
console.log("완료 후 확인: https://dongsim-bridge.onrender.com/health");
