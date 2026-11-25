import type pg from "pg";
import type { CreditEngine } from "./credits/engine.js";

/** Expira buckets vencidos e libera reservas órfãs (ação que nunca chamou settle/release). */
export async function runMaintenance(pool: pg.Pool, engine: CreditEngine, log = console.log) {
  const expiring = await pool.query(
    "select distinct workspace_id from credit_buckets where balance > 0 and expires_at <= now()",
  );
  for (const r of expiring.rows) await engine.expire(r.workspace_id);

  const orphans = await pool.query(
    "select action_id, workspace_id from credit_holds where created_at < now() - interval '1 hour'",
  );
  for (const r of orphans.rows) await engine.release(r.workspace_id, r.action_id);

  if (expiring.rowCount || orphans.rowCount) {
    log(`manutenção: ${expiring.rowCount} workspaces expirados, ${orphans.rowCount} reservas órfãs liberadas`);
  }
}

export function startJobs(pool: pg.Pool, engine: CreditEngine, everyMs = 15 * 60_000) {
  const tick = () => runMaintenance(pool, engine).catch((e) => console.error("manutenção falhou", e));
  tick();
  return setInterval(tick, everyMs);
}
