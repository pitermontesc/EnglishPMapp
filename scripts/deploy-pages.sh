#!/bin/sh
# Builds the web app and publishes dist/ to the gh-pages branch of this repo's origin.
# GitHub Pages serves that branch at https://<user>.github.io/<repo>/.
# The gh-pages branch only ever holds the latest build, so it is replaced on each run.
set -e
cd "$(dirname "$0")/.."
ORIGIN="$(git remote get-url origin)"
SOURCE="$(git rev-parse --short HEAD)"

npm run build
touch dist/.nojekyll   # serve files as-is, without Jekyll processing

cd dist
rm -rf .git
git init -q -b gh-pages
git add -A
git commit -q -m "Deploy web app from $SOURCE"
git push -q -f "$ORIGIN" gh-pages
rm -rf .git
echo "Published to the gh-pages branch of $ORIGIN"
