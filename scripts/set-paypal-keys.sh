#!/bin/zsh
# Saves the PayPal SANDBOX keys in a private file (mode 600) that only this Mac user can read.
# The secret is typed hidden: it never appears on screen, in the shell history, or in the project.
set -e
dir="$HOME/Library/Application Support/StudioPilot/secrets"
file="$dir/paypal-sandbox.json"
mkdir -p "$dir" && chmod 700 "$dir"
print -n "PayPal sandbox Client ID: "; read -r cid
print -n "PayPal sandbox Secret (hidden): "; read -rs sec; print
[[ -z "$cid" || -z "$sec" ]] && { print "Nothing saved: both values are needed."; exit 1; }
umask 077
CID="$cid" SEC="$sec" python3 -c 'import json,os; print(json.dumps({"client_id": os.environ["CID"], "client_secret": os.environ["SEC"]}))' > "$file"
chmod 600 "$file"
print "Saved to $file (private). Restart Mandat to use the sandbox."
