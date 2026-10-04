#!/bin/zsh
# Copies each secret, one at a time, to the clipboard so you can paste it into the Render dashboard.
# Nothing is printed on screen; the clipboard is cleared at the end.
set -e
dir="$HOME/Library/Application Support/StudioPilot/secrets"
read_key() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]], end="")' "$1" "$2"; }

# Usage: copy-keys-for-render.sh [r2|channel3|nebius]   (r2: only the three R2 values; channel3: only the Channel3 key)
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
# nebius: the Nebius version (mandat-nebius) — the agent's key is the Token Factory key, plus a fresh network secret.
if [[ "$1" == "nebius" ]]; then
  steps=("DEEPSEEK_API_KEY|$dir/nebius-tokenfactory.json|api_key" ${steps:#DEEPSEEK_API_KEY*})
  openssl rand -hex 24 | tr -d '\n' > "$TMPDIR/mandat-net"; chmod 600 "$TMPDIR/mandat-net"
  python3 -c 'import json,sys; print(json.dumps({"v": open(sys.argv[1]).read()}))' "$TMPDIR/mandat-net" > "$TMPDIR/mandat-net.json"; rm -f "$TMPDIR/mandat-net"
  steps+=("MANDAT_NETWORK_SECRET|$TMPDIR/mandat-net.json|v")
fi
[[ "$1" == "r2" ]] && steps=(${(M)steps:#R2_*})
[[ "$1" == "channel3" ]] && steps=(${(M)steps:#CHANNEL3_*})
for s in $steps; do
  name=${s%%|*}; rest=${s#*|}; file=${rest%%|*}; field=${rest#*|}
  read_key "$file" "$field" | pbcopy
  print "Copied: $name  →  in Render, select the value A_COLLER/A_GENERER of $name, paste (Cmd+V), then press Enter here."
  read -r _
done
print -n "" | pbcopy
rm -f "$TMPDIR/mandat-net.json"
print "Done. Clipboard cleared."
