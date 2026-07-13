import { readFileSync } from "node:fs";
import { config } from "dotenv";
import admin from "firebase-admin";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(root, ".env.render.local") });

function decodeB64(b64) {
  return Buffer.from(b64.replace(/\s/g, ""), "base64").toString("utf8");
}

async function testSplit(label, projectId, clientEmail, b64Var) {
  const b64 = process.env[b64Var];
  if (!b64) return console.log(`${label}: missing ${b64Var}`);
  const pem = decodeB64(b64);
  const appName = `test-${label}`;
  try {
    const app = admin.initializeApp(
      {
        credential: admin.credential.cert({ projectId, clientEmail, privateKey: pem }),
      },
      appName
    );
    await app.firestore().collection("bridge_transfers").limit(1).get();
    console.log(`${label} split creds: OK`);
    await app.delete();
  } catch (e) {
    console.log(`${label} split creds: FAIL`, e.message);
  }
}

async function testFullJson(label, jsonPath) {
  const sa = JSON.parse(readFileSync(jsonPath, "utf8"));
  const appName = `test-json-${label}`;
  try {
    const app = admin.initializeApp({ credential: admin.credential.cert(sa) }, appName);
    await app.firestore().collection("bridge_transfers").limit(1).get();
    console.log(`${label} full JSON: OK`);
    await app.delete();
  } catch (e) {
    console.log(`${label} full JSON: FAIL`, e.message);
  }
}

async function testFullB64(label, jsonPath) {
  const sa = JSON.parse(readFileSync(jsonPath, "utf8"));
  const b64 = Buffer.from(JSON.stringify(sa), "utf8").toString("base64");
  const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  const appName = `test-sa-b64-${label}`;
  try {
    const app = admin.initializeApp({ credential: admin.credential.cert(decoded) }, appName);
    await app.firestore().collection("bridge_transfers").limit(1).get();
    console.log(`${label} SA B64: OK`);
    await app.delete();
  } catch (e) {
    console.log(`${label} SA B64: FAIL`, e.message);
  }
}

const mainJson = resolve(root, "..", "majeon-ws-backup-firebase-adminsdk-fbsvc-11747677b0.json");
const backupJson = "c:/Users/user/Downloads/dongsim-backup-firebase-adminsdk-fbsvc-9b798301c3.json";

await testSplit("MAIN", process.env.MAIN_PROJECT_ID, process.env.MAIN_CLIENT_EMAIL, "MAIN_PRIVATE_KEY_B64");
await testSplit(
  "BACKUP",
  process.env.BACKUP_PROJECT_ID,
  process.env.BACKUP_CLIENT_EMAIL,
  "BACKUP_PRIVATE_KEY_B64"
);
await testFullJson("MAIN", mainJson);
await testFullJson("BACKUP", backupJson);
await testFullB64("MAIN", mainJson);
await testFullB64("BACKUP", backupJson);
