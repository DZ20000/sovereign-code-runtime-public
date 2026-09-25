# Sovereign Code Runtime

[English](README.md)

> **源码预览。** 本仓库发布的是源码，不是已宣布的二进制发行版，也不是安装态验收证明。在敏感环境中使用前，请阅读[安全政策](SECURITY.md)、[威胁模型](docs/threat-model.md)和[依赖安全说明](docs/dependency-security.md)。

Sovereign 让 **ChatGPT Web 对话通过 MCP 操作经授权的 Windows 工作区**。ChatGPT 提供模型与对话；Sovereign 提供本机工具、工作区权限、任务状态和审计证据。项目不内置模型客户端。

## 主要能力

- 仅监听回环地址并要求 Bearer 鉴权的 MCP Gateway。
- 受工作区约束的文件、终端、Python、浏览器、桌面、工作流和任务工具。
- 四级本机权限、后果性操作原生批准和本地审计回执。
- Tauri/WebView2 桌面外壳、Node Runtime Host，以及可选的 Android 预览 Agent。
- 面向干净 Windows 克隆的源码与依赖检查。

## 快速开始

环境要求：Windows 10/11、Node.js 24+、pnpm 10+、WebView2、Rust MSVC 工具链和 .NET Framework C# 编译器。

```powershell
pnpm install --frozen-lockfile
pnpm dev:desktop
```

只定位已有且可核验的构建产物，不安装、不启动：

```powershell
pnpm products:zh
pnpm products:open:zh
```

也可以双击英文文件名 `open-products.cmd`（默认英文输出）。详见[构建产物指南](releases/README.zh-CN.md)。

## 连接 ChatGPT

1. 启动 Sovereign，并授权允许操作的工作区文件夹。
2. 将官方 Windows `tunnel-client` 放入 `PATH`、在本机选择它，或在启动前设置 `SCR_TUNNEL_CLIENT_PATH`。
3. 在 **ChatGPT 连接** 中填写 OpenAI tunnel ID 和 runtime key，选择权限级别并启动连接。
4. 等待状态变为 **Ready**，再为 ChatGPT 自定义应用配置该 tunnel ID，并先验证一次只读调用。

```text
ChatGPT Web -> OpenAI Secure MCP Tunnel -> 回环 Gateway
            -> 权限与工作区策略 -> 本机工具与审计
```

Gateway 仅绑定 `127.0.0.1`。连接器凭据通过子进程环境传递，而不是出现在命令行参数中。持久化的隧道密钥和代理设置使用 Windows DPAPI 保护。可选控制平面代理只协调线路，不转发本机 MCP 流量。

## 权限与安全

| 级别 | 外部工具行为 |
| --- | --- |
| L1 观察 | 只读观察工具。 |
| L2 工作区 | 可在授权工作区写入、执行本地 Git、固定验证和取消运行。 |
| L3 后果性操作 | L1/L2 直接执行；后果性操作需要新的本机批准。 |
| L4 免确认 | 本机明确确认后，声明的工具不再弹出 Sovereign 批准提示。 |

记忆权限绑定到确切工作区。工作区恢复与权限是独立设置，开关恢复功能不会改变当前 L1-L4 权限。L4 不会授予管理员权限，也不会关闭工作区约束、版本检查、参数模式或审计。

PowerShell、ConPTY、Python、浏览器求值和桌面控制都以当前 Windows 用户权限执行，**不是操作系统沙箱**。安全桌面、凭据输入、提权、通行密钥、OTP 和 CAPTCHA 仍由人处理。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `apps/desktop-tauri` | 主要 Tauri/WebView2 外壳、打包和 Guardian。 |
| `apps/desktop/src/renderer` | Tauri 与旧 Electron 外壳共用的工作台 UI。 |
| `apps/runtime-host` | 托管控制平面和 Gateway 的 Node sidecar。 |
| `apps/gateway` | MCP 传输、实时目录和可选无头入口。 |
| `packages/control-plane` | 设置、权限、任务、隧道监督和生命周期。 |
| `packages/runtime-core` | 策略、模式、存储和审计基础。 |
| `packages/windows-adapter` | 受约束的 Windows 文件系统和进程原语。 |
| `packages/toolkit` | 工具模式与分发。 |
| `apps/android-agent` | 独立 Android 预览。 |

## 文档

- [中文文档导航](docs/README.zh-CN.md)
- [架构](docs/architecture.md)
- [开发与验证](docs/development.md)
- [能力目录](docs/capability-catalog.md)
- [远程主机与恢复](docs/remote-host.md)
- [贡献指南](CONTRIBUTING.md)
- [安全政策](SECURITY.md)

## 发布边界

构建成功、包完整性、安装、激活和实际运行验收是不同结果。源码 CI 通过不代表原生 UI、提权、安装或签名二进制已经验收。发行产物应放在 GitHub Releases，不应提交进源码历史。

## 许可证

原创源码和文档采用 [Apache License 2.0](LICENSE)。第三方组件保留各自许可证，详见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
