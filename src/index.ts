import "dotenv/config";
import cors from "cors";
import express, { type Request, type Response, type NextFunction } from "express";
import admin from "firebase-admin";
import type { Firestore } from "firebase-admin/firestore";

// ---------------------------------------------------------------------------
// Firestore paths (verified from majeon-wallstreet / dongsim-backup source)
// - Student balance: app/state → students[].id (number), students[].balance
// - Corp balance:    dongsim_settings/corp → accountBalance
// ---------------------------------------------------------------------------

const CORP_DOC_PATH = "dongsim_settings/corp";
const APP_STATE_PATH = "app/state";
const BRIDGE_COLLECTION = "bridge_transfers";
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

type AppState = {
  students?: Array<{
    id: number;
    name?: string;
    balance?: number;
    transactions?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
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

function parsePrivateKey(raw: string): string {
  return raw.replace(/\\n/g, "\n");
}

function initFirebaseApps() {
  if (admin.apps.length === 0) {
    admin.initializeApp(
      {
        credential: admin.credential.cert({
          projectId: requireEnv("MAIN_PROJECT_ID"),
          clientEmail: requireEnv("MAIN_CLIENT_EMAIL"),
          privateKey: parsePrivateKey(requireEnv("MAIN_PRIVATE_KEY")),
        }),
      },
      "main"
    );
    admin.initializeApp(
      {
        credential: admin.credential.cert({
          projectId: requireEnv("BACKUP_PROJECT_ID"),
          clientEmail: requireEnv("BACKUP_CLIENT_EMAIL"),
          privateKey: parsePrivateKey(requireEnv("BACKUP_PRIVATE_KEY")),
        }),
      },
      "backup"
    );
  }
  return {
    mainDb: admin.app("main").firestore(),
    backupDb: admin.app("backup").firestore(),
  };
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

async function getCompletedTransfer(
  db: Firestore,
  idempotencyKey: string
): Promise<BridgeTransferRecord | null> {
  const snap = await db.collection(BRIDGE_COLLECTION).doc(idempotencyKey).get();
  if (!snap.exists) return null;
  const data = snap.data() as BridgeTransferRecord;
  return data.status === "completed" ? data : null;
}

async function writeTransferRecord(db: Firestore, record: BridgeTransferRecord) {
  await db.collection(BRIDGE_COLLECTION).doc(record.idempotencyKey).set(record, { merge: true });
}

async function claimIdempotency(
  mainDb: Firestore,
  backupDb: Firestore,
  record: BridgeTransferRecord
): Promise<"new" | "completed"> {
  const existingMain = await mainDb.collection(BRIDGE_COLLECTION).doc(record.idempotencyKey).get();
  if (existingMain.exists) {
    const data = existingMain.data() as BridgeTransferRecord;
    if (data.status === "completed") return "completed";
    if (data.status === "pending") {
      throw new Error("동일 idempotencyKey 요청이 처리 중입니다. 잠시 후 다시 시도하세요.");
    }
  }

  await writeTransferRecord(mainDb, record);
  await writeTransferRecord(backupDb, record);
  return "new";
}

async function adjustStudentBalance(
  db: Firestore,
  studentId: number,
  delta: number,
  meta: { type: "income" | "expense"; category: string; description: string }
): Promise<number> {
  const stateRef = db.doc(APP_STATE_PATH);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef);
    if (!snap.exists) throw new Error("app/state 문서가 없습니다.");
    const data = snap.data() as AppState;
    const students = [...(data.students ?? [])];
    const idx = students.findIndex((s) => Number(s.id) === studentId);
    if (idx < 0) throw new Error(`학번 ${studentId} 학생을 찾을 수 없습니다.`);

    const student = { ...students[idx] };
    const current = Number(student.balance) || 0;
    const next = current + delta;
    if (next < 0) throw new Error("잔액이 부족합니다.");

    student.balance = next;
    const txs = Array.isArray(student.transactions) ? [...student.transactions] : [];
    txs.unshift({
      id: randomId(),
      date: new Date().toISOString(),
      type: meta.type,
      category: meta.category,
      amount: Math.abs(delta),
      balance: next,
      description: meta.description,
    });
    student.transactions = txs;
    students[idx] = student;
    tx.update(stateRef, { students });
    return next;
  });
}

async function adjustCorpBalance(
  db: Firestore,
  delta: number,
  description: string,
  studentId?: number
): Promise<number> {
  const corpRef = db.doc(CORP_DOC_PATH);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(corpRef);
    const prev = (snap.exists ? snap.data() : {}) as CorpDoc;
    const current = Number(prev.accountBalance) || 0;
    const next = current + delta;
    if (next < 0) throw new Error("법인 계좌 잔액이 부족합니다.");

    tx.set(
      corpRef,
      {
        accountBalance: next,
        companyId: CORP_COMPANY_ID,
        updatedAt: new Date().toISOString(),
        lastDescription: description,
        lastStudentId: studentId ?? null,
      } satisfies CorpDoc,
      { merge: true }
    );
    return next;
  });
}

async function markTransferCompleted(
  mainDb: Firestore,
  backupDb: Firestore,
  idempotencyKey: string,
  extra: Pick<BridgeTransferRecord, "sourceBalanceAfter" | "destinationBalanceAfter">
) {
  const patch = {
    status: "completed" as const,
    completedAt: new Date().toISOString(),
    ...extra,
  };
  await mainDb.collection(BRIDGE_COLLECTION).doc(idempotencyKey).set(patch, { merge: true });
  await backupDb.collection(BRIDGE_COLLECTION).doc(idempotencyKey).set(patch, { merge: true });
}

async function markTransferFailed(
  mainDb: Firestore,
  backupDb: Firestore,
  idempotencyKey: string,
  error: string
) {
  const patch = {
    status: "failed" as const,
    failedAt: new Date().toISOString(),
    error,
  };
  await mainDb.collection(BRIDGE_COLLECTION).doc(idempotencyKey).set(patch, { merge: true });
  await backupDb.collection(BRIDGE_COLLECTION).doc(idempotencyKey).set(patch, { merge: true });
}

async function transferMainToBackup(
  mainDb: Firestore,
  backupDb: Firestore,
  studentId: number,
  amount: number,
  idempotencyKey: string
) {
  const completed = await getCompletedTransfer(mainDb, idempotencyKey);
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
  await claimIdempotency(mainDb, backupDb, pending);

  const descOut = `[동심 팩토리 백업 이체] ₩${amount.toLocaleString()} 출금`;
  const descIn = `[마전 월스트리트 입금] ₩${amount.toLocaleString()}`;

  let mainBalanceAfter: number;
  try {
    mainBalanceAfter = await adjustStudentBalance(mainDb, studentId, -amount, {
      type: "expense",
      category: "동심 팩토리",
      description: descOut,
    });
  } catch (err) {
    await markTransferFailed(mainDb, backupDb, idempotencyKey, String(err));
    throw err;
  }

  try {
    const backupBalanceAfter = await adjustStudentBalance(backupDb, studentId, amount, {
      type: "income",
      category: "동심 팩토리",
      description: descIn,
    });
    await markTransferCompleted(mainDb, backupDb, idempotencyKey, {
      sourceBalanceAfter: mainBalanceAfter,
      destinationBalanceAfter: backupBalanceAfter,
    });
    return { duplicated: false, studentId, amount, mainBalanceAfter, backupBalanceAfter };
  } catch (err) {
    try {
      await adjustStudentBalance(mainDb, studentId, amount, {
        type: "income",
        category: "동심 팩토리",
        description: `[브릿지 롤백] ${descOut}`,
      });
    } catch (rollbackErr) {
      console.error("[rollback failed main-to-backup]", rollbackErr);
    }
    await markTransferFailed(mainDb, backupDb, idempotencyKey, String(err));
    throw err;
  }
}

async function transferBackupToMain(
  mainDb: Firestore,
  backupDb: Firestore,
  studentId: number,
  amount: number,
  idempotencyKey: string
) {
  const completed = await getCompletedTransfer(mainDb, idempotencyKey);
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
  await claimIdempotency(mainDb, backupDb, pending);

  const descOut = `[마전 월스트리트 회수] ₩${amount.toLocaleString()} 출금`;
  const descIn = `[동심 팩토리 백업 회수] ₩${amount.toLocaleString()} 입금`;

  let backupBalanceAfter: number;
  try {
    backupBalanceAfter = await adjustStudentBalance(backupDb, studentId, -amount, {
      type: "expense",
      category: "동심 팩토리",
      description: descOut,
    });
  } catch (err) {
    await markTransferFailed(mainDb, backupDb, idempotencyKey, String(err));
    throw err;
  }

  try {
    const mainBalanceAfter = await adjustStudentBalance(mainDb, studentId, amount, {
      type: "income",
      category: "동심 팩토리",
      description: descIn,
    });
    await markTransferCompleted(mainDb, backupDb, idempotencyKey, {
      sourceBalanceAfter: backupBalanceAfter,
      destinationBalanceAfter: mainBalanceAfter,
    });
    return { duplicated: false, studentId, amount, backupBalanceAfter, mainBalanceAfter };
  } catch (err) {
    try {
      await adjustStudentBalance(backupDb, studentId, amount, {
        type: "income",
        category: "동심 팩토리",
        description: `[브릿지 롤백] ${descOut}`,
      });
    } catch (rollbackErr) {
      console.error("[rollback failed backup-to-main]", rollbackErr);
    }
    await markTransferFailed(mainDb, backupDb, idempotencyKey, String(err));
    throw err;
  }
}

async function transferCorpToMain(
  mainDb: Firestore,
  backupDb: Firestore,
  studentId: number,
  amount: number,
  idempotencyKey: string
) {
  if (!MANAGER_IDS.has(studentId)) {
    throw new Error("법인 출금은 조한결(9번) 또는 노건호(5번)만 가능합니다.");
  }

  const completed = await getCompletedTransfer(mainDb, idempotencyKey);
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
  await claimIdempotency(mainDb, backupDb, pending);

  const desc = `[법인→마전 월스트리트] ₩${amount.toLocaleString()} (신청: ${studentId}번)`;

  let backupCorpAfter: number;
  try {
    backupCorpAfter = await adjustCorpBalance(backupDb, -amount, desc, studentId);
  } catch (err) {
    await markTransferFailed(mainDb, backupDb, idempotencyKey, String(err));
    throw err;
  }

  try {
    const mainCorpAfter = await adjustCorpBalance(mainDb, amount, desc, studentId);
    await markTransferCompleted(mainDb, backupDb, idempotencyKey, {
      sourceBalanceAfter: backupCorpAfter,
      destinationBalanceAfter: mainCorpAfter,
    });
    return { duplicated: false, studentId, amount, backupCorpAfter, mainCorpAfter };
  } catch (err) {
    try {
      await adjustCorpBalance(backupDb, amount, `[브릿지 롤백] ${desc}`, studentId);
    } catch (rollbackErr) {
      console.error("[rollback failed corp-to-main]", rollbackErr);
    }
    await markTransferFailed(mainDb, backupDb, idempotencyKey, String(err));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const { mainDb, backupDb } = initFirebaseApps();
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/transfer/main-to-backup", async (req, res) => {
  try {
    const studentId = parseStudentId(req.body?.studentId);
    const amount = parseAmount(req.body?.amount);
    const idempotencyKey = parseIdempotencyKey(req.body?.idempotencyKey);
    const result = await transferMainToBackup(mainDb, backupDb, studentId, amount, idempotencyKey);
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("부족") ? 400 : message.includes("Unauthorized") ? 401 : 500;
    res.status(status).json({ success: false, message });
  }
});

app.post("/transfer/backup-to-main", async (req, res) => {
  try {
    const studentId = parseStudentId(req.body?.studentId);
    const amount = parseAmount(req.body?.amount);
    const idempotencyKey = parseIdempotencyKey(req.body?.idempotencyKey);
    const result = await transferBackupToMain(mainDb, backupDb, studentId, amount, idempotencyKey);
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("부족") ? 400 : 500;
    res.status(status).json({ success: false, message });
  }
});

app.post("/transfer/corp-to-main", async (req, res) => {
  try {
    const studentId = parseStudentId(req.body?.studentId);
    const amount = parseAmount(req.body?.amount);
    const idempotencyKey = parseIdempotencyKey(req.body?.idempotencyKey);
    const result = await transferCorpToMain(mainDb, backupDb, studentId, amount, idempotencyKey);
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      message.includes("부족") || message.includes("만 가능") ? 400 : 500;
    res.status(status).json({ success: false, message });
  }
});

app.listen(PORT, () => {
  console.log(`dongsim-bridge listening on port ${PORT}`);
});
