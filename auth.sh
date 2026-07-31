#!/usr/bin/env bash
#
# claude-openrouter.sh
# Point Claude Code at OpenRouter using the key stored in ./.env
#
#   USAGE:   source ./claude-openrouter.sh
#
# It MUST be sourced. Running it as ./claude-openrouter.sh starts a child
# shell, exports the variables there, and then throws that shell away --
# your terminal is left exactly as unconfigured as before. This is the
# single most common reason "the script ran fine but nothing changed".
#
# What it does:
#   1. Reads the OpenRouter key out of .env WITHOUT executing the file
#   2. Verifies the key against OpenRouter before changing anything
#   3. Exports ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY
#   4. Never prints the key
#
# Override the env file:   ENV_FILE=../secrets.env source ./claude-openrouter.sh

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# OpenRouter's Anthropic-Messages-compatible endpoint ("Anthropic Skin").
# NOTE: no /v1 -- Claude Code appends /v1/messages itself. Using
# https://openrouter.ai/api/v1 here is the classic failure and yields 404s
# or malformed responses rather than a clean error.
_OR_BASE_URL="https://openrouter.ai/api"

_OR_ENV_FILE="${ENV_FILE:-.env}"

# Variable names to look for in .env, in priority order.
_OR_CANDIDATES="OPENROUTER_API_KEY OPENROUTER_KEY OPEN_ROUTER_API_KEY OR_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY"

# ---------------------------------------------------------------------------
# Guard: must be sourced
# ---------------------------------------------------------------------------

# Deliberately no `set -e` / `set -u` anywhere in this script: those options
# would be inherited by your interactive shell and make it exit on any
# subsequent non-zero command.

if ! (return 0 2>/dev/null); then
    printf '\033[31mThis script must be sourced, not executed.\033[0m\n' >&2
    printf 'Run:  source %s\n' "${BASH_SOURCE[0]:-./claude-openrouter.sh}" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_or_ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
_or_warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; }
_or_err()  { printf '  \033[31mfail\033[0m  %s\n' "$1" >&2; }

# Extract KEY=value from the env file by parsing, not sourcing. A .env is
# shell-syntax-adjacent but arbitrary; `source`-ing one runs whatever is in
# it, which is a bad habit even when you trust today's copy of the file.
_or_read_var() {
    local _name="$1" _val
    _val="$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?${_name}[[:space:]]*=[[:space:]]*(.*)$/\2/p" \
            "$_OR_ENV_FILE" 2>/dev/null | tail -n 1)"
    _val="${_val%$'\r'}"                       # CRLF line endings
    _val="${_val%"${_val##*[![:space:]]}"}"    # trailing whitespace
    case "$_val" in                            # surrounding quotes
        \"*\") _val="${_val#\"}"; _val="${_val%\"}" ;;
        \'*\') _val="${_val#\'}"; _val="${_val%\'}" ;;
    esac
    printf '%s' "$_val"
}

_or_cleanup() {
    unset _OR_BASE_URL _OR_ENV_FILE _OR_CANDIDATES _OR_KEY _OR_SRC _OR_NAME
    unset _OR_HTTP _OR_BODY _OR_TMP
    unset -f _or_ok _or_warn _or_err _or_read_var _or_cleanup 2>/dev/null
}

printf '\nConfiguring Claude Code -> OpenRouter\n\n'

# ---------------------------------------------------------------------------
# 1. Locate the env file
# ---------------------------------------------------------------------------

if [ ! -f "$_OR_ENV_FILE" ]; then
    _or_err "no '$_OR_ENV_FILE' found in $(pwd)"
    printf '\n        Pass a different path:  ENV_FILE=path/to/.env source %s\n\n' \
        "${BASH_SOURCE[0]:-./claude-openrouter.sh}"
    _or_cleanup
    return 1
fi
_or_ok "found $_OR_ENV_FILE"

# ---------------------------------------------------------------------------
# 2. Find the key
# ---------------------------------------------------------------------------

_OR_KEY=""
_OR_SRC=""
for _OR_NAME in $_OR_CANDIDATES; do
    _OR_KEY="$(_or_read_var "$_OR_NAME")"
    if [ -n "$_OR_KEY" ]; then
        _OR_SRC="$_OR_NAME"
        break
    fi
done

# Fallback: any sk-or-* token anywhere in the file, whatever it is named.
if [ -z "$_OR_KEY" ]; then
    _OR_KEY="$(grep -oE 'sk-or-[A-Za-z0-9._-]+' "$_OR_ENV_FILE" 2>/dev/null | tail -n 1)"
    [ -n "$_OR_KEY" ] && _OR_SRC="pattern match"
fi

if [ -z "$_OR_KEY" ]; then
    _or_err "no OpenRouter key found in $_OR_ENV_FILE"
    printf '\n        Looked for: %s\n' "$_OR_CANDIDATES"
    printf '        ...and for any value matching sk-or-*\n'
    printf '        Variable names present in the file:\n'
    grep -oE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' \
        "$_OR_ENV_FILE" 2>/dev/null | tr -d ' =' | sed 's/^export//' | sed 's/^/          /'
    printf '\n'
    _or_cleanup
    return 1
fi

_or_ok "key from '$_OR_SRC' (${#_OR_KEY} chars, ${_OR_KEY:0:7}...)"

case "$_OR_KEY" in
    sk-or-*) ;;
    *) _or_warn "key does not start with 'sk-or-' -- is this really an OpenRouter key?" ;;
esac

# ---------------------------------------------------------------------------
# 3. Verify the key BEFORE exporting anything
# ---------------------------------------------------------------------------

if command -v curl >/dev/null 2>&1; then
    _OR_TMP="$(mktemp 2>/dev/null || printf '/tmp/or.%s' "$$")"
    _OR_HTTP="$(curl -sS -m 20 -o "$_OR_TMP" -w '%{http_code}' \
        -H "Authorization: Bearer ${_OR_KEY}" \
        "https://openrouter.ai/api/v1/auth/key" 2>/dev/null)"
    _OR_BODY="$(cat "$_OR_TMP" 2>/dev/null)"
    rm -f "$_OR_TMP"

    case "$_OR_HTTP" in
        200)
            _or_ok "key accepted by OpenRouter"
            ;;
        401|403)
            _or_err "OpenRouter rejected the key (HTTP $_OR_HTTP)"
            printf '        %s\n' "$_OR_BODY"
            printf '\n        The key in %s is invalid, revoked, or from another provider.\n' "$_OR_ENV_FILE"
            printf '        Generate a new one at https://openrouter.ai/keys\n'
            printf '        Nothing was exported.\n\n'
            _or_cleanup
            return 1
            ;;
        000|"")
            _or_warn "could not reach OpenRouter (network/proxy?) -- exporting anyway"
            ;;
        *)
            _or_warn "unexpected HTTP $_OR_HTTP from OpenRouter -- exporting anyway"
            ;;
    esac
else
    _or_warn "curl not found -- skipping key verification"
fi

# ---------------------------------------------------------------------------
# 4. Export
# ---------------------------------------------------------------------------

# ANTHROPIC_AUTH_TOKEN  -> sent as  Authorization: Bearer <key>   (what OpenRouter reads)
# ANTHROPIC_API_KEY     -> sent as  x-api-key: <key>              (what Anthropic reads)
#
# Putting the OpenRouter key in ANTHROPIC_API_KEY is what produced the
# original "401 User not found": the credential arrived in a header
# OpenRouter never inspects, so it saw an anonymous request.
#
# Blanking rather than unsetting ANTHROPIC_API_KEY is what OpenRouter's own
# guide specifies; it stops a key from a shell profile reasserting itself.

export ANTHROPIC_BASE_URL="$_OR_BASE_URL"
export ANTHROPIC_AUTH_TOKEN="$_OR_KEY"
export ANTHROPIC_API_KEY=""

_or_ok "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
_or_ok "ANTHROPIC_AUTH_TOKEN set (Authorization: Bearer)"
_or_ok "ANTHROPIC_API_KEY blanked"

# Optional: pin models to OpenRouter slugs. Left commented because the
# default Anthropic model names route fine through the Anthropic Skin, and
# OpenRouter only guarantees Claude Code against Anthropic first-party
# models -- pointing these at open models often breaks the tool-use loop
# that Claude Code's agent depends on.
#
# export ANTHROPIC_MODEL="anthropic/claude-sonnet-4.6"
# export ANTHROPIC_SMALL_FAST_MODEL="anthropic/claude-haiku-4.5"

# ---------------------------------------------------------------------------
# 5. What's left to check
# ---------------------------------------------------------------------------

printf '\nDone. Start Claude Code from THIS shell:  claude\n'
printf '\nThen verify with /status -- you want to see:\n'
printf '    Auth token:         ANTHROPIC_AUTH_TOKEN\n'
printf '    Anthropic base URL: %s\n' "$_OR_BASE_URL"
printf '\nStill seeing a subscription login in /status? Run /logout inside\n'
printf 'Claude Code. A saved login sends its own Authorization: Bearer header\n'
printf 'and wins over these variables -- OpenRouter then receives an Anthropic\n'
printf 'OAuth token and answers with exactly the "User not found" you started with.\n'
printf '\nRequests should appear in https://openrouter.ai/activity within seconds.\n'
printf 'If you later hit "Extra inputs are not permitted", the gateway stripped\n'
printf 'the anthropic-beta header: export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1\n\n'

if [ -d .git ] && ! grep -qs '^\.env$' .gitignore 2>/dev/null; then
    _or_warn "$_OR_ENV_FILE is not in .gitignore -- add it before committing"
    printf '\n'
fi

_or_cleanup
