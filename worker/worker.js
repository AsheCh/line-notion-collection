// Cloudflare Worker：LINE 收藏 bot
// 專屬 LINE 群組裡丟含網址的訊息 → 抽出網址 → 寫入 Notion 收藏庫（狀態＝待整理）
// 需要的 secrets（用 npx wrangler secret put 設定）：
//   LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / NOTION_TOKEN / NOTION_DATABASE_ID
// 選用變數：ENABLE_REPLY="0" 可關閉「已收藏」回覆

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("OK"); // 健康檢查用

    // iOS 捷徑端點：不走 LINE、直接收連結（用 SHORTCUT_KEY 驗證）
    if (new URL(request.url).pathname === "/save") {
      return handleShortcutSave(request, env);
    }

    const bodyText = await request.text();
    const ok = await verifySignature(
      bodyText,
      request.headers.get("x-line-signature") || "",
      env.LINE_CHANNEL_SECRET
    );
    if (!ok) return new Response("bad signature", { status: 403 });

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return new Response("bad json", { status: 400 });
    }

    // 先回 200 避免 LINE 判定逾時重送，實際處理放背景
    ctx.waitUntil(handleEvents(body.events || [], env));
    return new Response("OK");
  },
};

// 驗證 LINE 簽章（HMAC-SHA256 + base64）
export async function verifySignature(bodyText, signature, secret) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}

async function handleEvents(events, env) {
  for (const ev of events) {
    if (ev.type !== "message") continue;

    // 圖片訊息：下載 → 上傳 Notion → 建待整理項目
    if (ev.message?.type === "image") {
      await handleImage(ev, env);
      continue;
    }
    if (ev.message?.type !== "text") continue;

    const text = (ev.message.text || "").trim();
    const urls = text.match(/https?:\/\/[^\s]+/g) || [];
    if (urls.length === 0) {
      // 沒網址：可能是查詢（1對1 任何文字；群組要「找/查」開頭），否則當閒聊跳過
      const query = extractQuery(text, ev.source?.type);
      if (query) {
        await reply(ev.replyToken, await searchCollection(query, env), env);
      }
      continue;
    }

    const note = text.replace(/https?:\/\/[^\s]+/g, "").trim();
    const sharer = await getSenderName(ev, env);
    // LINE timestamp 是毫秒，轉台北時區的 YYYY-MM-DD
    const date = new Date(ev.timestamp).toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });

    let saved = 0;
    const dups = [];
    for (const url of urls) {
      const norm = await normalizeUrl(url);
      const existing = await findExisting(norm, env);
      if (existing) {
        // 收過的標題若還是原始網址（未整理），回覆用通稱
        dups.push(existing.title.startsWith("http") ? "（一則尚未整理的收藏）" : existing.title.slice(0, 50));
        continue;
      }
      if (await saveToNotion({ url: norm, note, sharer, date }, env)) saved++;
    }
    if ((saved > 0 || dups.length > 0) && env.ENABLE_REPLY !== "0") {
      const parts = [];
      if (saved > 0) parts.push(`✅ 已收 ${saved} 則進收藏庫`);
      for (const t of dups) parts.push(`🔁 這則之前收過了：${t}`);
      await reply(ev.replyToken, parts.join("\n"), env);
    }
  }
}

// 已知的追蹤參數（同一篇貼文每次分享這些參數都不同，比對前要去掉）
const TRACKING_PARAMS = ["xmt", "slof", "fbclid", "igsh", "igshid", "gclid", "ref", "refer", "_r", "_t", "mibextid", "rdid", "share_id"];
// 這些網站光靠路徑就能識別貼文，query 全部去掉最保險
const STRIP_ALL_QUERY_HOSTS = ["threads.com", "threads.net", "instagram.com"];

// 網址正規化：去追蹤參數、去 hash、TikTok 短網址跟到最終網址，讓同一篇貼文比得起來
export async function normalizeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  // TikTok 短網址每次分享代碼都不同，先跟轉址取得真正的影片網址
  if (url.hostname === "vt.tiktok.com" || url.hostname === "vm.tiktok.com") {
    try {
      const res = await fetch(raw, { method: "HEAD", redirect: "follow" });
      if (res.url) url = new URL(res.url);
    } catch {}
  }
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  const host = url.hostname.replace(/^www\./, "");
  if (STRIP_ALL_QUERY_HOSTS.some((h) => host === h || host.endsWith("." + h))) {
    url.search = "";
  } else {
    for (const p of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.includes(p) || p.startsWith("utm_")) url.searchParams.delete(p);
    }
  }
  let s = url.toString();
  if (url.pathname !== "/" && !url.search && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

// 查收藏庫裡有沒有同一個（正規化後的）網址，有就回傳那筆的標題
async function findExisting(normUrl, env) {
  const res = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ filter: { property: "URL", url: { equals: normUrl } }, page_size: 1 }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.results?.length) return null;
  return { title: _plain(data.results[0].properties?.["標題"]?.title) };
}

// 判斷一則無網址訊息是不是查詢：1對1 聊天任何文字都算；群組要以「找」或「查」開頭
export function extractQuery(text, sourceType) {
  if (!text) return null;
  if (text.startsWith("找") || text.startsWith("查")) {
    const q = text.slice(1).trim();
    return q.length >= 1 ? q : null;
  }
  return sourceType === "user" ? text : null;
}

function _plain(rich) {
  return (rich || []).map((t) => t.plain_text || t.text?.content || "").join("");
}

// 撈整個資料庫（分頁），個人收藏量級下每次查詢直接全撈即可
async function fetchAllPages(env) {
  const pages = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (!res.ok) return pages;
    const data = await res.json();
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return pages;
}

// 關鍵字比對：分類（與整句雙向包含）、標題/摘要/備註（逐詞包含），照分數排序取前 5
export async function searchCollection(query, env) {
  const pages = await fetchAllPages(env);
  const terms = query.split(/\s+/).filter(Boolean);
  const scored = [];

  for (const p of pages) {
    const props = p.properties || {};
    const title = _plain(props["標題"]?.title);
    const summary = _plain(props["摘要"]?.rich_text);
    const note = _plain(props["備註"]?.rich_text);
    const category = props["分類"]?.select?.name || "";

    let score = 0;
    if (category && (query.includes(category) || category.includes(query))) score += 3;
    for (const t of terms) {
      // 待整理項目的標題還是原始網址，網址亂碼容易誤中，跳過標題比對
      if (!title.startsWith("http") && title.includes(t)) score += 2;
      if (summary.includes(t) || note.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ score, title, category, url: props["URL"]?.url });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);
  if (top.length === 0) {
    return `🔍 「${query}」沒找到收藏，試試分類（美食、旅遊景點…）`;
  }
  const lines = top.map(
    (r, i) => `${i + 1}. ${r.title.slice(0, 60)}${r.category ? `｜${r.category}` : ""}\n${r.url || ""}`
  );
  return `🔍 「${query}」找到 ${top.length} 則：\n\n${lines.join("\n\n")}`;
}

// 取得傳訊者的 LINE 顯示名稱（群組訊息要走 group member API）
async function getSenderName(ev, env) {
  const userId = ev.source?.userId;
  if (!userId) return "未知";
  const path =
    ev.source.type === "group"
      ? `/group/${ev.source.groupId}/member/${userId}`
      : `/profile/${userId}`;
  try {
    const res = await fetch("https://api.line.me/v2/bot" + path, {
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (res.ok) {
      const name = (await res.json()).displayName || "未知";
      return name.replaceAll(",", " "); // Notion select 選項名不能含逗號
    }
  } catch {}
  return "未知";
}

async function saveToNotion(item, env) {
  const props = {
    標題: { title: [{ text: { content: (item.note || item.url).slice(0, 200) } }] },
    URL: { url: item.url },
    分享者: { select: { name: item.sharer } },
    收藏日期: { date: { start: item.date } },
    狀態: { select: { name: "待整理" } },
  };
  if (item.note) {
    props["備註"] = { rich_text: [{ text: { content: item.note.slice(0, 1900) } }] };
  }
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties: props,
    }),
  });
  if (!res.ok) console.log("Notion 寫入失敗", res.status, await res.text());
  return res.ok;
}

// iOS 捷徑端點：POST /save，JSON {key, url, note?, sharer?}，回 JSON 訊息給捷徑通知用
async function handleShortcutSave(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return textResp("❌ 格式錯誤", 400);
  }
  if (!env.SHORTCUT_KEY || body.key !== env.SHORTCUT_KEY) {
    return textResp("❌ 金鑰錯誤", 401);
  }
  const rawUrl = ((body.url || "").match(/https?:\/\/[^\s]+/) || [])[0];
  if (!rawUrl) return textResp("❌ 沒有網址", 400);

  const norm = await normalizeUrl(rawUrl);
  const existing = await findExisting(norm, env);
  if (existing) {
    const t = existing.title.startsWith("http") ? "（一則尚未整理的收藏）" : existing.title.slice(0, 50);
    return textResp(`🔁 之前收過了：${t}`);
  }
  const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
  const ok = await saveToNotion(
    {
      url: norm,
      note: (body.note || "").trim(),
      sharer: (body.sharer || "捷徑").replaceAll(",", " "),
      date,
    },
    env
  );
  return textResp(ok ? "✅ 已收進收藏庫" : "❌ 寫入失敗", ok ? 200 : 500);
}

// 捷徑通知會直接顯示回應內文，所以回純文字（不回 JSON）
function textResp(text, status = 200) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

// 圖片訊息：從 LINE 下載 → 上傳 Notion（免費方案單檔上限 5MB）→ 建待整理項目
async function handleImage(ev, env) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${ev.message.id}/content`, {
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) return;
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > 4.9 * 1024 * 1024) {
    await reply(ev.replyToken, "⚠️ 圖片超過 5MB（Notion 免費上限），這張沒收進去", env);
    return;
  }
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const ext = contentType.includes("png") ? "png" : "jpg";
  const filename = `line-${ev.message.id}.${ext}`;
  const uploadId = await notionUploadFile(bytes, filename, contentType, env);
  if (!uploadId) return;

  const sharer = await getSenderName(ev, env);
  const date = new Date(ev.timestamp).toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
  const created = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties: {
        標題: { title: [{ text: { content: `（圖片收藏 ${date}）` } }] },
        圖片: { files: [{ type: "file_upload", file_upload: { id: uploadId }, name: filename }] },
        分享者: { select: { name: sharer } },
        收藏日期: { date: { start: date } },
        狀態: { select: { name: "待整理" } },
      },
    }),
  });
  if (created.ok && env.ENABLE_REPLY !== "0") {
    await reply(ev.replyToken, "✅ 已收 1 張圖片進收藏庫", env);
  } else if (!created.ok) {
    console.log("圖片頁面建立失敗", created.status, await created.text());
  }
}

// Notion File Upload 兩步驟：建立 upload 物件 → multipart 上傳，回傳 upload id
async function notionUploadFile(bytes, filename, contentType, env) {
  const created = await fetch("https://api.notion.com/v1/file_uploads", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!created.ok) {
    console.log("file_upload 建立失敗", created.status, await created.text());
    return null;
  }
  const { id, upload_url } = await created.json();
  const form = new FormData();
  form.append("file", new File([bytes], filename, { type: contentType }));
  const sent = await fetch(upload_url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
    },
    body: form,
  });
  if (!sent.ok) {
    console.log("file_upload 上傳失敗", sent.status, await sent.text());
    return null;
  }
  return id;
}

async function reply(replyToken, text, env) {
  try {
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
    });
  } catch {}
}
