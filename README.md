# 夜霜封面 UI 与动作视频协作包

这里保存夜霜 Windows 桌面程序的封面前端设计、统一基准画面和动作视频清单，供视觉与动作同事并行制作素材。

这不是夜霜完整后端，也不会替代原生桌面程序。仓库里的页面用于还原正式版封面、检查动作衔接和验证多尺寸适配；语音、模型、日记、记忆和本地运行时接口仍由主项目提供。

![夜霜统一基准画面](assets/scene-pack/base/yeshuang-base.png)

## 当前已经包含

- 正式封面 UI：夜蓝星光、左侧品牌导航、人物主画面、语音圆和右侧状态栏。
- 统一基准图：`1536 × 1024`，所有动作视频必须以它为首尾视觉基准。
- 一段正常速度的待机眨眼 `idle-blink-01`，以及一段保留原始慢节奏的慵懒合眼 `idle-drowsy-01`。
- 清单驱动的动作播放器：按状态选片、权重随机、避免连续重复、动作之间回到基准图。
- 素材导入与校验工具：自动统一分辨率、帧率、编码并更新 `manifest.json`。
- 完整前端与动作要求：[docs/FRONTEND_UI_REQUIREMENTS.md](docs/FRONTEND_UI_REQUIREMENTS.md)。
- 协作提交流程：[CONTRIBUTING.md](CONTRIBUTING.md)。

## 本地预览

请在仓库根目录启动一个静态文件服务：

```powershell
python -m http.server 8000
```

然后访问 `http://127.0.0.1:8000/`。不要直接双击 `index.html`，浏览器的本地文件安全策略会阻止读取动作清单。

预览版没有主项目的本地 API，因此日记、模型、语音等面板会显示“无法连接本地运行时”；封面布局、星光、语音圆、响应式适配和清单动作仍可正常检查。

## 添加一段动作

1. 把原始视频放进 `assets/scene-pack/incoming/`。
2. 安装一次工具依赖：

```powershell
python -m pip install -r requirements.txt
```

3. 导入素材，例如：

```powershell
python tools/yeshuang_scene_pack.py add `
  --source "assets/scene-pack/incoming/yeshuang-listening-01.mp4" `
  --id "listening-focus-01" `
  --state "listening" `
  --action "focus"
```

4. 完整校验：

```powershell
python tools/yeshuang_scene_pack.py validate
```

5. 启动预览，分别检查 `820×600`、`1040×680`、`1460×900` 和 `2560×1440`。

动作状态可使用：

| 状态 | 用途 | 例子 |
|---|---|---|
| `idle` | 无交互时的自然微动作 | 眨眼、呼吸、发丝轻动、轻微换眼神 |
| `listening` | 用户正在说话 | 注视、轻轻侧头、微微靠近 |
| `thinking` | 夜霜组织回复 | 目光短暂移开、若有所思 |
| `speaking` | 夜霜正在朗读 | 自然口型、轻微表情和小幅手势 |
| `emotion` | 对话触发的情绪动作 | 浅笑、担心、惊讶、害羞、轻叹 |

## 关键文件

```text
index.html                         封面和七个功能页的 DOM
styles.css                         正式视觉、断点和动效
app.js                             UI 状态与清单驱动动作播放器
assets/scene-pack/manifest.json    唯一动作注册表
assets/scene-pack/base/            统一基准图
assets/scene-pack/clips/           已验收动作
assets/scene-pack/incoming/        待处理素材，不提交原始大文件
tools/yeshuang_scene_pack.py       导入、转码、登记和校验
docs/FRONTEND_UI_REQUIREMENTS.md   必须遵守的前端与视频规范
```

## 最重要的三条

1. 不改人物构图、镜头和比例；所有视频都以统一基准图自然开始和结束。
2. 不用黑框遮水印，不在前端缩放视频；水印、字幕、黑边必须在素材阶段干净处理。
3. 不在页面里手写新视频标签；只把成片登记到 `manifest.json`。
