# BiliMusic 播放器基本功能测试用例

> 目标：覆盖播放器 P0 基本功能，重点验证本地下载文件的离线播放链路。  
> 测试方式：Electron 生产构建 + CDP 注入测试音频与下载记录，通过真实 DOM 点击和 audio 元素状态断言。  
> 最终结果：**16/16 通过**（2026-11-22，开发与打包产物双重验证）。

## 测试环境

- 应用版本：1.0.2
- 测试音频：440Hz / 30 秒 WAV（`.tmp-player-tests/tone30.wav`）
- 测试入口：下载页 `/downloads`
- 监控手段：CDP `Runtime.evaluate` 读取 `Audio` 实例 `src / paused / duration / error / volume / muted` 与媒体事件
- 测试日志：`.tmp-player-tests/cdp-test-final.log`（源码构建）、`.tmp-player-tests/cdp-test-v5-package.log`（v5 免安装包）

## P0 测试用例

| 编号 | 功能点 | 预期结果 | 实测结果 |
| --- | --- | --- | --- |
| TC-01 | 下载列表渲染 | 显示 2 条已完成记录 | 通过：rowCount=2 |
| TC-02 | 本地路径桥接 | 顶层与 `biliApi` 内 `openPath` 均存在 | 通过：均为 function |
| TC-03 | 打开本地文件 | `openPath(文件路径)` 返回 ok | 通过：`{ok:true}` |
| TC-04 | 播放本地文件 | audio.src 为带 host 的 `media://local/...` | 通过：src 正确 |
| TC-05 | 本地音频解码 | duration=30s，无 error | 通过：duration=30，error=null |
| TC-06 | 本地播放状态 | paused=false，收到 play 事件 | 通过 |
| TC-07 | 同曲目重复播放 | 重新触发 play，能再次播放 | 通过：play 事件 1→2 |
| TC-08 | 切换已下载曲目 | 当前曲目切到第二首并播放 | 通过：title=本地测试音 B |
| TC-09 | 本地进度拖动 | currentTime 可设置到 1s 附近 | 通过：currentTime≈1.74，收到 seeked |
| TC-10 | 播放/暂停切换 | paused 状态在 true/false 间切换 | 通过 |
| TC-11 | 下一首 | 切到队列下一首 | 通过：title=本地测试音 A |
| TC-12 | 上一首 | 回到上一首 | 通过：title=本地测试音 B |
| TC-13 | 音量设置 | 音量 5 时 audio.volume=0.05 | 通过 |
| TC-14 | 静音 | audio.muted=true | 通过 |
| TC-15 | 打开目录自动创建 | 目录不存在时创建并打开成功 | 通过：ok=true 且目录存在 |
| TC-16 | 缺失文件异常 | 触发 error 且 audio.paused=true，不崩溃 | 通过：error code 4，paused=true |

## P1 扩展用例（本轮不强制）

| 编号 | 功能点 | 说明 |
| --- | --- | --- |
| TC-17 | 在线音源播放 | 依赖 B 站 API 风控与登录态，单独验证 |
| TC-18 | 歌词同步 | 依赖 QQ 音乐歌词接口可用性 |
| TC-19 | 自动连播 / 循环模式 | 可用短音频补测 ended 事件 |
| TC-20 | 随机播放 / 队列排序 | 纯前端状态，建议补单元层测试 |
| TC-21 | MediaSession / 托盘控制 | 依赖系统媒体会话与托盘窗口 |
| TC-22 | 重启恢复播放状态 | 需跨进程重启验证持久化 |

## 缺陷记录与修复

| 编号 | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| BUG-01 | 打开目录 / 打开文件无反应 | preload 未暴露顶层 `openPath` | 顶层桥接 + 旧桥接兼容 + 目录自动创建 |
| BUG-02 | 播放本地文件无反应 | `media:///` 缺少 host，Chromium 媒体安全检查拒绝加载（`Media load rejected by URL safety check`） | 改为 `media://local/<encoded-path>` |
| BUG-03 | 同一曲目重复点击播放无反应 | 音频加载 effect 只依赖 `currentTrack.id/bvid`，同 id 不重新触发 | 增加 `playToken` 强制重载 |
| BUG-04 | 音频加载失败后 UI 仍显示播放中 | `error` 回调只改 React state，未暂停 audio 元素 | `onError` 中调用 `audio.pause()` |
| BUG-05 | 打包版本地音频 `duration=Infinity`，进度无法拖动 | `media://` 响应缺少 `Content-Length` / `Accept-Ranges`，Chromium 当作无限流 | media handler 显式返回文件长度、MIME、Range 206 响应 |
