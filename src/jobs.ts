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

  // planos anuais: libera os créditos do mês (recupera meses atrasados se o servidor ficou fora do ar)
  const due = await pool.query(
    "select id, plan_id, next_plan_grant_at from workspaces where next_plan_grant_at <= now() and next_plan_grant_at < plan_period_end",
  );
  for (const w of due.rows) {
    let next: Date = w.next_plan_grant_at;
    const end = await pool.query("select plan_period_end from workspaces where id = $1", [w.id]);
    while (next <= new Date() && next < end.rows[0].plan_period_end) {
      await engine.grantPlanMonth(w.id, w.plan_id, next.toISOString().slice(0, 10));
      next = new Date(next);
      next.setMonth(next.getMonth() + 1);
    }
    await pool.query("update workspaces set next_plan_grant_at = $2 where id = $1", [w.id, next]);
  }

  if (expiring.rowCount || orphans.rowCount || due.rowCount) {
    log(`manutenção: ${expiring.rowCount} workspaces expirados, ${orphans.rowCount} reservas órfãs liberadas`);
  }
}

export function startJobs(pool: pg.Pool, engine: CreditEngine, everyMs = 15 * 60_000) {
  const tick = () => runMaintenance(pool, engine).catch((e) => console.error("manutenção falhou", e));
  tick();
  return setInterval(tick, everyMs);
}
