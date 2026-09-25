# 构建产物

[English](README.md)

源码仓库不提交安装包、便携包、APK 或生成的 Runtime 资源。公开二进制应放在 GitHub Releases，并附带摘要和来源信息。

定位当前克隆及其 Git worktree 中已经生成的产物：

```powershell
pnpm products:zh
pnpm products:open:zh
```

也可以双击 `open-products.cmd`（默认英文输出）。该命令只定位经过核验的文件，不会安装、启动、替换或重启 Sovereign。

| 产物 | 显示的证据 |
| --- | --- |
| 已安装 Windows 应用 | 当前用户的 Windows 安装记录；只有 EXE 与已验证安装包 manifest 一致时才显示源码来源。 |
| 正在运行的 Windows 应用 | 运行中进程的确切可执行文件路径。 |
| Windows 安装包 | 版本、构建日期、来源提交、工作区脏状态，以及 manifest/文件摘要验证。 |
| Windows 便携包 | 已验证指针、manifest、组件摘要、来源提交和工作区脏状态；必须保留整个文件夹。 |
| Android debug APK | Gradle 输出元数据；它是开发预览，不代表真机验收。 |

常见本地产物目录已被 Git 忽略：

- Windows NSIS：`apps/desktop-tauri/src-tauri/target/release/bundle/nsis/`
- Windows 便携包：`apps/desktop-tauri/artifacts/portable-*/`
- Android debug：`apps/android-agent/app/build/outputs/apk/debug/`

文件更新、版本号相同或构建成功，都不能证明包已安装、正在运行、已签名或已验收。请遵循[开发与发布验证](../docs/development.md)。
