/**
 * Local dev database — embedded Postgres（生產機無 docker dev stack 嘅替代方案）。
 *
 * 用法：
 *   pnpm dev:db             # 起 Postgres 並長駐（background 行）
 *   pnpm dev:db:stop        # 停
 *
 * - 首次：initialize（initdb）→ start → 確保 clinic_workforce DB 存在
 * - 再起：port 已 ready → 直接 skip（冪等）
 * - 長駐原因：embedded-postgres 嘅 start() 明確「node script 退出時會 shutdown
 *   postgres」，所以 dev:db 必須保持 process 存活。
 *
 * ★ 端口鐵律：15532 專屬 clinic-workforce dev DB。
 *   15432 = wa-inbox 驗證專用，任何情況下唔好動。
 *
 * 模式參考：wa-clinic-inbox/scripts/dev-db.ts
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const ROOT = path.join(import.meta.dirname, "..");
const DATABASE_DIR = path.join(ROOT, ".dev", "pgdata");
const PORT = 15532;
const USER = "cw_dev";
const PASSWORD = "cw_dev_pw_2026"; // ★ dev-only，非機密（.gitignore 唔收呢個 script 以外嘅 env）
const DB = "clinic_workforce";

function pgIsReady(): boolean {
  const r = spawnSync("pg_isready", ["-h", "127.0.0.1", "-p", String(PORT), "-q"], {
    timeout: 3000,
  });
  return r.status === 0;
}

async function main(): Promise<void> {
  if (pgIsReady()) {
    console.log(`[dev-db] postgres already ready on 127.0.0.1:${PORT} — skip start`);
  } else {
    const postgres = new EmbeddedPostgres({
      databaseDir: DATABASE_DIR,
      port: PORT,
      user: USER,
      password: PASSWORD,
      persistent: true,
      authMethod: "scram-sha-256",
      onLog: (m) => console.log(`[dev-db:pg] ${m}`),
      onError: (m) => console.error(`[dev-db:pg:err] ${m}`),
    });
    // 已初始化過嘅 data dir（PG_VERSION 存在）→ 只 start，唔好再 initdb
    const alreadyInit = existsSync(path.join(DATABASE_DIR, "PG_VERSION"));
    if (alreadyInit) {
      console.log("[dev-db] existing data dir — start only (no initdb)");
    } else {
      await postgres.initialise();
    }
    await postgres.start();
    console.log(`[dev-db] postgres started on 127.0.0.1:${PORT}`);
  }

  // 確保 DB 存在（首次 initdb 只會建有 user 同名嘅 default DB）
  const client = new pg.Client({
    host: "127.0.0.1",
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: "postgres",
  });
  await client.connect();
  const { rows } = await client.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname = $1",
    [DB]
  );
  if (rows.length === 0) {
    await client.query(`CREATE DATABASE "${DB}" OWNER "${USER}"`);
    console.log(`[dev-db] created database ${DB}`);
  }

  // ★ 本机 prisma engine 嘅 SCRAM 握手失敗（P1000，2026-08-20 實測：node-pg OK / prisma fail，
  //   md5 都得）—— 127.0.0.1 dev 連線改 trust（localhost-only，冇對外暴露）。冪等。
  const hbaPath = path.join(DATABASE_DIR, "pg_hba.conf");
  const hba = readFileSync(hbaPath, "utf8");
  const hbaNorm = hba.replace(/^(host\s+all\s+all\s+127\.0\.0\.1\/32\s+)\S+/m, "$1trust");
  if (hbaNorm !== hba) {
    writeFileSync(hbaPath, hbaNorm);
    await client.query("SELECT pg_reload_conf()");
    console.log("[dev-db] pg_hba: 127.0.0.1/32 -> trust (prisma SCRAM workaround), reloaded");
  }
  await client.end();
  console.log(`[dev-db] ready — DATABASE_URL=postgresql://${USER}:***@127.0.0.1:${PORT}/${DB}`);
}

// 長駐：embedded-postgres 需要 parent process 存活（佢用 exit hook 管理 postgres 子 process）。
main()
  .then(() => {
    console.log("[dev-db] staying alive (postgres will stop when this process exits)");
    setInterval(() => undefined, 1 << 30);
  })
  .catch((err) => {
    console.error("[dev-db] failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
