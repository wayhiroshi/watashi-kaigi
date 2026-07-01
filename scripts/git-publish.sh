#!/usr/bin/env sh
set -eu

commit_message="${1:-}"

if [ -z "$commit_message" ]; then
  echo "使い方: npm run git:publish -- \"コミットメッセージ\"" >&2
  exit 64
fi

npm run verify

if [ -z "$(git status --porcelain)" ]; then
  echo "コミットする変更はありません。"
  exit 0
fi

git add -A
git commit -m "$commit_message"
git push
