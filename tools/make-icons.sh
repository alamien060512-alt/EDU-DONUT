#!/usr/bin/env bash
# Makes the item pictures the website shows next to item names, with RenderChest
# (https://github.com/aternosorg/renderchest). It downloads the Minecraft client from Mojang, renders every item
# and copies the pictures into data/icons (the bot serves them from there).
#
#   tools/make-icons.sh                 latest release, 64px icons into data/icons
#   MC_VERSION=1.21.4 tools/make-icons.sh
#   ICON_SIZE=96 tools/make-icons.sh
#
# Needs: PHP 8.1+ with the imagick extension, composer, git, curl, unzip, node. On Windows run it inside WSL.
# The pictures are Mojang's artwork: keep them for your own use, don't commit or share them (data/ is git-ignored).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/data/icons}"
WORK="${WORK_DIR:-$ROOT/data/icons-work}"
SIZE="${ICON_SIZE:-64}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing '$1'. $2" >&2; exit 1; }; }
need php "Install PHP 8.1 or newer."
need composer "Install composer: https://getcomposer.org/download/"
need git "Install git."
need curl "Install curl."
need unzip "Install unzip."
need node "Install Node.js."
php -r 'exit(class_exists("Imagick") ? 0 : 1);' || { echo "PHP needs the imagick extension (Ubuntu/WSL: sudo apt install php-imagick)." >&2; exit 1; }

mkdir -p "$WORK" && cd "$WORK"
[ -d renderchest ] || git clone --depth 1 https://github.com/aternosorg/renderchest renderchest
(cd renderchest && composer install --no-interaction --quiet)

echo "Finding the Minecraft client..."
curl -fsS https://piston-meta.mojang.com/mc/game/version_manifest_v2.json -o manifest.json
VERSION="${MC_VERSION:-$(node -p "require('./manifest.json').latest.release")}"
VURL="$(node -p "(require('./manifest.json').versions.find(v => v.id === '$VERSION') || {}).url || ''")"
[ -n "$VURL" ] || { echo "Minecraft version '$VERSION' not found." >&2; exit 1; }
curl -fsS "$VURL" -o version.json
JAR="$(node -p "require('./version.json').downloads.client.url")"
echo "Downloading Minecraft $VERSION client..."
[ -f "client-$VERSION.jar" ] || curl -fSL "$JAR" -o "client-$VERSION.jar"
rm -rf jar && mkdir jar && unzip -q -o "client-$VERSION.jar" 'assets/*' -d jar

echo "Rendering icons (about a minute)..."
rm -rf out
php renderchest/renderchest --assets jar/assets --output out --namespace minecraft --size "$SIZE" --format webp >/dev/null

mkdir -p "$OUT"
cp out/items/minecraft/*.webp "$OUT/"
echo "Done: $(ls "$OUT"/*.webp | wc -l) icons in $OUT (Minecraft $VERSION)"
