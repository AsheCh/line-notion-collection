// Worker 單元測試（Node 內建 test runner，不需安裝套件）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { normalizeUrl, extractQuery, verifySignature, searchCollection } from "../worker/worker.js";

test("normalizeUrl：移除 utm 與常見追蹤參數，保留其他參數", async () => {
  assert.equal(
    await normalizeUrl("https://example.com/post?id=7&utm_source=line&fbclid=abc"),
    "https://example.com/post?id=7"
  );
});

test("normalizeUrl：Threads / IG 網址去掉全部 query", async () => {
  assert.equal(
    await normalizeUrl("https://www.threads.com/@user/post/ABC?xmt=xyz&slof=1"),
    "https://www.threads.com/@user/post/ABC"
  );
  assert.equal(
    await normalizeUrl("https://www.instagram.com/p/XYZ/?igsh=123"),
    "https://www.instagram.com/p/XYZ"
  );
});

test("normalizeUrl：去 hash、主機名轉小寫、去結尾斜線", async () => {
  assert.equal(await normalizeUrl("https://Example.COM/a/b/#top"), "https://example.com/a/b");
});

test("normalizeUrl：同一篇貼文不同分享參數會得到同一個網址（去重的基礎）", async () => {
  const a = await normalizeUrl("https://www.threads.com/@u/post/1?xmt=AAA");
  const b = await normalizeUrl("https://www.threads.com/@u/post/1?xmt=BBB&slof=1");
  assert.equal(a, b);
});

test("normalizeUrl：無效網址原樣回傳", async () => {
  assert.equal(await normalizeUrl("not a url"), "not a url");
});

test("extractQuery：群組需以「找／查」開頭，1 對 1 任何文字都算查詢", () => {
  assert.equal(extractQuery("找 台北美食", "group"), "台北美食");
  assert.equal(extractQuery("查咖啡", "group"), "咖啡");
  assert.equal(extractQuery("今天好熱", "group"), null);
  assert.equal(extractQuery("台北美食", "user"), "台北美食");
  assert.equal(extractQuery("找", "group"), null);
});

test("verifySignature：正確簽章通過、竄改或缺值拒絕", async () => {
  const secret = "test-secret";
  const body = JSON.stringify({ events: [] });
  const sig = createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(await verifySignature(body, sig, secret), true);
  assert.equal(await verifySignature(body + " ", sig, secret), false);
  assert.equal(await verifySignature(body, "", secret), false);
  assert.equal(await verifySignature(body, sig, ""), false);
});

test("searchCollection：依分類、標題、摘要計分排序，並跳過未整理項目的網址標題", async () => {
  const page = (title, category, summary, url) => ({
    properties: {
      標題: { title: [{ plain_text: title }] },
      分類: { select: category ? { name: category } : null },
      摘要: { rich_text: [{ plain_text: summary }] },
      備註: { rich_text: [] },
      URL: { url },
    },
  });
  const pages = [
    page("台北咖啡廳整理", "美食", "十家咖啡廳", "https://a.com"),
    page("咖啡豆怎麼挑", "購物清單", "", "https://b.com"),
    page("https://咖啡.example/未整理", null, "", "https://c.com"),
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: pages, has_more: false }) });
  try {
    const out = await searchCollection("咖啡", { NOTION_DATABASE_ID: "db", NOTION_TOKEN: "t" });
    assert.match(out, /找到 2 則/);
    assert.ok(out.indexOf("台北咖啡廳整理") < out.indexOf("咖啡豆怎麼挑"));
    assert.doesNotMatch(out, /c\.com/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
