# bilibili-vault-link（B站 × 笔记库桥接）

Obsidian 伴生插件：把 B 站视频接入「Learning Vault」式知识库——粘贴 BV/av/b23 链接即归档，深度归档产出「关键帧 × 本地转写」的图文对照笔记，逐帧配本地视觉模型图注。

深度归档采用**单一引擎**架构：本插件是 [bilibili-video-learning](https://github.com/Confidence-huang/bilibili-douyin-video-learning) 技能 `bilibili_deep_archive.py` 的薄客户端（与 douyin 版 `douyin-vault-link` 同构，算法与图文对照契约完全共享）。

```text
Obsidian 命令（薄客户端）──> bilibili_deep_archive.py（唯一引擎，本地 GPU）
  yt-dlp 取视频(<=720p, 匿名可用) → 场景打分自适应抽帧(≤24帧) → faster-whisper 转写
  → 时间对齐图文对照 → Ollama 逐帧图注 → 收件箱笔记（bvid 契约，幂等重跑）
```

## 功能

- **粘贴链接归档**：BV 号 / av 号 / 网页链接 / b23.tv 分享短链，单条/多条，无需先建笔记；公开视频**匿名可用**；
- **深度归档**：打开笔记执行 → 引擎全流程（下载 → ≤24 关键帧 → 本地 faster-whisper → 逐帧图注）；
- **新笔记自动深度归档**（开关，默认关）：粘贴归档完成自动接引擎；
- **打开B站归档收件箱**。

## 安装

1. 安装并配置 [bilibili-video-learning](https://github.com/Confidence-huang/bilibili-douyin-video-learning) 技能（含 `.venv-gpu` 环境，≥1.4.0）；
2. 拷贝 `main.js`、`manifest.json` 到 `<vault>/.obsidian/plugins/bilibili-vault-link/`，启用；
3. 可选：本地 Ollama + qwen2.5vl:3b（帧图注）；会员/高清视频提供 yt-dlp cookies 文件路径。

## 设置

| 设置 | 说明 |
| --- | --- |
| B站归档收件箱 | 默认 `00-原始笔记/B站归档`（可用环境变量 `BILIBILI_OBSIDIAN_VAULT`/`_FOLDER` 定向） |
| 引擎 Python / 转写模型 / 帧数 | 引擎运行参数 |
| 视觉端点 / 模型 | 默认本机 Ollama `http://127.0.0.1:11434/v1` + `qwen2.5vl:3b` |
| B站 Cookies 文件 | 会员/高清视频的 yt-dlp cookies（普通公开视频不需要） |

## 命令行入口（与 Obsidian 命令同一引擎）

```bash
python scripts/bilibili_deep_archive.py --url "https://b23.tv/xxxx" --vault "D:/你的库" --vision
```

## 致谢

- [BiliNote](https://github.com/JefferyHcool/BiliNote)：管道化设计参考；
- [Learning-Vault-Skills](https://github.com/Serral828/Learning-Vault-Skills)：知识库工作流与授权边界；
- 姊妹项目 [douyin-vault-link](https://github.com/Confidence-huang/douyin-vault-link)（抖音版，同一架构）。

## License

Apache-2.0
