DROP TABLE IF EXISTS accounts;

CREATE TABLE accounts (
    id      INT PRIMARY KEY,
    balance BIGINT NOT NULL
);

INSERT INTO accounts (id, balance) VALUES (1, 10000), (2, 10000);

