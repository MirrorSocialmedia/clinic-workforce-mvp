-- Clinic Workforce MVP — Database Initialization
-- This file is mounted to /docker-entrypoint-initdb.d/ in Docker Compose
-- PostgreSQL runs it automatically on first startup

-- No manual DDL needed — Prisma migrations handle schema creation.
-- This file serves as a placeholder for any additional initialization.

-- Example: Set timezone to Hong Kong
SET timezone = 'Asia/Hong_Kong';

-- Example: Create extension for UUID generation (optional, Prisma uses cuid)
-- CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
