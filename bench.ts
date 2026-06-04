import { METHODS, pool, type Method } from './main';

// Direct, in-process measurement: fire CONCURRENT_REQUESTS transfers of the
// chosen METHOD concurrently and report correctness (sum, drift) and cost
// (time, retries). No HTTP. Run with:
//   METHOD=forUpdate CONCURRENT_REQUESTS=200 npm run bench
async function main() {
    const method = (process.env.METHOD ?? 'naive') as Method;
    const concurrency = Number(process.env.CONCURRENT_REQUESTS ?? 100);
    const amount = Number(process.env.AMOUNT ?? 1);

    const transfer = METHODS[method];
    if (!transfer) {
        console.error(`unknown METHOD="${method}". Available: ${Object.keys(METHODS).join(', ')}`);
        await pool.end();
        process.exit(1);
    }

    await pool.query('UPDATE accounts SET balance = 10000, version = 0');

    const t0 = Date.now();
    const results = await Promise.allSettled(
        Array.from({ length: concurrency }, () => transfer(1, 2, amount)),
    );
    const ms = Date.now() - t0;

    let ok = 0, retries = 0;
    const errs: Record<string, number> = {};
    for (const r of results) {
        if (r.status === 'fulfilled' && r.value.ok) {
            ok++;
            retries += r.value.retries ?? 0;
        } else {
            const k = r.status === 'fulfilled' ? (r.value.error ?? 'fail') : (r.reason?.message ?? 'rejected');
            errs[k] = (errs[k] ?? 0) + 1;
        }
    }

    const { rows } = await pool.query<{ id: number; balance: string }>(
        'SELECT id, balance::text AS balance FROM accounts ORDER BY id');
    const sum = rows.reduce((s, r) => s + BigInt(r.balance), 0n);
    const a1 = BigInt(rows.find(r => r.id === 1)!.balance);
    const expected1 = 10000n - BigInt(ok) * BigInt(amount);

    console.log(`\n--- method=${method}  concurrent=${concurrency}  amount=${amount} ---`);
    console.log(`time:      ${ms}ms`);
    console.log(`ok:        ${ok}   retries: ${retries}`);
    console.log(`errs:      ${JSON.stringify(errs)}`);
    console.log(`sum:       ${sum}  (expected 20000)`);
    console.log(`account 1: actual=${a1}  expected=${expected1}  drift=${a1 - expected1}`);
    console.log(sum === 20000n && a1 === expected1
        ? `\nOK ✅  invariant holds, no money lost`
        : `\nLOST UPDATE ❌  sum drifted by ${sum - 20000n}, account 1 drift ${a1 - expected1}`);

    await pool.end();
}

main();
