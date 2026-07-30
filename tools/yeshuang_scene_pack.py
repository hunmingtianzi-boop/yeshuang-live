"""Validate and extend the manifest-driven Ye Shuang scene video pack."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PACK_ROOT = PROJECT_ROOT / "assets" / "scene-pack"
MANIFEST_PATH = PACK_ROOT / "manifest.json"
PACK_URL_PREFIX = "assets/scene-pack/"
ALLOWED_STATES = {"idle", "listening", "thinking", "speaking", "emotion"}
CLIP_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
CANVAS = (1536, 1024)
TARGET_FPS = 24


def finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def finite_range(value: Any, *, minimum: float = 0, maximum: float | None = None) -> bool:
    if (
        not isinstance(value, list)
        or len(value) != 2
        or not all(finite_number(item) for item in value)
    ):
        return False
    lower, upper = (float(value[0]), float(value[1]))
    return lower >= minimum and upper >= lower and (maximum is None or upper <= maximum)


def load_manifest() -> dict[str, Any]:
    payload = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("manifest.json 必须是 JSON object。")
    return payload


def save_manifest(payload: dict[str, Any]) -> None:
    temporary = MANIFEST_PATH.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, MANIFEST_PATH)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pack_url_to_path(url: str) -> Path:
    if not url.startswith(PACK_URL_PREFIX):
        raise ValueError(f"素材地址必须以 {PACK_URL_PREFIX} 开头：{url}")
    relative = Path(url.removeprefix(PACK_URL_PREFIX))
    resolved = (PACK_ROOT / relative).resolve()
    try:
        resolved.relative_to(PACK_ROOT.resolve())
    except ValueError as exc:
        raise ValueError(f"素材地址越过了工作包目录：{url}") from exc
    return resolved


def png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as stream:
        header = stream.read(24)
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"不是有效 PNG：{path}")
    return struct.unpack(">II", header[16:24])


def video_metadata(path: Path) -> dict[str, Any]:
    try:
        import imageio_ffmpeg
    except ImportError as exc:
        raise RuntimeError("缺少 imageio-ffmpeg，请先执行 pip install imageio-ffmpeg。") from exc

    reader = imageio_ffmpeg.read_frames(str(path), pix_fmt="rgb24")
    try:
        metadata = next(reader)
    finally:
        reader.close()
    size = metadata.get("size") or metadata.get("source_size") or (0, 0)
    return {
        "width": int(size[0]),
        "height": int(size[1]),
        "fps": float(metadata.get("fps", 0) or 0),
        "duration": float(metadata.get("duration", 0) or 0),
        "codec": str(metadata.get("codec", "") or ""),
        "pix_fmt": str(metadata.get("pix_fmt", "") or ""),
    }


def ffmpeg_executable() -> str:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        executable = shutil.which("ffmpeg")
        if executable:
            return executable
    raise RuntimeError("没有找到 FFmpeg，请安装 imageio-ffmpeg 或把 ffmpeg 加入 PATH。")


def validate_pack() -> list[str]:
    manifest = load_manifest()
    errors: list[str] = []
    base = manifest.get("base")
    if not isinstance(base, dict):
        errors.append("缺少 base 配置。")
    else:
        try:
            base_path = pack_url_to_path(str(base.get("src", "")))
            if not base_path.is_file():
                errors.append(f"基准图不存在：{base_path}")
            else:
                if png_size(base_path) != CANVAS:
                    errors.append(f"基准图必须为 {CANVAS[0]}×{CANVAS[1]}。")
                expected_hash = str(base.get("sha256", "")).lower()
                if expected_hash and sha256(base_path) != expected_hash:
                    errors.append("基准图 SHA256 与 manifest 不一致。")
        except (OSError, ValueError) as exc:
            errors.append(str(exc))

    layout = manifest.get("layout", {})
    if not isinstance(layout, dict):
        errors.append("layout 必须是 object。")
    else:
        presence_roi = layout.get("presence_roi")
        if presence_roi is not None:
            if not isinstance(presence_roi, dict):
                errors.append("layout.presence_roi 必须是 object。")
            else:
                roi_values: dict[str, list[float]] = {}
                for field in ("enter", "exit"):
                    value = presence_roi.get(field)
                    valid = (
                        isinstance(value, list)
                        and len(value) == 4
                        and all(finite_number(item) and 0 <= float(item) <= 1 for item in value)
                        and float(value[0]) < float(value[2])
                        and float(value[1]) < float(value[3])
                    )
                    if not valid:
                        errors.append(f"layout.presence_roi.{field} 必须是有效的归一化 [左, 上, 右, 下]。")
                    else:
                        roi_values[field] = [float(item) for item in value]
                if "enter" in roi_values and "exit" in roi_values:
                    enter, exit_bounds = roi_values["enter"], roi_values["exit"]
                    if not (
                        exit_bounds[0] <= enter[0]
                        and exit_bounds[1] <= enter[1]
                        and exit_bounds[2] >= enter[2]
                        and exit_bounds[3] >= enter[3]
                    ):
                        errors.append("layout.presence_roi.exit 必须完整包住 enter，形成退出缓冲区。")

    playback = manifest.get("playback", {})
    if not isinstance(playback, dict):
        errors.append("playback 必须是 object。")
    else:
        if not finite_range(playback.get("idle_gap_ms", [3500, 9000])):
            errors.append("playback.idle_gap_ms 必须是有效的非负毫秒范围。")
        idle_skip_chance = playback.get("idle_skip_chance", 0.3)
        if not finite_number(idle_skip_chance) or not 0 <= float(idle_skip_chance) <= 1:
            errors.append("playback.idle_skip_chance 必须在 0–1 之间。")
        if not finite_range(
            playback.get("idle_playback_rate", [0.96, 1.04]),
            minimum=0.5,
            maximum=2,
        ):
            errors.append("playback.idle_playback_rate 必须是 0.5–2 之间的有效范围。")
        for field in ("presence_initial_delay_ms", "presence_cooldown_ms"):
            if not finite_range(playback.get(field, [0, 0])):
                errors.append(f"playback.{field} 必须是有效的非负毫秒范围。")
        presence_actions = playback.get("presence_actions", ["glance"])
        if (
            not isinstance(presence_actions, list)
            or not presence_actions
            or not all(isinstance(action, str) and action.strip() for action in presence_actions)
        ):
            errors.append("playback.presence_actions 必须是非空动作名数组。")
        away_threshold = playback.get("presence_away_threshold_ms", 8000)
        if not finite_number(away_threshold) or float(away_threshold) < 0:
            errors.append("playback.presence_away_threshold_ms 必须是非负数字。")
        mode_gaps = playback.get("mode_gap_ms", {})
        if not isinstance(mode_gaps, dict):
            errors.append("playback.mode_gap_ms 必须是 object。")
        else:
            for mode, bounds in mode_gaps.items():
                if mode not in {"listening", "thinking", "speaking"} or not finite_range(bounds):
                    errors.append(f"playback.mode_gap_ms.{mode} 不是有效的状态停顿范围。")

    clips = manifest.get("clips")
    if not isinstance(clips, list):
        return errors + ["clips 必须是数组。"]

    seen_ids: set[str] = set()
    for index, clip in enumerate(clips):
        prefix = f"clips[{index}]"
        if not isinstance(clip, dict):
            errors.append(f"{prefix} 不是 object。")
            continue
        clip_id = str(clip.get("id", ""))
        state = str(clip.get("state", ""))
        if not CLIP_ID_PATTERN.fullmatch(clip_id):
            errors.append(f"{prefix}.id 不符合小写短横线命名规则：{clip_id}")
        if clip_id in seen_ids:
            errors.append(f"动作 ID 重复：{clip_id}")
        seen_ids.add(clip_id)
        if state not in ALLOWED_STATES:
            errors.append(f"{clip_id or prefix} 的 state 无效：{state}")
        weight = clip.get("weight", 1)
        if not finite_number(weight) or float(weight) <= 0:
            errors.append(f"{clip_id or prefix} 的 weight 必须是大于 0 的数字。")
        cooldown_seconds = clip.get("cooldown_seconds")
        if cooldown_seconds is not None and (
            not finite_number(cooldown_seconds) or float(cooldown_seconds) < 0
        ):
            errors.append(f"{clip_id or prefix} 的 cooldown_seconds 必须是非负数字。")
        gap_after = clip.get("gap_after_ms")
        if gap_after is not None:
            if (
                not isinstance(gap_after, list)
                or len(gap_after) != 2
                or not all(finite_number(value) for value in gap_after)
                or float(gap_after[0]) < 0
                or float(gap_after[1]) < float(gap_after[0])
            ):
                errors.append(f"{clip_id or prefix} 的 gap_after_ms 必须是有效的 [最短, 最长] 毫秒范围。")
        try:
            path = pack_url_to_path(str(clip.get("src", "")))
            if not path.is_file():
                errors.append(f"{clip_id or prefix} 的视频不存在：{path}")
                continue
            metadata = video_metadata(path)
            if (metadata["width"], metadata["height"]) != CANVAS:
                errors.append(f"{clip_id} 必须为 {CANVAS[0]}×{CANVAS[1]}。")
            if min(abs(metadata["fps"] - 24), abs(metadata["fps"] - 30)) > 0.05:
                errors.append(f"{clip_id} 帧率必须为 24 或 30 FPS，当前为 {metadata['fps']:.3f}。")
            if metadata["codec"].lower() != "h264":
                errors.append(f"{clip_id} 编码必须为 H.264，当前为 {metadata['codec'] or '未知'}。")
            if not metadata["pix_fmt"].lower().startswith("yuv420p"):
                errors.append(
                    f"{clip_id} 像素格式必须为 yuv420p，"
                    f"当前为 {metadata['pix_fmt'] or '未知'}。"
                )
            expected_duration = float(clip.get("duration_seconds", 0) or 0)
            if expected_duration and abs(metadata["duration"] - expected_duration) > 0.12:
                errors.append(
                    f"{clip_id} 时长与 manifest 不一致："
                    f"{metadata['duration']:.2f}s / {expected_duration:.2f}s。"
                )
            action_window = clip.get("action_window_seconds")
            if (
                not isinstance(action_window, list)
                or len(action_window) != 2
                or not all(isinstance(value, (int, float)) for value in action_window)
            ):
                errors.append(f"{clip_id} 缺少有效的 action_window_seconds。")
            else:
                action_start = float(action_window[0])
                action_end = float(action_window[1])
                duration = float(metadata["duration"])
                if action_start < 0 or action_end <= action_start or action_end > duration + 0.05:
                    errors.append(
                        f"{clip_id} 的动作时间窗无效："
                        f"{action_start:.2f}s–{action_end:.2f}s / {duration:.2f}s。"
                    )
            expected_hash = str(clip.get("sha256", "")).lower()
            if expected_hash and sha256(path) != expected_hash:
                errors.append(f"{clip_id} SHA256 与 manifest 不一致。")
        except (OSError, RuntimeError, ValueError) as exc:
            errors.append(f"{clip_id or prefix} 校验失败：{exc}")
    if isinstance(playback, dict):
        configured_presence_actions = playback.get("presence_actions", ["glance"])
        if isinstance(configured_presence_actions, list):
            idle_actions = {
                str(clip.get("action", ""))
                for clip in clips
                if isinstance(clip, dict)
                and clip.get("state") == "idle"
                and clip.get("enabled", True) is not False
            }
            for action in configured_presence_actions:
                if isinstance(action, str) and action and action not in idle_actions:
                    errors.append(f"presence_actions 引用了不存在的 idle 动作：{action}")
    return errors


def add_clip(args: argparse.Namespace) -> None:
    source = Path(args.source).expanduser().resolve()
    if not source.is_file():
        raise ValueError(f"找不到源视频：{source}")
    if not CLIP_ID_PATTERN.fullmatch(args.id):
        raise ValueError("动作 ID 只能使用小写字母、数字和短横线。")
    if args.state not in ALLOWED_STATES:
        raise ValueError(f"状态必须是：{', '.join(sorted(ALLOWED_STATES))}")
    if (args.action_start is None) != (args.action_end is None):
        raise ValueError("--action-start 与 --action-end 必须同时提供。")
    if args.cooldown_seconds is not None and (
        not math.isfinite(args.cooldown_seconds) or args.cooldown_seconds < 0
    ):
        raise ValueError("--cooldown-seconds 必须是非负数字。")
    if (args.gap_after_min is None) != (args.gap_after_max is None):
        raise ValueError("--gap-after-min 与 --gap-after-max 必须同时提供。")
    if args.gap_after_min is not None and (
        args.gap_after_min < 0 or args.gap_after_max < args.gap_after_min
    ):
        raise ValueError("动作后的停顿必须满足 0 <= min <= max。")

    source_metadata = video_metadata(source)
    source_ratio = source_metadata["width"] / max(1, source_metadata["height"])
    target_ratio = CANVAS[0] / CANVAS[1]
    if abs(source_ratio - target_ratio) > 0.015:
        raise ValueError(
            f"源视频比例为 {source_metadata['width']}×{source_metadata['height']}，"
            "请先生成或裁成 3:2，导入工具不会自动裁掉人物。"
        )

    destination_dir = PACK_ROOT / "clips" / args.state
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / f"{args.id}.mp4"
    if destination.exists() and not args.force:
        raise ValueError(f"目标已存在：{destination}；如需覆盖请加 --force。")

    command = [
        ffmpeg_executable(),
        "-y",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        str(source),
        "-vf",
        f"scale={CANVAS[0]}:{CANVAS[1]}:flags=lanczos,fps={TARGET_FPS},format=yuv420p",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-movflags",
        "+faststart",
        "-map_metadata",
        "-1",
        str(destination),
    ]
    subprocess.run(command, check=True)
    metadata = video_metadata(destination)
    action_window: list[float] | None = None
    if args.action_start is not None and args.action_end is not None:
        action_start = round(float(args.action_start), 2)
        action_end = round(float(args.action_end), 2)
        if action_start < 0 or action_end <= action_start:
            raise ValueError("动作时间窗必须满足 0 <= start < end。")
        if action_end > float(metadata["duration"]) + 0.05:
            raise ValueError(
                f"动作结束时间 {action_end:.2f}s 超过视频时长 {metadata['duration']:.2f}s。"
            )
        action_window = [action_start, action_end]
    manifest = load_manifest()
    clips = manifest.setdefault("clips", [])
    if not isinstance(clips, list):
        raise ValueError("manifest.json 的 clips 不是数组。")
    clips[:] = [clip for clip in clips if not isinstance(clip, dict) or clip.get("id") != args.id]
    clip_record = {
        "id": args.id,
        "state": args.state,
        "action": args.action,
        "src": f"{PACK_URL_PREFIX}clips/{args.state}/{args.id}.mp4",
        "enabled": True,
        "playback": args.playback,
        "weight": round(max(0.01, args.weight), 3),
        "duration_seconds": round(metadata["duration"], 2),
        "fps": round(metadata["fps"], 3),
        "width": metadata["width"],
        "height": metadata["height"],
        "sha256": sha256(destination),
        "source_note": args.source_note or source.name,
    }
    if action_window is not None:
        clip_record["action_window_seconds"] = action_window
    if args.cooldown_seconds is not None:
        clip_record["cooldown_seconds"] = round(args.cooldown_seconds, 2)
    if args.gap_after_min is not None and args.gap_after_max is not None:
        clip_record["gap_after_ms"] = [args.gap_after_min, args.gap_after_max]
    clips.append(clip_record)
    clips.sort(key=lambda clip: (str(clip.get("state", "")), str(clip.get("id", ""))))
    save_manifest(manifest)
    print(f"已加入动作：{args.id}")
    print(f"输出：{destination}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="管理夜霜动作视频工作包。")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("validate", help="校验底图、视频规格、哈希和清单。")

    add_parser = subparsers.add_parser("add", help="规范化一个视频并写入 manifest。")
    add_parser.add_argument("--source", required=True, help="待导入的视频路径。")
    add_parser.add_argument("--id", required=True, help="例如 listening-nod-01。")
    add_parser.add_argument("--state", required=True, choices=sorted(ALLOWED_STATES))
    add_parser.add_argument("--action", required=True, help="动作短名，例如 nod。")
    add_parser.add_argument("--playback", choices=("once", "loop"), default="once")
    add_parser.add_argument("--weight", type=float, default=1)
    add_parser.add_argument("--action-start", type=float, required=True, help="真实动作开始时间（秒）。")
    add_parser.add_argument("--action-end", type=float, required=True, help="真实动作结束时间（秒）。")
    add_parser.add_argument("--cooldown-seconds", type=float, help="同类动作再次出现前的冷却秒数。")
    add_parser.add_argument("--gap-after-min", type=int, help="动作结束后的最短停顿（毫秒）。")
    add_parser.add_argument("--gap-after-max", type=int, help="动作结束后的最长停顿（毫秒）。")
    add_parser.add_argument("--source-note", help="素材来源或授权说明。")
    add_parser.add_argument("--force", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "validate":
            errors = validate_pack()
            if errors:
                print("动作视频包校验失败：", file=sys.stderr)
                for error in errors:
                    print(f"- {error}", file=sys.stderr)
                return 1
            manifest = load_manifest()
            enabled = sum(
                1
                for clip in manifest.get("clips", [])
                if isinstance(clip, dict) and bool(clip.get("enabled", True))
            )
            print(f"动作视频包校验通过：{enabled} 个启用动作。")
            return 0
        add_clip(args)
        errors = validate_pack()
        if errors:
            for error in errors:
                print(f"- {error}", file=sys.stderr)
            return 1
        return 0
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"处理失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
