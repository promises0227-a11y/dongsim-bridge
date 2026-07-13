import { config } from "dotenv";
import admin from "firebase-admin";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(root, ".env.render.local") });

function decodeB64(b64) {
  return Buffer.from(b64.replace(/\s/g, ""), "base64").toString("utf8");
}

async function test(label, b64Var) {
  const b64 = process.env[b64Var];
  if (!b64) return console.log(`${label}: missing ${b64Var}`);
  const sa = JSON.parse(decodeB64(b64));
  const appName = `test-${label}`;
  try {
    const app = admin.initializeApp({ credential: admin.credential.cert(sa) }, appName);
    await app.firestore().collection("bridge_transfers").limit(1).get();
    console.log(`${label}: OK`, sa.project_id);
    await app.delete();
  } catch (e) {
    console.log(`${label}: FAIL`, e.message);
  }
}

await test("MAIN", "MAIN_SERVICE_ACCOUNT_B64");
await test("BACKUP", "BACKUP_SERVICE_ACCOUNT_B64");
