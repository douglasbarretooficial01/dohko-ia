#!/bin/sh
# Prepara e sobe a Dohko IA no Mac (requer OrbStack ou Docker Desktop aberto).
set -e
cd "$(dirname "$0")/.."
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
until curl -fs localhost:3000/health >/dev/null 2>&1; do printf "."; sleep 2; done
echo ""
echo "Dohko IA rodando em http://localhost:3000"
open http://localhost:3000 2>/dev/null || true
