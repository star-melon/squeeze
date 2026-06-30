#!/bin/bash
# Squeeze · 双击运行（首次会自动装依赖，无需打包）
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。请先安装：https://nodejs.org  或  brew install node"
  echo "按回车关闭。"; read -r; exit 1
fi
if [ ! -d node_modules ]; then
  echo "首次运行：安装依赖中（会下载 Mac 版 ffmpeg/cwebp）…"
  npm install || { echo "npm install 失败。按回车关闭。"; read -r; exit 1; }
fi
echo "启动 Squeeze…"
npm start
