#!/data/data/com.termux/files/usr/bin/bash

# Actualizare pachete
pkg update -y
pkg upgrade -y

# Instalare dependențe necesare
pkg install -y nodejs git


# Instalare pachete Node.js
npm init -y
npm install nodejs-insta-private-api readline-sync

npm install chalk npm uninstall chalk
npm install chalk@4
# Pornire automată a botului
npm start
