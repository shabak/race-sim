# race-sim

A playground for reproducing and fixing database race conditions (TypeScript + Postgres/MySQL).

## Setup

```bash
npm install
```

Pick the data source in `main.ts` (top of file):

```ts
const DSN = 'postgres://shabak@localhost:5432/race_sim';
// const DSN = 'mysql://root@localhost:3306/race_sim';
```

### Postgres

```bash
createdb race_sim
psql -d race_sim -f db/schema.sql
```

### MySQL

```bash
brew install mysql
brew services start mysql
mysqladmin -u root create race_sim
mysql -u root race_sim < db/schema.sql
```

## Run

```bash
# Lost-update demo (HTTP server)
RACE_DELAY_MS=10 npm run serve   # terminal 1
npm run attack                    # terminal 2 — fires N=100 parallel transfers

# Dirty-read demo (Postgres vs MySQL, READ UNCOMMITTED)
npm run dirty

# Reset balances to 10000
npm run reset
```

## Env vars

| Var             | Default            | Used by | Meaning                                                  |
|-----------------|--------------------|---------|----------------------------------------------------------|
| `RACE_DELAY_MS` | `0`                | serve   | Sleep between SELECT and UPDATE (widens the race window) |
| `N`             | `100`              | attack  | Number of parallel transfer requests                     |
| `AMOUNT`        | `1`                | attack  | Amount per transfer                                      |
| `ENDPOINT`      | `/transfer/naive`  | attack  | Endpoint under attack                                    |
| `PORT`          | `3000`             | both    | HTTP port                                                |
