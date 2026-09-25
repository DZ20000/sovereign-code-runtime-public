# 文档导航

[English](README.md) · [项目中文 README](../README.zh-CN.md)

## 使用与开发

| 目标 | 从这里开始 |
| --- | --- |
| 安装依赖、从源码运行、选择验证命令 | [开发与验证](development.md) |
| 理解进程边界和共享 UI | [架构](architecture.md) |
| 配置远程连接、登录启动和恢复 | [远程主机](remote-host.md)、[控制平面切换](control-plane-failover.md) |
| 查找工具和可选能力 | [能力目录](capability-catalog.md)、[工具包](tool-packs.md)、[上下文工具](context-tools.md) |
| 查看长任务输出 | [进程输出](process-output.md) |
| 处理任务和跨任务协作 | [任务中心](task-agent-hub.md)、[任务协调](task-coordination.md) |
| 开发 Android 预览 | [Android README](../apps/android-agent/README.md)、[Android 架构](android-agent-architecture.md) |
| 验证 UI 和性能 | [视觉测试](visual-testing.md)、[已安装 UI 审计](installed-ui-audit.md)、[性能预算](performance-budget.md) |

## 安全与发布

- [威胁模型](threat-model.md)和 [Android 威胁模型](android-agent-threat-model.md)
- [安全执行](secure-execution.md)和 [Gateway 会话容量](gateway-session-capacity.md)
- [应用重启更新](application-restart-updates.md)
- [Renderer 热更新](renderer-hot-updates.md)和 [Runtime 候选更新](runtime-candidate-updates.md)
- [签名更新](signed-update.md)、[分层更新](layered-live-update.md)和[持久化切换恢复](durable-cutover-recovery.md)
- [依赖安全](dependency-security.md)

## 维护

- [仓库结构](repository-layout.md)
- [生成产物盘点](generated-artifact-inventory.md)
- [源码结构检查](source-structure-guard.md)
- [会话交接](session-handoff.md)

当前行为以源码、包脚本和当前文档为准，不以旧的本地报告或私有恢复记录为准。
