import Database from "better-sqlite3";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  reason?: "per-ip" | "global-cap";
}

export interface Clock { now(): number; }

interface RateLimiterOpts {
  sqlitePath: string;
  cooldownSeconds: number;
  dailyCap: number;
}

/**
 * SQLite-backed per-IP cooldown + global daily cap.
 * Schema bootstrap uses prepare().run() per statement (safer than multi-statement
 * helpers; same end state).
 */
export class RateLimiter {
  private readonly db: Database.Database;
  private readonly cooldown: number;
  private readonly cap: number;

  constructor(opts: RateLimiterOpts) {
    this.db = new Database(opts.sqlitePath);
    this.db.pragma("journal_mode = WAL");
    this.db.prepare(
      `CREATE TABLE IF NOT EXISTS hits (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ip TEXT NOT NULL,
         ts INTEGER NOT NULL,
         allowed INTEGER NOT NULL
       )`
    ).run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_hits_ts ON hits(ts)").run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_hits_ip_ts ON hits(ip, ts)").run();
    this.cooldown = opts.cooldownSeconds;
    this.cap = opts.dailyCap;
  }

  checkAndRecord(ip: string, clock: Clock): RateLimitResult {
    const now = clock.now();
    const since = now - 86_400;
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM hits WHERE ts >= ? AND allowed = 1")
      .get(since) as { n: number };
    if (countRow.n >= this.cap) {
      this.recordHit(ip, now, false);
      return { allowed: false, reason: "global-cap" };
    }
    const lastRow = this.db
      .prepare("SELECT ts FROM hits WHERE ip = ? AND allowed = 1 ORDER BY ts DESC LIMIT 1")
      .get(ip) as { ts: number } | undefined;
    if (lastRow && now - lastRow.ts < this.cooldown) {
      this.recordHit(ip, now, false);
      return {
        allowed: false,
        reason: "per-ip",
        retryAfterSeconds: this.cooldown - (now - lastRow.ts),
      };
    }
    this.recordHit(ip, now, true);
    return { allowed: true };
  }

  stats(clock: Clock): { totalRequests24h: number; throttled24h: number } {
    const since = clock.now() - 86_400;
    const total = this.db
      .prepare("SELECT COUNT(*) AS n FROM hits WHERE ts >= ?")
      .get(since) as { n: number };
    const throttled = this.db
      .prepare("SELECT COUNT(*) AS n FROM hits WHERE ts >= ? AND allowed = 0")
      .get(since) as { n: number };
    return { totalRequests24h: total.n, throttled24h: throttled.n };
  }

  evictStale(clock: Clock): void {
    this.db.prepare("DELETE FROM hits WHERE ts < ?").run(clock.now() - 86_400);
  }

  close(): void { this.db.close(); }

  private recordHit(ip: string, ts: number, allowed: boolean): void {
    this.db
      .prepare("INSERT INTO hits (ip, ts, allowed) VALUES (?, ?, ?)")
      .run(ip, ts, allowed ? 1 : 0);
  }
}
