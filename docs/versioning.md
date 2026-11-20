# XCompiler 版本管理

`package.json` 是 XCompiler 核心版本和 Plugin API 版本的唯一真源：

```json
{
  "version": "0.4.0",
  "xcompiler": { "pluginApiVersion": 4 }
}
```

`src/version.ts` 是自动生成的运行时常量，`package-lock.json` 由同一工具同步。不要手工修改这两个位置。

`npm run build` 通过 `prebuild` 先执行 `version:check`。手工打包时先运行 `npm run build`，再运行 `npm pack`。`prepack` 会校验版本及包文件清单，缺少构建入口或发布资源时直接报错。`npm run package:verify` 可单独校验包文件清单。

## 常用命令

```bash
# 检查 package、lockfile、CLI 运行时常量是否一致
npm run version:check

# 重新按 package.json 生成其他版本元数据
npm run version:sync

# 设置下一个核心版本并同步全部位置
npm run version:set -- 0.1.4

# 准备一次本地发版（不 push）
npm run release:local -- v0.1.4
```

核心版本遵循 SemVer。发布 tag 必须是 `v<package version>`，例如 `v0.1.3`；Release workflow 会在测试和打包前强制校验，版本不一致时停止发布。二进制分发包内包含 `VERSION` 文件，CLI 的 `--version` 也读取同一个生成常量。

`release:local` 会要求工作区干净，然后同步 `package.json`、`package-lock.json` 与 `src/version.ts`，执行本地发版门禁（`version:check`、`npm audit --omit=dev`、`typecheck`、`lint`、`test`、`build`、`package:verify`），提交 `chore: release <tag>`，并创建本地 annotated tag。需要发布时，手工执行以下命令。

```bash
git push origin <branch>
git push origin <tag>
```

如果上一次本地 tag 创建错了但还没有推送远端，可使用 `npm run release:local -- v0.1.4 --replace-local-tag`，所有本地门禁通过后才替换 tag。离线环境可加 `--skip-audit` 跳过本地依赖审计，GitHub Release workflow 仍会执行该审计。GitHub Release 和 npm 发布使用同一组发版门禁。npm 正式版本发布到 `latest`，预发行版本发布到 `next`。

Plugin API 版本独立于核心版本，只在插件公共接口出现不兼容修改时递增整数主版本。Plugin API 3 移除了旧的内存 Skill 对象注册接口，改为 Agent Skills Specification 目录和 `registerSkillDirectory()`；不提供旧接口兼容层。Plugin API 4（XCompiler 0.4）随角色与工作拆分修改了 `step.attempt.*` 的 `role`/`work` 字段和 Hook 中的 `Plan`/`Step` 形状，详见 [plugin_api.md](plugin_api.md)；声明 `apiVersion: 3` 的插件需要按新形状更新后改为 4。插件自身使用 SemVer，并在 manifest 中强制声明 `apiVersion` 和 `minXCompilerVersion`；详细规则见 [plugin_api.md](plugin_api.md)。

审计内容默认使用 `redacted` 模式：完整保留事件与正文，只遮蔽 API key、token、密码等凭据；受控环境可设置 `XC_AUDIT_CONTENT_MODE=full` 保留未脱敏正文。原始 `audit.jsonl` 与 `process_log.md` 不做内容瘦身，轻量检索使用可重建的 `audit/summary.md`，其中保留原始行号和领域对象 revision 链接。

## 升级到 0.4

0.4 有以下不兼容变化，不提供兼容层：

- **配置**：`llm.roles` 和 `llm.role_fallbacks` 由具名模型池 `llm.pools.{management|planning|design|coding|testing}` 取代。
  对应关系：`roles.ProjectManager` → `pools.management`，`roles.Planner` → `pools.planning`，`roles.Architect` → `pools.design`，
  `roles.Coder` → `pools.coding`，`roles.Tester` → `pools.testing`；`roles.Debugger` 取消，缺陷修复使用执行者所属角色的池；
  `role_fallbacks` 取消，池内顺序即候选顺序，全局 `fallbacks` 保留。启动时缺少任何角色默认池会直接报错。示例见 `config.example.yaml`。
- **工作区**：0.3 以及 0.4 开发期间创建的工作区（Ticket/Step/Actor 带旧的角色字段，或存在 `role-definition` 对象）无法加载，需要新建工作区。
- **安装级角色覆盖层**（`XC_PATH` 下的角色模板）已删除；角色身份与工作说明改由编译器 RuleList（`rules/`）提供，并按请求语言渲染中文或英文。
- **插件**：Plugin API 升到 4，变化见 [plugin_api.md](plugin_api.md)；声明 `apiVersion: 3` 的插件需要更新。
