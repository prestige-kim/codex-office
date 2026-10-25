#!/bin/zsh
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 이상을 설치한 뒤 다시 실행해 주세요."
  read -r "?Enter를 누르면 닫힙니다."
  exit 1
fi
echo "브라우저에서 http://localhost:4777 을 열어 주세요."
node server.js
