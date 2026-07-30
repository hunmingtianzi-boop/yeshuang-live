# 夜霜动作视频工作包

这个目录是夜霜人物场景的唯一素材入口。程序启动时读取 `manifest.json`，自动创建视频层；后续不再修改主页 HTML 来增添动作。

## 目录

```text
scene-pack/
├─ base/
│  └─ yeshuang-base.png       统一首帧与兜底画面
├─ clips/
│  ├─ idle/                   待机、眨眼、呼吸、视线变化
│  ├─ listening/              倾听、轻微点头
│  ├─ thinking/               思考、移开视线
│  ├─ speaking/               自然说话、短句口型
│  └─ emotion/                浅笑、害羞、困倦等低频动作
├─ incoming/                  新生成视频的临时放置区
└─ manifest.json              程序实际读取的动作清单
```

未创建的 `clips` 子目录可以在首次加入对应动作时创建。

## 统一规格

- 画布：`1536 × 1024`，比例 `3:2`
- 帧率：优先 `24 FPS`，允许 `30 FPS`
- 编码：H.264、`yuv420p`、无音轨、`faststart`
- 镜头：固定，不推拉、不缩放、不改变人物位置
- 首帧：必须回到 `base/yeshuang-base.png`
- 尾帧：尽量回到同一姿势；动作片默认播放一次，底图负责动作间停顿
- 禁止：黑边、字幕、平台标志、水印、突然闪现其他人物或 Q 版形象

## 文件命名

使用 `<状态>-<动作>-<两位序号>.mp4`：

- `idle-blink-01.mp4`
- `listening-nod-01.mp4`
- `thinking-glance-away-01.mp4`
- `speaking-natural-01.mp4`
- `emotion-soft-smile-01.mp4`

## 新增流程

1. 把原视频放进 `incoming/`。
2. 使用项目脚本规范化：

   ```powershell
   python tools/yeshuang_scene_pack.py add `
     --source "assets/scene-pack/incoming/新视频.mp4" `
     --id "listening-nod-01" `
     --state "listening" `
     --action "nod" `
     --action-start 0.4 `
     --action-end 3.3 `
     --cooldown-seconds 18 `
     --gap-after-min 1800 `
     --gap-after-max 4200 `
     --source-note "WorkBuddy VideoGen；生成日期与人工验收说明"
   ```

3. 执行 `python tools/yeshuang_scene_pack.py validate`。
4. 刷新协作预览页。正式程序会读取同一份清单，不需要再改界面代码。

`--action-start` 与 `--action-end` 必须登记人工确认后的真实动作时间窗。`--cooldown-seconds` 控制同类动作再次出现前的冷却时间，`--gap-after-min` / `--gap-after-max` 控制该动作结束后的自然停顿；低频动作还可以使用小数 `--weight`（例如微风设为 `0.2`）。播放器会按 `action` 共享冷却、避开最近两类动作，并偶尔继续保持静止，避免机械轮播。

普通眨眼、口型等需要局部变速的素材应先人工确认动作时间窗，再加入工作包；困倦合眼、浅睡等刻意表达慵懒感的动作应保留原始慢节奏，并使用 `drowsy`、`sleepy` 一类动作名，不能登记成普通 `blink`。导入脚本只负责统一画布、帧率、H.264 / `yuv420p` 编码、移除音轨并更新清单，动作本身仍需人工看片验收。

## 自然反应

`manifest.json` 的 `playback` 同时控制人物的非机械节奏：

- `idle_playback_rate`：为待机片加入极轻微速度差异，同一动作不会每次完全等速。
- `presence_actions`：鼠标在主页人物区域活动，或离开窗口一段时间后回来时，可低频触发的回应动作；目前使用 `glance`。
- `presence_initial_delay_ms` / `presence_cooldown_ms`：避免刚打开页面就盯人，也避免视线回应过于频繁。
- `presence_away_threshold_ms`：离开多久后，回来才被视为一次值得回应的“再次出现”。
- `layout.presence_roi`：以基准图归一化坐标登记脸部进入区与更大的退出区；只有指针进入人物附近并短暂停留才算“靠近”。

人物正在说话、倾听、思考、静谧模式或页面不可见时不会触发存在感回应。`breeze` 播放期间星尘会短暂产生横向拖尾；系统启用“减少动态效果”时，动作视频、存在感回应与星尘动画都会保持静止。
