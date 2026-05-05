# TOAA 部署指南（deploy）

> 适用版本：`@toaa/cli ≥ 0.1.0`
> 两种部署方式：
>
> 1. **本地（Local）**：宿主机直接装 Node 20 + Python 3，用 `npm link` 暴露 `toaa` 命令。开发与单机生产首选。
> 2. **Docker**：多阶段构建的 `toaa:latest` 镜像 + `docker compose`。适合 CI、共享服务器、网络隔离的生产环境。

---

## 0. 前置条件（两种方式通用）

| 组件 | 版本 | 用途 |
|---|---|---|
| **LLM 服务** | ollama ≥ 0.3 (`gemma4:31b` + `qwen3-coder:30b`) **或** 任一 OpenAI 兼容 endpoint | TOAA 的所有 Agent 推理 |
| **Git** | 任意现代版本 | TOAA 在 workspace 内做 snapshot/revert（每个 Step 一次提交）|
| **Python 3.11+** | （仅 `sandbox=subprocess` 必需，docker 模式可省）| 沙盒内运行 pip / pytest |

> **网络要求**：沙盒在 `pip install -r requirements.txt` 时需要可达的 PyPI 镜像。建议在 shell 注入：
> `PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple`（或阿里云、内网 mirror）。

---

## 1. 本地部署（Local）

### 1.1 安装 Node 与依赖

```bash
# Linux/macOS
curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz | sudo tar -xJ -C /opt
export PATH=/opt/node-v20.18.0-linux-x64/bin:$PATH
node -v   # v20.x

# 克隆并装包
git clone <repo-url> toaa && cd toaa
npm ci
```

### 1.2 配置

```bash
cp .env.example .env
# 编辑 .env：
#   OLLAMA_BASE_URL=http://10.80.105.160:11434
#   OPENAI_API_KEY=...（可空）

cp config.example.yaml config.yaml
# 关键字段（详见 README.md "运行期调优参数"）：
#   llm.roles.{Planner|Architect|Coder|Tester|Debugger}: provider 名
#   agent.sandbox: subprocess | docker
#   agent.max_rounds_per_step / max_debug_rounds_per_step / max_debug_retries
```

### 1.3 构建并安装为全局命令

```bash
npm run build       # tsup -> dist/
npm link            # 注册 toaa / toaa_c / toaa_run 到 $PATH

toaa --help
toaa --version
```

> **不想 `npm link`？** 直接用 `npx`：`npx -p . toaa --help`，
> 或在开发期 `npm run dev -- c -i workspace/intake.md`（tsx 直跑 TS）。

### 1.4 烟测

```bash
# 1) 单测（不依赖 LLM/网络）
npm run typecheck
npm test                           # 应 12 files / 55 tests passed

# 2) ollama 烟测（需 OLLAMA_BASE_URL 可达）
OLLAMA_BASE_URL=http://10.80.105.160:11434 npm run smoke:ollama

# 3) 端到端编排
mkdir -p /tmp/hello-demo && cat > /tmp/hello-demo/intake.md <<'EOF'
开发一个 Python 包 hello，提供 hello.greet(name) -> str；至少 3 个 pytest 用例。
EOF
toaa c -o /tmp/hello-demo -i /tmp/hello-demo/intake.md --yes
toaa run /tmp/hello-demo/plan.json
```

### 1.5 升级

```bash
cd toaa
git pull
npm ci
npm run build
# npm link 一次性建立的符号链接会自动指向新 dist/
```

### 1.6 卸载

```bash
npm unlink -g @toaa/cli
rm -rf <repo>/node_modules <repo>/dist
```

---

## 2. Docker 部署

### 2.1 镜像结构

[Dockerfile](../Dockerfile) 是两阶段：

| Stage | 基础镜像 | 用途 |
|---|---|---|
| `build` | `node:20-bookworm-slim` | `npm ci` + `npm run build` 生成 `dist/` |
| `runtime` | `node:20-bookworm-slim` + `python3 / python3-venv / git / docker.io / tini` | 仅装 production deps，运行 `toaa` |

启动时 `tini` 做 PID 1，运行用户为 `toaa (uid=1000)`，工作目录 `/workspace` 以 volume 形式暴露。

### 2.2 构建镜像

```bash
cd toaa
docker build -t toaa:latest .
# 或带版本 tag：docker build -t toaa:0.1.0 -t toaa:latest .
```

### 2.3 配置文件准备

```bash
cp .env.example .env
cp config.example.yaml config.yaml
mkdir -p workspace
```

### 2.4 用 docker compose 跑（推荐）

[docker-compose.yml](../docker-compose.yml) 已挂好：
- `./workspace -> /workspace`（编排产出）
- `./config.yaml -> /home/toaa/app/config.yaml:ro`
- `/var/run/docker.sock -> /var/run/docker.sock`（DooD：让容器内 toaa 能起 sibling 沙盒容器）

```bash
# 看帮助
docker compose run --rm toaa --help

# 编译需求 -> plan.json（写到指定输出目录）
docker compose run --rm toaa c \
  -i /workspace/intake.md \
  -c /home/toaa/app/config.yaml \
  -o /workspace/hello-demo \
  --yes

# 执行 plan
docker compose run --rm toaa run \
  /workspace/<project>/plan.json \
  -c /home/toaa/app/config.yaml
```

> **DooD 的 GID 注入**：宿主 `/var/run/docker.sock` 的属主 GID 通常是 `999` 或 `998`。
> 默认 `group_add: ["999"]`；如果不同，请：
>
> ```bash
> DOCKER_GID=$(stat -c '%g' /var/run/docker.sock) docker compose run --rm toaa ...
> ```

### 2.5 直接 `docker run`（不要 compose）

```bash
docker run --rm -it \
  --env-file .env \
  -v "$PWD/workspace:/workspace" \
  -v "$PWD/config.yaml:/home/toaa/app/config.yaml:ro" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  -w /workspace \
  toaa:latest \
  c -i /workspace/intake.md -c /home/toaa/app/config.yaml --yes
```

### 2.6 沙盒模式选择

`config.yaml -> agent.sandbox`：

| 模式 | 适用场景 | 说明 |
|---|---|---|
| `subprocess` | **容器部署唯一支持项** / 轻量本地 | 直接在 TOAA 镜像内 `python -m venv .sandbox/venv`。简单，最快。默认推荐。 |
| `docker` | **仅限宿主部署使用** | 在宿主 docker daemon 上起 sibling 容器（image 由 `agent.sandbox_docker.image` 指定）。 |

> ⚠️ **容器内不可使用 `sandbox=docker`**。TOAA 启动时会检测运行环境（`/.dockerenv` / `/proc/1/cgroup` / `TOAA_IN_CONTAINER` env），若检测到在容器内且 `agent.sandbox: docker`，将报错退出并提示改用 `subprocess`。
>
> 原因：DooD 路径错位、`docker.sock` GID 冲突、sibling 容器看不到 TOAA 容器内的 `/workspace` 路径。
>
> 如确需绕过（宿主与容器路径完全一致的可控调试场景）：`-e TOAA_IN_CONTAINER=0`。

[Dockerfile](../Dockerfile) 已预设 `ENV TOAA_IN_CONTAINER=1`。

### 2.7 内置 ollama（可选）

如要在同一 compose 中跑 ollama，编辑 [docker-compose.yml](../docker-compose.yml) 取消注释 `ollama` 服务与对应 volume，然后：

```bash
docker compose up -d ollama
docker compose exec ollama ollama pull gemma4:31b
docker compose exec ollama ollama pull qwen3-coder:30b
# 在 .env 里把 OLLAMA_BASE_URL 改成 http://ollama:11434
```

### 2.8 升级

```bash
cd toaa
git pull
docker build -t toaa:latest .
# compose run 会自动用新镜像；workspace 与 config.yaml 不会被 rebuild 影响
```

### 2.9 清理

```bash
docker compose down
docker rmi toaa:latest
# workspace/ 与 .env / config.yaml 是宿主文件，保留或手动删
```

---

## 3. 常见问题

| 现象 | 原因 | 处置 |
|---|---|---|
| `pip install` 在沙盒里 DNS 失败 | 宿主到 PyPI 不通 | 设 `PIP_INDEX_URL=<可达镜像>` 注入到 TOAA 进程环境 |
| docker 模式下沙盒容器找不到工程文件 | 用了 `./workspace` 相对路径 | 改成绝对路径或 `$(pwd)/workspace` |
| `EACCES: /var/run/docker.sock` | `toaa` 用户不在宿主 docker 组 | `DOCKER_GID=$(stat -c '%g' /var/run/docker.sock) docker compose ...` |
| 长时 LLM 调用后 `audit.jsonl` 没事件 | （已修）旧版异步 appendFile 排队丢失 | 升级到当前版本：审计已改为 `appendFileSync` |
| `Plan schema 校验失败` | LLM 返回 plan 字段类型异常 | 查看 `<workspace>/docs/.draft/plan.invalid.json` 定位字段，必要时调高 `agent.max_rounds_per_step` 或换更强模型作为 Planner |
| TEST 步骤一直被 DEBUG 重试到 max | 实现层 bug，DEBUG 也修不动 | 看 `<workspace>/.toaa/audit.jsonl` 里 `pytest stderr (tail)`；必要时手动改 SUT 后 `toaa run --from S<id>` 续跑 |

---

## 4. 目录约定

部署完成后的工作区典型结构：

```
<workspace>/
├── intake.md                # 需求输入（用户提供）
├── config.yaml              # 本次运行的配置
├── plan.json                # toaa c 产出
├── requirements.txt         # 由 pythonRequirements 在 toaa run 启动时种入
├── docs/
│   ├── requirements.md
│   ├── architecture.md
│   ├── tasks.md
│   ├── refactor.md
│   ├── delivery.md
│   ├── process_log.md       # AuditLogger 自动生成
│   ├── history/             # 同名旧文档归档
│   └── .draft/              # 失败 plan 等中间产物
├── src/                     # CODE 阶段产出
├── tests/                   # TEST 阶段产出
├── .sandbox/venv/           # subprocess 沙盒虚拟环境
└── .toaa/audit.jsonl        # 审计事件流（同步落盘）
```
