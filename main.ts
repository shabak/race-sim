import express from 'express';
import { Pool, Client } from 'pg';
import mysql from 'mysql2/promise';

// ── Switch the source manually: uncomment the line you need ───────
const DSN = 'postgres://shabak@localhost:5432/race_sim';
// const DSN = 'mysql://root@localhost:3306/race_sim';
// ──────────────────────────────────────────────────────────────────

export const pool = new Pool({ connectionString: DSN, max: Number(process.env.POOL_MAX ?? 20) });
const PORT = Number(process.env.PORT ?? 3000);
const RACE_DELAY_MS = Number(process.env.RACE_DELAY_MS ?? 0);
const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? 100000);

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export type Result = { ok: boolean; retries?: number; error?: string };

// ════════════════════════════════════════════════════════════════
//  Семь способов перевести `amount` со счёта `from` на счёт `to`.
//  Все, кроме naive, держат инвариант sum(balance) = const.
// ════════════════════════════════════════════════════════════════

// 1. Наивный — read-modify-write в коде. Теряет деньги под конкуренцией.
export async function naive(from: number, to: number, amount: number): Promise<Result> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const r1 = await client.query<{ balance: string }>('SELECT balance FROM accounts WHERE id = $1', [from]);
        const fb = BigInt(r1.rows[0].balance);
        if (fb < BigInt(amount)) { await client.query('ROLLBACK'); return { ok: false, error: 'insufficient' }; }
        if (RACE_DELAY_MS > 0) await sleep(RACE_DELAY_MS);
        await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [String(fb - BigInt(amount)), from]);
        const r2 = await client.query<{ balance: string }>('SELECT balance FROM accounts WHERE id = $1', [to]);
        const tb = BigInt(r2.rows[0].balance);
        await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [String(tb + BigInt(amount)), to]);
        await client.query('COMMIT');
        return { ok: true };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        return { ok: false, error: (e as Error).message };
    } finally { client.release(); }
}

// 2. Атомарный — read-modify-write одной командой. Без блокировок и повторов.
export async function atomic(from: number, to: number, amount: number): Promise<Result> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const r = await client.query(
            'UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1', [amount, from]);
        if (r.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, error: 'insufficient' }; }
        await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, to]);
        await client.query('COMMIT');
        return { ok: true };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        return { ok: false, error: (e as Error).message };
    } finally { client.release(); }
}

// 3. SELECT … FOR UPDATE — пессимистичная блокировка обеих строк (в порядке id, без deadlock).
export async function forUpdate(from: number, to: number, amount: number): Promise<Result> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const r = await client.query<{ id: number; balance: string }>(
            'SELECT id, balance FROM accounts WHERE id IN ($1, $2) ORDER BY id FOR UPDATE', [from, to]);
        const bal = new Map(r.rows.map(x => [x.id, BigInt(x.balance)]));
        const fb = bal.get(from)!, tb = bal.get(to)!;
        if (fb < BigInt(amount)) { await client.query('ROLLBACK'); return { ok: false, error: 'insufficient' }; }
        if (RACE_DELAY_MS > 0) await sleep(RACE_DELAY_MS);
        await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [String(fb - BigInt(amount)), from]);
        await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [String(tb + BigInt(amount)), to]);
        await client.query('COMMIT');
        return { ok: true };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        return { ok: false, error: (e as Error).message };
    } finally { client.release(); }
}

// 4. Advisory lock — логический мьютекс по номеру счёта (оба ключа в порядке, без deadlock).
export async function advisory(from: number, to: number, amount: number): Promise<Result> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [Math.min(from, to)]);
        await client.query('SELECT pg_advisory_xact_lock($1)', [Math.max(from, to)]);
        const r1 = await client.query<{ balance: string }>('SELECT balance FROM accounts WHERE id = $1', [from]);
        const fb = BigInt(r1.rows[0].balance);
        if (fb < BigInt(amount)) { await client.query('ROLLBACK'); return { ok: false, error: 'insufficient' }; }
        if (RACE_DELAY_MS > 0) await sleep(RACE_DELAY_MS);
        await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [String(fb - BigInt(amount)), from]);
        const r2 = await client.query<{ balance: string }>('SELECT balance FROM accounts WHERE id = $1', [to]);
        const tb = BigInt(r2.rows[0].balance);
        await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [String(tb + BigInt(amount)), to]);
        await client.query('COMMIT');
        return { ok: true };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        return { ok: false, error: (e as Error).message };
    } finally { client.release(); }
}

// 5. Оптимистичная блокировка через version — повтор при rowCount = 0.
export async function version(from: number, to: number, amount: number): Promise<Result> {
    const client = await pool.connect();
    let retries = 0;
    try {
        for (;;) {
            await client.query('BEGIN');
            const rf = await client.query<{ balance: string; version: number }>('SELECT balance, version FROM accounts WHERE id = $1', [from]);
            const rt = await client.query<{ balance: string; version: number }>('SELECT balance, version FROM accounts WHERE id = $1', [to]);
            const fb = BigInt(rf.rows[0].balance), fv = rf.rows[0].version;
            const tb = BigInt(rt.rows[0].balance), tv = rt.rows[0].version;
            if (fb < BigInt(amount)) { await client.query('ROLLBACK'); return { ok: false, error: 'insufficient', retries }; }
            if (RACE_DELAY_MS > 0) await sleep(RACE_DELAY_MS);
            const u1 = await client.query('UPDATE accounts SET balance = $1, version = version + 1 WHERE id = $2 AND version = $3', [String(fb - BigInt(amount)), from, fv]);
            const u2 = await client.query('UPDATE accounts SET balance = $1, version = version + 1 WHERE id = $2 AND version = $3', [String(tb + BigInt(amount)), to, tv]);
            if (u1.rowCount === 1 && u2.rowCount === 1) { await client.query('COMMIT'); return { ok: true, retries }; }
            await client.query('ROLLBACK');
            if (++retries > MAX_RETRIES) return { ok: false, error: 'too_many_retries', retries };
        }
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        return { ok: false, error: (e as Error).message, retries };
    } finally { client.release(); }
}

// 6 & 7. Изоляция + повтор на 40001 (serialization_failure).
async function isolated(level: 'REPEATABLE READ' | 'SERIALIZABLE', from: number, to: number, amount: number): Promise<Result> {
    const client = await pool.connect();
    let retries = 0;
    try {
        for (;;) {
            try {
                await client.query('BEGIN');
                await client.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
                const r1 = await client.query<{ balance: string }>('SELECT balance FROM accounts WHERE id = $1', [from]);
                const fb = BigInt(r1.rows[0].balance);
                if (fb < BigInt(amount)) { await client.query('ROLLBACK'); return { ok: false, error: 'insufficient', retries }; }
                if (RACE_DELAY_MS > 0) await sleep(RACE_DELAY_MS);
                await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [String(fb - BigInt(amount)), from]);
                const r2 = await client.query<{ balance: string }>('SELECT balance FROM accounts WHERE id = $1', [to]);
                const tb = BigInt(r2.rows[0].balance);
                await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [String(tb + BigInt(amount)), to]);
                await client.query('COMMIT');
                return { ok: true, retries };
            } catch (e) {
                await client.query('ROLLBACK').catch(() => {});
                if ((e as { code?: string }).code === '40001') { if (++retries > MAX_RETRIES) return { ok: false, error: 'too_many_retries', retries }; continue; }
                return { ok: false, error: (e as Error).message, retries };
            }
        }
    } finally { client.release(); }
}

export const repeatableRead = (from: number, to: number, amount: number) => isolated('REPEATABLE READ', from, to, amount);
export const serializable = (from: number, to: number, amount: number) => isolated('SERIALIZABLE', from, to, amount);

export const METHODS = { naive, atomic, forUpdate, advisory, version, repeatableRead, serializable };
export type Method = keyof typeof METHODS;

// ════════════════════════════════════════════════════════════════
//  HTTP server / dirty-read demo / reset
// ════════════════════════════════════════════════════════════════

async function serve() {
    const app = express();
    app.use(express.json());

    app.post('/transfer', async (req, res) => {
        const { method, from, to, amount } = req.body as { method?: Method; from: number; to: number; amount: number };
        const fn = METHODS[method ?? 'naive'] ?? naive;
        const result = await fn(from, to, amount);
        res.status(result.ok ? 200 : 400).json(result);
    });

    app.get('/state', async (_req, res) => {
        const { rows } = await pool.query<{ id: number; balance: string }>(
            'SELECT id, balance::text AS balance FROM accounts ORDER BY id');
        const sum = rows.reduce((s, r) => s + BigInt(r.balance), 0n);
        res.json({ accounts: rows, sum: String(sum) });
    });

    app.listen(PORT, () => console.log(`server on :${PORT}  RACE_DELAY_MS=${RACE_DELAY_MS}  pool.max=${pool.options.max}`));
}

async function reset() {
    await pool.query('UPDATE accounts SET balance = 10000, version = 0');
    console.log('reset: both accounts = 10000, version = 0');
    await pool.end();
}

// Dirty-read demo: B reads, at READ UNCOMMITTED, a row that A has
// modified but NOT yet committed.
//   Postgres → no dirty read (RU = READ COMMITTED).
//   MySQL    → B sees the uncommitted 99999.
type Conn = { query: (sql: string) => Promise<any[]>; end: () => Promise<void> };

async function openConn(): Promise<Conn> {
    if (DSN.startsWith('postgres')) {
        const c = new Client({ connectionString: DSN });
        await c.connect();
        return { query: async sql => (await c.query(sql)).rows, end: () => c.end() };
    }
    const c = await mysql.createConnection(DSN);
    return { query: async sql => { const [rows] = await c.query(sql); return rows as any[]; }, end: () => c.end() };
}

async function dirtyRead() {
    const A = await openConn();
    const B = await openConn();
    await A.query('UPDATE accounts SET balance = 10000 WHERE id = 1');
    await B.query('SET SESSION TRANSACTION ISOLATION LEVEL READ UNCOMMITTED');
    await A.query('BEGIN');
    await A.query('UPDATE accounts SET balance = 99999 WHERE id = 1');
    await B.query('BEGIN');
    const rows = await B.query('SELECT balance FROM accounts WHERE id = 1');
    const seen = Number(rows[0].balance);
    await B.query('COMMIT');
    await A.query('ROLLBACK');
    console.log(`engine:           ${DSN.split(':')[0]}`);
    console.log(`B read:           balance = ${seen}`);
    console.log(seen === 99999
        ? '!! DIRTY READ: B saw uncommitted data (MySQL READ UNCOMMITTED)'
        : '-- no dirty read: B saw 10000 (Postgres treats RU as READ COMMITTED)');
    await A.end();
    await B.end();
}

// HTTP load: fire CONCURRENT_REQUESTS transfers of the chosen METHOD at the server.
async function attack() {
    const method = (process.env.METHOD ?? 'naive') as Method;
    const N = Number(process.env.CONCURRENT_REQUESTS ?? 100);
    const amount = Number(process.env.AMOUNT ?? 1);
    const url = `http://localhost:${PORT}/transfer`;

    try {
        const ping = await fetch(`http://localhost:${PORT}/state`);
        if (!ping.ok) throw new Error();
    } catch {
        console.error(`!! server not reachable on :${PORT} — run "npm run serve" first`);
        await pool.end();
        process.exit(1);
    }

    await pool.query('UPDATE accounts SET balance = 10000, version = 0');

    const t0 = Date.now();
    const results = await Promise.allSettled(Array.from({ length: N }, () =>
        fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method, from: 1, to: 2, amount }),
        }).then(async r => ({ ok: r.ok, body: (await r.json().catch(() => ({}))) as Result }))));
    const ms = Date.now() - t0;

    let ok = 0, retries = 0;
    const errs: Record<string, number> = {};
    for (const r of results) {
        if (r.status === 'fulfilled' && r.value.ok) { ok++; retries += r.value.body.retries ?? 0; }
        else {
            const k = r.status === 'fulfilled' ? (r.value.body.error ?? 'http') : 'rejected';
            errs[k] = (errs[k] ?? 0) + 1;
        }
    }

    const { rows } = await pool.query<{ id: number; balance: string }>('SELECT id, balance::text AS balance FROM accounts ORDER BY id');
    const sum = rows.reduce((s, r) => s + BigInt(r.balance), 0n);

    console.log(`\n--- attack(HTTP) method=${method} concurrent=${N} amount=${amount} ---`);
    console.log(`time:     ${ms}ms`);
    console.log(`ok:       ${ok}   retries: ${retries}`);
    console.log(`errs:     ${JSON.stringify(errs)}`);
    console.log(`sum:      ${sum}  (expected 20000)  ${sum === 20000n ? 'OK ✅' : 'LOST UPDATE ❌'}`);
    await pool.end();
}

// Run the CLI router only when main.ts is the entry point (skipped on import).
import { fileURLToPath } from 'node:url';
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
    const mode = process.argv[2];
    if (mode === 'serve') serve();
    else if (mode === 'attack') attack();
    else if (mode === 'reset') reset();
    else if (mode === 'dirty') dirtyRead();
    else { console.error('usage: tsx main.ts (serve|attack|reset|dirty)'); process.exit(1); }
}
