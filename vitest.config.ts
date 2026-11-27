import { defineConfig } from "vitest/config";
// os testes de integração usam o mesmo banco: rodar arquivos em sequência
export default defineConfig({ test: { fileParallelism: false, include: ["test/**/*.test.ts"] } });
