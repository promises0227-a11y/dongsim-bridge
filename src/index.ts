import "dotenv/config";
import cors from "cors";
import express, { type Request, type Response, type NextFunction } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Supabase paths (verified from supabase/schema.sql + client services)
// - Student majeon balance: students.balance
// - Student dongsim bridged wallet: students.support_fund.bridgeBalance (jsonb)
// - Corp balance: dongsim_settings doc_id=corp → data.accountBalance
// - Majeon teen corp mirror: teen_companies id=dongsim-factory-corp → account_balance
// - Transfer log: bridge_transfers
// ---------------------------------------------------------------------------

const CORP_DOC_ID = "corp";
const CORP_COMPANY_ID = "dongsim-factory-corp";
const MANAGER_IDS = new Set([5, 9]);

type TransferType = "main-to-backup" | "backup-to-main" | "corp-to-main";
type TransferStatus = "pending" | "completed" | "failed";

type BridgeTransferRecord = {
  idempotencyKey: string;
  type: TransferType;
  studentId: number;
  amount: number;
  status: TransferStatus;
  createdAt: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
  sourceBalanceAfter?: number;
  destinationBalanceAfter?: number;
};

type SupportFundJson = {
  balance?: number;
  usableIn?: string[];
  bridgeBalance?: number;
};

type CorpDoc = {
  accountBalance?: number;
  companyId?: string;
  updatedAt?: string;
  lastDescription?: string;
  lastStudentId?: number | null;
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function toClientErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function randomId() {
  return Math.random().toString(36).slice(2, 11);
}

function parseStudentId(raw: unknown): number {
  const id = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
  if (!Number.isInteger(id) || id < 1 || id > 99) {
    throw new Error("studentId는 유효한 학번(정수)이어야 합니다.");
  }
  return id;
}

function parseAmount(raw: unknown): number {
  const amount = Math.floor(Number(raw));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("amount는 1 이상의 정수여야 합니다.");
  }
  return amount;
}

function parseIdempotencyKey(raw: unknown): string {
  const key = String(raw ?? "").trim();
  if (!key || key.length > 128) {
    throw new Error("idempotencyKey가 필요합니다.");
  }
  return key;
}

function getBridgeBalance(supportFund: SupportFundJson | null | undefined): number {
  return Number(supportFund?.bridgeBalance) || 0;
}

function withBridgeBalance(
  supportFund: SupportFundJson | null | undefined,
  bridgeBalance: number
): SupportFundJson {
  const base = supportFund && typeof supportFund === "object" ? { ...supportFund } : {};
  return { ...base, bridgeBalance: Math.max(0, bridgeBalance) };
}

function createSupabase(): SupabaseClient {
  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const supabase = createSupabase();

async function getCompletedTransfer(idempotencyKey: string): Promise<BridgeTransferRecord | null> {
  const { data, error } = await supabase
    .from("bridge_transfers")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.status !== "completed") return null;
  return {
    idempotencyKey,
    type: data.type as TransferType,
    studentId: Number(data.student_id),
    amount: Number(data.amount),
    status: "completed",
    createdAt: String(data.created_at),
    completedAt: data.completed_at ? String(data.completed_at) : undefined,
    sourceBalanceAfter:
      data.source_balance_after != null ? Number(data.source_balance_after) : undefined,
    destinationBalanceAfter:
      data.destination_balance_after != null ? Number(data.destination_balance_after) : undefined,
  };
}

async function writeTransferRecord(record: BridgeTransferRecord) {
  const { error } = await supabase.from("bridge_transfers").upsert(
    {
      id: record.idempotencyKey,
      idempotency_key: record.idempotencyKey,
      student_id: record.studentId,
      type: record.type,
      amount: record.amount,
      status: record.status,
      created_at: record.createdAt,
      completed_at: record.completedAt ?? null,
      failed_at: record.failedAt ?? null,
      error_message: record.error ?? null,
      source_balance_after: record.sourceBalanceAfter ?? null,
      destination_balance_after: record.destinationBalanceAfter ?? null,
      data: record,
    },
    { onConflict: "id" }
  );
  if (error) throw error;
}

async function claimIdempotency(record: BridgeTransferRecord): Promise<"new" | "completed"> {
  const existing = await getCompletedTransfer(record.idempotencyKey);
  if (existing) return "completed";

  const { data, error } = await supabase
    .from("bridge_transfers")
    .select("status")
    .eq("idempotency_key", record.idempotencyKey)
    .maybeSingle();
  if (error) throw error;
  if (data?.status === "pending") {
    throw new Error("동일 idempotencyKey 요청이 처리 중입니다. 잠시 후 다시 시도하세요.");
  }

  await writeTransferRecord(record);
  return "new";
}

async function fetchStudentRow(studentId: number) {
  const { data, error } = await supabase
    .from("students")
    .select("id, balance, support_fund")
    .eq("id", studentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`학번 ${studentId} 학생을 찾을 수 없습니다.`);
  return {
    id: Number(data.id),
    balance: Number(data.balance) || 0,
    supportFund: (data.support_fund as SupportFundJson | null) ?? null,
  };
}

async function insertStudentTransaction(
  studentId: number,
  meta: { type: "income" | "expense"; category: string; description: string; amount: number; balance: number }
) {
  const { error } = await supabase.from("student_transactions").insert({
    id: randomId(),
    student_id: studentId,
    date: new Date().toISOString(),
    type: meta.type,
    category: meta.category,
    amount: meta.amount,
    balance: meta.balance,
    description: meta.description,
  });
  if (error) throw error;
}

async function updateStudentWallets(
  studentId: number,
  balance: number,
  supportFund: SupportFundJson | null
) {
  const { error } = await supabase
    .from("students")
    .update({
      balance,
      support_fund: supportFund,
      updated_at: new Date().toISOString(),
    })
    .eq("id", studentId);
  if (error) throw error;
}

async function markTransferCompleted(
  idempotencyKey: string,
  extra: Pick<BridgeTransferRecord, "sourceBalanceAfter" | "destinationBalanceAfter">
) {
  const patch = {
    status: "completed" as const,
    completed_at: new Date().toISOString(),
    source_balance_after: extra.sourceBalanceAfter ?? null,
    destination_balance_after: extra.destinationBalanceAfter ?? null,
  };
  const { error } = await supabase
    .from("bridge_transfers")
    .update(patch)
    .eq("idempotency_key", idempotencyKey);
  if (error) throw error;
}

async function markTransferFailed(idempotencyKey: string, errorMessage: string) {
  const { error } = await supabase
    .from("bridge_transfers")
    .update({
      status: "failed",
      failed_at: new Date().toISOString(),
      error_message: errorMessage,
    })
    .eq("idempotency_key", idempotencyKey);
  if (error) throw error;
}

async function fetchCorpDoc(): Promise<CorpDoc> {
  const { data, error } = await supabase
    .from("dongsim_settings")
    .select("data")
    .eq("doc_id", CORP_DOC_ID)
    .maybeSingle();
  if (error) throw error;
  const prev = (data?.data as CorpDoc | null) ?? {};
  return {
    accountBalance: Number(prev.accountBalance) || 0,
    companyId: prev.companyId || CORP_COMPANY_ID,
    updatedAt: prev.updatedAt,
    lastDescription: prev.lastDescription,
    lastStudentId: prev.lastStudentId ?? null,
  };
}

async function saveCorpDoc(doc: CorpDoc) {
  const { error } = await supabase.from("dongsim_settings").upsert({
    doc_id: CORP_DOC_ID,
    data: doc,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function adjustCorpBalance(
  delta: number,
  description: string,
  studentId?: number
): Promise<number> {
  const prev = await fetchCorpDoc();
  const current = Number(prev.accountBalance) || 0;
  const next = current + delta;
  if (next < 0) throw new Error("법인 계좌 잔액이 부족합니다.");

  const doc: CorpDoc = {
    accountBalance: next,
    companyId: CORP_COMPANY_ID,
    updatedAt: new Date().toISOString(),
    lastDescription: description,
    lastStudentId: studentId ?? null,
  };
  await saveCorpDoc(doc);
  return next;
}

async function adjustTeenCorpBalance(delta: number): Promise<number> {
  const { data, error } = await supabase
    .from("teen_companies")
    .select("account_balance")
    .eq("id", CORP_COMPANY_ID)
    .maybeSingle();
  if (error) throw error;

  const current = Number(data?.account_balance) || 0;
  const next = current + delta;
  if (next < 0) throw new Error("마전 법인 계좌 잔액이 부족합니다.");

  const { error: upsertError } = await supabase.from("teen_companies").upsert({
    id: CORP_COMPANY_ID,
    owner_id: 9,
    name: "동심 팩토리",
    account_balance: next,
    created_at: data ? undefined : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (upsertError) throw upsertError;
  return next;
}

async function transferMainToBackup(studentId: number, amount: number, idempotencyKey: string) {
  const completed = await getCompletedTransfer(idempotencyKey);
  if (completed) {
    return {
      duplicated: true,
      studentId,
      amount,
      mainBalanceAfter: completed.sourceBalanceAfter,
      backupBalanceAfter: completed.destinationBalanceAfter,
    };
  }

  const pending: BridgeTransferRecord = {
    idempotencyKey,
    type: "main-to-backup",
    studentId,
    amount,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  await claimIdempotency(pending);

  const descOut = `[동심 팩토리 백업 이체] ₩${amount.toLocaleString()} 출금`;
  const descIn = `[마전 월스트리트 입금] ₩${amount.toLocaleString()}`;

  const student = await fetchStudentRow(studentId);
  if (student.balance < amount) {
    await markTransferFailed(idempotencyKey, "잔액이 부족합니다.");
    throw new Error("잔액이 부족합니다.");
  }

  const mainBalanceAfter = student.balance - amount;
  const backupBalanceAfter = getBridgeBalance(student.supportFund) + amount;
  const nextSupportFund = withBridgeBalance(student.supportFund, backupBalanceAfter);

  try {
    await updateStudentWallets(studentId, mainBalanceAfter, nextSupportFund);
    await insertStudentTransaction(studentId, {
      type: "expense",
      category: "동심 팩토리",
      description: descOut,
      amount,
      balance: mainBalanceAfter,
    });
    await insertStudentTransaction(studentId, {
      type: "income",
      category: "동심 팩토리",
      description: descIn,
      amount,
      balance: mainBalanceAfter,
    });
    await markTransferCompleted(idempotencyKey, {
      sourceBalanceAfter: mainBalanceAfter,
      destinationBalanceAfter: backupBalanceAfter,
    });
    return { duplicated: false, studentId, amount, mainBalanceAfter, backupBalanceAfter };
  } catch (err) {
    await markTransferFailed(idempotencyKey, toClientErrorMessage(err));
    throw err;
  }
}

async function transferBackupToMain(studentId: number, amount: number, idempotencyKey: string) {
  const completed = await getCompletedTransfer(idempotencyKey);
  if (completed) {
    return {
      duplicated: true,
      studentId,
      amount,
      backupBalanceAfter: completed.sourceBalanceAfter,
      mainBalanceAfter: completed.destinationBalanceAfter,
    };
  }

  const pending: BridgeTransferRecord = {
    idempotencyKey,
    type: "backup-to-main",
    studentId,
    amount,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  await claimIdempotency(pending);

  const descOut = `[마전 월스트리트 회수] ₩${amount.toLocaleString()} 출금`;
  const descIn = `[동심 팩토리 백업 회수] ₩${amount.toLocaleString()} 입금`;

  const student = await fetchStudentRow(studentId);
  const currentBridge = getBridgeBalance(student.supportFund);
  if (currentBridge < amount) {
    await markTransferFailed(idempotencyKey, "잔액이 부족합니다.");
    throw new Error("잔액이 부족합니다.");
  }

  const backupBalanceAfter = currentBridge - amount;
  const mainBalanceAfter = student.balance + amount;
  const nextSupportFund = withBridgeBalance(student.supportFund, backupBalanceAfter);

  try {
    await updateStudentWallets(studentId, mainBalanceAfter, nextSupportFund);
    await insertStudentTransaction(studentId, {
      type: "expense",
      category: "동심 팩토리",
      description: descOut,
      amount,
      balance: mainBalanceAfter,
    });
    await insertStudentTransaction(studentId, {
      type: "income",
      category: "동심 팩토리",
      description: descIn,
      amount,
      balance: mainBalanceAfter,
    });
    await markTransferCompleted(idempotencyKey, {
      sourceBalanceAfter: backupBalanceAfter,
      destinationBalanceAfter: mainBalanceAfter,
    });
    return { duplicated: false, studentId, amount, backupBalanceAfter, mainBalanceAfter };
  } catch (err) {
    await markTransferFailed(idempotencyKey, toClientErrorMessage(err));
    throw err;
  }
}

async function transferCorpToMain(studentId: number, amount: number, idempotencyKey: string) {
  if (!MANAGER_IDS.has(studentId)) {
    throw new Error("법인 출금은 조한결(9번) 또는 노건호(5번)만 가능합니다.");
  }

  const completed = await getCompletedTransfer(idempotencyKey);
  if (completed) {
    return {
      duplicated: true,
      studentId,
      amount,
      backupCorpAfter: completed.sourceBalanceAfter,
      mainCorpAfter: completed.destinationBalanceAfter,
    };
  }

  const pending: BridgeTransferRecord = {
    idempotencyKey,
    type: "corp-to-main",
    studentId,
    amount,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  await claimIdempotency(pending);

  const desc = `[법인→마전 월스트리트] ₩${amount.toLocaleString()} (신청: ${studentId}번)`;

  let backupCorpAfter: number;
  try {
    backupCorpAfter = await adjustCorpBalance(-amount, desc, studentId);
  } catch (err) {
    await markTransferFailed(idempotencyKey, toClientErrorMessage(err));
    throw err;
  }

  try {
    const mainCorpAfter = await adjustTeenCorpBalance(amount);
    await markTransferCompleted(idempotencyKey, {
      sourceBalanceAfter: backupCorpAfter,
      destinationBalanceAfter: mainCorpAfter,
    });
    return { duplicated: false, studentId, amount, backupCorpAfter, mainCorpAfter };
  } catch (err) {
    try {
      await adjustCorpBalance(amount, `[브릿지 롤백] ${desc}`, studentId);
    } catch (rollbackErr) {
      console.error("[rollback failed corp-to-main]", rollbackErr);
    }
    await markTransferFailed(idempotencyKey, toClientErrorMessage(err));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const BRIDGE_SECRET = requireEnv("BRIDGE_SECRET");

app.use(cors());
app.use(express.json());

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/health") return next();
  const secret = req.header("x-bridge-secret");
  if (secret !== BRIDGE_SECRET) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }
  next();
}

app.use(authMiddleware);

app.get("/health", async (_req, res) => {
  const timestamp = new Date().toISOString();
  const { error } = await supabase.from("students").select("id").limit(1);
  const connected = !error;
  res.status(connected ? 200 : 503).json({
    status: connected ? "ok" : "error",
    database: connected ? "connected" : "disconnected",
    type: "supabase",
    message: error ? toClientErrorMessage(error) : undefined,
    timestamp,
  });
});

app.post("/transfer/main-to-backup", async (req, res) => {
  try {
    const studentId = parseStudentId(req.body?.studentId);
    const amount = parseAmount(req.body?.amount);
    const idempotencyKey = parseIdempotencyKey(req.body?.idempotencyKey);
    const result = await transferMainToBackup(studentId, amount, idempotencyKey);
    res.json({ success: true, ...result });
  } catch (err) {
    const message = toClientErrorMessage(err);
    const status = message.includes("부족") ? 400 : message.includes("Unauthorized") ? 401 : 500;
    res.status(status).json({ success: false, message });
  }
});

app.post("/transfer/backup-to-main", async (req, res) => {
  try {
    const studentId = parseStudentId(req.body?.studentId);
    const amount = parseAmount(req.body?.amount);
    const idempotencyKey = parseIdempotencyKey(req.body?.idempotencyKey);
    const result = await transferBackupToMain(studentId, amount, idempotencyKey);
    res.json({ success: true, ...result });
  } catch (err) {
    const message = toClientErrorMessage(err);
    const status = message.includes("부족") ? 400 : 500;
    res.status(status).json({ success: false, message });
  }
});

app.post("/transfer/corp-to-main", async (req, res) => {
  try {
    const studentId = parseStudentId(req.body?.studentId);
    const amount = parseAmount(req.body?.amount);
    const idempotencyKey = parseIdempotencyKey(req.body?.idempotencyKey);
    const result = await transferCorpToMain(studentId, amount, idempotencyKey);
    res.json({ success: true, ...result });
  } catch (err) {
    const message = toClientErrorMessage(err);
    const status = message.includes("부족") || message.includes("만 가능") ? 400 : 500;
    res.status(status).json({ success: false, message });
  }
});

app.listen(PORT, () => {
  console.log(`dongsim-bridge (supabase) listening on port ${PORT}`);
});
