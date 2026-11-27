import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenRouterProvider, ProviderError } from "../src/llm/provider.js";

// Servidor falso que imita o streaming do OpenRouter (formato OpenAI + comentários + usage com custo)
let server: Server;
let base = "";
let lastBody: any = null;
let mode: "ok" | "error" | "midstream-error" = "ok";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastBody = JSON.parse(body);
      if (mode === "error") {
        res.writeHead(402, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Insufficient credits" } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunks = [
        ": OPENROUTER PROCESSING\n\n",
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Olá" } }] })}\n\n`,
        // chunk partido no meio da linha
        `data: ${JSON.stringify({ choices: [{ delta: { content: ", Douglas" } }] })}`.slice(0, 20),
        `data: ${JSON.stringify({ choices: [{ delta: { content: ", Douglas" } }] })}\n\n`.slice(20),
        mode === "midstream-error" ? `data: ${JSON.stringify({ error: { message: "upstream caiu" } })}\n\n` : "",
        `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 120, completion_tokens: 8, cost: 0.00042 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      let i = 0;
      const tick = () => (i < chunks.length ? (res.write(chunks[i++]), setTimeout(tick, 5)) : res.end());
      tick();
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

describe("OpenRouterProvider", () => {
  const p = () => new OpenRouterProvider("sk-or-test", "http://localhost", base);

  it("lê o streaming, junta deltas (mesmo partidos) e devolve tokens e custo real", async () => {
    mode = "ok";
    let out = "";
    const r = await p().stream({ model: "anthropic/claude-sonnet-4.5", messages: [{ role: "user", content: "oi" }], maxTokens: 100 }, (t) => (out += t));
    expect(out).toBe("Olá, Douglas");
    expect(r).toEqual({ inputTokens: 120, outputTokens: 8, costUSD: 0.00042 });
    expect(lastBody).toMatchObject({ model: "anthropic/claude-sonnet-4.5", stream: true, usage: { include: true }, max_tokens: 100 });
  });

  it("erro HTTP vira ProviderError com status", async () => {
    mode = "error";
    await expect(p().stream({ model: "x", messages: [] }, () => {})).rejects.toMatchObject({ status: 402 });
  });

  it("erro no meio do stream vira ProviderError", async () => {
    mode = "midstream-error";
    await expect(p().stream({ model: "x", messages: [] }, () => {})).rejects.toBeInstanceOf(ProviderError);
  });
});
