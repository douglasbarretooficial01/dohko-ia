#!/bin/sh
# Atualiza a Dohko IA no Mac com a última versão do GitHub, mantendo o .env e o banco.
set -e
cd "$(dirname "$0")/.."
REPO="https://github.com/douglasbarretooficial01/dohko-ia/archive/refs/heads/main.zip"
TMP=$(mktemp -d)
echo "Baixando a última versão..."
curl -fsSL -o "$TMP/main.zip" "$REPO" || { echo "Falha no download. Se o repositório ficou privado, use git pull."; exit 1; }
unzip -q "$TMP/main.zip" -d "$TMP"
rsync -a --exclude ".env" --exclude "node_modules" "$TMP/dohko-ia-main/" ./
rm -rf "$TMP"
# variáveis novas que ainda não existem no .env
grep -q "^SESSION_SECRET=" .env || echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
grep -q "^ADMIN_EMAILS=" .env || echo "ADMIN_EMAILS=" >> .env
echo "Recompilando e reiniciando..."
docker compose up -d --build
printf "Aguardando a API"
i=0
until curl -fs localhost:3000/health >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo ""; docker compose logs api --tail 40; exit 1; }
  printf "."; sleep 2
done
echo ""
echo "Atualizado! http://localhost:3000"
