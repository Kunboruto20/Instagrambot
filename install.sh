#!/data/data/com.termux/files/usr/bin/bash
echo "=== Instalare Instagram Bot Boruto ==="
pkg update -y && pkg upgrade -y
pkg install -y nodejs git
npm install instagram-private-api readline
npm install --production
node index.cjs
