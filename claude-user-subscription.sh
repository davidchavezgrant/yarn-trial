#!/usr/bin/env bash
#
# claude-use-subscription.sh
# Remove OpenRouter / gateway configuration so Claude Code uses your
# Claude subscription login again.
#
#   USAGE:   source ./claude-use-subscription.sh --dry-run
#            source ./claude-use-subscription.sh
#
# Works under both zsh and bash. Must be sourced -- `unset` only affects
# the shell that runs it.
#
# Portability notes, since the previous version broke on zsh:
#   - no ${!var} indirection (bash-only); uses eval instead
#   - no `for x in $LIST`; zsh does not word-split unquoted expansions,
#     so every loop below iterates over literal words
#   - no ${BASH_SOURCE[0]}; not defined in zsh
#
# Nothing is deleted outright: modified files are backed up alongside
# themselves, so a key that lives only in settings.json survives.

# No `set -e` / `set -u`: this is sourced into your interactive shell.

_CS_STAMP="$(date +%Y%m%d-%H%M%S)"
_CS_DRY=0
[ "${1:-}" = "--dry-run" ] && _CS_DRY=1

# ---------------------------------------------------------------------------
# Guard: must be sourced (shell-agnostic detection)
# ---------------------------------------------------------------------------

_CS_SOURCED=0
_CS_SELF="./claude-use-subscription.sh"
if [ -n "${ZSH_VERSION:-}" ]; then
    case "${ZSH_EVAL_CONTEXT:-}" in *:file*) _CS_SOURCED=1 ;; esac
elif [ -n "${BASH_VERSION:-}" ]; then
    [ "${BASH_SOURCE[0]}" != "$0" ] && _CS_SOURCED=1
    _CS_SELF="${BASH_SOURCE[0]}"
fi

if [ "$_CS_SOURCED" != "1" ]; then
    printf '\033[31mThis script must be sourced, not executed.\033[0m\n' >&2
    printf 'Run:  source %s\n' "$_CS_SELF" >&2
    return 1 2>/dev/null || exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_cs_ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
_cs_warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; }
_cs_info() { printf '        %s\n' "$1"; }

# Portable "is this variable set?" -- works in zsh and bash alike.
_cs_is_set() { eval "[ -n \"\${$1+x}\" ]"; }

# Redact any OpenRouter key before it reaches the terminal.
_cs_redact() { sed -E 's/(sk-or-[A-Za-z0-9]{6})[A-Za-z0-9._-]+/\1.../'; }

_cs_cleanup() {
    unset _CS_STAMP _CS_DRY _CS_SOURCED _CS_SELF _CS_V _CS_F _CS_HITS _CS_FOUND
    unset -f _cs_ok _cs_warn _cs_info _cs_is_set _cs_redact _cs_cleanup 2>/dev/null
}

printf '\nRestoring Claude Code subscription auth\n'
[ "$_CS_DRY" = "1" ] && printf '\033[33m(dry run -- nothing will be changed)\033[0m\n'
printf '\n'

# ---------------------------------------------------------------------------
# 1. Current shell
# ---------------------------------------------------------------------------

printf 'Shell environment\n'
_CS_FOUND=0

# Literal list: splits correctly in both shells.
for _CS_V in \
    ANTHROPIC_BASE_URL \
    ANTHROPIC_AUTH_TOKEN \
    ANTHROPIC_API_KEY \
    ANTHROPIC_CUSTOM_HEADERS \
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
do
    if _cs_is_set "$_CS_V"; then
        _CS_FOUND=1
        if [ "$_CS_DRY" = "1" ]; then
            _cs_info "would unset $_CS_V"
        else
            unset "$_CS_V"
            _cs_ok "unset $_CS_V"
        fi
    fi
done

# Model overrides: only clear gateway-style slugs (containing "/").
# A plain "sonnet" or "opus" is a valid subscription setting.
for _CS_V in \
    ANTHROPIC_MODEL \
    ANTHROPIC_SMALL_FAST_MODEL \
    ANTHROPIC_DEFAULT_SONNET_MODEL \
    ANTHROPIC_DEFAULT_OPUS_MODEL \
    ANTHROPIC_DEFAULT_HAIKU_MODEL
do
    if _cs_is_set "$_CS_V"; then
        eval "_CS_HITS=\"\$$_CS_V\""
        case "$_CS_HITS" in
            */*)
                _CS_FOUND=1
                if [ "$_CS_DRY" = "1" ]; then
                    _cs_info "would unset $_CS_V (=$_CS_HITS)"
                else
                    unset "$_CS_V"
                    _cs_ok "unset $_CS_V (was $_CS_HITS)"
                fi
                ;;
            *)
                _cs_info "keeping $_CS_V=$_CS_HITS (not a gateway slug)"
                ;;
        esac
    fi
done

[ "$_CS_FOUND" = "0" ] && _cs_ok "nothing to clear in this shell"

# ---------------------------------------------------------------------------
# 2. Settings files
# ---------------------------------------------------------------------------

printf '\nSettings files\n'

if ! command -v python3 >/dev/null 2>&1; then
    _cs_warn "python3 not found -- remove these keys by hand from the 'env' block:"
    _cs_info "ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY"
    for _CS_F in \
        "$HOME/.claude/settings.json" \
        "$HOME/.claude/settings.local.json" \
        ".claude/settings.json" \
        ".claude/settings.local.json"
    do
        [ -f "$_CS_F" ] && grep -qs ANTHROPIC "$_CS_F" && _cs_info "$_CS_F"
    done
else
    for _CS_F in \
        "$HOME/.claude/settings.json" \
        "$HOME/.claude/settings.local.json" \
        ".claude/settings.json" \
        ".claude/settings.local.json"
    do
        [ -f "$_CS_F" ] || continue
        grep -qs 'ANTHROPIC\|CLAUDE_CODE_ENABLE_GATEWAY' "$_CS_F" || continue

        if [ "$_CS_DRY" = "1" ]; then
            _cs_info "would clean $_CS_F"
            grep -n 'ANTHROPIC\|CLAUDE_CODE_ENABLE_GATEWAY' "$_CS_F" \
                | _cs_redact | sed 's/^/          /'
            continue
        fi

        cp "$_CS_F" "${_CS_F}.bak-${_CS_STAMP}" 2>/dev/null

        SETTINGS_PATH="$_CS_F" python3 - <<'PYEOF'
import json, os, sys

path = os.environ["SETTINGS_PATH"]
DROP = {
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
}
MODELS = {
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
}

try:
    with open(path) as fh:
        data = json.load(fh)
except Exception as exc:
    print(f"  \033[33mwarn\033[0m  {path}: could not parse ({exc}) -- left alone")
    sys.exit(0)

env = data.get("env")
if not isinstance(env, dict):
    print(f"  \033[32mok\033[0m    {path}: no env block")
    sys.exit(0)

removed = []
for name in list(env):
    if name in DROP:
        removed.append(name)
        del env[name]
    elif name in MODELS and "/" in str(env[name]):
        removed.append(name)
        del env[name]

if not env:
    del data["env"]

if removed:
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    print(f"  \033[32mok\033[0m    {path}: removed {', '.join(removed)}")
else:
    print(f"  \033[32mok\033[0m    {path}: nothing to remove")
PYEOF

        _cs_info "backup: ${_CS_F}.bak-${_CS_STAMP}"
    done
fi

# ---------------------------------------------------------------------------
# 3. Report only -- profiles, direnv, wrappers
# ---------------------------------------------------------------------------

printf '\nOther sources (reported, not modified)\n'
_CS_FOUND=0

for _CS_F in \
    "$HOME/.zshrc" \
    "$HOME/.zprofile" \
    "$HOME/.zshenv" \
    "$HOME/.bashrc" \
    "$HOME/.bash_profile" \
    "$HOME/.profile" \
    "$HOME/.config/fish/config.fish" \
    ".envrc" \
    ".env"
do
    [ -f "$_CS_F" ] || continue
    _CS_HITS="$(grep -n 'ANTHROPIC_BASE_URL\|ANTHROPIC_AUTH_TOKEN\|ANTHROPIC_API_KEY\|openrouter' \
                "$_CS_F" 2>/dev/null | _cs_redact)"
    if [ -n "$_CS_HITS" ]; then
        _CS_FOUND=1
        _cs_warn "$_CS_F"
        printf '%s\n' "$_CS_HITS" | sed 's/^/          /'
    fi
done

# A function or alias named `claude` can export the variables itself just
# before exec'ing the real binary -- invisible to `echo $VAR`.
case "$(type claude 2>/dev/null)" in
    *function*|*alias*)
        _CS_FOUND=1
        _cs_warn "'claude' is a shell function or alias, not the plain binary:"
        type claude 2>/dev/null | sed 's/^/          /'
        ;;
esac

[ "$_CS_FOUND" = "0" ] && _cs_ok "no profile, direnv or wrapper references found"

# ---------------------------------------------------------------------------
# 4. Next steps
# ---------------------------------------------------------------------------

printf '\n'
if [ "$_CS_DRY" = "1" ]; then
    printf 'Dry run complete. Re-run without --dry-run to apply.\n\n'
    _cs_cleanup
    return 0
fi

printf 'Next:\n'
printf '  1. Comment out anything flagged above, then open a new terminal\n'
printf '  2. Start Claude Code:  claude\n'
printf '  3. Run /login and pick your subscription\n'
printf '  4. Run /status to confirm\n'
printf '\n/status should show your account, no API key row, no custom base URL.\n'
printf 'If a gateway URL survives, it is coming from something in section 3.\n'
printf '\nSettings load at startup, so restart rather than editing in place.\n'
printf 'The old OpenRouter key is preserved in the .bak-%s files.\n\n' "$_CS_STAMP"

_cs_cleanup
