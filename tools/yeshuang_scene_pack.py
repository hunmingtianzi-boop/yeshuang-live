"""Validate and extend the manifest-driven Ye Shuang scene video pack."""

from __future__ import annotations

import argparse
import hashlib
import json
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
            expected_duration = float(clip.get("duration_seconds", 0) or 0)
            if expected_duration and abs(metadata["duration"] - expected_duration) > 0.12:
                errors.append(
                    f"{clip_id} 时长与 manifest 不一致："
                    f"{metadata['duration']:.2f}s / {expected_duration:.2f}s。"
                )
            expected_hash = str(clip.get("sha256", "")).lower()
            if expected_hash and sha256(path) != expected_hash:
                errors.append(f"{clip_id} SHA256 与 manifest 不一致。")
        except (OSError, RuntimeError, ValueError) as exc:
            errors.append(f"{clip_id or prefix} 校验失败：{exc}")
    return errors


def add_clip(args: argparse.Namespace) -> None:
    source = Path(args.source).expanduser().resolve()
    if not source.is_file():
        raise ValueError(f"找不到源视频：{source}")
    if not CLIP_ID_PATTERN.fullmatch(args.id):
        raise ValueError("动作 ID 只能使用小写字母、数字和短横线。")
    if args.state not in ALLOWED_STATES:
        raise ValueError(f"状态必须是：{', '.join(sorted(ALLOWED_STATES))}")

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
    manifest = load_manifest()
    clips = manifest.setdefault("clips", [])
    if not isinstance(clips, list):
        raise ValueError("manifest.json 的 clips 不是数组。")
    clips[:] = [clip for clip in clips if not isinstance(clip, dict) or clip.get("id") != args.id]
    clips.append(
        {
            "id": args.id,
            "state": args.state,
            "action": args.action,
            "src": f"{PACK_URL_PREFIX}clips/{args.state}/{args.id}.mp4",
            "enabled": True,
            "playback": args.playback,
            "weight": max(1, args.weight),
            "duration_seconds": round(metadata["duration"], 2),
            "fps": round(metadata["fps"], 3),
            "width": metadata["width"],
            "height": metadata["height"],
            "sha256": sha256(destination),
            "source_note": source.name,
        }
    )
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
    add_parser.add_argument("--weight", type=int, default=1)
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
