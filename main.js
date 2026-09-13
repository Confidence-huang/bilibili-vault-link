/*
 * bilibili-vault-link — Learning Vault 式 Obsidian 库 × bilibili-video-learning 技能 伴生桥接插件
 *
 * 职责：
 *   1. 收藏夹同步：引擎 --metadata-only 逐条入库（YAML 契约键 bvid）+ AI 本地分类，目录镜像收藏夹
 *   2. 粘贴链接归档：BV/av/b23 链接 → 引擎生成收件箱笔记
 *   3. 深度归档：打开笔记执行 → 引擎产出逐帧 × 转写对照（本地 GPU 转写 + 视觉图注）
 *   4. 新笔记自动深度归档（开关，默认关）
 *   5. 晋升为来源笔记（收件箱 → 04-来源，带确认弹窗）并挂 03-主题地图
 *   6. 同步日志：同步/归档/深度归档/晋升追加一行到 B站归档/同步日志.md
 *
 * 架构：薄客户端——全部管线在 bilibili-video-learning 技能的 bilibili_deep_archive.py（单一实现）；
 *       封面下载与 vault_status/promoted_to 契约字段由引擎负责（1.4.2+）。
 * 边界：只写收件箱与 04-来源（晋升需确认弹窗）；Cookie/Key 不入库。
 */
"use strict";

const obsidian = require("obsidian");
const { Plugin, Notice, normalizePath, requestUrl, Modal, PluginSettingTab, Setting, TFolder } = obsidian;
const path = require("path");

const DEFAULT_SETTINGS = {
  inboxDir: "00-原始笔记/B站归档",
  mediaDir: "附件/bili-media",
  sourceFolder: "04-来源",
  mapsFolder: "03-主题地图",
  syncLogEnabled: true,
  syncLogPath: "00-原始笔记/B站归档/同步日志.md",
  domainRegistry: "education\nhardware\nmath\nsoftware\nweb",
  enginePython: "",
  localAsrModel: "small",
  maxFrames: 24,
  ffmpegPath: "ffmpeg",
  videoWorkRoot: "",
  cookiesFile: "",
  visionUrl: "http://127.0.0.1:11434/v1",
  visionModel: "qwen2.5vl:3b",
  visionEnabled: true,
  aiModel: "qwen2.5:3b",
  aiCategories: "成长学习\n投资理财\nAI编程\n心理情感\n职场商业\n娱乐生活\n运动健康\n其他（不好分类）",
  autoDeepArchive: false,
  biliBridgeUrl: "http://127.0.0.1:8766",
};

const BILI_LINK_RE = /(?:https?:\/\/)?(?:www\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{8,12})|(?:https?:\/\/)?b23\.tv\/[A-Za-z0-9]+|\bav(\d{2,12})\b/gi;

function extractBiliRefs(text) {
  const refs = [];
  const seen = new Set();
  let m;
  const re = new RegExp(BILI_LINK_RE.source, "gi");
  while ((m = re.exec(text))) {
    if (m[1]) { if (!seen.has(m[1])) { seen.add(m[1]); refs.push({ bvid: m[1] }); } }
    else if (m[2]) { if (!seen.has("av" + m[2])) { seen.add("av" + m[2]); refs.push({ aid: m[2] }); } }
    else if (m[0]) { if (!seen.has(m[0])) { seen.add(m[0]); refs.push({ url: m[0] }); } }
  }
  return refs;
}

/* ---------------- 小工具（与 douyin-vault-link 同款） ---------------- */

function sanitizeTitle(s, max = 80) {
  const t = String(s || "").replace(/[\\/:*?"<>|#^[\]%\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return t ? (t.length > max ? t.slice(0, max).trim() : t) : "";
}

function fmStr(v) { return v == null ? '""' : JSON.stringify(String(v)); }

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nowStamp() {
  const d = new Date();
  return `${todayLocal()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function mdLink(display, vaultPath) {
  const enc = vaultPath.split("/").map(encodeURIComponent).join("/");
  return `[${display}](${enc})`;
}

async function ensureFolder(vault, p) {
  const parts = normalizePath(p).split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!vault.getAbstractFileByPath(cur)) {
      try { await vault.createFolder(cur); } catch {}
    }
  }
}

/* 解析笔记 frontmatter（扁平 key: value，够用于自己生成的 YAML） */
function parseFrontmatter(text) {
  if (!text.startsWith("---")) return { data: {}, body: text, fmEnd: 0 };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: text, fmEnd: 0 };
  const block = text.slice(4, end);
  const data = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch {} }
    data[m[1]] = v;
  }
  return { data, body: text.slice(end + 4), fmEnd: end + 4 };
}

function updateFrontmatter(text, updates) {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return text;
  let block = text.slice(4, end);
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}:.*$`, "m");
    const line = `${k}: ${typeof v === "string" && v.startsWith("[[") ? fmStr(v) : v}`;
    if (re.test(block)) block = block.replace(re, line);
    else block = `${block}\n${line}`;
  }
  return `---\n${block}\n---${text.slice(end + 4)}`;
}

class LinkInputModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.titleEl.setText("粘贴 B 站链接归档");
    this.contentEl.createEl("p", {
      text: "支持 BV 号、av 号、网页链接与 b23.tv 分享短链，一行一条，可一次多条。",
      cls: "setting-item-description",
    });
    const area = this.contentEl.createEl("textarea", { attr: { rows: 5, style: "width:100%;resize:vertical" } });
    area.focus();
    const btns = this.contentEl.createDiv({ attr: { style: "display:flex;gap:8px;margin-top:10px;justify-content:flex-end" } });
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    const ok = btns.createEl("button", { text: "归档", cls: "mod-cta" });
    ok.onclick = async () => {
      const text = String(area.value || "").trim();
      if (!text) { new Notice("请先粘贴链接"); return; }
      this.close();
      await this.onSubmit(text);
    };
  }

  onClose() { this.contentEl.empty(); }
}

class BiliVaultLinkSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    new Setting(containerEl).setName("路径").setHeading();
    new Setting(containerEl).setName("B站归档收件箱").setDesc("引擎产出笔记的目录（相对库根）").addText((t) => t.setValue(s.inboxDir).onChange(async (v) => { s.inboxDir = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("媒体目录").setDesc("帧图与封面存放处（相对库根）").addText((t) => t.setValue(s.mediaDir).onChange(async (v) => { s.mediaDir = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("来源目录").setDesc("晋升目标（04-来源）").addText((t) => t.setValue(s.sourceFolder).onChange(async (v) => { s.sourceFolder = v.trim() || DEFAULT_SETTINGS.sourceFolder; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("主题地图目录").addText((t) => t.setValue(s.mapsFolder).onChange(async (v) => { s.mapsFolder = v.trim() || DEFAULT_SETTINGS.mapsFolder; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("同步日志").setHeading();
    new Setting(containerEl).setName("启用同步日志").setDesc("每次同步/归档/晋升追加一行到日志笔记（过程产物）").addToggle((t) => t.setValue(s.syncLogEnabled).onChange(async (v) => { s.syncLogEnabled = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("日志路径").addText((t) => t.setValue(s.syncLogPath).onChange(async (v) => { s.syncLogPath = v.trim() || DEFAULT_SETTINGS.syncLogPath; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("领域标签注册表").setDesc("每行一个 domain/<slug>（禁 domain/other）").addTextArea((t) => {
      t.setValue(s.domainRegistry).onChange(async (v) => { s.domainRegistry = v; await this.plugin.saveSettings(); });
      t.inputEl.rows = 5; t.inputEl.style.width = "100%";
    });
    new Setting(containerEl).setName("深度归档（逐帧 × 转写）").setHeading();
    new Setting(containerEl).setName("最多关键帧数").addText((t) => t.setValue(String(s.maxFrames)).onChange(async (v) => { const n = parseInt(v, 10); s.maxFrames = Number.isFinite(n) && n >= 2 ? n : 24; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("引擎 Python").setDesc("bilibili-video-learning 技能 .venv-gpu 里的 python.exe；留空 = %USERPROFILE%\\.agents\\skills\\bilibili-video-learning\\.venv-gpu\\Scripts\\python.exe").addText((t) => t.setValue(s.enginePython || "").onChange(async (v) => { s.enginePython = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("转写模型").setDesc("small 已在 RTX 5070 实测 ≈9× 实时；large-v3-turbo 更准但吃显存").addDropdown((dd) => {
      for (const m of ["tiny", "base", "small", "medium", "large-v3-turbo"]) dd.addOption(m, m);
      dd.setValue(s.localAsrModel || "small");
      dd.onChange(async (v) => { s.localAsrModel = v; await this.plugin.saveSettings(); });
    });
    new Setting(containerEl).setName("ffmpeg 路径").addText((t) => t.setValue(s.ffmpegPath).onChange(async (v) => { s.ffmpegPath = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("视频工作目录").setDesc("留空 = %TEMP%\\bilibili-vault-link\\<BV>").addText((t) => t.setValue(s.videoWorkRoot).onChange(async (v) => { s.videoWorkRoot = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("B站桥接地址").setDesc("同步收藏夹时自动拉起的活会话桥接（端口 8766；与抖音桥接 8765 并存）").addText((t) => t.setValue(s.biliBridgeUrl).onChange(async (v) => { s.biliBridgeUrl = v.trim() || "http://127.0.0.1:8766"; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("B站 Cookies 文件").setDesc("会员/高清视频需要 yt-dlp cookies 文件路径；普通公开视频留空即可").addText((t) => t.setValue(s.cookiesFile || "").onChange(async (v) => { s.cookiesFile = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("视觉图注（本地）").setHeading();
    new Setting(containerEl).setName("启用视觉图注").setDesc("逐帧交给本地多模态模型（如 Ollama qwen2.5vl），生成「字幕原文｜概述」图注").addToggle((t) => t.setValue(s.visionEnabled).onChange(async (v) => { s.visionEnabled = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("视觉端点").setDesc("OpenAI 兼容端点根；默认本机 Ollama").addText((t) => t.setValue(s.visionUrl).onChange(async (v) => { s.visionUrl = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("视觉模型").addText((t) => t.setValue(s.visionModel).onChange(async (v) => { s.visionModel = v.trim() || "qwen2.5vl:3b"; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("AI 自动分类（本地）").setHeading();
    new Setting(containerEl).setName("文本模型").setDesc("深度归档时自动给笔记写 category 分类").addText((t) => t.setValue(s.aiModel).onChange(async (v) => { s.aiModel = v.trim() || "qwen2.5:3b"; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("分类列表").setDesc("每行一个；引擎只从中选择").addTextArea((t) => {
      t.setValue(s.aiCategories).onChange(async (v) => { s.aiCategories = v; await this.plugin.saveSettings(); });
      t.inputEl.setAttr("rows", 6);
    });
    new Setting(containerEl).setName("自动深度归档").setDesc("开启后：粘贴归档产生的新笔记自动跑深度归档引擎；每条约 +1~2 分钟。默认关").addToggle((t) => t.setValue(s.autoDeepArchive || false).onChange(async (v) => { s.autoDeepArchive = v; await this.plugin.saveSettings(); }));
  }
}

class BiliVaultLinkPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() ?? {});
    this.addSettingTab(new BiliVaultLinkSettingTab(this.app, this));
    this.addCommand({ id: "paste-link-archive", name: "粘贴链接归档（BV/av/b23，单条/多条）", callback: () => this.cmdPasteArchive() });
    this.addCommand({ id: "deep-archive", name: "深度归档（逐帧提取 × 转写对照）", callback: () => this.cmdDeepArchive() });
    this.addCommand({ id: "promote-to-source", name: "晋升为来源笔记（收件箱 → 04-来源）", callback: () => this.cmdPromote() });
    this.addCommand({ id: "open-inbox", name: "打开B站归档收件箱", callback: () => this.cmdOpenInbox() });
    this.addCommand({ id: "sync-favorites", name: "同步B站收藏夹（元数据 + AI分类）", callback: () => this.cmdSyncFavorites() });
    this.addRibbonIcon("play-circle", "B站 × 笔记库桥接", (evt) => this.showMenu(evt));
  }

  async loadSettings() { Object.assign(this.settings, await this.loadData() ?? {}); }
  async saveSettings() { await this.saveData(this.settings); }

  showMenu(evt) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("粘贴链接归档").setIcon("clipboard").onClick(() => this.cmdPasteArchive()));
    menu.addItem((i) => i.setTitle("深度归档（逐帧 × 转写对照）").setIcon("film").onClick(() => this.cmdDeepArchive()));
    menu.addItem((i) => i.setTitle("晋升为来源笔记").setIcon("file-plus").onClick(() => this.cmdPromote()));
    menu.addItem((i) => i.setTitle("打开B站归档收件箱").setIcon("folder-open").onClick(() => this.cmdOpenInbox()));
    menu.addItem((i) => i.setTitle("同步B站收藏夹").setIcon("refresh-cw").onClick(() => this.cmdSyncFavorites()));
    menu.showAtMouseEvent(evt);
  }

  inboxDir() { return normalizePath(this.settings.inboxDir || "00-原始笔记/B站归档"); }

  enginePaths() {
    const os = window.require("os");
    const py = (this.settings.enginePython || "").trim() || path.join(os.homedir(), ".agents", "skills", "bilibili-video-learning", ".venv-gpu", "Scripts", "python.exe");
    return { py, script: path.resolve(path.dirname(py), "..", "..", "scripts", "bilibili_deep_archive.py") };
  }

  /* B站桥接（活会话，8766）：同步收藏夹时自动拉起 */
  async ensureBiliBridge() {
    const base = this.settings.biliBridgeUrl || "http://127.0.0.1:8766";
    try { const r = await requestUrl({ url: base + "/ping", throw: false }); if (r.status === 200) return base; } catch {}
    new Notice("B站桥接未运行，正在拉起…");
    const fs = window.require("fs");
    const bridgeJs = path.join(this.manifest.dir, "bili-bridge.js");
    if (!fs.existsSync(bridgeJs)) throw new Error(`桥接脚本不存在：${bridgeJs}`);
    const nodeCfg = await this.readBridgeNodeConfig();
    const spawn = window.require("child_process").spawn;
    const node = (nodeCfg.bridgeNodePath || "").trim() || "node";
    const env = { ...process.env };
    const nm = (nodeCfg.bridgeNodeModules || "").trim();
    if (nm) { env.NODE_PATH = nm; env.DOUYIN_SYNC_INSTALLER = nm.replace(/[\\/]node_modules$/, ""); }
    const child = spawn(node, [bridgeJs, String(Number(base.split(":").pop()) || 8766)], { detached: true, stdio: "ignore", windowsHide: true, env, cwd: this.manifest.dir });
    child.unref?.();
    for (let i = 0; i < 30; i++) {
      await new Promise((r2) => setTimeout(r2, 500));
      try { const r = await requestUrl({ url: base + "/ping", throw: false }); if (r.status === 200) { new Notice("B站桥接已就绪"); return base; } } catch {}
    }
    throw new Error("B站桥接启动超时（15s）。请确认桥接环境（node + playwright-core）可用。");
  }

  /* 桥接 node 环境配置：优先读 douyin-vault-link 自身设置，回落 douyin-sync（1.x 兼容） */
  async readBridgeNodeConfig() {
    for (const dir of ["douyin-vault-link", "douyin-sync"]) {
      try {
        const raw = await this.app.vault.adapter.read(normalizePath(`.obsidian/plugins/${dir}/data.json`));
        const s = JSON.parse(raw).settings || {};
        if (s.bridgeNodePath || s.bridgeNodeModules) return s;
      } catch {}
    }
    return {};
  }

  /* ---- 同步日志 ---- */

  async appendSyncLog(line) {
    if (!this.settings.syncLogEnabled) return;
    const p = normalizePath(this.settings.syncLogPath);
    const header = "# B站同步归档日志\n\n> 过程产物（不入图谱）。伴生插件自动追加。\n";
    const f = this.app.vault.getAbstractFileByPath(p);
    if (f instanceof obsidian.TFile) {
      const text = await this.app.vault.read(f);
      await this.app.vault.modify(f, `${text.replace(/\n*$/, "\n")}${line}\n`);
    } else {
      await ensureFolder(this.app.vault, this.settings.syncLogPath.slice(0, this.settings.syncLogPath.lastIndexOf("/")));
      await this.app.vault.create(p, `${header}\n${line}\n`);
    }
  }

  /* 同步B站收藏夹：引擎元数据模式逐条入库 + AI 分类；新视频笔记可选自动深度归档 */
  cmdSyncFavorites() {
    void (async () => {
      try {
        const { py } = this.enginePaths();
        const fs = window.require("fs");
        const syncScript = path.join(this.manifest.dir, "tools", "bili-fav-sync.py");
        if (!fs.existsSync(syncScript)) throw new Error(`同步脚本不存在：${syncScript}（请随插件分发 tools/bili-fav-sync.py）`);
        const vaultRoot = this.app.vault.adapter.getBasePath();
        const inboxPrefix = this.inboxDir() + "/";
        const before = new Set(this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(inboxPrefix)).map((f) => f.path));
        const bridge = await this.ensureBiliBridge();
        const notice = new Notice("同步B站收藏夹…", 0);
        await new Promise((resolve, reject) => {
          const env = { ...process.env };
          env.PYTHONIOENCODING = "utf-8";
          env.BILI_VIDEO_BRIDGE = bridge;
          delete env.BILIBILI_OBSIDIAN_VAULT;
          const cp = spawn(py, [syncScript, "--vault", vaultRoot], { windowsHide: true, env });
          let stderr = "";
          const timer = setTimeout(() => { cp.kill(); reject(new Error("同步超时（40 分钟）")); }, 40 * 60 * 1000);
          cp.stderr.on("data", (d) => {
            stderr += d;
            const lines = String(d).match(/\[[夹\d][^\r\n]*\]/g);
            if (lines) notice.setMessage(`同步B站收藏夹：${lines[lines.length - 1].replace(/^\[/, "").replace(/\]$/, "").slice(0, 60)}`);
          });
          cp.on("error", (e) => { clearTimeout(timer); reject(e); });
          cp.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr.trim().split("\n").pop()?.slice(0, 200) || `退出码 ${code}`)); });
        });
        const after = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(inboxPrefix) && !before.has(f.path));
        let deep = 0;
        if (this.settings.autoDeepArchive && after.length > 0) {
          new Notice(`自动深度归档：${after.length} 条新增…`, 0);
          for (const nf of after) {
            try {
              const text = await this.app.vault.read(nf);
              const fm = (() => { const o = {}; const m = text.match(/^---\n([\s\S]*?)\n---/); if (m) for (const line of m[1].split("\n")) { const mm = line.match(/^([A-Za-z_]\w*):\s*(.*)$/); if (mm) o[mm[1]] = mm[2].replace(/^"|"$/g, ""); } return o; })();
              if (!fm.bvid || (fm.type && fm.type !== "视频")) continue;
              await this.runEngineOnce({ bvid: fm.bvid, note: path.join(vaultRoot, nf.path) }, () => {});
              deep++;
            } catch (e) { new Notice(`深度归档失败（${nf.basename.slice(0, 24)}）：${String(e.message || e).slice(0, 80)}`, 8000); }
          }
        }
        new Notice(`同步完成：新增 ${after.length} 条` + (deep ? `，深度归档 ${deep} 条` : ""), 8000);
        await this.appendSyncLog(`- ${nowStamp()} — 收藏夹同步：新增 ${after.length} 条${deep ? `，深度归档 ${deep} 条` : ""}${after.length ? `：${after.slice(0, 5).map((f) => f.basename).join("、")}${after.length > 5 ? " …" : ""}` : ""}`);
      } catch (e) {
        new Notice(`同步失败：${String(e.message || e).slice(0, 200)}`, 12000);
        try { await this.appendSyncLog(`- ${nowStamp()} — 收藏夹同步失败：${String(e.message || e).slice(0, 120)}`); } catch {}
      }
    })();
  }

  cmdOpenInbox() {
    const p = normalizePath(this.inboxDir());
    const folder = this.app.vault.getAbstractFileByPath(p);
    if (folder instanceof TFolder) {
      try { this.app.internalPlugins.getPluginById("file-explorer").instance.revealInFolder(folder); return; } catch {}
    }
    new Notice(`B站归档收件箱：${p}`);
  }

  cmdPasteArchive() {
    new LinkInputModal(this.app, async (text) => {
      const refs = extractBiliRefs(text);
      if (refs.length === 0) { new Notice("没有识别到 B 站链接（支持 BV/av/b23.tv）"); return; }
      const notice = new Notice(`正在归档 ${refs.length} 条…`, 0);
      const created = [];
      let failed = 0;
      for (const ref of refs) {
        try {
          const out = await this.runEngineOnce({ url: ref.url || ref.bvid || ("av" + ref.aid) }, () => {});
          created.push({ bvid: out?.bvid || ref.bvid || ref.url, path: out?.note || "" });
        } catch (e) {
          failed++;
          new Notice(`归档失败：${String(e.message || e).slice(0, 140)}`, 10000);
        }
      }
      notice.hide();
      new Notice(`归档 ${created.length} 条` + (failed ? `，失败 ${failed}` : ""), 8000);
      await this.appendSyncLog(`- ${nowStamp()} — 粘贴链接归档 ${created.length} 条${failed ? `，失败 ${failed}` : ""}${created.length ? `：${created.map((c) => c.bvid).join("、")}` : ""}`);
      if (this.settings.autoDeepArchive && created.length > 0) {
        let ok = 0;
        new Notice(`自动深度归档：${created.length} 条新笔记…`, 0);
        for (const c of created) {
          const tf = c.path ? this.app.vault.getAbstractFileByPath(normalizePath(c.path.replace(/\\/g, "/"))) : null;
          if (!tf) continue;
          try {
            await this.runEngineOnce({ bvid: c.bvid, note: tf.path }, () => {});
            ok++;
          } catch (e) { new Notice(`自动深度归档失败：${String(e.message || e).slice(0, 100)}`, 8000); }
        }
        if (ok > 0) new Notice(`自动深度归档完成：${ok}/${created.length}`, 6000);
        if (created.length === 1 && created[0].path) {
          try { this.app.workspace.openLinkText(normalizePath(created[0].path.replace(/\\/g, "/")), "", false); } catch {}
        }
      } else if (created.length === 1 && created[0].path) {
        try { this.app.workspace.openLinkText(normalizePath(created[0].path.replace(/\\/g, "/")), "", false); } catch {}
      }
    }).open();
  }

  cmdDeepArchive() {
    const md = this.app.workspace.activeEditor;
    if (!md || !md.file) { new Notice("请先打开B站归档里的视频笔记"); return; }
    const f = md.file;
    if (!f.path.startsWith(this.inboxDir() + "/")) { new Notice("当前笔记不在B站归档收件箱内"); return; }
    void (async () => {
      try {
        const text = await this.app.vault.read(f);
        const fm = (() => { const m = text.match(/^---\n([\s\S]*?)\n---/); const o = {}; if (m) for (const line of m[1].split("\n")) { const mm = line.match(/^([A-Za-z_]\w*):\s*(.*)$/); if (mm) o[mm[1]] = mm[2].replace(/^"|"$/g, ""); } return o; })();
        if (!fm.bvid) { new Notice("笔记缺少 bvid 属性"); return; }
        const notice = new Notice("深度归档：引擎启动…", 0);
        const out = await this.runEngineOnce({ bvid: fm.bvid, note: this.app.vault.adapter.getFullPath(f.path) }, (msg) => notice.setMessage(`深度归档：${msg}`));
        new Notice(`深度归档完成：${out ? `${out.frames} 帧 ｜ ${out.segments} 句` : "完成"}`, 8000);
        await this.appendSyncLog(`- ${nowStamp()} — 深度归档「${f.basename}」：${out ? `${out.frames} 帧/${out.segments} 句` : "完成"}`);
      } catch (e) {
        new Notice(`深度归档失败：${String(e.message || e).slice(0, 200)}`, 10000);
      }
    })();
  }

  /* ---- 晋升为来源（与 douyin-vault-link 同构，douyin_id → bvid） ---- */

  cmdPromote() {
    const md = this.app.workspace.activeEditor;
    if (!md || !md.file) { new Notice("请先打开B站归档里的视频笔记"); return; }
    const f = md.file;
    if (!f.path.startsWith(this.inboxDir() + "/")) { new Notice("当前笔记不在B站归档收件箱内"); return; }
    void (async () => {
      const text = await this.app.vault.read(f);
      const { data } = parseFrontmatter(text);
      if (!data.bvid) { new Notice("笔记缺少 bvid 属性，不是B站归档笔记"); return; }
      if (data.vault_status === "已晋升") { new Notice(`该笔记已晋升：${data.promoted_to || ""}`); return; }
      new PromoteModal(this.app, this, f, data).open();
    })();
  }

  async promote(stagedFile, stagedData, plan) {
    const name = sanitizeTitle(plan.title, 80) || `B站视频_${stagedData.bvid}`;
    const targetPath = normalizePath(`${this.settings.sourceFolder}/${name}.md`);
    if (this.app.vault.getAbstractFileByPath(targetPath)) { new Notice(`已存在 ${targetPath}，请换标题`); return false; }

    const domainTags = plan.domains.map((d) => `  - domain/${d}`);
    const content = [
      "---",
      "type: source",
      "source-kind: 视频",
      `author: ${fmStr(stagedData.author || "")}`,
      `url: ${fmStr(stagedData.url || `https://www.bilibili.com/video/${stagedData.bvid}`)}`,
      `created: ${fmStr(todayLocal())}`,
      `bvid: ${fmStr(stagedData.bvid)}`,
      stagedData.published ? `published: ${fmStr(stagedData.published)}` : null,
      "tags:",
      ...domainTags,
      "---",
      "",
      `# ${name}`,
      "",
      "## 来源信息",
      "",
      `- 作者：${stagedData.author || "（缺失，不猜测）"}`,
      `- 链接：${stagedData.url || `https://www.bilibili.com/video/${stagedData.bvid}`}（B站视频）`,
      `- 收件箱：${mdLink(`${stagedFile.basename}`, stagedFile.path)}（逐字稿/图片文字全量在此；本页只留检索与结构）`,
      "",
      "## 为什么使用这个来源",
      "",
      plan.reason || "",
      "",
      "## 关键证据",
      "",
      "（待补：区分原文信息 / 自己的理解 / AI 辅助内容）",
      "",
      "## 关联问题与概念",
      "",
      "- [[ ]] —",
      "",
    ].filter((l) => l !== null).join("\n");

    await ensureFolder(this.app.vault, this.settings.sourceFolder);
    await this.app.vault.create(targetPath, content);

    if (plan.mapPath) {
      try {
        const mf = this.app.vault.getAbstractFileByPath(normalizePath(plan.mapPath));
        if (mf instanceof obsidian.TFile) {
          const mapText = await this.app.vault.read(mf);
          const linkLine = `- [[${name}]] — ${plan.reason || plan.group || "B站来源"}`;
          const mapLines = mapText.split("\n");
          const gIdx = mapLines.findIndex((l) => l.trim() === `### ${plan.group}`);
          if (gIdx >= 0) mapLines.splice(gIdx + 1, 0, linkLine);
          else mapLines.push("", `### ${plan.group}`, "", linkLine, "");
          await this.app.vault.modify(mf, mapLines.join("\n"));
        }
      } catch (e) { new Notice(`挂地图失败：${String(e.message || e).slice(0, 100)}`); }
    }

    const stagedText = await this.app.vault.read(stagedFile);
    await this.app.vault.process(stagedFile, () => updateFrontmatter(stagedText, {
      vault_status: "已晋升",
      promoted_to: `[[${name}]]`,
    }));

    await this.appendSyncLog(`- ${nowStamp()} — 晋升「${stagedFile.basename}」→ ${this.settings.sourceFolder}/${name}${plan.mapPath ? `（挂 ${plan.mapPath}）` : ""}`);
    new Notice(`已晋升：${this.settings.sourceFolder}/${name}`);
    return true;
  }

  /* 引擎单次执行：ref = {bvid|aid|url}，notePath 给定则更新该笔记 */
  async runEngineOnce(ref, onProgress) {
    const { py, script } = this.enginePaths();
    const fs = window.require("fs");
    if (!fs.existsSync(py)) throw new Error(`引擎 Python 不存在：${py}（请安装 bilibili-video-learning 技能或在本设置页填路径）`);
    if (!fs.existsSync(script)) throw new Error(`引擎脚本不存在：${script}（请把技能更新到 1.4.0+）`);
    const vaultRoot = this.app.vault.adapter.getBasePath();
    const args = [script, "--vault", vaultRoot,
      "--ffmpeg", this.settings.ffmpegPath || "ffmpeg",
      "--max-frames", String(this.settings.maxFrames || 24),
      "--model", this.settings.localAsrModel || "small"];
    if (ref.bvid) args.push("--bvid", ref.bvid);
    else if (ref.aid) args.push("--url", "https://www.bilibili.com/video/av" + ref.aid);
    else if (ref.url) args.push("--url", ref.url);
    if (ref.note) args.push("--note", ref.note);
    if (this.settings.inboxDir) args.push("--inbox-dir", this.settings.inboxDir);
    if (this.settings.mediaDir) args.push("--media-dir", this.settings.mediaDir);
    if (this.settings.videoWorkRoot) args.push("--workdir", this.settings.videoWorkRoot);
    if (this.settings.cookiesFile) args.push("--cookies-file", this.settings.cookiesFile);
    if (this.settings.visionEnabled && this.settings.visionUrl) {
      args.push("--vision", "--vision-url", this.settings.visionUrl, "--vision-model", this.settings.visionModel || "qwen2.5vl:3b");
    }
    if ((this.settings.aiCategories || "").trim()) {
      args.push("--ai-url", this.settings.visionUrl || "http://127.0.0.1:11434/v1",
        "--ai-model", this.settings.aiModel || "qwen2.5:3b",
        "--categories", this.settings.aiCategories);
    }
    return await new Promise((resolve, reject) => {
      const cp = window.require("child_process").spawn(py, args, { windowsHide: true });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { cp.kill(); reject(new Error("引擎超时（30 分钟）")); }, 30 * 60 * 1000);
      cp.stdout.on("data", (d) => { stdout += d; });
      cp.stderr.on("data", (d) => {
        stderr += d;
        const lines = String(d).match(/\[archive\][^\r\n]+/g);
        if (lines && onProgress) onProgress(lines[lines.length - 1].replace("[archive] ", ""));
      });
      cp.on("error", (e) => { clearTimeout(timer); reject(e); });
      cp.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(-300);
          reject(new Error(tail || `引擎退出码 ${code}`));
          return;
        }
        let out = null;
        try { out = JSON.parse(stdout.trim().split("\n").pop()); } catch {}
        resolve(out);
      });
    });
  }
}

/* ---------------- 晋升确认弹窗（与 douyin-vault-link 同构） ---------------- */

class PromoteModal extends Modal {
  constructor(app, plugin, stagedFile, stagedData) {
    super(app);
    this.plugin = plugin;
    this.stagedFile = stagedFile;
    this.stagedData = stagedData;
    this.title = stagedData.title || stagedFile.basename.replace(/\s*\[[^\]]+\]$/, "");
    this.domains = [];
    this.mapPath = "";
    this.group = "资料来源";
    this.reason = "";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "晋升为来源笔记（写入 04-来源，需确认）" });
    contentEl.createEl("p", { text: `收件箱：${this.stagedFile.path}` });

    new Setting(contentEl).setName("来源标题（04-来源/标题.md）").addText((t) => {
      t.setValue(this.title).onChange((v) => { this.title = v.trim(); });
      t.inputEl.style.width = "100%";
    });

    const reg = this.plugin.settings.domainRegistry.split("\n").map((s) => s.trim()).filter(Boolean);
    const domSetting = new Setting(contentEl).setName("领域标签（1~2 个，domain/<slug>）");
    for (const slug of reg) {
      domSetting.addToggle((tg) => {
        tg.setValue(false).onChange((v) => {
          if (v) {
            if (this.domains.length >= 2) { tg.setValue(false); new Notice("最多 2 个标签"); return; }
            this.domains.push(slug);
          } else this.domains = this.domains.filter((d) => d !== slug);
        });
      });
    }

    const maps = this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith(this.plugin.settings.mapsFolder + "/"))
      .sort((a, b) => a.basename.localeCompare(b.basename, "zh"));
    new Setting(contentEl).setName("挂到主题地图（可选）").addDropdown((dd) => {
      dd.addOption("", "不挂地图");
      for (const f of maps) dd.addOption(f.path, f.basename);
      dd.onChange((v) => { this.mapPath = v; });
    });
    new Setting(contentEl).setName("地图分组（### 标题，不存在则新建）").addText((t) => {
      t.setValue(this.group).onChange((v) => { this.group = v.trim(); });
    });
    new Setting(contentEl).setName("归属理由（一句；同时写入「为什么使用这个来源」）").addText((t) => {
      t.setValue("B站收藏的参考材料").onChange((v) => { this.reason = v.trim(); });
      t.inputEl.style.width = "100%";
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
      .addButton((b) => b.setCta().setButtonText("确认晋升").onClick(() => {
        if (!this.title) { new Notice("标题不能为空"); return; }
        if (this.domains.length < 1) { new Notice("至少 1 个 domain 标签"); return; }
        this.close();
        void this.plugin.promote(this.stagedFile, this.stagedData, {
          title: this.title, domains: this.domains, mapPath: this.mapPath, group: this.group, reason: this.reason,
        });
      }));
  }

  onClose() { this.contentEl.empty(); }
}

module.exports = BiliVaultLinkPlugin;
