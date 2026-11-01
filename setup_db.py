#!/usr/bin/env python3
"""一次性腳本：在指定的 Notion 頁面底下建立「收藏庫」資料庫。

用法：
    python3 setup_db.py <Notion 頁面連結或 page ID>

成功後會把 COLLECTION_DB_ID 寫進同目錄 .env，之後 worker 與 collect.py 共用。
"""
import os
import re
import sys
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


# 憑證放同目錄 .env
_load_env_file(SCRIPT_DIR / ".env")

NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")
HEADERS = {
    "Authorization": f"Bearer {NOTION_TOKEN}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
}

# 資料庫欄位規格（與 worker.js、collect.py 的欄位名必須一致）
DB_SCHEMA = {
    "標題": {"title": {}},
    "URL": {"url": {}},
    "分類": {
        "select": {
            "options": [
                {"name": "AI 應用", "color": "purple"},
                {"name": "美食", "color": "orange"},
                {"name": "旅遊景點", "color": "blue"},
                {"name": "居家裝潢", "color": "green"},
                {"name": "食譜", "color": "yellow"},
                {"name": "購物清單", "color": "pink"},
                {"name": "學習", "color": "red"},
                {"name": "零售相關", "color": "brown"},
                {"name": "追劇清單", "color": "gray"},
            ]
        }
    },
    "圖片": {"files": {}},
    "摘要": {"rich_text": {}},
    "備註": {"rich_text": {}},
    "分享者": {"select": {}},
    "收藏日期": {"date": {}},
    "狀態": {
        "select": {
            "options": [
                {"name": "待整理", "color": "red"},
                {"name": "已整理", "color": "green"},
            ]
        }
    },
}


def extract_page_id(s: str) -> str:
    """從 Notion 連結或原始字串抽出 32 碼 page ID"""
    # 取最後一段獨立的 32 碼（可含 UUID 連字號）；先拿掉連字號再找會把標題結尾的 a-f 字母誤併進 ID
    ids = re.findall(
        r"(?<![0-9a-f])([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})(?![0-9a-f])",
        s.lower(),
    )
    if not ids:
        sys.exit(f"認不出 page ID：{s}")
    h = ids[-1].replace("-", "")
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def main():
    if not NOTION_TOKEN:
        sys.exit("找不到 NOTION_TOKEN（請設定 .env）")
    if len(sys.argv) < 2:
        sys.exit("用法：python3 setup_db.py <Notion 頁面連結>")

    page_id = extract_page_id(sys.argv[1])
    res = requests.post(
        "https://api.notion.com/v1/databases",
        headers=HEADERS,
        json={
            "parent": {"type": "page_id", "page_id": page_id},
            "is_inline": True,  # 內嵌在頁面上直接可見，不要多一層子頁面
            "title": [{"type": "text", "text": {"content": "📥 收藏庫"}}],
            "properties": DB_SCHEMA,
        },
        timeout=30,
    )
    if res.status_code != 200:
        sys.exit(f"建立失敗 {res.status_code}：{res.text[:500]}\n（401/404 多半是頁面沒分享給 integration）")

    db_id = res.json()["id"].replace("-", "")

    # 寫回 .env（已有 COLLECTION_DB_ID 就換掉，沒有就追加）
    env_path = SCRIPT_DIR / ".env"
    lines = env_path.read_text().splitlines() if env_path.exists() else []
    lines = [l for l in lines if not l.startswith("COLLECTION_DB_ID=")]
    lines.append(f"COLLECTION_DB_ID={db_id}")
    env_path.write_text("\n".join(lines) + "\n")

    print(f"✅ 資料庫已建立：https://www.notion.so/{db_id}")
    print(f"✅ COLLECTION_DB_ID 已寫入 {env_path}")
    print("下一步：把這個 ID 設進 Cloudflare Worker 的 NOTION_DATABASE_ID secret")


if __name__ == "__main__":
    main()
