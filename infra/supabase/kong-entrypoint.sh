#!/bin/sh
# Render kong.yml.template → /tmp/kong.yml with the JWT keys from env, then
# exec kong via its stock entrypoint. Substitution uses `sed` (no extra
# packages needed in the kong image) and only the two specific placeholders we
# own, so the rest of the YAML can contain literal `$` chars without breaking.
#
# Compose mounts:
#   /home/kong/kong.yml.template  (the template)
#   this script at /docker-entrypoint-cezar.sh
# And sets KONG_DECLARATIVE_CONFIG=/tmp/kong.yml so kong reads the rendered
# file instead of the template.

set -e

: "${SUPABASE_ANON_KEY:?must be set}"
: "${SUPABASE_SERVICE_ROLE_KEY:?must be set}"

# Escape `&`, `|`, `\` in the values so sed's replacement side stays literal.
# JWT bodies are base64url so they never contain these in practice, but if a
# value were ever rotated to something exotic the escape keeps sed honest.
escape() {
  printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'
}
ANON_ESC=$(escape "$SUPABASE_ANON_KEY")
SERVICE_ESC=$(escape "$SUPABASE_SERVICE_ROLE_KEY")

sed \
  -e "s|\${SUPABASE_ANON_KEY}|${ANON_ESC}|g" \
  -e "s|\${SUPABASE_SERVICE_ROLE_KEY}|${SERVICE_ESC}|g" \
  /home/kong/kong.yml.template > /tmp/kong.yml

exec /docker-entrypoint.sh "$@"
