import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB)("migrations", () => {
  const pool = createPool(DB!);
  afterAll(() => pool.end());

  it("vários processos subindo ao mesmo tempo não conflitam (trava)", async () => {
    await pool.query("drop schema public cascade; create schema public;");
    const pools = Array.from({ length: 4 }, () => createPool(DB!));
    await Promise.all(pools.map((p) => migrate(p, () => {})));
    await Promise.all(pools.map((p) => p.end()));
    const r = await pool.query("select count(*)::int as n from schema_migrations");
    expect(r.rows[0].n).toBe(2);
  });

  it("rodar de novo não faz nada", async () => {
    const logs: string[] = [];
    await migrate(pool, (m) => logs.push(m));
    expect(logs).toEqual([]);
  });
});
