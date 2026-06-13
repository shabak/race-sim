# race-sim

Demo examples for the article «2 + 2 = 6 and how we fix it: lost updates in
Postgres»: https://habr.com/ru/articles/1044190/

Shows the **lost update** anomaly in Postgres and compares the ways to remove it,
along with their cost (speed, retries).

Stack: Node + TypeScript, the `pg` / `mysql2` drivers, no ORM.

## Setup

```bash
npm install
```

The data source is selected at the top of `main.ts`:

```ts
const DSN = 'postgres://shabak@localhost:5432/race_sim';
// const DSN = 'mysql://root@localhost:3306/race_sim';
```

### Postgres

```bash
createdb race_sim
psql -d race_sim -f db/schema.sql
```

## Seven ways to do the transfer

Transferring `amount` from account `from` to account `to`, implemented in seven
ways (`METHODS` in `main.ts`):

| method           | group        | retries | loses money? |
|------------------|--------------|---------|--------------|
| `naive`          | baseline     | no      | **yes**      |
| `atomic`         | no read      | no      | no           |
| `forUpdate`      | pessimistic  | no      | no           |
| `advisory`       | pessimistic  | no      | no           |
| `version`        | optimistic   | yes     | no           |
| `repeatableRead` | optimistic   | yes     | no           |
| `serializable`   | optimistic   | yes     | no           |

## Run

```bash
# Direct measurement of the selected method (single process, no HTTP).
# Median over 10 runs with warmup, on 2 accounts vs 1000, under delay:
METHOD=atomic    ACCOUNTS=2    RACE_DELAY_MS=10 RUNS=13 WARMUP=3 npm run bench
METHOD=forUpdate ACCOUNTS=2    RACE_DELAY_MS=10 RUNS=13 WARMUP=3 npm run bench
METHOD=version   ACCOUNTS=1000 RACE_DELAY_MS=0  RUNS=13 WARMUP=3 npm run bench

# A single run of the naive method — money is lost (the invariant breaks):
METHOD=naive ACCOUNTS=2 CONCURRENT_REQUESTS=200 npm run bench

# Same thing over an HTTP server (more realistic — external clients)
npm run serve                                   # terminal 1
METHOD=version CONCURRENT_REQUESTS=200 npm run attack   # terminal 2

# Dirty-read demo (Postgres vs MySQL, READ UNCOMMITTED)
npm run dirty

# Reset balances to 10000 and version to 0
npm run reset
```

The measurement prints: the median throughput (ops/s) with min–max, the number
of retries (`retries`), and the invariant check (the sum of balances stays
constant). `naive` breaks the invariant, the others hold it.

## Env vars

| Var                   | Default  | Where        | Meaning                                                       |
|-----------------------|----------|--------------|---------------------------------------------------------------|
| `METHOD`              | `naive`  | bench/attack | Transfer method (see the table above)                         |
| `CONCURRENT_REQUESTS` | `100`    | bench/attack | How many transfers to run at the same time                    |
| `ACCOUNTS`            | `2`      | bench        | Number of accounts: 2 — contention point, 1000 — load spread out |
| `AMOUNT`              | `1`      | bench/attack | Amount of a single transfer                                   |
| `RACE_DELAY_MS`       | `0`      | serve/bench  | Work inside the transaction (widens the row-hold window)      |
| `RUNS`                | `1`      | bench        | How many times to repeat the measurement (median is taken)    |
| `WARMUP`              | `0`      | bench        | How many first runs to drop for warmup                        |
| `POOL_MAX`            | `20`     | all          | Connection pool size                                          |
| `MAX_RETRIES`         | `100000` | bench/attack | Retry ceiling for the optimistic methods                      |
| `PORT`                | `3000`   | serve/attack | HTTP port                                                     |
