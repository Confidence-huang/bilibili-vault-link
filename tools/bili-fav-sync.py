"""
B站收藏夹同步编排器：枚举全部收藏夹的视频，对新视频调用引擎 --metadata-only
（建笔记 + AI 本地分类），目录镜像 B站收藏夹结构。断点续跑（已有的跳过）。
前置：bili-folders.json（夹清单缓存）+ %TEMP%\\bili-cookies.txt（SESSDATA，仅用于列表分页）。
调用示例：python bili-fav-sync.py --dry-run     /     python bili-fav-sync.py            # 全量
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

VAULT = Path(os.environ.get("BILIBILI_OBSIDIAN_VAULT") or r"D:\NOTE")
INBOX_BASE = VAULT / "00-原始笔记" / "B站归档"
TOOLS = Path(__file__).parent
ENGINE_PY = os.environ.get("BVL_ENGINE_PYTHON") or os.path.expanduser(
    "~/.agents/skills/bilibili-video-learning/.venv-gpu/Scripts/python.exe")
ENGINE_SCRIPT = os.environ.get("BVL_ENGINE_SCRIPT") or os.path.expanduser(
    "~/.agents/skills/bilibili-video-learning/scripts/bilibili_deep_archive.py")
BRIDGELESS_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Referer": "https://www.bilibili.com/",
}


BILI_BRIDGE = os.environ.get("BILI_VIDEO_BRIDGE") or "http://127.0.0.1:8766"


def bridge_get_json(url: str):
    """活会话路线：桥接页面内 fetch（Cookie 自动携带与续期）。"""
    req = urllib.request.Request(BILI_BRIDGE.rstrip("/") + "/req",
                                 data=json.dumps({"url": url, "method": "GET"}).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    out = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
    if out.get("status") != 200:
        raise RuntimeError(f"bridge upstream {out.get('status')}")
    return json.loads(out.get("text") or "{}")


def get_json(url: str):
    import time as _t
    cookie = ""
    ck = Path(os.environ.get("TEMP", "/tmp")) / "bili-cookies.txt"
    if ck.exists():
        cookie = ck.read_text(encoding="utf-8").strip()
    headers = dict(BRIDGELESS_HEADERS)
    if cookie:
        headers["Cookie"] = cookie
    try:
        return bridge_get_json(url)  # 首选活会话桥接
    except Exception as e:
        print(f"    [bridge] 桥接失败回落静态 Cookie：{str(e)[:60]}", flush=True)
    last = None
    for attempt in range(5):  # 412/超时 → 30s 起步指数退避，B站风控冷却
        try:
            req = urllib.request.Request(url, headers=headers)
            return json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (412, 429, 503):
                wait = 30 * (2 ** attempt)
                print(f"    [rate] HTTP {e.code}，退避 {wait}s...", flush=True)
                _t.sleep(wait)
                continue
            raise
        except Exception as e:
            last = e
            _t.sleep(10)
    raise last


def load_categories() -> list[str]:
    """分类列表：优先 douyin-vault-link（2.0.0 起自持设置），回落 douyin-sync（1.x 兼容）。"""
    for plugin in ("douyin-vault-link", "douyin-sync"):
        p = VAULT / ".obsidian" / "plugins" / plugin / "data.json"
        if not p.exists():
            continue
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        cats = [x.strip() for x in re.split(r"[\n,，;；]", (d.get("settings") or {}).get("aiCategories", "")) if x.strip()]
        if cats:
            return cats
    return []


def main() -> int:
    ap = argparse.ArgumentParser(description="B站收藏夹批量同步（元数据+AI分类，不下载视频）")
    ap.add_argument("--folders", default=None, help="逗号分隔只同步这些夹名；空=全部")
    ap.add_argument("--limit", type=int, default=0, help="最多处理 N 条（0=不限）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    folders = json.loads((TOOLS / "bili-folders.json").read_text(encoding="utf-8"))
    if args.folders:
        want = {x.strip() for x in args.folders.split(",") if x.strip()}
        folders = [f for f in folders if f["title"] in want]
    categories = load_categories()
    cat_arg = ",".join(categories)

    plan = []
    seen_global = set()
    for f in folders:
        cid, name = f["id"], f["title"]
        cursor, n = 0, 0
        folder_dir = INBOX_BASE / name
        existing = set()
        if folder_dir.exists():
            for p in folder_dir.glob("*.md"):
                existing.add(p.name)
        while True:
            d = get_json(f"https://api.bilibili.com/x/v3/fav/resource/list?{ 'device_platform=webapp&aid=6383&channel=channel_pc_web' }"
                         f"&media_id={cid}&pn={cursor // 20 + 1}&ps=20&cursor={cursor}")
            data = d.get("data") or {}
            for mitem in data.get("medias") or []:
                bv = str(mitem.get("bvid") or "")
                if not bv or bv in seen_global:
                    continue
                seen_global.add(bv)
                # 命中判断：该夹目录里任一笔记文件名含 bvid
                hit = any(bv in name_ for name_ in existing)
                if not hit:
                    plan.append({"bvid": bv, "folder": name, "title": str(mitem.get("title") or "")[:60]})
                n += 1
            if not data.get("has_more"):
                break
            cursor = data.get("cursor") or (cursor + 20)
            time.sleep(1.5)  # 页间限速
        print(f"[夹] {name}: {n} 条（新增待建 {sum(1 for x in plan if x['folder'] == name)}）", flush=True)

    print(json.dumps({"folders": len(folders), "total_items": len(seen_global),
                      "to_create": len(plan)}, ensure_ascii=False), flush=True)
    if args.limit:
        plan = plan[: args.limit]
    if args.dry_run:
        return 0

    ok = failed = 0
    for i, item in enumerate(plan, 1):
        inbox_dir = f"00-原始笔记/B站归档/{item['folder']}"
        cmd = [sys.executable, ENGINE_SCRIPT, "--bvid", item["bvid"], "--vault", str(VAULT),
               "--inbox-dir", inbox_dir,
               "--metadata-only", "--ai-url", "http://127.0.0.1:11434/v1",
               "--ai-model", "qwen2.5:3b", "--categories", cat_arg]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
            if proc.returncode != 0:
                raise RuntimeError(proc.stderr.strip().split("\n")[-1][:120])
            ok += 1
        except Exception as e:
            failed += 1
            print(f"[{i}/{len(plan)}] FAIL {item['bvid']} {item['title'][:30]}: {str(e)[:100]}", flush=True)
            continue
        if i % 20 == 0 or i == len(plan):
            print(f"[{i}/{len(plan)}] ok={ok} failed={failed}", flush=True)
        time.sleep(0.4)

    print(json.dumps({"ok": True, "created": ok, "failed": failed}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
