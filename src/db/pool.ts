import pg from "pg";

// numeric → number (créditos e custos cabem com folga em double)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export function createPool(connectionString: string) {
  return new pg.Pool({ connectionString, max: 10 });
}
