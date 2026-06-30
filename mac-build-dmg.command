#!/bin/bash
# Squeeze · 双击构建 macOS 安装包(.dmg) 到 dist/
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。请先安装：https://nodejs.org  或  brew install node"
  echo "按回车关闭。"; read -r; exit 1
fi
[ -d node_modules ] || npm install || { echo "npm install 失败。按回车关闭。"; read -r; exit 1; }
echo "构建 DMG 中…"
npm run build:mac || { echo "构建失败。按回车关闭。"; read -r; exit 1; }
echo "完成！DMG 在 dist/ 目录。按回车关闭。"; read -r
