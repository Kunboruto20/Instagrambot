#!/data/data/com.termux/files/usr/bin/bash

# Actualizare pachete
pkg update -y
pkg upgrade -y

# Instalare dependențe necesare
pkg install -y nodejs git

# Clonare repository
git clone https://github.com/gyovannyvpn123/Instagrambot.git
cd Instagrambot

# Instalare pachete Node.js
npm install

# Pornire automată a botului
npm start
