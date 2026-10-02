#!/bin/zsh
# Saves the Channel3 API key in a private file (mode 600). Typed hidden: never on screen or in history.
set -e
dir="$HOME/Library/Application Support/StudioPilot/secrets"
file="$dir/channel3.json"
mkdir -p "$dir" && chmod 700 "$dir"
print -n "Channel3 API key (hidden): "; read -rs key; print
[[ -z "$key" ]] && { print "Nothing saved."; exit 1; }
umask 077
KEY="$key" python3 -c 'import json,os; print(json.dumps({"api_key": os.environ["KEY"]}))' > "$file"
chmod 600 "$file"
print "Saved to $file (private). Restart Mandat to use Channel3."
