# 目录与产物约定

| 目录 | 内容 |
| --- | --- |
| `apps/` | 可运行应用与宿主；`apps/desktop/src/renderer` 是 Tauri/Electron 共享 UI。 |
| `packages/` | 共享运行时、适配器、协议和工具实现。 |
| `tests/` | 跨模块集成测试；模块测试跟随所在包。 |
| `scripts/` | 可重复的项目维护入口；一次性脚本不放这里。 |
| `config/` | 受版本管理的策略、结构基线和构建配置。 |
| `docs/` | 使用、开发与安全说明；从[文档导航](README.md)按需进入。 |
| `releases/` | [成品入口说明](../releases/README.md)；实际二进制保留在打包工具管理的位置。 |
| `.sovereign/scratch/` | 本机临时脚本、截图、抓取输出；不提交。 |
| `.sovereign/reports/` | 本机验证记录和诊断报告；不提交。 |
| `.sovereign/archive/` | 可逆整理的旧文件及原路径、摘要清单；不提交。 |
| `.worktrees/` | 新建的受管并行工作树；由 Git 工具管理。 |

不要把截图、外部 APK、临时 Python/Java/XML 文件堆在根目录。需要保留的一次性材料按任务放到 scratch；整理既有材料时保留相对依赖、原路径和 SHA-256，避免把未提交文件当作垃圾。

存放位置不等于永久保留要求。任务收尾按 [CONTRIBUTING.md](../CONTRIBUTING.md)处理：确认用途结束的临时产物可直接删除；当前交付、恢复证据和用途未明的材料保留并在原任务记录注明解除条件。

`node_modules`、Gradle/Cargo 缓存和现有打包目录沿用工具链约定，不为外观整齐搬动它们。既有 `.claude/worktrees` 属于已注册的历史工作树，未确认任务结束前不得移动或删除。

```powershell
pnpm worktrees:audit
pnpm worktrees:prune
```

`worktrees:prune` 现在只列出候选，不移除目录或 Git 登记。目录年龄、干净状态都不能证明闲置；确认负责方已结束后，才用 `pnpm worktree:finish -- <name>` 定向结束一个受管工作树。`worktree:create` 已内置数量检查，不必先重复运行 guard。

`worktree:finish` 还会拒绝包含 Git 忽略内容的工作树。被忽略的安装包、配置、交接记录或交付文件不会出现在普通 Git 状态中，也不能靠保留分支找回。先核实并转存需要保留的文件，按已获授权处理真正废弃的缓存，再重新执行；命令没有跳过这项保护的强制选项。

源码结构检查不要求重排整个项目。共享 UI、Rust 宿主、Android Gradle 工程及依赖包路径继续保持稳定；按职责定位代码，按构建记录定位成品。
