#!/bin/zsh
# Saves the Nebius Token Factory API key in a private file (mode 600). Typed hidden: never on screen or in history.
# Then: DEEPSEEK_BASE_URL=https://api.tokenfactory.nebius.com/v1 DEEPSEEK_KEY_FILE=<this file> runs Mandat on Nebius.
set -e
dir="$HOME/Library/Application Support/StudioPilot/secrets"
file="$dir/nebius-tokenfactory.json"
mkdir -p "$dir" && chmod 700 "$dir"
print -n "Nebius Token Factory API key (hidden): "; read -rs key; print
[[ -z "$key" ]] && { print "Nothing saved."; exit 1; }
umask 077
KEY="$key" python3 -c 'import json,os; print(json.dumps({"api_key": os.environ["KEY"]}))' > "$file"
chmod 600 "$file"
code=$(KEY="$key" curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" https://api.tokenfactory.nebius.com/v1/models)
print "Saved to $file (private). Nebius answered HTTP $code (200 = the key works)."
