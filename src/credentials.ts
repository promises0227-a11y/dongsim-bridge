import { createPrivateKey } from "node:crypto";

/**
 * Render 등 PaaS 환경변수에서 흔한 PEM 포맷 문제를 정규화합니다.
 * - 따옴표로 감싼 값 ("-----BEGIN...")
 * - 리터럴 \\n / \n
 * - CRLF
 * - 한 줄로 붙은 PEM
 */
export function parsePrivateKey(raw: string, label: string): string {
  let key = raw.trim();

  if (key.startsWith("{") && key.includes("private_key")) {
    throw new Error(
      `${label}: 서비스 계정 JSON 전체가 아니라 private_key 문자열만 환경변수에 넣어주세요.`
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
      `${label}: PEM 형식이 아닙니다. Firebase 서비스 계정 JSON의 private_key 값을 확인하세요.`
    );
  }

  try {
    createPrivateKey({ key, format: "pem", type: "pkcs8" });
  } catch {
    try {
      createPrivateKey({ key, format: "pem", type: "pkcs1" });
    } catch {
      throw new Error(
        `${label}: private key를 해석할 수 없습니다. Render 환경변수에서 앞뒤 따옴표를 제거하거나 ${label}_B64(Base64)를 사용하세요.`
      );
    }
  }

  return key;
}

export function loadPrivateKey(pemVar: string, b64Var: string): string {
  const b64 = process.env[b64Var]?.trim();
  if (b64) {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    return parsePrivateKey(decoded, b64Var);
  }
  const pem = process.env[pemVar]?.trim();
  if (!pem) {
    throw new Error(`Missing environment variable: ${pemVar} (or ${b64Var})`);
  }
  return parsePrivateKey(pem, pemVar);
}

export function toClientErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes("DECODER routines::unsupported") ||
    message.includes("Getting metadata from plugin failed") ||
    message.includes("private key를 해석할 수 없습니다") ||
    message.includes("PEM 형식이 아닙니다")
  ) {
    return "브릿지 서버 Firebase 인증 키 형식 오류입니다. Render의 MAIN_PRIVATE_KEY / BACKUP_PRIVATE_KEY 설정을 확인해 주세요.";
  }
  return message;
}
