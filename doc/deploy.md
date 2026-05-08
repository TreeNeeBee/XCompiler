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

## 1.7 单文件可执行程序（无 Node 依赖）

> 适合分发到**没有 Node 环境**的目标机器。打出来的可执行程序内嵌了 Node 20 + 全部 JS 依赖，
> 终端用户只需要把单文件 `toaa` / `toaa.exe` 解压后直接运行即可。
>
> ⚠️ **注意**：单文件可执行程序仍然需要目标机器自带 **Python 3.11+ / git** —— 它们用于沙盒（pip / pytest）和 snapshot/revert。这是 TOAA 自身的运行期依赖，不在打包范围内。

### 1.7.1 一次性打全部目标

```bash
# 三目标全打：linux-x64 / linux-arm64 / win-x64
npm run package
```

产物布局：

```
dist/pkg/
├── toaa-linux-x64/
│   ├── toaa                      # ELF 64-bit, x86_64
│   ├── README.md  LICENSE  NOTICE
│   ├── config.example.yaml  .env.example
├── toaa-linux-x64.tar.gz         # 打包发布用
├── toaa-linux-arm64/
│   ├── toaa                      # ELF 64-bit, aarch64
│   └── ...（同上）
├── toaa-linux-arm64.tar.gz
├── toaa-macos-arm64/
│   ├── toaa                      # Mach-O 64-bit, arm64（已 ad-hoc 签名）
│   └── ...
├── toaa-macos-arm64.tar.gz
├── toaa-win-x64/
│   ├── toaa.exe                  # PE32+, x86_64 — ⚠️ v0.1.0 未在 Windows 实机验证
│   └── ...
└── toaa-win-x64.zip              # 需要本机有 zip 命令；否则只产生目录
```

> **macOS Apple Silicon 已纳入默认目标**（macos-arm64）。
> 关键点：
>
> - `--no-bytecode` 已默认开启 — 解决 V8 bytecode snapshot 在 Node 20 readline / NDJSON HTTP 流场景下的 SIGSEGV。
> - 强制代码签名 — 脚本会按 (1) 系统已装的 `ldid` → (2) 自动从 ProcursusTeam/ldid releases 拉取与本机架构匹配的静态二进制到 `.tools/ldid` → (3) 都失败时打印 `codesign --sign -` 提示。
> - macos-x64（Intel Mac）作为可选目标，需手动指定：`./scripts/package.sh macos-x64`。

### 1.7.2 单目标打包

```bash
npm run package:linux-x64
npm run package:linux-arm64
npm run package:macos-arm64
npm run package:win-x64

# 或直接调脚本
./scripts/package.sh linux-x64 win-x64
./scripts/package.sh macos-arm64 macos-x64
TARGETS="linux-arm64" ./scripts/package.sh
```

### 1.7.3 终端用户的使用流程

**Linux**:

```bash
tar -xzf toaa-linux-x64.tar.gz
cd toaa-linux-x64
cp config.example.yaml ~/.toaa/config.yaml      # 按需编辑
./toaa --help
./toaa c -i intake.md -o ~/myproj --yes
./toaa run ~/myproj/plan.json
```

**Windows**（PowerShell）：

> ⚠️ **v0.1.0 状态**：`toaa-win-x64.exe` 已能成功打包，但**尚未在 Windows 实机上端到端验证**（沙盒 / git snapshot / pytest 流程）。建议作为预览版试用，遇到问题请提 issue。Linux / macOS Apple Silicon 已通过完整回归。

```powershell
Expand-Archive toaa-win-x64.zip
cd toaa-win-x64
copy config.example.yaml $env:USERPROFILE\.toaa\config.yaml
.\toaa.exe --help
.\toaa.exe c -i intake.md -o C:\myproj --yes
.\toaa.exe run C:\myproj\plan.json
```

### 1.7.4 实现细节（如何打的包）

| 阶段 | 工具 | 输入 → 输出 |
|---|---|---|
| 1. 构建 CJS 单包 | [tsup.pkg.config.ts](../tsup.pkg.config.ts) | `src/cli/toaa.ts` → `dist/pkg-build/toaa.cjs`（约 1.7 MB，已 inline 全部依赖）|
| 2. 跨平台编译 | `@yao-pkg/pkg` (vercel/pkg 维护活跃 fork) | `toaa.cjs` + 内置 Node20 → 各目标平台 native binary（约 55 MB）|
| 3. 压缩发布 | `tar` / `zip` | `toaa-<target>/` → `toaa-<target>.tar.gz` / `.zip`（约 21 MB）|

脚本主入口：[scripts/package.sh](../scripts/package.sh)。配置都集中在 `tsup.pkg.config.ts` 与 `package.json -> scripts`。

> **为什么不打 `toaa_c` / `toaa_run` 单独的 exe？**
> `toaa` 是统一入口，`toaa c` ≡ `toaa_c`，`toaa run` ≡ `toaa_run`。一个 60 MB 的可执行文件
> 可以承担全部子命令；如果想要 `toaa_c.exe` 这种命名，复制重命名即可，行为不变。

> **Windows .zip 需要 zip 命令**：脚本检测不到 `zip` 时会跳过压缩步骤、只保留目录，
> 提示用户自行用 7-Zip / PowerShell `Compress-Archive` 打包。Linux / WSL 上 `apt install zip` 即可。


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
