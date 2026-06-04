import { transferNaive, pool } from './main';
import { writeFileSync } from 'node:fs';

// Grid sweep: for each (delay, concurrency) run K volleys, record error breakdown.
// One process, explicit levels (no binary search). Run with: USE_POOL=false tsx sweep.ts
const DELAYS = [0, 10, 100, 1000];                                  // RACE_DELAY_MS
const LEVELS = [50, 100, 200, 500, 1000, 1500, 2000, 2500, 2800, 3500]; // CONCURRENT_REQUESTS
const K = 5;                                                        // repeats per cell

type Row = {
    delay: number;
    concurrency: number;
    k: number;
    time: number;
    ok: number;
    e53300: number;
    etimedout: number;
    other: number;
    firstFailIndex: number; // -1 if none
    firstFailCode: string;  // '' if none
};

type Outcome = PromiseSettledResult<{ ok: boolean; error?: string }>;
const isOk = (r: Outcome) => r.status === 'fulfilled' && r.value.ok;
const codeOf = (r: Outcome): string =>
    r.status === 'fulfilled'
        ? r.value.error ?? 'fail'
        : (r.reason as NodeJS.ErrnoException)?.code ?? (r.reason as Error)?.message ?? 'rejected';

async function volley(delay: number, concurrency: number, k: number): Promise<Row> {
    await pool.query('UPDATE accounts SET balance = 10000'); // keep balance high → no 'insufficient' noise

    const t0 = Date.now();
    const results = await Promise.allSettled(
        Array.from({ length: concurrency }, () => transferNaive(1, 2, 1, delay)),
    );
    const time = Date.now() - t0;

    let ok = 0, e53300 = 0, etimedout = 0, other = 0;
    results.forEach(r => {
        if (isOk(r)) { ok++; return; }
        const c = codeOf(r);
        if (c === '53300') e53300++;
        else if (c === 'ETIMEDOUT') etimedout++;
        else other++;
    });

    const failIdx = results.findIndex(r => !isOk(r));
    return {
        delay, concurrency, k, time, ok, e53300, etimedout, other,
        firstFailIndex: failIdx,
        firstFailCode: failIdx === -1 ? '' : codeOf(results[failIdx]),
    };
}

async function main() {
    const total = DELAYS.length * LEVELS.length * K;
    const rows: Row[] = [];
    let n = 0;

    for (const delay of DELAYS) {
        for (const concurrency of LEVELS) {
            for (let k = 1; k <= K; k++) {
                const row = await volley(delay, concurrency, k);
                rows.push(row);
                n++;
                const pct = String(Math.round((n / total) * 100)).padStart(3);
                console.log(
                    `[${pct}%] ${n}/${total}  delay=${String(delay).padStart(4)} ` +
                    `conc=${String(concurrency).padStart(4)} k=${k}/${K}  ` +
                    `time=${String(row.time).padStart(5)}ms  ok=${String(row.ok).padStart(4)}  ` +
                    `53300=${row.e53300}  ETIMEDOUT=${row.etimedout}  other=${row.other}  ` +
                    `firstFail=${row.firstFailIndex === -1 ? 'none' : `#${row.firstFailIndex}(${row.firstFailCode})`}`,
                );
            }
        }
    }

    writeFileSync(new URL('./sweep.json', import.meta.url).pathname, JSON.stringify(rows, null, 2));
    console.log(`\nDone. ${rows.length} rows → sweep.json`);
    await pool.end();
}

main();
