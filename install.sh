pkg update -y && pkg upgrade -y
pkg install -y nodejs git
npm install instagram-private-api
npm install --production
node index.cjs
