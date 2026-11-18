# DYNMECH CycleView 便携版（单文件 exe）打包指南

便携版是**单文件自解压 exe**（`release/DYNMECH-CycleView-Portable-1.0.0.exe`，约 80 MB），双击即运行，目标电脑**零环境**——不需要 Node.js、不需要 npm、不用安装（Windows x64 / Win 10+）。

---

## 一、打包前：先编译最新代码（关键）

`electron-builder` 只负责把已有的构建产物 + Electron 运行时压成 exe，**不会帮你编译源码**。每次改完 `src/`，务必先重新构建，否则打出来的 exe 是旧代码。

```bash
cd /e/CODE/IVD_gante
npx vite build
```

产出 `dist/`（界面）和 `dist-electron/`（主进程）。确认时间戳是最新的再打包。

> 可选的额外校验：`npm run typecheck`（类型检查）和 `npx vitest run`（测试）。它们不影响打包，但能提前发现问题。

---

## 二、打包命令（本机直接可用）

当前这台电脑已经备齐离线工具，直接执行：

```bash
npx electron-builder --win portable \
  -c.electronDist="E:/CODE/IVD_gante/node_modules/electron/dist" \
  -c.directories.output="release-portable"
```

- `--win portable`：只打**单文件便携版**（不打 zip 和安装包）
- `-c.electronDist=…`：用本地已安装的 Electron 运行时，**跳过 GitHub 下载**（网络不稳时必加）
- `-c.directories.output=…`：输出到**全新目录**。`electron-builder` 会清空旧输出目录，在受保护环境下批量删除可能失败，换新目录可绕开

耗时约 4 分钟。产物：`release-portable/DYNMECH-CycleView-Portable-1.0.0.exe`。确认无误后复制到 `release/` 覆盖旧版即可交付。

---

## 三、联网正常时的最简方式

如果 GitHub 能稳定访问，让 `electron-builder` 自动下载依赖即可，去掉 `-c.electronDist`：

```bash
npx vite build
npx electron-builder --win portable
```

> 也可用 `npm run dist:win`，但它会同时打**便携版 + zip + 安装包**三个目标，更慢。只要单文件 exe，用上面的命令。

---

## 四、换电脑 / 缓存丢失时

`electron-builder` 依赖 4 个二进制工具，缓存在 `%LOCALAPPDATA%\electron-builder\Cache\`：

| 工具 | 版本 | 缓存位置（Cache 目录下） |
|---|---|---|
| Electron | 28.3.3 | `electron\28.3.3\electron-v28.3.3-win32-x64.zip` |
| winCodeSign | 2.6.0 | `winCodeSign\winCodeSign-2.6.0\`（含 `rcedit-x64.exe`） |
| NSIS | 3.0.4.1 | `nsis\nsis-3.0.4.1\makensis.exe` |
| NSIS resources | 3.4.1 | `nsis\nsis-resources-3.4.1\plugins\` |

联网正常时这些会自动下载。网络不稳时可从 GitHub 手动下载并解压到对应目录（用项目自带的 7z：`node_modules\7zip-bin\win\x64\7za.exe x 包.7z -o目标目录`）：

- `https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z`
- `https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z`
- `https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-resources-3.4.1/nsis-resources-3.4.1.7z`

Electron 本体不必下载——用 `-c.electronDist` 指向本地 `node_modules\electron\dist` 即可。

---

## 五、验证产物

```bash
# PE 头应为 4d5a（MZ）
head -c 2 release/DYNMECH-CycleView-Portable-1.0.0.exe | xxd

# 确认最新功能进了包（多周期布局的特征串）
grep -a -c data-task-id release-portable/win-unpacked/resources/app.asar
# 其他特征：cycleMs、resourceId、甘特矩阵、周期、冲突
```

---

## 六、常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 卡在下载 electron-v28 / winCodeSign / NSIS | 网络问题。按第二、四节用本地 Electron + 已备缓存离线打包 |
| 清空旧输出目录失败 / 删除被拦截 | 加 `-c.directories.output` 换一个全新目录名 |
| 打出来的 exe 是旧代码 | 忘了第一步 `npx vite build`，先重新编译再打包 |
| git 状态冒出几百 MB 大文件 | 正常不会：`.gitignore` 已忽略 `release*/`、`*.exe`、`win-unpacked/` |
| `npm run build` 报错 | 它末尾会调用 `electron-builder` 但没带离线参数，联网差时会失败；用第二节命令代替 |
