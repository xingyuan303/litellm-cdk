#!/bin/sh
set -e
# Substitute the Bedrock geography prefix (us|eu|jp|au|global) to match the deployment region.
sed -i "s/__BEDROCK_GEO__/${BEDROCK_GEO:-us}/g" /app/config.yaml
# Compose DATABASE_URL from the secret fields injected by ECS (kept out of the task def plaintext).
export DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
# One Uvicorn worker per task; scale horizontally (more tasks), per LiteLLM prod guidance.
exec litellm --config /app/config.yaml --port 4000 --num_workers 1
