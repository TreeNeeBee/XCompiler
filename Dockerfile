# syntax=docker/dockerfile:1.6
# ---------------------------------------------------------------------------
# XCompiler — multi-stage image
#   stage 1 (build):  install dev deps, compile TS -> dist/
#   stage 2 (runtime): node24-slim + python3/venv/git，仅装 production deps，体积更小。
#                      容器内强制 sandbox=subprocess（运行时检测到容器即拒绝 docker 沙盒）。
# ---------------------------------------------------------------------------

# -------- Stage 1: build ----------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# -------- Stage 2: runtime --------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# Python（subprocess 沙盒 / Architect 装包用）+ git（snapshot/revert）
# tini 用作 PID 1，正确转发信号、回收 zombies
# 注意：容器部署不支持 sandbox=docker，故不安装 docker CLI
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        python3 python3-venv python3-pip git tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 创建非 root 账号
RUN useradd -m -u 1000 -s /bin/bash xcompiler
WORKDIR /home/xcompiler/app

# 仅复制运行时必需文件
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY config.example.yaml .env.example README.md ./

# 软链 xcompiler 命令到 /usr/local/bin，便于直接调用
RUN ln -sf /home/xcompiler/app/dist/cli/xcompiler.js       /usr/local/bin/xcompiler       && chmod +x /home/xcompiler/app/dist/cli/xcompiler.js \
 && ln -sf /home/xcompiler/app/dist/cli/xcompiler_build.js /usr/local/bin/xcompiler_build && chmod +x /home/xcompiler/app/dist/cli/xcompiler_build.js \
 && ln -sf /home/xcompiler/app/dist/cli/xcompiler_run.js   /usr/local/bin/xcompiler_run   && chmod +x /home/xcompiler/app/dist/cli/xcompiler_run.js

# 工作区挂载点：宿主 ./workspace -> /workspace
RUN mkdir -p /workspace && chown -R xcompiler:xcompiler /workspace /home/xcompiler
VOLUME ["/workspace"]

USER xcompiler
ENV NODE_ENV=production \
    XC_DEFAULT_BASE_DIR=/workspace \
    XC_IN_CONTAINER=1

ENTRYPOINT ["/usr/bin/tini", "--", "xcompiler"]
CMD ["--help"]
