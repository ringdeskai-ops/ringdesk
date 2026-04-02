#!/bin/bash
# Usage: ./bump-version.sh patch|minor|major "Description of changes"

TYPE=${1:-patch}
DESC=${2:-"Version bump"}
CURRENT=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case $TYPE in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac

NEW="$MAJOR.$MINOR.$PATCH"
DATE=$(date +%Y-%m-%d)

echo "Bumping $CURRENT → $NEW ($TYPE)"

# Update package.json
sed -i "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" package.json

# Update app.js
sed -i "s/const APP_VERSION = '$CURRENT'/const APP_VERSION = '$NEW'/" app.js

# Add changelog entry
ENTRY="## [$NEW] - $DATE\n\n### Changes\n- $DESC\n\n---\n"
sed -i "s/# AiRingDesk Changelog/# AiRingDesk Changelog\n\n$ENTRY/" CHANGELOG.md

# Commit and tag
node --check app.js && \
git add app.js package.json package-lock.json CHANGELOG.md && \
git commit -m "v$NEW - $DESC" && \
git tag "v$NEW" && \
git push origin master && \
git push origin "v$NEW" && \
pm2 restart airingdesk --update-env

echo "✅ Version bumped to $NEW and pushed"
