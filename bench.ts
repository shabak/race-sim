import { METHODS, pool, type Method } from './main';

// Direct, in-process measurement harness.
//   METHOD              — transfer strategy
//   CONCURRENT_REQUESTS — how many transfers fire at once
//   ACCOUNTS            — how many accounts (2 = one hot pair; large = low contention)
//   AMOUNT              — amount per transfer
//   RACE_DELAY_MS       — work held inside the transaction
//   RUNS                — repeat the measurement N times and average
// Example: METHOD=forUpdate ACCOUNTS=2 CONCURRENT_REQUESTS=100 RUNS=10 npm run bench

function randomPair(n: number): [number, number] {
    const a = 1 + Math.floor(Math.random() * n);
    let b = a;
    while (b === a) b = 1 + Math.floor(Math.random() * n);
    return a < b ? [a, b] : [b, a];
}

const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function oneRun(transfer: (f: number, t: number, a: number) => Promise<{ ok: boolean; retries?: number }>,
                      accounts: number, concurrency: number, amount: number) {
    await pool.query('TRUNCATE accounts');
    await pool.query('INSERT INTO accounts (id, balance) SELECT g, 10000 FROM generate_series(1, $1) g', [accounts]);
    const startTotal = BigInt(accounts) * 10000n;

    const t0 = Date.now();
    const results = await Promise.allSettled(
        Array.from({ length: concurrency }, () => {
            const [from, to] = randomPair(accounts);
            return transfer(from, to, amount);
        }),
    );
    const ms = Date.now() - t0;

    let ok = 0, retries = 0;
    for (const r of results) if (r.status === 'fulfilled' && r.value.ok) { ok++; retries += r.value.retries ?? 0; }

    const { rows } = await pool.query<{ sum: string }>('SELECT COALESCE(SUM(balance),0)::text AS sum FROM accounts');
    const sumOk = BigInt(rows[0].sum) === startTotal;

    return { throughput: ok > 0 ? (ok / ms) * 1000 : 0, retries, ok, sumOk };
}

async function main() {
    const method = (process.env.METHOD ?? 'naive') as Method;
    const concurrency = Number(process.env.CONCURRENT_REQUESTS ?? 100);
    const accounts = Number(process.env.ACCOUNTS ?? 2);
    const amount = Number(process.env.AMOUNT ?? 1);
    const runs = Number(process.env.RUNS ?? 1);

    const transfer = METHODS[method];
    if (!transfer) {
        console.error(`unknown METHOD="${method}". Available: ${Object.keys(METHODS).join(', ')}`);
        await pool.end();
        process.exit(1);
    }

    const warmup = Number(process.env.WARMUP ?? 0);
    const tputs: number[] = [], retr: number[] = [], oks: number[] = [];
    let invariantHeld = true;
    for (let i = 0; i < runs; i++) {
        const r = await oneRun(transfer, accounts, concurrency, amount);
        if (!r.sumOk) invariantHeld = false;
        if (i < warmup) continue; // discard warmup runs
        tputs.push(r.throughput);
        retr.push(r.retries);
        oks.push(r.ok);
    }

    const medT = Math.round(median(tputs));
    const minT = Math.round(Math.min(...tputs));
    const maxT = Math.round(Math.max(...tputs));
    const medR = Math.round(median(retr));
    const medOk = Math.round(median(oks));

    console.log(`\n--- method=${method} accounts=${accounts} conc=${concurrency} delay=${process.env.RACE_DELAY_MS ?? 0}ms runs=${runs} warmup=${warmup} (median of ${tputs.length}) ---`);
    console.log(`median_throughput: ${medT} ops/sec   (min ${minT}, max ${maxT})`);
    console.log(`median_retries:    ${medR}`);
    console.log(`median_ok:         ${medOk} / ${concurrency}`);
    console.log(`invariant:      ${invariantHeld ? 'held ✅' : 'BROKEN ❌'}`);

    await pool.end();
}

main();
