"""
B站批量深度归档：按条件选收件箱视频笔记，逐条调引擎（断点续跑，跳过已有 deep_archived_at 的）。
调用示例：python bili-batch-deep-archive.py --limit 30
          python bili-batch-deep-archive.py                # 全量剩余
          python bili-batch-deep-archive.py --dry-run      # 只统计
运维保护：视频缓存放 D 盘（BILI_VIDEO_WORKDIR 可覆盖），成功即删缓存（每条 ~20-50MB）。
前置：无需桥接（yt-dlp 匿名下载公开视频）；Ollama 运行中（转写后图注 + 分类刷新走 11434）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_VAULT = os.environ.get("BILIBILI_OBSIDIAN_VAULT") or r"D:\NOTE"
ENGINE_PY = os.environ.get("BVL_ENGINE_PYTHON") or os.path.expanduser(
    "~/.agents/skills/bilibili-video-learning/.venv-gpu/Scripts/python.exe")
ENGINE_SCRIPT = os.environ.get("BVL_ENGINE_SCRIPT") or os.path.expanduser(
    "~/.agents/skills/bilibili-video-learning/scripts/bilibili_deep_archive.py")
VISION_URL = os.environ.get("DOUYIN_VIDEO_VISION_URL") or "http://127.0.0.1:11434/v1"
VISION_MODEL = "qwen2.5vl:3b"
AI_MODEL = "qwen2.5:3b"
WORK_ROOT = Path(os.environ.get("BILI_VIDEO_WORKDIR") or r"D:\BiliMediaWork")


def frontmatter(text: str) -> dict:
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    fm = {}
    if m:
        for line in m.group(1).split("\n"):
            mm = re.match(r"^([A-Za-z_][\w]*):\s*(.*)$", line)
            if mm:
                fm[mm.group(1)] = mm.group(2).strip().strip('"')
    return fm


def load_categories(vault: Path) -> str:
    """分类列表：优先 douyin-vault-link（2.0.0 起自持设置），回落 douyin-sync（1.x 兼容）。"""
    for plugin in ("douyin-vault-link", "douyin-sync"):
        p = vault / ".obsidian" / "plugins" / plugin / "data.json"
        if not p.exists():
            continue
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        cats = [x.strip() for x in re.split(r"[\n,，;；]", (d.get("settings") or {}).get("aiCategories", "")) if x.strip()]
        if cats:
            return ",".join(cats)
    return "成长学习,投资理财,AI编程,心理情感,职场商业,娱乐生活,运动健康,其他（不好分类）"


def main() -> int:
    ap = argparse.ArgumentParser(description="B站批量深度归档（逐条调引擎，断点续跑）")
    ap.add_argument("--vault", default=DEFAULT_VAULT)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--model", default="small")
    ap.add_argument("--timeout", type=int, default=3600, help="单条引擎超时秒数（长视频建议 3600+）")
    ap.add_argument("--sleep", type=int, default=3, help="条间休眠秒数（yt-dlp 限速礼貌间隔）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    vault = Path(args.vault)
    inbox = vault / "00-原始笔记" / "B站归档"
    cats = load_categories(vault)
    todo = []
    for p in sorted(inbox.rglob("*.md")):
        if p.name == "00-说明.md" or "同步日志" in p.name:
            continue
        text = p.read_text(encoding="utf-8")
        fm = frontmatter(text)
        if not fm.get("bvid") or fm.get("type", "视频") != "视频":
            continue
        # 断点续跑依据：真实深度归档必有帧（引擎首帧恒在 t=0）；
        # frames_extracted:0 + deep_archived_at 是旧引擎 metadata-only 更新路径误盖的戳，需重跑覆盖。
        try:
            if int(fm.get("frames_extracted", 0)) > 0:
                continue
        except (TypeError, ValueError):
            pass
        todo.append((p, fm))
    if args.limit:
        todo = todo[: args.limit]

    print(json.dumps({"todo": len(todo), "sample": [p.name[:40] for p, _ in todo[:5]]}, ensure_ascii=False), flush=True)
    if args.dry_run:
        return 0

    ok = failed = 0
    for i, (p, fm) in enumerate(todo, 1):
        t0 = time.time()
        print(f"[{i}/{len(todo)}] START {fm.get('title', p.stem)[:40]}", flush=True)
        try:
            proc = subprocess.run(
                [sys.executable, ENGINE_SCRIPT, "--bvid", str(fm["bvid"]), "--note", str(p),
                 "--vault", str(vault), "--ffmpeg", "ffmpeg",
                 "--max-frames", "24", "--model", args.model,
                 "--workdir", str(WORK_ROOT),
                 "--vision", "--vision-url", VISION_URL, "--vision-model", VISION_MODEL,
                 "--ai-url", VISION_URL, "--ai-model", AI_MODEL, "--categories", cats],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=args.timeout)
            if proc.returncode != 0:
                raise RuntimeError(proc.stderr.strip().split("\n")[-1][:160])
            out = {}
            try:
                out = json.loads(proc.stdout.strip().split("\n").pop())
            except Exception:
                pass
            ok += 1
            shutil.rmtree(WORK_ROOT / str(fm["bvid"]), ignore_errors=True)  # 成功即清视频缓存
            print(f"[{i}/{len(todo)}] OK {out.get('frames', '?')}帧/{out.get('segments', '?')}句 "
                  f"{time.time() - t0:.0f}s", flush=True)
        except Exception as e:
            failed += 1
            print(f"[{i}/{len(todo)}] FAIL {p.name[:36]}: {str(e)[:130]}", flush=True)
        time.sleep(args.sleep)

    print(json.dumps({"ok": True, "done": ok, "failed": failed}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
