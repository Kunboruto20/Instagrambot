#!/data/data/com.termux/files/usr/bin/bash

echo "-------------------------------------"
echo "  Instagram Bot Installer for Termux"
echo "  By Gyovanny - Latest Dependencies"
echo "-------------------------------------"

# Actualizare Termux
pkg update -y && pkg upgrade -y

# Dependențe OS
pkg install -y nodejs-lts git python make clang openssl-tool

# Instalare npx fix
npm install -g npm@latest

# Creare proiect
[ ! -f package.json ] && npm init -y

# Instalare pachete necesare
echo "Instalez dependințe NPM (latest)..."

npm install instagram-private-api@latest \
            instagram_mqtt@latest \
            readline-sync@latest \
            chalk@latest \
            fs-extra@latest \
            mqtt@latest \
            events@latest \
            uuid@latest \
            tslib@latest

# Optional dev tools (nu afectează scriptul, dar ajută în viitor)
npm install --save-dev typescript@latest ts-node@latest @types/node@latest

# Creare script start în package.json dacă nu există
if ! grep -q '"start"' package.json; then
  jq '.scripts.start="node index.js"' package.json > tmp.$$.json && mv tmp.$$.json package.json
fi

echo "-------------------------------------"
echo " Instalare completă!"
echo " Rulează botul cu:  node index.js"
echo " sau:              npm start"
echo "-------------------------------------"
