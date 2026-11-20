#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# XCompiler 跨平台打包脚本
# -----------------------------------------------------------------------------
# 产出多目标的单文件可执行程序：
#   - dist/pkg/xcompiler-linux-x64/xcompiler            (Linux x86_64)
#   - dist/pkg/xcompiler-linux-arm64/xcompiler          (Linux aarch64)
#   - dist/pkg/xcompiler-macos-arm64/xcompiler          (macOS Apple Silicon, ad-hoc 签名)
#   - dist/pkg/xcompiler-win-x64/xcompiler.exe          (Windows x86_64)
#
# 每个目录另外携带：README.md / LICENSE / NOTICE / config.example.yaml /
#                  .env.example / rules / debug-wiki / skills，以便用户开箱即用。
# 最后将每个目录压缩成 tar.gz（linux/macos）或 zip（windows），放在 dist/pkg/。
#
# macOS 目标说明：
#   - macos-arm64（Apple Silicon）可在 macOS 本机直接打包、签名并执行冒烟验证。
#     pkg 必须搭配 --no-bytecode（snapshot 在 Node20 readline+NDJSON 流场景会 SIGSEGV）。
#     Apple Silicon 强制代码签名：macOS 使用系统 codesign；Linux 交叉打包时使用 ldid。
#   - macos-x64（Intel Mac）可在 Intel Mac 本机打包，或作为显式交叉编译目标。
#
# 依赖：
#   - Node 24+
#   - @yao-pkg/pkg（devDependency；必须已通过 npm ci / npm install 安装）
#   - zip（选择 Windows 目标时必需）
#   - 可选：ldid（macOS 包签名用）；缺失时本脚本会自动从 GitHub 拉取静态二进制
#
# 用法：
#   ./scripts/package.sh                                 # 打当前宿主机原生目标
#   ./scripts/package.sh native                          # 同上
#   ./scripts/package.sh all                             # 四个发布目标全打
#   ./scripts/package.sh linux-x64                       # 只打指定目标
#   ./scripts/package.sh macos-arm64 macos-x64           # 只打 macOS
#   TARGETS="linux-x64 macos-arm64" ./scripts/package.sh
# -----------------------------------------------------------------------------
set -euo pipefail

# 项目根 = scripts 所在目录的上一级
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 所有面向用户的脚本文案通过稳定消息 ID 渲染；XC_LANG=CN/zh 切换中文。
msg() {
  node "$ROOT/scripts/script_i18n.mjs" "$@"
}

# Compiler rules are required release sources, never optional attachments. This list must equal
# COMPILER_RULE_MANIFEST (generated in src/infrastructure/rules/compiler_rule_manifest.ts); a test guards it.
REQUIRED_RULE_SOURCES=(
  rules/genesis.yaml
  rules/base-level-definitions.yaml
  rules/base-output-language.yaml
  rules/language-typescript.yaml
  rules/language-python.yaml
  rules/role-project-manager.yaml
  rules/role-planner.yaml
  rules/role-requirements-analyst.yaml
  rules/role-system-architect.yaml
  rules/role-python-developer.yaml
  rules/role-typescript-developer.yaml
  rules/role-test-engineer.yaml
  rules/role-integration-test-engineer.yaml
  rules/work-execution-common.yaml
  rules/work-design-baseline-deferred.yaml
  rules/work-repair-debug.yaml
  rules/work-change-apply.yaml
  rules/work-analyze-requirements.yaml
  rules/work-design-high-level.yaml
  rules/work-design-detailed.yaml
  rules/work-code-implement.yaml
  rules/work-verify-unit.yaml
  rules/work-verify-integration.yaml
  rules/work-verify-module.yaml
  rules/work-verify-functional.yaml
  rules/scenario-outcome.yaml
  rules/contract-basis-judgement.yaml
  rules/ticket-review.yaml
)
for rule_source in "${REQUIRED_RULE_SOURCES[@]}"; do
  if [[ ! -f "$ROOT/$rule_source" ]]; then
    msg package.required_asset_missing "$rule_source" >&2
    exit 1
  fi
done

VERSION="$(node -p "require('./package.json').version")"
npm run version:check

# ---------------- 解析目标列表 ----------------
ALL_TARGETS="linux-x64 linux-arm64 macos-arm64 win-x64"

detect_host_target() {
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64|Darwin:aarch64) echo "macos-arm64" ;;
    Darwin:x86_64) echo "macos-x64" ;;
    Linux:x86_64|Linux:amd64) echo "linux-x64" ;;
    Linux:aarch64|Linux:arm64) echo "linux-arm64" ;;
    *) return 1 ;;
  esac
}

if [[ $# -gt 0 ]]; then
  REQUESTED_TARGETS="$*"
elif [[ -n "${TARGETS:-}" ]]; then
  REQUESTED_TARGETS="$TARGETS"
else
  REQUESTED_TARGETS="native"
fi

# 同时接受空格和逗号分隔；all/native 可与显式目标一起使用，并自动去重。
REQUESTED_TARGETS="${REQUESTED_TARGETS//,/ }"
TARGETS=""
HOST_TARGET="$(detect_host_target || true)"
append_target() {
  local value="$1"
  [[ " $TARGETS " == *" $value "* ]] || TARGETS="${TARGETS:+$TARGETS }$value"
}

for requested in $REQUESTED_TARGETS; do
  case "$requested" in
    all)
      for target in $ALL_TARGETS; do append_target "$target"; done
      ;;
    native)
      if [[ -z "$HOST_TARGET" ]]; then
        msg package.host_unsupported "$(uname -s)" "$(uname -m)" >&2
        exit 2
      fi
      append_target "$HOST_TARGET"
      ;;
    linux-x64|linux-arm64|macos-arm64|macos-x64|win-x64)
      append_target "$requested"
      ;;
    *)
      msg package.unknown_target "$requested" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$TARGETS" ]]; then
  msg package.targets_empty >&2
  exit 2
fi

NODE_VER="node24"
ENTRY="dist/pkg-build/xcompiler.cjs"
OUT_ROOT="dist/pkg"
PKG_BIN="$ROOT/node_modules/.bin/pkg"

msg package.header
msg package.version "$VERSION"
msg package.root "$ROOT"
msg package.entry "$ENTRY"
msg package.output "$OUT_ROOT"
msg package.targets "$TARGETS"
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
      msg package.macos_no_ldid >&2
      ;;
  esac
  return 1
}

sign_macos() {
  local binary="$1"

  if [[ "$(uname -s)" == "Darwin" ]]; then
    if ! command -v codesign >/dev/null 2>&1; then
      msg package.codesign_missing >&2
      return 1
    fi
    if ! codesign --force --sign - --timestamp=none "$binary" ||
        ! codesign --verify --verbose=2 "$binary"; then
      msg package.signing_failed "$binary" >&2
      return 1
    fi
    msg package.signed "$(command -v codesign)"
    return 0
  fi

  local signer
  signer="$(ensure_ldid || true)"
  if [[ -n "$signer" ]]; then
    if ! "$signer" -S "$binary"; then
      msg package.signing_failed "$binary" >&2
      return 1
    fi
    msg package.signed "$signer"
    return 0
  fi

  msg package.unsigned >&2
  msg package.codesign_hint "$binary" >&2
  return 1
}

smoke_native() {
  local short="$1"
  local binary="$2"
  [[ "$short" == "$HOST_TARGET" ]] || return 0

  local actual_version
  if ! actual_version="$("$binary" --version)"; then
    msg package.smoke_failed "$binary" --version >&2
    return 1
  fi
  if [[ "$actual_version" != "$VERSION" ]]; then
    msg package.smoke_version_mismatch "$VERSION" "$actual_version" >&2
    return 1
  fi
  if ! "$binary" --help >/dev/null; then
    msg package.smoke_failed "$binary" --help >&2
    return 1
  fi
  msg package.smoke_passed "$short" "$actual_version"
}

# Keep all changes outside the public output until every requested target succeeds.
# The lock also protects the CJS output used by pkg from another package.sh run.
mkdir -p dist
LOCK_DIR="$ROOT/dist/.pkg-lock"
if ! mkdir "$LOCK_DIR"; then
  msg package.output_locked "$LOCK_DIR" >&2
  exit 1
fi
WORK_ROOT=""
cleanup() {
  if [[ -n "$WORK_ROOT" ]]; then
    if [[ -e "$WORK_ROOT/previous" || -L "$WORK_ROOT/previous" ]]; then
      if [[ ! -e "$OUT_ROOT" && ! -L "$OUT_ROOT" ]]; then
        if ! mv "$WORK_ROOT/previous" "$OUT_ROOT"; then
          msg package.restore_failed "$WORK_ROOT/previous" >&2
          rmdir "$LOCK_DIR"
          return 1
        fi
      fi
    fi
    rm -rf "$WORK_ROOT"
  fi
  rmdir "$LOCK_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
WORK_ROOT="$(mktemp -d "$ROOT/dist/.pkg-stage.XXXXXX")"
STAGED_OUTPUT="$WORK_ROOT/pkg"
mkdir "$STAGED_OUTPUT"

# ---------------- 1. 生成 CJS 单文件包 ----------------
msg package.cjs_build "$ENTRY"
if [[ ! -x "$PKG_BIN" ]]; then
  msg package.pkg_missing "$PKG_BIN" >&2
  exit 1
fi
npm run --silent build:pkg

if [[ ! -f "$ENTRY" ]]; then
  msg package.entry_missing "$ENTRY" >&2
  exit 1
fi

# ---------------- 2. 逐目标用 pkg 编译 ----------------
echo
msg package.cross_compile

ASSET_SNAPSHOT="$WORK_ROOT/assets"
mkdir "$ASSET_SNAPSHOT"
node scripts/package-assets.mjs copy "$ASSET_SNAPSHOT"

# A bundle and its attachments can change even when package.json keeps the same version.
BUILD_ID="$(node --input-type=module - "$ASSET_SNAPSHOT" "$ENTRY" <<'NODE'
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , snapshot, entry] = process.argv;
const inputs = [entry, 'package-lock.json', 'scripts/package.sh']
  .map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]);

function hashAssets(directory, prefix = '') {
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, child.name);
    const relative = prefix + child.name;
    if (child.isDirectory()) {
      hashAssets(file, relative + '/');
    } else {
      inputs.push(['assets/' + relative, createHash('sha256').update(readFileSync(file)).digest('hex')]);
    }
  }
}

hashAssets(snapshot);
console.log(createHash('sha256').update(JSON.stringify(inputs.sort())).digest('hex'));
NODE
)"
printf '%s\n' "$BUILD_ID" > "$STAGED_OUTPUT/.build-sha256"

if command -v sha256sum >/dev/null 2>&1; then
  SHA256=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHA256=(shasum -a 256)
else
  msg package.checksum_tool_missing >&2
  exit 1
fi

archive_name() {
  case "$1" in
    win-*) echo "xcompiler-$1.zip" ;;
    *) echo "xcompiler-$1.tar.gz" ;;
  esac
}

if [[ ! -L "$OUT_ROOT" && -f "$OUT_ROOT/.build-sha256" &&
      "$(cat "$OUT_ROOT/.build-sha256")" == "$BUILD_ID" ]]; then
  for t in $ALL_TARGETS macos-x64; do
    [[ " $TARGETS " != *" $t "* ]] || continue
    dir="xcompiler-$t"
    archive="$(archive_name "$t")"
    [[ -e "$OUT_ROOT/$dir" || -e "$OUT_ROOT/$archive" ]] || continue
    if [[ ! -L "$OUT_ROOT/$dir" && ! -L "$OUT_ROOT/$archive" &&
          -d "$OUT_ROOT/$dir" && -f "$OUT_ROOT/$archive" &&
          -f "$OUT_ROOT/SHA256SUMS" &&
          "$(cat "$OUT_ROOT/$dir/VERSION")" == "$VERSION" ]] &&
        checksum="$(cd "$OUT_ROOT" && "${SHA256[@]}" "$archive")" &&
        grep -Fxq -- "$checksum" "$OUT_ROOT/SHA256SUMS"; then
      cp -R "$OUT_ROOT/$dir" "$OUT_ROOT/$archive" "$STAGED_OUTPUT/"
    else
      msg package.artifact_not_reused "$dir" >&2
    fi
  done
fi

build_one() {
  local short="$1"               # linux-x64 / linux-arm64 / macos-arm64 / win-x64
  local pkg_target="${NODE_VER}-${short}"
  local staging_dir="$STAGED_OUTPUT/xcompiler-${short}"
  local exe_name="xcompiler"
  [[ "$short" == win-* ]] && exe_name="xcompiler.exe"

  echo
  msg package.target "$pkg_target"
  mkdir "$staging_dir"

  # 注：必须 --no-bytecode（搭配 --public）禁用 V8 bytecode snapshot。
  # snapshot 在 Node20 + readline + 后续 NDJSON HTTP 流场景下会触发 SIGSEGV
  # （Linux x64 / arm64 与 macOS arm64 均复现）。Apache-2.0 项目，源码本就开源。
  if ! "$PKG_BIN" "$ENTRY" \
      --targets "$pkg_target" \
      --output "$staging_dir/$exe_name" \
      --compress GZip \
      --no-bytecode \
      --public \
      --public-packages "*"; then
    msg package.target_failed "$pkg_target" >&2
    return 1
  fi

  # 附带文档与示例配置
  cp -R "$ASSET_SNAPSHOT/." "$staging_dir/"
  for rule_source in "${REQUIRED_RULE_SOURCES[@]}"; do
    if [[ ! -f "$staging_dir/$rule_source" ]]; then
      msg package.required_asset_missing "$rule_source" >&2
      return 1
    fi
  done
  printf '%s\n' "$VERSION" > "$staging_dir/VERSION"

  # 给 Linux / macOS 目标加可执行位
  [[ "$short" == linux-* || "$short" == macos-* ]] && chmod +x "$staging_dir/$exe_name"

  # macOS 本机使用系统 codesign；Linux 交叉打包使用 ldid。
  if [[ "$short" == macos-* ]]; then
    if ! sign_macos "$staging_dir/$exe_name"; then
      return 1
    fi
  fi

  if ! smoke_native "$short" "$staging_dir/$exe_name"; then
    return 1
  fi
}

for t in $TARGETS; do
  build_one "$t"
done

# ---------------- 3. 压缩 ----------------
echo
msg package.archive

cd "$STAGED_OUTPUT"
for t in $TARGETS; do
  dir="xcompiler-${t}"
  archive="$(archive_name "$t")"
  if [[ "$t" == win-* ]]; then
    if command -v zip >/dev/null 2>&1; then
      zip -qr "$archive" "$dir" -x '*/._*'
    else
      msg package.zip_missing "$dir" >&2
      exit 1
    fi
  else
    COPYFILE_DISABLE=1 tar --exclude='._*' -czf "$archive" "$dir"
  fi
  msg package.created "$archive"
done


# ---------------- 4. 校验和 ----------------
# Include both new archives and verified archives retained from the same build.
msg package.checksum
archives=()
for archive in xcompiler-*.tar.gz xcompiler-*.zip; do
  [[ -f "$archive" ]] && archives+=("$archive")
done

if [[ ${#archives[@]} -eq 0 ]]; then
  msg package.no_archives >&2
  exit 1
fi
"${SHA256[@]}" "${archives[@]}" > SHA256SUMS
"${SHA256[@]}" -c SHA256SUMS
msg package.created "SHA256SUMS"
cd "$ROOT"

if [[ -e "$OUT_ROOT" || -L "$OUT_ROOT" ]]; then
  mv "$OUT_ROOT" "$WORK_ROOT/previous"
fi
mv "$STAGED_OUTPUT" "$OUT_ROOT"

echo
msg package.complete "$OUT_ROOT"
ls -lh "$OUT_ROOT" | sed 's/^/    /'
