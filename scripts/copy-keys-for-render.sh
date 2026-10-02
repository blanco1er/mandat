#!/bin/zsh
# Copies each secret, one at a time, to the clipboard so you can paste it into the Render dashboard.
# Nothing is printed on screen; the clipboard is cleared at the end.
set -e
dir="$HOME/Library/Application Support/StudioPilot/secrets"
read_key() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]], end="")' "$1" "$2"; }

# Usage: copy-keys-for-render.sh [r2|channel3]   (r2: only the three R2 values; channel3: only the Channel3 key)
steps=(
  "DEEPSEEK_API_KEY|$dir/deepseek-dialogue.json|api_key"
  "PAYPAL_CLIENT_ID|$dir/paypal-sandbox.json|client_id"
  "PAYPAL_CLIENT_SECRET|$dir/paypal-sandbox.json|client_secret"
  "GOOGLE_PLACES_KEY|$dir/google-places.json|api_key"
  "R2_ACCOUNT_ID|$dir/r2-mandat.json|account_id"
  "R2_ACCESS_KEY_ID|$dir/r2-mandat.json|access_key_id"
  "R2_SECRET_ACCESS_KEY|$dir/r2-mandat.json|secret_access_key"
  "CHANNEL3_API_KEY|$dir/channel3.json|api_key"
)
[[ "$1" == "r2" ]] && steps=(${(M)steps:#R2_*})
[[ "$1" == "channel3" ]] && steps=(${(M)steps:#CHANNEL3_*})
for s in $steps; do
  name=${s%%|*}; rest=${s#*|}; file=${rest%%|*}; field=${rest#*|}
  read_key "$file" "$field" | pbcopy
  print "Copied: $name  →  paste it into the $name field in Render (Cmd+V), then press Enter here."
  read -r _
done
print -n "" | pbcopy
print "Done. Clipboard cleared."
