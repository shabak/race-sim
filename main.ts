import express from 'express';
import { Pool, Client } from 'pg';
import mysql from 'mysql2/promise';

// ── Switch the source manually: uncomment the line you need ───────
// const DSN = 'postgres://shabak@localhost:5432/race_sim';
const DSN = 'mysql://root@localhost:3306/race_sim';
// ──────────────────────────────────────────────────────────────────

const pool = new Pool({ max: 20 });
const PORT = Number(process.env.PORT ?? 3000);
const RACE_DELAY_MS = Number(process.env.RACE_DELAY_MS ?? 0);

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function transferNaive(from: number, to: number, amount: number) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const r1 = await client.query<{ balance: string }>(
            'SELECT balance FROM accounts WHERE id = $1',
            [from],
        );
        const fromBalance = BigInt(r1.rows[0].balance);

        if (fromBalance < BigInt(amount)) {
            await client.query('ROLLBACK');
            return { ok: false, error: 'insufficient' };
        }

        if (RACE_DELAY_MS > 0) await sleep(RACE_DELAY_MS);

        await client.query(
            'UPDATE accounts SET balance = $1 WHERE id = $2',
            [String(fromBalance - BigInt(amount)), from],
        );

        const r2 = await client.query<{ balance: string }>(
            'SELECT balance FROM accounts WHERE id = $1',
            [to],
        );
        const toBalance = BigInt(r2.rows[0].balance);

        await client.query(
            'UPDATE accounts SET balance = $1 WHERE id = $2',
            [String(toBalance + BigInt(amount)), to],
        );

        await client.query('COMMIT');
        return { ok: true };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        return { ok: false, error: (e as Error).message };
    } finally {
        client.release();
    }
}

async function serve() {
    const app = express();
    app.use(express.json());

    app.post('/transfer/naive', async (req, res) => {
        const { from, to, amount } = req.body as { from: number; to: number; amount: number };
        const result = await transferNaive(from, to, amount);
        if (result.ok) res.json(result);
        else res.status(400).json(result);
    });

    app.get('/state', async (_req, res) => {
        const { rows } = await pool.query<{ id: number; balance: string }>(
            'SELECT id, balance::text AS balance FROM accounts ORDER BY id',
        );
        const sum = rows.reduce((s, r) => s + BigInt(r.balance), 0n);
        res.json({ accounts: rows, sum: String(sum) });
    });

    app.listen(PORT, () => {
        console.log(`server on :${PORT}  RACE_DELAY_MS=${RACE_DELAY_MS}`);
    });
}

async function reset() {
    await pool.query('UPDATE accounts SET balance = 10000');
    console.log('reset: both accounts = 10000');
    await pool.end();
}

async function attack() {
    const N = Number(process.env.N ?? 100);
    const amount = Number(process.env.AMOUNT ?? 1);
    const endpoint = process.env.ENDPOINT ?? '/transfer/naive';
    const url = `http://localhost:${PORT}${endpoint}`;

    await pool.query('UPDATE accounts SET balance = 10000');

    const t0 = Date.now();
    const results = await Promise.allSettled(
        Array.from({ length: N }, () =>
            fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ from: 1, to: 2, amount }),
            }).then(r => (r.ok ? 'ok' : `http_${r.status}`)),
        ),
    );
    const ms = Date.now() - t0;

    let ok = 0;
    const errors: Record<string, number> = {};
    for (const r of results) {
        if (r.status === 'fulfilled' && r.value === 'ok') ok++;
        else {
            const k = r.status === 'fulfilled' ? r.value : 'rejected';
            errors[k] = (errors[k] ?? 0) + 1;
        }
    }

    const { rows } = await pool.query<{ id: number; balance: string }>(
        'SELECT id, balance::text AS balance FROM accounts ORDER BY id',
    );
    const sumAfter = rows.reduce((s, r) => s + BigInt(r.balance), 0n);

    const expectedFrom = 10000n - BigInt(ok) * BigInt(amount);
    const expectedTo = 10000n + BigInt(ok) * BigInt(amount);
    const actualFrom = BigInt(rows.find(r => r.id === 1)!.balance);
    const actualTo = BigInt(rows.find(r => r.id === 2)!.balance);

    console.log(`\n--- attack ${url}  N=${N} amount=${amount} ---`);
    console.log(`time:        ${ms}ms`);
    console.log(`ok:          ${ok}`);
    console.log(`errors:      ${JSON.stringify(errors)}`);
    console.log(`sum:         ${sumAfter}  (expected 20000)`);
    console.log(`account 1:   expected=${expectedFrom}  actual=${actualFrom}  drift=${actualFrom - expectedFrom}`);
    console.log(`account 2:   expected=${expectedTo}  actual=${actualTo}  drift=${actualTo - expectedTo}`);

    if (actualFrom > expectedFrom) {
        console.log(`\n!! LOST UPDATE: ${actualFrom - expectedFrom} unit(s) never left account 1`);
    } else if (sumAfter !== 20000n) {
        console.log(`\n!! INVARIANT BROKEN: sum drifted by ${sumAfter - 20000n}`);
    } else {
        console.log(`\n-- no race detected (try RACE_DELAY_MS=10 on the server)`);
    }

    await pool.end();
}

// Unified adapter: one interface on top of pg and mysql2.
type Conn = {
    query: (sql: string) => Promise<any[]>;
    end: () => Promise<void>;
};

async function openConn(): Promise<Conn> {
    if (DSN.startsWith('postgres')) {
        const c = new Client({ connectionString: DSN });
        await c.connect();
        return {
            query: async sql => (await c.query(sql)).rows,
            end: () => c.end(),
        };
    }
    const c = await mysql.createConnection(DSN);
    return {
        query: async sql => {
            const [rows] = await c.query(sql);
            return rows as any[];
        },
        end: () => c.end(),
    };
}

// Dirty read demo: B reads, at READ UNCOMMITTED, a row that A has
// modified but NOT yet committed.
//   Postgres → no dirty read (RU = READ COMMITTED).
//   MySQL    → B sees the uncommitted 99999.
async function dirtyRead() {
    const A = await openConn();
    const B = await openConn();

    await A.query('UPDATE accounts SET balance = 10000 WHERE id = 1');

    await B.query('SET SESSION TRANSACTION ISOLATION LEVEL READ UNCOMMITTED');

    // A writes and does NOT commit
    await A.query('BEGIN');
    await A.query('UPDATE accounts SET balance = 99999 WHERE id = 1');

    // B reads right now, while A's transaction is still open
    await B.query('BEGIN');
    const rows = await B.query('SELECT balance FROM accounts WHERE id = 1');
    const seen = Number(rows[0].balance);
    await B.query('COMMIT');

    // A rolls back — as if the 99999 never existed
    await A.query('ROLLBACK');

    console.log(`engine:           ${DSN.split(':')[0]}`);
    console.log(`B прочитал:       balance = ${seen}`);
    console.log(
        seen === 99999
            ? '!! DIRTY READ: B увидел незакоммиченные данные (MySQL READ UNCOMMITTED)'
            : '-- грязного чтения нет: B увидел 10000 (Postgres трактует RU как READ COMMITTED)',
    );

    await A.end();
    await B.end();
}

const mode = process.argv[2];
if (mode === 'serve') serve();
else if (mode === 'attack') attack();
else if (mode === 'reset') reset();
else if (mode === 'dirty') dirtyRead();
else {
    console.error('usage: tsx main.ts (serve|attack|reset|dirty)');
    process.exit(1);
}
