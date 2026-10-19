#!/bin/zsh
# Jeton secret qui ouvre le journal des visites (MANDAT_VISITS_TOKEN), pour le propriétaire seulement.
#   zsh scripts/visits-token.sh            crée un jeton neuf, le range dans le trousseau macOS et le copie dans le
#                                          presse-papiers pour le coller dans Render (rien ne s'affiche à l'écran)
#   zsh scripts/visits-token.sh --saisir   saisie masquée d'un jeton existant (par ex. celui déjà posé dans Render)
#   zsh scripts/visits-token.sh --copier   recopie le jeton du trousseau dans le presse-papiers
# Le presse-papiers est vidé au bout de 60 secondes.
set -euo pipefail
SERVICE="mandat-visits-paypal"   # nom de l'entrée du trousseau pour cette démo
ACCOUNT="mandat"

store() {
  # Passé à « security » par son entrée standard : le jeton n'apparaît jamais dans la liste des processus.
  print -r -- "add-generic-password -U -s $SERVICE -a $ACCOUNT -l \"Mandat visites\" -w $1" | security -i >/dev/null
}
clip() {
  print -rn -- "$1" | pbcopy
  ( sleep 60; [[ "$(pbpaste)" == "$1" ]] && print -n "" | pbcopy ) >/dev/null 2>&1 &!
}

case "${1:-}" in
  --saisir)
    print -n "Collez le jeton (rien ne s'affiche), puis Entrée : "
    read -rs TOKEN; print
    [[ ${#TOKEN} -ge 32 ]] || { print "Jeton trop court (32 caractères au moins)."; exit 1; }
    store "$TOKEN"
    print "Jeton rangé dans le trousseau (« $SERVICE »)."
    ;;
  --copier)
    TOKEN=$(security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w 2>/dev/null) || { print "Aucun jeton dans le trousseau : lancez ce script sans option."; exit 1; }
    clip "$TOKEN"
    print "Jeton copié (presse-papiers vidé dans 60 s)."
    ;;
  "")
    if security find-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1; then
      print -n "Un jeton existe déjà dans le trousseau. Le remplacer ? Il faudra aussi le changer dans Render. [o/N] "
      read -r OK; [[ "$OK" == [oOyY]* ]] || { print "Rien n'a changé. (Pour le recopier : --copier)"; exit 0; }
    fi
    TOKEN=$(openssl rand -hex 32)
    store "$TOKEN"
    clip "$TOKEN"
    print "Jeton neuf rangé dans le trousseau (« $SERVICE ») et copié dans le presse-papiers pour 60 secondes."
    print "Collez-le maintenant dans Render, variable MANDAT_VISITS_TOKEN."
    ;;
  *) print "Options : (aucune) | --saisir | --copier"; exit 2 ;;
esac
