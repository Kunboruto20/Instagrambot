#!/data/data/com.termux/files/usr/bin/bash

# Actualizare pachete
pkg update -y
pkg upgrade -y

# Instalare dependențe necesare
pkg install -y nodejs git

# Clonare repository
git clone https://github.com/Kunboruto20/Instagrambot.git
cd Instagrambot

# Instalare pachete Node.js
npm init -y
npm install instagram-private-api readline-sync

npm install chalk
# Pornire automată a botului
npm start
