# Thin Postgres image for the local Supabase stack: stock `postgres:15` plus
# `wal2json` (the logical-decoding output plugin supabase/realtime tails).
# `postgres:15-alpine` doesn't have apt + the wal2json package, hence the
# Debian base.

FROM postgres:15

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-15-wal2json \
 && rm -rf /var/lib/apt/lists/*
