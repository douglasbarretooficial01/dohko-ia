#!/bin/sh
# Atualiza a Dohko IA no Mac com a última versão do GitHub, mantendo o .env e o banco.
set -e
# Descobre a pasta do projeto SEM depender de $0 (que vira "sh" quando o script chega por "curl | sh").
# Só aceita uma pasta que seja de fato a Dohko IA; nunca roda em outra pasta.
is_dohko() { [ -f "$1/docker-compose.yml" ] && [ -f "$1/package.json" ] && grep -q '"name": "dohko-ia"' "$1/package.json" 2>/dev/null; }
if is_dohko "$PWD"; then DIR="$PWD"
elif is_dohko "$HOME/dohko-ia"; then DIR="$HOME/dohko-ia"
else echo "Não encontrei a pasta da Dohko IA (esperado: ~/dohko-ia). Nada foi alterado."; exit 1
fi
cd "$DIR"
echo "Atualizando em: $DIR"
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
