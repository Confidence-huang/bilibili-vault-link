/*
 * bili-bridge.js — B站登录态桥接（活会话）：playwright 常驻 profile + 页面内 fetch 代理
 * 端口 8766（与抖音桥接 8765 并存）。首次运行建议 HEADED=1 打开可见窗口完成一次登录，
 * 之后 Cookie 由 B站页面活动自动续期，长期有效。
 * 端点：GET /ping ｜ GET /login-status ｜ POST /req {url,method,body,contentType} ｜ POST /open-login
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = Number(process.env.PORT || 8766);
const PROFILE = path.join(process.env.LOCALAPPDATA || "", "BiliVaultBridge", "login-profile");
const INSTALLER = process.env.DOUYIN_SYNC_INSTALLER || "D:/douyin-sync-installer/bridge";
const HEADED = process.env.HEADED === "1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

let ctx = null, page = null, closing = false;

async function launch() {
  const { chromium } = require(INSTALLER + "/node_modules/playwright-core");
  fs.mkdirSync(PROFILE, { recursive: true });
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: findChrome(),
    headless: !HEADED,
    userAgent: UA,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run"],
  });
  page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://www.bilibili.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  ctx.on("close", () => { if (!closing) process.exit(0); });
}

function findChrome() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "chrome";
}

async function isLogin() {
  try {
    const out = await page.evaluate(async () => {
      const r = await fetch("https://api.bilibili.com/x/web-interface/nav", { credentials: "include" });
      const d = await r.json();
      return { isLogin: !!(d.data && d.data.isLogin), mid: d.data ? d.data.mid : 0, uname: d.data ? d.data.uname : "" };
    });
    return out;
  } catch { return { isLogin: false, mid: 0, uname: "" }; }
}

function send(res, code, obj) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  if (req.method === "GET" && u === "/ping") return send(res, 200, { ok: true, ready: !!page, headed: HEADED });
  if (req.method === "GET" && u === "/login-status") {
    (async () => send(res, 200, await isLogin()))();
    return;
  }
  if (req.method === "POST" && u === "/open-login") {
    (async () => { await page.goto("https://www.bilibili.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}); send(res, 200, { ok: true }); })();
    return;
  }
  if (req.method === "POST" && u === "/req") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(raw); } catch { return send(res, 400, { error: "bad json" }); }
      (async () => {
        try {
          const out = await page.evaluate(async (p) => {
            const r = await fetch(p.url, {
              method: p.method || "GET",
              credentials: "include",
              headers: p.contentType ? { "Content-Type": p.contentType } : undefined,
              body: p.body,
            });
            return { status: r.status, text: await r.text() };
          }, payload);
          send(res, 200, out);
        } catch (e) {
          send(res, 200, { status: -1, text: String(e).slice(0, 200) });
        }
      })();
    });
    return;
  }
  send(res, 404, { error: "not found" });
});

/* 会话保活心跳：每 6 小时经页面内 fetch 打一次带登录态的轻量接口（nav），
 * 让 B站看到活跃会话——Set-Cookie 续期直接落入持久化 profile（抖音桥接同款思路）。
 * 启动时也打一次，顺带在控制台留登录态轨迹。 */
const HEARTBEAT_MS = 6 * 60 * 60 * 1000;
async function heartbeat() {
  const s = await isLogin();
  console.log(`[bili-bridge] heartbeat ${new Date().toISOString()} isLogin=${s.isLogin}${s.uname ? " (" + s.uname + ")" : ""}`);
  if (!s.isLogin) console.log("[bili-bridge] 登录态失效！用 HEADED=1 启动本桥接扫码重登，或更新 %TEMP%\bili-cookies.txt");
}
setInterval(() => { heartbeat().catch(() => {}); }, HEARTBEAT_MS);

(async () => {
  await launch();
  heartbeat().catch(() => {});
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[bili-bridge] listening on http://127.0.0.1:${PORT} (headed=${HEADED})`);
    console.log(`[bili-bridge] profile: ${PROFILE}`);
  });
})();
