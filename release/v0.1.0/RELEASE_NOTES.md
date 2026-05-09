# TOAA v0.1.0 — First Hardened Preview Release

发布日期: 2026-05-08
Git tag: `v0.1.0` → commit `d185d3c`

> 经 45 轮迭代后达到端到端可用状态。**Linux / macOS Apple Silicon 已通过完整端到端验证；Windows 仅完成打包流程，未在 Windows 实机上做过 plan 全跑**——欢迎试用并反馈。

---

## 下载

| 目标平台 | 文件 | 大小 | 状态 |
|---|---|---|---|
| Linux x86_64 | `toaa-linux-x64.tar.gz` | 21 MB | ✅ 已验证 |
| Linux aarch64 | `toaa-linux-arm64.tar.gz` | 20 MB | ✅ 已验证 |
| macOS Apple Silicon | `toaa-macos-arm64.tar.gz` | 18 MB | ✅ 已验证（ad-hoc 签名） |
| Windows x86_64 | `toaa-win-x64.zip` | 16 MB | ⚠️ **未验证** — 仅打包通过，未在 Windows 实机端到端跑过 plan |

校验和: 见同目录 [SHA256SUMS](SHA256SUMS)。

## 运行期依赖（不在 pkg 范围）

- Python 3.11+（沙盒 pip / pytest）
- git（plan snapshot / revert）
- 可达的 ollama 服务器 或 OpenAI API key

## 主要变更（第 29-45 轮 hardening 摘要）

详见 [doc/dev_audit_log.md](../../doc/dev_audit_log.md)。

### LLM 编排
- LLM 评分系统 + 启动期 ollama preflight，缺模型自动 `/api/tags` 注入
- 角色 → LLM 数组（兼容旧 single-string 配置），按评分降序、0 分跳过
- 滑动窗口 AIMD 重试 + 滑动 deadline wall-clock（4× 硬上限）

### Plan 校准
- `calibrateStepShape` 增加 phase 推断（别名 + outputs 路径强证据），救 `phase="---"` 这类 LLM 写歪
- `calibratePlanCoverage` 自动追加缺失 TEST Step，救 lint S004/S005
- `parseDraftPlanJson` 强制 V 模型骨架（≥4 步 + 必含 REQUIREMENT/ARCH/CODE/DELIVERY）
- lint 错误信息改造为可执行提示
- REFACTOR 阶段允许输出 src/tests 文件

### Tester / Debugger
- 14 条 Python 错误模式 → 修复建议
- `conftest.py` 自动生成 + `tests/fixtures/` 写权限放开
- `run_tests` summary 自动附 stderr/stdout 末尾若干行

### 打包
- `macos-arm64` 加入默认目标 + `ldid` 三段式签名兜底（系统 → `.tools/` 缓存 → 自动下载）
- spinner 在 pkg+TTY 下用零依赖 mini spinner（绕过 pkg+ora 的 SIGSEGV）

## 已知限制

- **Windows 端到端未验证**: 子进程 spawn / git revert / pytest 行为未在 Win32 实测，可能有路径分隔符 / shell 引号问题。
- 仅支持生成 Python 工程（按设计）。
- ollama 不可达时 preflight 不会清零评分（防止单次网络抖动毁掉所有模型），需要重启 toaa 后重新 preflight。

## 安装

```bash
# Linux / macOS
tar -xzf toaa-<target>.tar.gz
cd toaa-<target>
cp config.example.yaml ~/.toaa/config.yaml      # 按需编辑 ollama / openai
./toaa --help

# Windows (PowerShell, 未验证)
Expand-Archive toaa-win-x64.zip
cd toaa-win-x64
copy config.example.yaml $env:USERPROFILE\.toaa\config.yaml
.\toaa.exe --help
```

详细部署文档见 [doc/deploy.md](../../doc/deploy.md)。
