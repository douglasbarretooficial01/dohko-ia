import type pg from "pg";
import type { CreditRepo, CreditTx } from "./repo.js";
import type { CreditBucket, Hold } from "./types.js";

export class WorkspaceNotFoundError extends Error {
  constructor(id: string) {
    super(`WORKSPACE_NAO_ENCONTRADO: ${id}`);
  }
}

/**
 * Repositório Postgres. Cada operação do motor roda numa transação com
 * `SELECT … FOR UPDATE` na linha do workspace: débitos do mesmo workspace são serializados.
 */
export class PostgresRepo implements CreditRepo {
  constructor(private pool: pg.Pool) {}

  async withWorkspaceLock<T>(workspaceId: string, fn: (tx: CreditTx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const r = await c.query("select 1 from workspaces where id = $1 for update", [workspaceId]);
      if (r.rowCount === 0) throw new WorkspaceNotFoundError(workspaceId);
      const out = await fn(this.tx(c));
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  private tx(c: pg.PoolClient): CreditTx {
    return {
      async listBuckets(ws) {
        const r = await c.query(
          `select id, workspace_id, kind, balance, expires_at, created_at from credit_buckets
           where workspace_id = $1 and balance > 0`,
          [ws],
        );
        return r.rows.map(
          (x): CreditBucket => ({
            id: x.id,
            workspaceId: x.workspace_id,
            kind: x.kind,
            balance: x.balance,
            expiresAt: x.expires_at,
            createdAt: x.created_at,
          }),
        );
      },
      async insertBucket(b) {
        await c.query(
          `insert into credit_buckets (id, workspace_id, kind, balance, expires_at, created_at) values ($1,$2,$3,$4,$5,$6)`,
          [b.id, b.workspaceId, b.kind, b.balance, b.expiresAt, b.createdAt],
        );
      },
      async updateBucketBalance(id, balance) {
        await c.query("update credit_buckets set balance = $2 where id = $1", [id, balance]);
      },
      async addToBucket(id, delta) {
        await c.query("update credit_buckets set balance = balance + $2 where id = $1", [id, delta]);
      },
      async appendLedger(e) {
        await c.query(
          `insert into credit_ledger (id, workspace_id, bucket_id, type, amount, action_id, meta, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [e.id, e.workspaceId, e.bucketId, e.type, e.amount, e.actionId ?? null, e.meta ?? null, e.createdAt],
        );
      },
      async getHold(actionId) {
        const r = await c.query("select * from credit_holds where action_id = $1", [actionId]);
        if (!r.rowCount) return null;
        const h = r.rows[0];
        return { actionId: h.action_id, workspaceId: h.workspace_id, mode: h.mode, movements: h.movements, total: h.total, createdAt: h.created_at } as Hold;
      },
      async saveHold(h) {
        await c.query(
          `insert into credit_holds (action_id, workspace_id, mode, movements, total, created_at) values ($1,$2,$3,$4,$5,$6)`,
          [h.actionId, h.workspaceId, h.mode, JSON.stringify(h.movements), h.total, h.createdAt],
        );
      },
      async deleteHold(actionId) {
        await c.query("delete from credit_holds where action_id = $1", [actionId]);
      },
      async seen(key) {
        return ((await c.query("select 1 from idempotency_keys where key = $1", [key])).rowCount ?? 0) > 0;
      },
      async markSeen(key) {
        await c.query("insert into idempotency_keys (key) values ($1) on conflict do nothing", [key]);
      },
    };
  }
}
