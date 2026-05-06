#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# TOAA 跨平台打包脚本
# -----------------------------------------------------------------------------
# 产出三个目标的单文件可执行程序：
#   - dist/pkg/toaa-linux-x64/toaa            (Linux x86_64)
#   - dist/pkg/toaa-linux-arm64/toaa          (Linux aarch64)
#   - dist/pkg/toaa-win-x64/toaa.exe          (Windows x86_64)
#
# 每个目录另外携带：README.md / LICENSE / NOTICE / config.example.yaml /
#                  .env.example  以便用户开箱即用。
# 最后将每个目录压缩成 tar.gz（linux）或 zip（windows），放在 dist/pkg/。
#
# 注：macOS 目标（macos-arm64 / macos-x64）在当前 Linux 打包机 + V8 bytecode snapshot
# 下会出现 segfault（已知 pkg 问题），暂从默认目标中移除。如需手动走：
#   ./scripts/package.sh macos-arm64       # 会走 build_one，但产出运行未验证。
#
# 依赖：
#   - Node 20+
#   - @yao-pkg/pkg（devDep；本脚本会按需 npx 唤起）
#   - 可选：zip（Windows 包用），未装则跳过 zip，仅产生目录
#
# 用法：
#   ./scripts/package.sh                   # 三目标全打
#   ./scripts/package.sh linux-x64         # 只打指定目标
#   TARGETS="linux-x64 win-x64" ./scripts/package.sh
# -----------------------------------------------------------------------------
set -euo pipefail

# 项目根 = scripts 所在目录的上一级
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ---------------- 解析目标列表 ----------------
DEFAULT_TARGETS="linux-x64 linux-arm64 win-x64"
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

  # macOS 二进制必须有签名才能在 Apple Silicon 上启动；如本机有 ldid 就做 ad-hoc 签名
  if [[ "$short" == macos-* ]]; then
    if command -v ldid >/dev/null 2>&1; then
      ldid -S "$outdir/$exe_name" && echo "    (ad-hoc signed by ldid)"
    else
      echo "    NOTE: ldid 未安装，macOS 二进制未签名。终端用户首次运行前需在 Mac 上执行：" >&2
      echo "          codesign --sign - $exe_name" >&2
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
