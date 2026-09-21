#!/bin/sh
# 容器启动入口：完成依赖准备与初始化后启动服务
set -e

echo "[fold-proofing] 初始化运行环境..."

# 数据目录（方案 JSON 持久化）
mkdir -p "${DATA_DIR:-/app/data}"

# 依赖自检：缺 node_modules 时自动安装
if [ ! -d /app/node_modules ]; then
  echo "[fold-proofing] 未检测到 node_modules，执行 npm install ..."
  npm install --omit=dev --no-audit --no-fund
fi

# 引擎自检（确保折叠逻辑模块可加载）
node -e "require('./public/foldEngine.js'); console.log('[fold-proofing] 折叠引擎自检通过');"

echo "[fold-proofing] 启动 Web 服务，端口 ${PORT:-3000} ..."
exec node server.js
