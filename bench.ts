import { transferNaive, pool } from './main';

// Direct, in-process attack: call transferNaive() concurrently — no HTTP,
// no child server. The DB-level race (lost update) reproduces all the same.
// RACE_DELAY_MS / USE_POOL / POOL_MAX are read by main.ts from env at import,
// so set them on the command line:  USE_POOL=false CONCURRENT_REQUESTS=200 tsx bench.ts
async function main() {
    const concurrency = Number(process.env.CONCURRENT_REQUESTS ?? 100);
    const amount = Number(process.env.AMOUNT ?? 1);

    await pool.query('UPDATE accounts SET balance = 10000');

    const t0 = Date.now();
    // all        — waits for all; rejects on the first rejection
    // allSettled — waits for all; never rejects → [{status, value|reason}]
    // race       — first to settle wins (fulfilled OR rejected)
    // any        — first fulfilled wins; rejects only if all fail (AggregateError)
    // mnemonic: all=strict, allSettled=soft, race=first-any, any=first-ok
    const results = await Promise.allSettled(
        Array.from({ length: concurrency }, () => transferNaive(1, 2, amount)),
    );
    const ms = Date.now() - t0;

    type Outcome = PromiseSettledResult<{ ok: boolean; error?: string }>;
    const isOk = (r: Outcome) => r.status === 'fulfilled' && r.value.ok;
    const codeOf = (r: Outcome): string =>
        r.status === 'fulfilled'
            ? r.value.error ?? 'fail'
            : (r.reason as NodeJS.ErrnoException)?.code ?? (r.reason as Error)?.message ?? 'rejected';

    let ok = 0;
    const errs: Record<string, number> = {};
    const firstByCode: Record<string, number> = {}; // launch-index of first hit per code
    // results keep launch order → index i == launch index of that request
    results.forEach((r, i) => {
        if (isOk(r)) {
            ok++;
        } else {
            const k = codeOf(r);
            errs[k] = (errs[k] ?? 0) + 1;
            if (!(k in firstByCode)) firstByCode[k] = i;
        }
    });

    const failIdx = results.findIndex(r => !isOk(r));
    const firstFail = failIdx === -1 ? null : { i: failIdx, code: codeOf(results[failIdx]) };

    const { rows } = await pool.query<{ id: number; balance: string }>(
        'SELECT id, balance::text AS balance FROM accounts ORDER BY id',
    );
    const sum = rows.reduce((s, r) => s + BigInt(r.balance), 0n);
    const a1 = BigInt(rows.find(r => r.id === 1)!.balance);
    const expected1 = 10000n - BigInt(ok) * BigInt(amount);

    console.log(`concurrent_requests=${concurrency} amount=${amount} time=${ms}ms`);
    console.log(`ok=${ok} errs=${JSON.stringify(errs)}`);
    console.log(`firstFail=${firstFail ? `#${firstFail.i} (${firstFail.code})` : 'none'}`);
    console.log(`firstByCode=${JSON.stringify(firstByCode)}`);
    console.log(`sum=${sum} (expected 20000)`);
    console.log(`account 1: actual=${a1} expected=${expected1} drift=${a1 - expected1}`);

    await pool.end();
}

main();
