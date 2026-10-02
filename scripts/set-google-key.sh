#!/bin/zsh
# Saves the Google Places API key in a private file (mode 600). Typed hidden: never on screen or in history.
set -e
dir="$HOME/Library/Application Support/StudioPilot/secrets"
file="$dir/google-places.json"
mkdir -p "$dir" && chmod 700 "$dir"
print -n "Google Places API key (hidden): "; read -rs key; print
[[ -z "$key" ]] && { print "Nothing saved."; exit 1; }
umask 077
KEY="$key" python3 -c 'import json,os; print(json.dumps({"api_key": os.environ["KEY"]}))' > "$file"
chmod 600 "$file"
print "Saved to $file (private). Restart Mandat to use Google photos."
