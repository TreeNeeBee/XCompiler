#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# TOAA 跨平台打包脚本
# -----------------------------------------------------------------------------
# 产出多目标的单文件可执行程序：
#   - dist/pkg/toaa-linux-x64/toaa            (Linux x86_64)
#   - dist/pkg/toaa-linux-arm64/toaa          (Linux aarch64)
#   - dist/pkg/toaa-macos-arm64/toaa          (macOS Apple Silicon, ad-hoc 签名)
#   - dist/pkg/toaa-win-x64/toaa.exe          (Windows x86_64)
#
# 每个目录另外携带：README.md / LICENSE / NOTICE / config.example.yaml /
#                  .env.example  以便用户开箱即用。
# 最后将每个目录压缩成 tar.gz（linux/macos）或 zip（windows），放在 dist/pkg/。
#
# macOS 目标说明：
#   - macos-arm64（Apple M1/M2/M3）已纳入默认目标。
#     pkg 必须搭配 --no-bytecode（snapshot 在 Node20 readline+NDJSON 流场景会 SIGSEGV）。
#     Apple Silicon 强制代码签名：本脚本会按以下顺序尝试 ad-hoc 签名：
#       1. 系统已安装的 `ldid`（Linux 上由 ProcursusTeam 提供静态二进制）；
#       2. 自动从 GitHub Releases 下载与本机架构匹配的 `ldid` 到 ./.tools/ldid；
#       3. 都失败则保留未签名二进制 + 给终端用户打印 `codesign --sign - toaa` 提示。
#   - macos-x64（Intel Mac）作为可选目标，需手动指定：./scripts/package.sh macos-x64
#
# 依赖：
#   - Node 20+
#   - @yao-pkg/pkg（devDep；本脚本会按需 npx 唤起）
#   - 可选：zip（Windows 包用），未装则跳过 zip，仅产生目录
#   - 可选：ldid（macOS 包签名用）；缺失时本脚本会自动从 GitHub 拉取静态二进制
#
# 用法：
#   ./scripts/package.sh                                 # 默认四目标全打
#   ./scripts/package.sh linux-x64                       # 只打指定目标
#   ./scripts/package.sh macos-arm64 macos-x64           # 只打 macOS
#   TARGETS="linux-x64 macos-arm64" ./scripts/package.sh
# -----------------------------------------------------------------------------
set -euo pipefail

# 项目根 = scripts 所在目录的上一级
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ---------------- 解析目标列表 ----------------
DEFAULT_TARGETS="linux-x64 linux-arm64 macos-arm64 win-x64"
if [[ $# -gt 0 ]]; then
  TARGETS="$*"
elif [[ -n "${TARGETS:-}" ]]; then
  : # 用环境变量
else
  TARGETS="$DEFAULT_TARGETS"
fi

NODE_VER="node20"
ENTRY="dist/pkg-build/toaa.cjs"
OUT_ROOT="dist/pkg"

echo "==> TOAA 打包"
echo "    项目根:  $ROOT"
echo "    入口:    $ENTRY"
echo "    输出根:  $OUT_ROOT"
echo "    目标:    $TARGETS"
echo

# ---------------- 工具：定位或自动获取 ldid（macOS 包 ad-hoc 签名用） ----------------
# 调用约定：成功则把可用的 ldid 路径打到 stdout 并 return 0；失败 return 1（不输出）。
# 决策顺序：
#   1. PATH 上已有 ldid → 直接用；
#   2. 项目级 .tools/ldid 已下载 → 直接用；
#   3. 探测 OSTYPE：
#      - Linux：从 ProcursusTeam/ldid releases 拉取与 `uname -m` 匹配的静态二进制；
#      - macOS：理论上系统自带 codesign 即可，但若用户偏好 ldid 则尝试通过 brew 提示；
#      - 其他：放弃。
ensure_ldid() {
  if command -v ldid >/dev/null 2>&1; then
    command -v ldid
    return 0
  fi
  local local_bin="$ROOT/.tools/ldid"
  if [[ -x "$local_bin" ]]; then
    echo "$local_bin"
    return 0
  fi
  # 仅在 Linux 上自动下载（避免在 macOS 上覆盖系统签名工具链）
  case "$(uname -s)" in
    Linux)
      local arch
      arch="$(uname -m)"
      local url="https://github.com/ProcursusTeam/ldid/releases/latest/download/ldid_linux_${arch}"
      mkdir -p "$ROOT/.tools"
      if curl -fsSL "$url" -o "${local_bin}.tmp" 2>/dev/null; then
        chmod +x "${local_bin}.tmp"
        mv "${local_bin}.tmp" "$local_bin"
        echo "$local_bin"
        return 0
      fi
      rm -f "${local_bin}.tmp"
      ;;
    Darwin)
      # 在 Mac 上 pkg 自身能调系统 codesign，正常不会走到这里；提示一下即可。
      echo "    NOTE: macOS 上未检测到 ldid；pkg 通常会自动调用系统 codesign。" >&2
      ;;
  esac
  return 1
}

# ---------------- 1. 生成 CJS 单文件包 ----------------
echo "==> [1/3] tsup 打 CJS 单文件 -> $ENTRY"
npx tsup --config tsup.pkg.config.ts

if [[ ! -f "$ENTRY" ]]; then
  echo "ERROR: $ENTRY 未生成；请检查 tsup.pkg.config.ts" >&2
  exit 1
fi

# ---------------- 2. 逐目标用 pkg 编译 ----------------
echo
echo "==> [2/3] @yao-pkg/pkg 跨平台编译"

mkdir -p "$OUT_ROOT"
# 共享附件
ASSETS=(README.md LICENSE NOTICE config.example.yaml .env.example)

build_one() {
  local short="$1"               # linux-x64 / linux-arm64 / macos-arm64 / win-x64
  local pkg_target="${NODE_VER}-${short}"
  local outdir="$OUT_ROOT/toaa-${short}"
  local exe_name="toaa"
  [[ "$short" == win-* ]] && exe_name="toaa.exe"

  echo
  echo "  -> $pkg_target"
  rm -rf "$outdir"
  mkdir -p "$outdir"

  # 注：必须 --no-bytecode（搭配 --public）禁用 V8 bytecode snapshot。
  # snapshot 在 Node20 + readline + 后续 NDJSON HTTP 流场景下会触发 SIGSEGV
  # （Linux x64 / arm64 与 macOS arm64 均复现）。Apache-2.0 项目，源码本就开源。
  npx @yao-pkg/pkg "$ENTRY" \
    --targets "$pkg_target" \
    --output  "$outdir/$exe_name" \
    --compress GZip \
    --no-bytecode \
    --public \
    --public-packages "*"

  # 附带文档与示例配置
  for f in "${ASSETS[@]}"; do
    [[ -f "$f" ]] && cp "$f" "$outdir/"
  done

  # 给 Linux / macOS 目标加可执行位
  [[ "$short" == linux-* || "$short" == macos-* ]] && chmod +x "$outdir/$exe_name"

  # macOS 二进制必须有签名才能在 Apple Silicon 上启动；按 (1) 系统 ldid → (2) 自动拉取 → (3) 提示
  if [[ "$short" == macos-* ]]; then
    local signer
    signer="$(ensure_ldid || true)"
    if [[ -n "$signer" ]]; then
      "$signer" -S "$outdir/$exe_name" && echo "    (ad-hoc signed by $signer)"
    else
      echo "    NOTE: ldid 不可用且自动下载失败，macOS 二进制未签名。" >&2
      echo "          终端用户首次运行前需在 Mac 上执行：codesign --sign - $exe_name" >&2
    fi
  fi
}

for t in $TARGETS; do
  case "$t" in
    linux-x64|linux-arm64|macos-arm64|macos-x64|win-x64) build_one "$t" ;;
    *) echo "WARN: 未知目标 '$t'，跳过（合法值：linux-x64 / linux-arm64 / macos-arm64 / macos-x64 / win-x64）" >&2 ;;
  esac
done

# ---------------- 3. 压缩 ----------------
echo
echo "==> [3/3] 打包发布产物"

cd "$OUT_ROOT"
for t in $TARGETS; do
  dir="toaa-${t}"
  [[ -d "$dir" ]] || continue
  if [[ "$t" == win-* ]]; then
    if command -v zip >/dev/null 2>&1; then
      rm -f "${dir}.zip"
      zip -qr "${dir}.zip" "$dir" -x '*/._*'
      echo "  -> ${dir}.zip"
    else
      echo "  WARN: 未找到 zip 命令，仅保留目录 $dir/" >&2
    fi
  else
    rm -f "${dir}.tar.gz"
    tar --exclude='._*' -czf "${dir}.tar.gz" "$dir"
    echo "  -> ${dir}.tar.gz"
  fi
done
cd "$ROOT"

echo
echo "✔ 打包完成。产物位于 $OUT_ROOT/"
ls -lh "$OUT_ROOT" | sed 's/^/    /'
