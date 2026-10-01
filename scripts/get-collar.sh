#!/bin/sh
# Nova Collar, one step:
#   curl -fsSL https://raw.githubusercontent.com/Squidspork/nova-collar/main/scripts/get-collar.sh | sh
set -eu
dest="${NOVA_COLLAR_HOME:-$HOME/NovaCollar}"
repo="https://github.com/Squidspork/nova-collar.git"
if [ -d "$dest/.git" ]; then
  git -C "$dest" pull --ff-only
else
  git clone "$repo" "$dest"
fi
cd "$dest"
if [ ! -d node_modules/electron ]; then
  npm install
fi
node --input-type=module -e "import { linkNp } from './src/main/install.js'; const linked = linkNp(); process.stdout.write((linked.note || ('nova-collar is ' + linked.path)) + '\n');"
echo "Nova Collar is in $dest"
echo "Choose your own model in a terminal: nova-collar install"
echo "Update the program later: nova-collar update"
echo "Optional decider, about 1 GB: nova-collar update laya"
