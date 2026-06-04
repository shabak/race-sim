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
# Прямой замер выбранного способа (в одном процессе, без HTTP)
METHOD=naive      CONCURRENT_REQUESTS=100 npm run bench
METHOD=forUpdate  CONCURRENT_REQUESTS=100 npm run bench
METHOD=serializable CONCURRENT_REQUESTS=100 npm run bench

# То же через HTTP-сервер (реалистичнее — внешние клиенты)
npm run serve                                   # терминал 1
METHOD=version CONCURRENT_REQUESTS=200 npm run attack   # терминал 2

# Dirty-read демо (Postgres vs MySQL, READ UNCOMMITTED)
npm run dirty

# Сброс балансов в 10000 и version в 0
npm run reset
```

Замер печатает: время, `ok`, число повторов (`retries`), ошибки, итоговую сумму
(инвариант = 20000) и drift по счёту. `naive` ломает инвариант, остальные держат.

## Env vars

| Var                   | Default  | Где          | Смысл                                              |
|-----------------------|----------|--------------|----------------------------------------------------|
| `METHOD`              | `naive`  | bench/attack | Способ перевода (см. таблицу выше)                 |
| `CONCURRENT_REQUESTS` | `100`    | bench/attack | Сколько переводов запустить одновременно           |
| `AMOUNT`              | `1`      | bench/attack | Сумма одного перевода                              |
| `RACE_DELAY_MS`       | `0`      | serve/bench  | Пауза между SELECT и UPDATE (расширяет окно гонки) |
| `POOL_MAX`            | `20`     | все          | Размер пула соединений                             |
| `MAX_RETRIES`         | `100000` | bench/attack | Потолок повторов для оптимистичных способов        |
| `PORT`                | `3000`   | serve/attack | HTTP-порт                                          |
