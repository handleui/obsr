#!/bin/bash
# Local PostgreSQL setup script for Detent API
#
# Usage:
#   bun run db:setup          # Setup database (idempotent, safe to run multiple times)
#   bun run db:setup:clean    # Drop and recreate database (fresh migrations)
#
# Note: These commands only affect LOCAL database, not migration files.
# Migration files in drizzle/ are source-controlled and used in production.

set -e

CLEAN=false
[[ "$1" == "--clean" ]] && CLEAN=true

echo "🐘 Setting up local PostgreSQL for Detent..."

# Detect PostgreSQL installation
if command -v /opt/homebrew/opt/postgresql@17/bin/psql &> /dev/null; then
  PG_BIN="/opt/homebrew/opt/postgresql@17/bin"
  BREW_SERVICE="postgresql@17"
elif command -v /usr/local/opt/postgresql@17/bin/psql &> /dev/null; then
  PG_BIN="/usr/local/opt/postgresql@17/bin"
  BREW_SERVICE="postgresql@17"
elif command -v psql &> /dev/null; then
  PG_BIN=""
  BREW_SERVICE="postgresql"
else
  echo "PostgreSQL not found. Install with: brew install postgresql@17"
  exit 1
fi

PSQL="${PG_BIN:+$PG_BIN/}psql"
PG_ISREADY="${PG_BIN:+$PG_BIN/}pg_isready"

# Start PostgreSQL if not running
if ! $PG_ISREADY -q 2>/dev/null; then
  echo "Starting PostgreSQL..."
  brew services start $BREW_SERVICE
  sleep 2
fi

# Verify PostgreSQL is running
if ! $PG_ISREADY -q 2>/dev/null; then
  echo "PostgreSQL failed to start"
  exit 1
fi
echo "✅ PostgreSQL is running"

SYSTEM_USER=$(whoami)

# Create postgres superuser if not exists
$PSQL -U $SYSTEM_USER -d postgres -q << 'EOF'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'postgres';
  ELSE
    ALTER ROLE postgres WITH PASSWORD 'postgres';
  END IF;
END
$$;
EOF

# Handle --clean: drop existing database
if [ "$CLEAN" = true ]; then
  echo "🗑️  Dropping detent database..."
  $PSQL -U $SYSTEM_USER -d postgres -q << 'EOF'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'detent' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS detent;
EOF
fi

# Create database if not exists
$PSQL -U $SYSTEM_USER -d postgres -q << 'EOF'
SELECT 'CREATE DATABASE detent OWNER postgres' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'detent')\gexec
GRANT ALL PRIVILEGES ON DATABASE detent TO postgres;
EOF

echo "✅ Database ready"

# Run migrations
echo "🚀 Applying migrations..."
cd "$(dirname "$0")/.."
bun run db:migrate

echo ""
echo "✅ Done! Connection: postgresql://postgres:postgres@localhost:5432/detent"
