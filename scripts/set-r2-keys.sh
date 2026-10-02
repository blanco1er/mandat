#!/bin/zsh
# Saves the Cloudflare R2 keys for Mandat's durable data in a private file (mode 600).
# The Access Key ID and the Secret are typed hidden: never on screen or in history.
set -e
dir="$HOME/Library/Application Support/StudioPilot/secrets"
file="$dir/r2-mandat.json"
mkdir -p "$dir" && chmod 700 "$dir"
print -n "Cloudflare Account ID (shown on the R2 page): "; read -r account; print
print -n "R2 Access Key ID (hidden): "; read -rs id; print
print -n "R2 Secret Access Key (hidden): "; read -rs secret; print
[[ -z "$account" || -z "$id" || -z "$secret" ]] && { print "Nothing saved: a value is missing."; exit 1; }
umask 077
A="$account" I="$id" S="$secret" python3 -c 'import json,os; print(json.dumps({"account_id": os.environ["A"].strip(), "access_key_id": os.environ["I"].strip(), "secret_access_key": os.environ["S"].strip(), "bucket": "mandat-data"}))' > "$file"
chmod 600 "$file"
print "Saved to $file (private)."
