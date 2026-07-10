import { createPrivateKey } from "node:crypto";

export type CredentialSource =
  | "service_account_b64"
  | "service_account_json"
  | "private_key_b64"
  | "private_key";

export type LoadedCredential = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  source: CredentialSource;
};

function decodeBase64(raw: string, label: string): string {
  const normalized = raw.replace(/\s/g, "");
  if (!normalized) {
    throw new Error(`${label}: Base64 값이 비어 있습니다.`);
  }
  const decoded = Buffer.from(normalized, "base64").toString("utf8");
  if (!decoded) {
    throw new Error(`${label}: Base64 디코딩 결과가 비어 있습니다.`);
  }
  return decoded;
}

function validateEmailMatchesProject(
  clientEmail: string,
  projectId: string,
  label: string
): void {
  const expectedSuffix = `@${projectId}.iam.gserviceaccount.com`;
  if (!clientEmail.endsWith(expectedSuffix)) {
    throw new Error(
      `${label}: client_email(${clientEmail})이 project_id(${projectId})와 맞지 않습니다. ` +
        `같은 서비스 계정 JSON에서 생성한 값인지 확인하거나 ${label}_SERVICE_ACCOUNT_B64를 사용하세요.`
    );
  }
}

/**
 * Render 등 PaaS 환경변수에서 흔한 PEM 포맷 문제를 정규화합니다.
 */
export function parsePrivateKey(raw: string, label: string): string {
  let key = raw.trim();

  if (key.startsWith("{") && key.includes("private_key")) {
    throw new Error(
      `${label}: 서비스 계정 JSON 전체가 아니라 private_key 문자열만 넣었는지 확인하세요. ` +
        `권장: ${label.replace(/_PRIVATE_KEY.*/, "")}_SERVICE_ACCOUNT_B64 사용`
    );
  }

  while (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }

  key = key.replace(/\\n/g, "\n").replace(/\r/g, "");

  if (!key.includes("\n") && key.includes("BEGIN PRIVATE KEY")) {
    key = key
      .replace("-----BEGIN PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----\n")
      .replace("-----END PRIVATE KEY-----", "\n-----END PRIVATE KEY-----\n");
  }

  if (!key.includes("BEGIN PRIVATE KEY") || !key.includes("END PRIVATE KEY")) {
    throw new Error(
      `${label}: PEM 형식이 아닙니다. Firebase 서비스 계정 JSON의 private_key를 확인하세요.`
    );
  }

  try {
    createPrivateKey({ key, format: "pem", type: "pkcs8" });
  } catch {
    try {
      createPrivateKey({ key, format: "pem", type: "pkcs1" });
    } catch {
      throw new Error(
        `${label}: private key를 해석할 수 없습니다. Render에서 ${label}_SERVICE_ACCOUNT_B64 사용을 권장합니다.`
      );
    }
  }

  return key;
}

function fromServiceAccountJson(
  json: Record<string, unknown>,
  label: string,
  source: CredentialSource
): LoadedCredential {
  const projectId = String(json.project_id || "").trim();
  const clientEmail = String(json.client_email || "").trim();
  const privateKeyRaw = String(json.private_key || "");
  if (!projectId || !clientEmail || !privateKeyRaw) {
    throw new Error(
      `${label}: project_id, client_email, private_key가 모두 필요합니다.`
    );
  }
  const privateKey = parsePrivateKey(privateKeyRaw, label);
  validateEmailMatchesProject(clientEmail, projectId, label);
  return { projectId, clientEmail, privateKey, source };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

/**
 * Firebase Admin credential 로드 (우선순위):
 * 1. {PREFIX}_SERVICE_ACCOUNT_B64  — 전체 JSON Base64 (Render 권장)
 * 2. {PREFIX}_SERVICE_ACCOUNT_JSON — 전체 JSON 문자열
 * 3. {PREFIX}_PRIVATE_KEY_B64 + PROJECT_ID + CLIENT_EMAIL
 * 4. {PREFIX}_PRIVATE_KEY + PROJECT_ID + CLIENT_EMAIL
 */
export function loadCredential(prefix: string): LoadedCredential {
  const saB64 = process.env[`${prefix}_SERVICE_ACCOUNT_B64`];
  if (saB64?.trim()) {
    const json = JSON.parse(
      decodeBase64(saB64.trim(), `${prefix}_SERVICE_ACCOUNT_B64`)
    ) as Record<string, unknown>;
    return fromServiceAccountJson(json, `${prefix}_SERVICE_ACCOUNT_B64`, "service_account_b64");
  }

  const saJson = process.env[`${prefix}_SERVICE_ACCOUNT_JSON`]?.trim();
  if (saJson) {
    const json = JSON.parse(saJson) as Record<string, unknown>;
    return fromServiceAccountJson(json, `${prefix}_SERVICE_ACCOUNT_JSON`, "service_account_json");
  }

  const b64 = process.env[`${prefix}_PRIVATE_KEY_B64`];
  if (b64?.trim()) {
    const privateKey = parsePrivateKey(
      decodeBase64(b64.trim(), `${prefix}_PRIVATE_KEY_B64`),
      `${prefix}_PRIVATE_KEY_B64`
    );
    const projectId = requireEnv(`${prefix}_PROJECT_ID`);
    const clientEmail = requireEnv(`${prefix}_CLIENT_EMAIL`);
    validateEmailMatchesProject(clientEmail, projectId, prefix);
    return { projectId, clientEmail, privateKey, source: "private_key_b64" };
  }

  const pem = process.env[`${prefix}_PRIVATE_KEY`];
  if (pem?.trim()) {
    const privateKey = parsePrivateKey(pem.trim(), `${prefix}_PRIVATE_KEY`);
    const projectId = requireEnv(`${prefix}_PROJECT_ID`);
    const clientEmail = requireEnv(`${prefix}_CLIENT_EMAIL`);
    validateEmailMatchesProject(clientEmail, projectId, prefix);
    return { projectId, clientEmail, privateKey, source: "private_key" };
  }

  throw new Error(
    `Missing ${prefix} credentials. Render 권장: ${prefix}_SERVICE_ACCOUNT_B64 ` +
      `(scripts/generate-render-env.mjs 로 생성)`
  );
}

/** @deprecated loadCredential 사용 */
export function loadPrivateKey(pemVar: string, b64Var: string): string {
  const prefix = pemVar.replace(/_PRIVATE_KEY$/, "");
  return loadCredential(prefix).privateKey;
}

export function toClientErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes("DECODER routines::unsupported") ||
    message.includes("Getting metadata from plugin failed") ||
    message.includes("private key를 해석할 수 없습니다") ||
    message.includes("PEM 형식이 아닙니다")
  ) {
    return "브릿지 서버 Firebase 인증 키 형식 오류입니다. Render에서 *_SERVICE_ACCOUNT_B64 설정을 확인해 주세요.";
  }
  if (message.includes("UNAUTHENTICATED") || message.includes("invalid authentication credentials")) {
    return (
      "Firebase 인증 실패(UNAUTHENTICATED). Render 환경변수의 project_id·client_email·private_key가 " +
      "서로 다른 JSON에서 섞이지 않았는지 확인하세요. MAIN_SERVICE_ACCOUNT_B64 / BACKUP_SERVICE_ACCOUNT_B64 사용을 권장합니다."
    );
  }
  if (message.includes("project_id") && message.includes("client_email")) {
    return message;
  }
  return message;
}
