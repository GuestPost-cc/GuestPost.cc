#!/bin/bash
set -e

echo "=== GuestPost.cc Development Environment ==="

# Start infrastructure
echo "Starting Docker services (PostgreSQL, Redis, MinIO, Mailpit, Traefik)..."
docker compose -f infrastructure/docker/docker-compose.yml up -d

echo ""
echo "Services:"
echo "  PostgreSQL :5432"
echo "  Redis      :6379"
echo "  MinIO      :9000 (console :9001)"
echo "  Mailpit    :1025 (UI :8025)"
echo "  Traefik    :80 (dashboard :8080)"
echo ""
echo "Run 'docker compose -f infrastructure/docker/docker-compose.yml down' to stop."
