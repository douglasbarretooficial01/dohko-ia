#!/bin/sh
# Prepara e sobe a Dohko IA no Mac (requer OrbStack ou Docker Desktop aberto).
set -e
is_dohko() { [ -f "$1/docker-compose.yml" ] && [ -f "$1/package.json" ] && grep -q '"name": "dohko-ia"' "$1/package.json" 2>/dev/null; }
if is_dohko "$PWD"; then cd "$PWD"
elif is_dohko "$HOME/dohko-ia"; then cd "$HOME/dohko-ia"
else echo "Rode este script de dentro da pasta da Dohko IA (ex.: cd ~/dohko-ia)."; exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Abrindo o OrbStack..."; open -a OrbStack 2>/dev/null || true
  until docker info >/dev/null 2>&1; do sleep 2; done
fi
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i '' "s/^API_KEY=.*/API_KEY=$(openssl rand -hex 32)/" .env
  sed -i '' "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env
  echo ".env criado com chaves novas."
fi
docker compose up -d --build
printf "Aguardando a API"
i=0
until curl -fs localhost:3000/health >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo ""
    echo "A API não respondeu em 2 minutos. Últimas linhas do log:"
    echo "----------------------------------------------------------"
    docker compose logs api --tail 40
    echo "----------------------------------------------------------"
    echo "Mande este log para análise. Para tentar de novo: sh scripts/setup-mac.sh"
    exit 1
  fi
  printf "."
  sleep 2
done
echo ""
echo "Dohko IA rodando em http://localhost:3000"
open http://localhost:3000 2>/dev/null || true
