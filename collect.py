#!/usr/bin/env python3
"""收藏庫整理工具（配合 Claude Code 的 /organize-collection 使用；retail 子指令可當 retail-news-pipeline 的額外來源）。

用法：
    python3 collect.py pending [--no-fetch]     # 列出狀態=待整理的項目（JSON），預設會嘗試抓網頁標題/描述
    python3 collect.py update --page-id <id> --title <t> --category <c> [--summary <s>]
                                                # 回寫整理結果並把狀態設為已整理
    python3 collect.py retail [--days 7]        # 列出分類=零售相關、收藏日期在近 N 天的項目（給零售週報當來源）
"""
import argparse
import html
import json
import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).resolve().parent


def _load_env_file(path: Path):
    """從 .env 補載環境變數（不覆蓋已存在的）"""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env_file(SCRIPT_DIR / ".env")

NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")
DB_ID = os.environ.get("COLLECTION_DB_ID", "")
HEADERS = {
    "Authorization": f"Bearer {NOTION_TOKEN}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
}
VALID_CATEGORIES = ["AI 應用", "美食", "旅遊景點", "居家裝潢", "食譜", "購物清單", "學習", "零售相關", "追劇清單"]


def _plain(rich):
    return "".join(t.get("plain_text", "") for t in rich)


def fetch_page_meta(url: str) -> dict:
    """盡力抓網頁的 title 與 description；社群連結（IG/FB/Threads）常抓不到，失敗就回空"""
    try:
        res = requests.get(
            url,
            timeout=8,
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},
            allow_redirects=True,
        )
        text = res.text[:200_000]
    except Exception as e:
        return {"fetch_error": str(e)[:100]}

    meta = {}
    m = re.search(r"<title[^>]*>(.*?)</title>", text, re.I | re.S)
    if m:
        meta["page_title"] = html.unescape(m.group(1)).strip()[:200]
    for prop in ["og:title", "og:description", "description"]:
        m = re.search(
            rf'<meta[^>]+(?:property|name)=["\']{prop}["\'][^>]+content=["\'](.*?)["\']', text, re.I
        ) or re.search(
            rf'<meta[^>]+content=["\'](.*?)["\'][^>]+(?:property|name)=["\']{prop}["\']', text, re.I
        )
        if m:
            meta[prop.replace(":", "_")] = html.unescape(m.group(1)).strip()[:400]
    return meta


def cmd_pending(no_fetch: bool):
    items, cursor = [], None
    while True:
        payload = {"filter": {"property": "狀態", "select": {"equals": "待整理"}}, "page_size": 100}
        if cursor:
            payload["start_cursor"] = cursor
        res = requests.post(
            f"https://api.notion.com/v1/databases/{DB_ID}/query", headers=HEADERS, json=payload, timeout=30
        )
        if res.status_code != 200:
            sys.exit(f"查詢失敗 {res.status_code}：{res.text[:300]}")
        data = res.json()
        for page in data["results"]:
            p = page["properties"]
            item = {
                "page_id": page["id"],
                "url": p.get("URL", {}).get("url"),
                "title": _plain(p.get("標題", {}).get("title", [])),
                "note": _plain(p.get("備註", {}).get("rich_text", [])),
                "sharer": (p.get("分享者", {}).get("select") or {}).get("name", ""),
                "date": (p.get("收藏日期", {}).get("date") or {}).get("start", ""),
            }
            files = p.get("圖片", {}).get("files", [])
            if files:
                f = files[0]
                # Notion 簽名網址約 1 小時失效，整理時要當場下載
                item["image_url"] = (f.get("file") or {}).get("url") or (f.get("external") or {}).get("url")
            if item["url"] and not no_fetch:
                item["meta"] = fetch_page_meta(item["url"])
            items.append(item)
        if not data.get("has_more"):
            break
        cursor = data.get("next_cursor")

    print(json.dumps({"count": len(items), "items": items}, ensure_ascii=False, indent=1))


def cmd_update(args):
    if args.category not in VALID_CATEGORIES:
        sys.exit(f"分類必須是：{VALID_CATEGORIES}")
    props = {
        "標題": {"title": [{"text": {"content": args.title[:200]}}]},
        "分類": {"select": {"name": args.category}},
        "狀態": {"select": {"name": "已整理"}},
    }
    if args.summary:
        props["摘要"] = {"rich_text": [{"text": {"content": args.summary[:1900]}}]}

    res = requests.patch(
        f"https://api.notion.com/v1/pages/{args.page_id}", headers=HEADERS, json={"properties": props}, timeout=30
    )
    if res.status_code != 200:
        sys.exit(f"更新失敗 {res.status_code}：{res.text[:300]}")
    print(f"✅ 已整理：{args.title[:40]}")


def cmd_retail(days: int):
    """零售週報用：撈分類=零售相關、收藏日期在近 N 天的已整理項目"""
    since = (date.today() - timedelta(days=days)).isoformat()
    items, cursor = [], None
    while True:
        payload = {
            "filter": {
                "and": [
                    {"property": "分類", "select": {"equals": "零售相關"}},
                    {"property": "收藏日期", "date": {"on_or_after": since}},
                ]
            },
            "page_size": 100,
        }
        if cursor:
            payload["start_cursor"] = cursor
        res = requests.post(
            f"https://api.notion.com/v1/databases/{DB_ID}/query", headers=HEADERS, json=payload, timeout=30
        )
        if res.status_code != 200:
            sys.exit(f"查詢失敗 {res.status_code}：{res.text[:300]}")
        data = res.json()
        for page in data["results"]:
            p = page["properties"]
            items.append({
                "title": _plain(p.get("標題", {}).get("title", [])),
                "url": p.get("URL", {}).get("url"),
                "summary": _plain(p.get("摘要", {}).get("rich_text", [])),
                "sharer": (p.get("分享者", {}).get("select") or {}).get("name", ""),
                "date": (p.get("收藏日期", {}).get("date") or {}).get("start", ""),
            })
        if not data.get("has_more"):
            break
        cursor = data.get("next_cursor")

    print(json.dumps({"count": len(items), "since": since, "items": items}, ensure_ascii=False, indent=1))


def main():
    if not NOTION_TOKEN or not DB_ID:
        sys.exit("缺 NOTION_TOKEN 或 COLLECTION_DB_ID（先跑 setup_db.py）")

    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("pending")
    p1.add_argument("--no-fetch", action="store_true")

    p2 = sub.add_parser("update")
    p2.add_argument("--page-id", required=True)
    p2.add_argument("--title", required=True)
    p2.add_argument("--category", required=True)
    p2.add_argument("--summary", default="")

    p3 = sub.add_parser("retail")
    p3.add_argument("--days", type=int, default=7)

    args = parser.parse_args()
    if args.cmd == "pending":
        cmd_pending(args.no_fetch)
    elif args.cmd == "retail":
        cmd_retail(args.days)
    else:
        cmd_update(args)


if __name__ == "__main__":
    main()
