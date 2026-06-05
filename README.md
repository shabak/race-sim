# race-sim

Демонстрация аномалии **lost update** в Postgres и сравнение способов её убрать —
по цене (скорость, повторы). Код к статье «Деньги из воздуха: lost update в
Postgres и цена каждого фикса».

Стек: Node + TypeScript, драйверы `pg` / `mysql2`, без ORM.

## Setup

```bash
npm install
```

Источник данных выбирается вверху `main.ts`:

```ts
const DSN = 'postgres://shabak@localhost:5432/race_sim';
// const DSN = 'mysql://root@localhost:3306/race_sim';
```

### Postgres

```bash
createdb race_sim
psql -d race_sim -f db/schema.sql
```

## Семь способов перевода

Перевод `amount` со счёта `from` на счёт `to`, реализованный семью способами
(`METHODS` в `main.ts`):

| method           | группа         | повторы | теряет деньги? |
|------------------|----------------|---------|----------------|
| `naive`          | базовый        | нет     | **да**         |
| `atomic`         | без чтения     | нет     | нет            |
| `forUpdate`      | пессимистичный | нет     | нет            |
| `advisory`       | пессимистичный | нет     | нет            |
| `version`        | оптимистичный  | да      | нет            |
| `repeatableRead` | оптимистичный  | да      | нет            |
| `serializable`   | оптимистичный  | да      | нет            |

## Run

```bash
# Прямой замер выбранного способа (в одном процессе, без HTTP).
# Медиана по 10 прогонам с прогревом, на 2 счетах vs 1000, под задержкой:
METHOD=atomic    ACCOUNTS=2    RACE_DELAY_MS=10 RUNS=13 WARMUP=3 npm run bench
METHOD=forUpdate ACCOUNTS=2    RACE_DELAY_MS=10 RUNS=13 WARMUP=3 npm run bench
METHOD=version   ACCOUNTS=1000 RACE_DELAY_MS=0  RUNS=13 WARMUP=3 npm run bench

# Один прогон наивного способа — видно потерю денег (инвариант ломается):
METHOD=naive ACCOUNTS=2 CONCURRENT_REQUESTS=200 npm run bench

# То же через HTTP-сервер (реалистичнее — внешние клиенты)
npm run serve                                   # терминал 1
METHOD=version CONCURRENT_REQUESTS=200 npm run attack   # терминал 2

# Dirty-read демо (Postgres vs MySQL, READ UNCOMMITTED)
npm run dirty

# Сброс балансов в 10000 и version в 0
npm run reset
```

Замер печатает: медиану throughput (ops/s) с min–max, число повторов (`retries`)
и проверку инварианта (сумма балансов постоянна). `naive` инвариант ломает,
остальные держат.

## Env vars

| Var                   | Default  | Где          | Смысл                                                       |
|-----------------------|----------|--------------|-------------------------------------------------------------|
| `METHOD`              | `naive`  | bench/attack | Способ перевода (см. таблицу выше)                          |
| `CONCURRENT_REQUESTS` | `100`    | bench/attack | Сколько переводов запустить одновременно                    |
| `ACCOUNTS`            | `2`      | bench        | Число счетов: 2 — точка конкуренции, 1000 — нагрузка размазана |
| `AMOUNT`              | `1`      | bench/attack | Сумма одного перевода                                       |
| `RACE_DELAY_MS`       | `0`      | serve/bench  | Работа внутри транзакции (расширяет окно удержания строки)  |
| `RUNS`                | `1`      | bench        | Сколько раз повторить замер (берётся медиана)               |
| `WARMUP`              | `0`      | bench        | Сколько первых прогонов отбросить на прогрев                |
| `POOL_MAX`            | `20`     | все          | Размер пула соединений                                      |
| `MAX_RETRIES`         | `100000` | bench/attack | Потолок повторов для оптимистичных способов                 |
| `PORT`                | `3000`   | serve/attack | HTTP-порт                                                   |
