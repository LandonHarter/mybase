# mybase's Postgres: the official image plus extra extensions that projects can
# enable from the dashboard (CREATE EXTENSION, per project database). Build from the repo root:
#   docker build -f docker/postgres.Dockerfile -t mybase-postgres .
#
# Debian, not Alpine: the extensions come from the PGDG apt repo, which the official
# image already configures, with amd64 and arm64 packages. Contrib extensions
# (pgcrypto, pg_trgm, citext, hstore, uuid-ossp, ...) ship with the base image.
#
# Not included: pg_cron. It runs in one fixed database and schedules jobs as superuser,
# which doesn't fit one database + role per project.
FROM postgres:17-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    postgresql-17-pgvector \
    postgresql-17-postgis-3 \
    postgresql-17-hypopg \
    postgresql-17-partman \
  && rm -rf /var/lib/apt/lists/*

# pg_stat_statements only works when preloaded. auth_delay waits half a second after each failed
# sign-in, which slows password guessing when the port is reachable from the internet.
CMD ["postgres", "-c", "shared_preload_libraries=pg_stat_statements,auth_delay", "-c", "auth_delay.milliseconds=500"]
