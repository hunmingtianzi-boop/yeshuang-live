#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME_CANDIDATES = [
  process.env.YESHUANG_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["PROGRAMFILES(X86)"]
    && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA
    && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const TEST_TIMEOUT_MS = 10_000;

const sleep = (milliseconds) => new Promise((resolvePromise) => {
  setTimeout(resolvePromise, milliseconds);
});

function formatDetails(details) {
  if (details === undefined) return "";
  return `\n${JSON.stringify(details, null, 2)}`;
}

function assert(condition, message, details) {
  if (!condition) throw new Error(`${message}${formatDetails(details)}`);
}

function contentType(pathname) {
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  }[extname(pathname).toLowerCase()] || "application/octet-stream";
}

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname.startsWith("/api/")) {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end("{}");
        return;
      }
      if (requestUrl.pathname === "/__scene_runtime_probe__.mp4") {
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
        return;
      }

      const pathname = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
      const targetPath = resolve(REPO_ROOT, `.${pathname}`);
      if (targetPath !== REPO_ROOT && !targetPath.startsWith(`${REPO_ROOT}${sep}`)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }

      const fileStat = await stat(targetPath);
      if (!fileStat.isFile()) throw new Error("Not a file");
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": fileStat.size,
        "Content-Type": contentType(targetPath),
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(targetPath);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法获取测试服务器端口。");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections?.();
      if (server.listening) await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", () => this.rejectAll(new Error("CDP WebSocket 已关闭。")));
    socket.addEventListener("error", () => this.rejectAll(new Error("CDP WebSocket 出错。")));
  }

  static async connect(url, timeoutMs = TEST_TIMEOUT_MS) {
    const socket = new WebSocket(url);
    await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(new Error(`连接 CDP 超时：${url}`)), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolvePromise();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        rejectPromise(new Error(`无法连接 CDP：${url}`));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result || {});
      return;
    }
    if (!message.method) return;
    const waiters = this.eventWaiters.get(message.method) || [];
    this.eventWaiters.delete(message.method);
    waiters.forEach((waiter) => {
      clearTimeout(waiter.timeout);
      waiter.resolve(message.params || {});
    });
  }

  rejectAll(error) {
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
    this.eventWaiters.forEach((waiters) => waiters.forEach((waiter) => {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }));
    this.eventWaiters.clear();
  }

  send(method, params = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP 未连接，无法调用 ${method}。`));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { method, resolve: resolvePromise, reject: rejectPromise });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method, timeoutMs = TEST_TIMEOUT_MS) {
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = {
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout: setTimeout(() => {
          const waiters = this.eventWaiters.get(method) || [];
          this.eventWaiters.set(method, waiters.filter((entry) => entry !== waiter));
          rejectPromise(new Error(`等待 CDP 事件超时：${method}`));
        }, timeoutMs),
      };
      const waiters = this.eventWaiters.get(method) || [];
      waiters.push(waiter);
      this.eventWaiters.set(method, waiters);
    });
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

async function waitForFile(pathname, child, timeoutMs = TEST_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(pathname, "utf8");
    } catch {
      if (child.exitCode !== null) throw new Error(`Chrome 提前退出，退出码 ${child.exitCode}。`);
      await sleep(40);
    }
  }
  throw new Error(`等待文件超时：${pathname}`);
}

async function startChrome() {
  let chromePath = "";
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      chromePath = candidate;
      break;
    } catch {
      // Try the next common Chrome location.
    }
  }
  if (!chromePath) {
    throw new Error("找不到 Chrome；可通过 YESHUANG_CHROME_PATH 指定可执行文件。");
  }
  const profilePrefix = join(tmpdir(), "yeshuang-scene-runtime-");
  const profilePath = await mkdtemp(profilePrefix);
  const child = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profilePath}`,
    "--remote-allow-origins=*",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-gpu",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-default-browser-check",
    "--no-first-run",
    "--window-size=1280,720",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeLog = "";
  child.stderr.on("data", (chunk) => {
    chromeLog = `${chromeLog}${chunk}`.slice(-8000);
  });

  try {
    const activePort = await waitForFile(join(profilePath, "DevToolsActivePort"), child);
    const [portLine, browserPath] = activePort.trim().split(/\r?\n/);
    const port = Number(portLine);
    if (!Number.isInteger(port) || !browserPath) throw new Error("DevToolsActivePort 内容无效。");
    return {
      child,
      chromeLog: () => chromeLog,
      httpOrigin: `http://127.0.0.1:${port}`,
      profilePath,
      profilePrefix,
      wsUrl: `ws://127.0.0.1:${port}${browserPath}`,
    };
  } catch (error) {
    child.kill("SIGTERM");
    if (profilePath.startsWith(profilePrefix)) await rm(profilePath, { recursive: true, force: true });
    throw new Error(`${error.message}${chromeLog ? `\nChrome 输出：\n${chromeLog}` : ""}`);
  }
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  return Promise.race([
    once(child, "exit").then(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
}

async function stopChrome(chrome) {
  try {
    const browserClient = await CdpClient.connect(chrome.wsUrl, 2000);
    try {
      await Promise.race([browserClient.send("Browser.close"), sleep(1000)]);
    } finally {
      browserClient.close();
    }
  } catch {
    // Fall through to process termination.
  }
  if (!(await waitForChildExit(chrome.child, 2500))) {
    chrome.child.kill("SIGTERM");
  }
  if (!(await waitForChildExit(chrome.child, 2500))) {
    chrome.child.kill("SIGKILL");
    await waitForChildExit(chrome.child, 1000);
  }
  if (chrome.profilePath.startsWith(chrome.profilePrefix)) {
    await rm(chrome.profilePath, { recursive: true, force: true });
  }
}

function makeClip(id, state, action, overrides = {}) {
  return {
    id,
    state,
    action,
    src: "/__scene_runtime_probe__.mp4",
    enabled: true,
    playback: "once",
    weight: 1,
    cooldown_seconds: 0,
    gap_after_ms: [60_000, 60_000],
    ...overrides,
  };
}

function makeManifest(clips, playback = {}, layout = {}) {
  return {
    schema_version: 2,
    base: {
      src: "assets/scene-pack/base/yeshuang-base.png",
      width: 1536,
      height: 1024,
    },
    layout: {
      voice_anchor: { x: 0.19531, y: 0.45508 },
      presence_roi: {
        enter: [0, 0, 1, 1],
        exit: [0, 0, 1, 1],
      },
      ...layout,
    },
    playback: {
      transition_ms: 80,
      mode_transition_ms: 80,
      initial_idle_delay_ms: 300,
      idle_gap_ms: [60_000, 60_000],
      idle_skip_chance: 0,
      idle_playback_rate: [1, 1],
      presence_actions: ["breeze"],
      presence_initial_delay_ms: [0, 0],
      presence_cooldown_ms: [0, 0],
      presence_away_threshold_ms: 3000,
      mode_gap_ms: {
        listening: [60_000, 60_000],
        thinking: [60_000, 60_000],
        speaking: [60_000, 60_000],
      },
      safe_start_seconds: 0,
      ...playback,
    },
    clips,
  };
}

function probeSource({ manifest, deferredPlayIds = [], holdChat = false }) {
  const options = JSON.stringify({ manifest, deferredPlayIds, holdChat });
  return `(() => {
    const options = ${options};
    Math.random = () => 0;
    localStorage.setItem("yeshuang.music.enabled", "false");
    const probe = {
      blockedVideoErrorListeners: 0,
      deferredPlayIds: new Set(options.deferredPlayIds),
      lifecycle: [],
      maxActive: 0,
      pageErrors: [],
      pauseCalls: [],
      pendingPlays: Object.create(null),
      playCalls: [],
      timerCalls: [],
      windStrokes: 0,
      sample(label = "sample") {
        const active = Array.from(document.querySelectorAll(".scene-video.is-active"), (video) => video.dataset.sceneId);
        this.maxActive = Math.max(this.maxActive, active.length);
        this.lifecycle.push({
          action: document.documentElement?.dataset.sceneAction || "",
          active,
          at: performance.now(),
          label,
          mode: document.documentElement?.dataset.sceneMode || "",
        });
        return active;
      },
      rejectPlay(id, message = "stale play rejected by runtime smoke test") {
        const pending = this.pendingPlays[id];
        if (!pending) return false;
        delete this.pendingPlays[id];
        pending.reject(new DOMException(message, "AbortError"));
        return true;
      },
      snapshot() {
        const active = this.sample("snapshot");
        return {
          action: document.documentElement?.dataset.sceneAction || "",
          active,
          blockedVideoErrorListeners: this.blockedVideoErrorListeners,
          lifecycle: this.lifecycle.slice(-40),
          maxActive: this.maxActive,
          mode: document.documentElement?.dataset.sceneMode || "",
          pageErrors: [...this.pageErrors],
          pauseCalls: [...this.pauseCalls],
          playCalls: [...this.playCalls],
          quiet: document.documentElement?.dataset.quiet || "",
          timerCalls: this.timerCalls.slice(-80),
          windStrokes: this.windStrokes,
        };
      },
    };
    window.__sceneProbe = probe;

    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    nativeAddEventListener.call(window, "error", (event) => {
      probe.pageErrors.push(String(event.error?.stack || event.message || "window error"));
    });
    nativeAddEventListener.call(window, "unhandledrejection", (event) => {
      probe.pageErrors.push(String(event.reason?.stack || event.reason || "unhandled rejection"));
    });
    EventTarget.prototype.addEventListener = function(type, listener, eventOptions) {
      if (type === "error" && this instanceof HTMLVideoElement && this.classList.contains("scene-video")) {
        probe.blockedVideoErrorListeners += 1;
        return;
      }
      return nativeAddEventListener.call(this, type, listener, eventOptions);
    };

    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = function(callback, delay = 0, ...args) {
      probe.timerCalls.push({ at: performance.now(), delay: Number(delay) || 0 });
      return nativeSetTimeout(callback, delay, ...args);
    };

    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      writable: true,
      value: function() {
        if (!this.classList.contains("scene-video")) return Promise.resolve();
        const id = this.dataset.sceneId || this.id || "unknown";
        probe.playCalls.push({
          action: this.dataset.sceneAction || "",
          activeCount: document.querySelectorAll(".scene-video.is-active").length,
          at: performance.now(),
          id,
          role: this.dataset.sceneRole || "",
        });
        probe.sample("play:" + id);
        if (!probe.deferredPlayIds.has(id)) return Promise.resolve();
        return new Promise((resolvePlay, rejectPlay) => {
          probe.pendingPlays[id] = { resolve: resolvePlay, reject: rejectPlay };
        });
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      writable: true,
      value: function() {
        if (this.classList.contains("scene-video")) {
          probe.pauseCalls.push({ at: performance.now(), id: this.dataset.sceneId || this.id || "unknown" });
          probe.sample("pause:" + (this.dataset.sceneId || this.id || "unknown"));
        }
      },
    });

    const nativeStroke = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function(...args) {
      if (this.canvas?.id === "starField") probe.windStrokes += 1;
      return nativeStroke.apply(this, args);
    };

    const nativeFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      const rawUrl = typeof input === "string" ? input : input?.url || String(input);
      const url = new URL(rawUrl, location.href);
      const jsonResponse = (payload) => Promise.resolve(new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
      }));
      if (url.pathname.endsWith("/assets/scene-pack/manifest.json")) return jsonResponse(options.manifest);
      if (url.pathname === "/api/app/chat" && options.holdChat) return new Promise(() => {});
      if (url.pathname.startsWith("/api/")) return jsonResponse({});
      return nativeFetch(input, init);
    };

    const observer = new MutationObserver(() => probe.sample("mutation"));
    observer.observe(document, {
      attributes: true,
      attributeFilter: ["class", "data-scene-action", "data-scene-mode"],
      childList: true,
      subtree: true,
    });
    window.setInterval(() => probe.sample("interval"), 5);
  })();`;
}

async function createTarget(chrome) {
  const response = await fetch(`${chrome.httpOrigin}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT",
  });
  if (!response.ok) throw new Error(`创建 Chrome target 失败：HTTP ${response.status}`);
  return response.json();
}

async function closeTarget(chrome, targetId) {
  try {
    await fetch(`${chrome.httpOrigin}/json/close/${encodeURIComponent(targetId)}`);
  } catch {
    // Browser shutdown is the final cleanup fallback.
  }
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || "页面表达式执行失败";
    throw new Error(description);
  }
  return result.result?.value;
}

async function waitForEvaluation(client, expression, label, timeoutMs = TEST_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, expression)) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(25);
  }
  throw new Error(`等待页面条件超时：${label}${lastError ? `\n最后错误：${lastError.message}` : ""}`);
}

async function withTestPage(chrome, origin, options, callback) {
  const target = await createTarget(chrome);
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    if (options.reducedMotion) {
      await client.send("Emulation.setEmulatedMedia", {
        media: "",
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
    }
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: probeSource(options),
    });
    const loaded = client.waitForEvent("Page.loadEventFired");
    await client.send("Page.navigate", { url: `${origin}/` });
    await loaded;
    await waitForEvaluation(
      client,
      `document.documentElement.dataset.view === "overview"
        && document.querySelectorAll(".scene-video").length === ${options.manifest.clips.length}`,
      "场景调度器初始化",
    );
    return await callback(client);
  } finally {
    client.close();
    await closeTarget(chrome, target.id);
  }
}

async function snapshot(client) {
  return evaluate(client, "window.__sceneProbe.snapshot()");
}

async function testStateSwitchAndStalePromise(chrome, origin) {
  const idleId = "runtime-idle-breeze";
  const thinkingId = "runtime-thinking";
  const manifest = makeManifest([
    makeClip(idleId, "idle", "breeze"),
    makeClip(thinkingId, "thinking", "thinking-glance"),
  ]);

  return withTestPage(chrome, origin, {
    manifest,
    deferredPlayIds: [idleId],
    holdChat: true,
  }, async (client) => {
    await waitForEvaluation(
      client,
      `window.__sceneProbe.playCalls.some((entry) => entry.id === ${JSON.stringify(idleId)})`,
      "首个 idle 视频开始播放",
    );
    await evaluate(client, `(() => {
      const input = document.querySelector("#heroChatInput");
      input.value = "runtime smoke";
      document.querySelector("#heroChatForm").requestSubmit();
      return true;
    })()`);
    await waitForEvaluation(
      client,
      `window.__sceneProbe.playCalls.some((entry) => entry.id === ${JSON.stringify(thinkingId)})`,
      "状态切换后的 thinking 视频开始播放",
    );
    const rejected = await evaluate(client, `window.__sceneProbe.rejectPlay(${JSON.stringify(idleId)})`);
    assert(rejected, "旧 idle play Promise 未处于可控 pending 状态。");
    await sleep(40);
    const result = await snapshot(client);
    const idleFailed = await evaluate(
      client,
      `document.querySelector('[data-scene-id=${JSON.stringify(idleId)}]')?.dataset.sceneFailed || ""`,
    );
    assert(result.maxActive <= 1, "状态切换期间出现多个 active video。", result);
    assert(result.active.length === 1 && result.active[0] === thinkingId, "旧 Promise 覆盖了新状态。", result);
    assert(result.mode === "thinking" && result.action === "thinking-glance", "thinking 生命周期标记不正确。", result);
    assert(idleFailed !== "true", "过期 play rejection 错误地标记了旧视频失败。", { idleFailed, result });
    return { maxActive: result.maxActive, finalAction: result.action, playCount: result.playCalls.length };
  });
}

async function testPreferredActionFailureRecovery(chrome, origin) {
  const preferredId = "runtime-preferred-breeze";
  const fallbackId = "runtime-fallback-blink";
  const manifest = makeManifest([
    makeClip(preferredId, "idle", "breeze"),
    makeClip(fallbackId, "idle", "blink"),
  ], { initial_idle_delay_ms: 60_000 });

  return withTestPage(chrome, origin, { manifest }, async (client) => {
    const baselineTimers = await evaluate(
      client,
      "window.__sceneProbe.timerCalls.filter((entry) => entry.delay === 280).length",
    );
    await evaluate(client, `(() => {
      const stage = document.querySelector(".hero-stage");
      const layer = document.querySelector("#sceneLayer");
      const rect = layer.getBoundingClientRect();
      stage.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        clientX: rect.left + rect.width * 0.7,
        clientY: rect.top + rect.height * 0.35,
        pointerType: "mouse",
      }));
      return true;
    })()`);
    await waitForEvaluation(
      client,
      `window.__sceneProbe.timerCalls.filter((entry) => entry.delay === 280).length > ${baselineTimers}`,
      "presence 已安排 preferred action",
    );
    await evaluate(
      client,
      `document.querySelector('[data-scene-id=${JSON.stringify(preferredId)}]').dataset.sceneFailed = "true"`,
    );
    await waitForEvaluation(
      client,
      `window.__sceneProbe.playCalls.some((entry) => entry.id === ${JSON.stringify(fallbackId)})`,
      "preferred action 失败后普通 idle 调度恢复",
      4000,
    );
    const result = await snapshot(client);
    assert(!result.playCalls.some((entry) => entry.id === preferredId), "已失败的 preferred action 仍被播放。", result);
    assert(result.active.length === 1 && result.active[0] === fallbackId, "fallback idle 未接管调度。", result);
    assert(result.action === "blink", "fallback action 生命周期标记错误。", result);
    assert(result.maxActive <= 1, "preferred action 恢复过程中出现多个 active video。", result);
    return { maxActive: result.maxActive, finalAction: result.action, recoveredWith: fallbackId };
  });
}

async function testBreezeLifecycle(chrome, origin) {
  const breezeId = "runtime-breeze-lifecycle";
  const manifest = makeManifest([makeClip(breezeId, "idle", "breeze")]);

  return withTestPage(chrome, origin, { manifest }, async (client) => {
    await waitForEvaluation(
      client,
      `window.__sceneProbe.playCalls.some((entry) => entry.id === ${JSON.stringify(breezeId)})`,
      "breeze 视频开始播放",
    );
    let result = await snapshot(client);
    assert(result.action === "breeze" && result.active[0] === breezeId, "breeze 播放时 data lifecycle 未设置。", result);

    await evaluate(client, "document.querySelector('#quietToggle').click(); true");
    await waitForEvaluation(
      client,
      `!document.documentElement.dataset.sceneAction
        && document.querySelectorAll(".scene-video.is-active").length === 0`,
      "静谧模式清除 breeze lifecycle",
    );
    await evaluate(client, "document.querySelector('#quietToggle').click(); true");
    await waitForEvaluation(
      client,
      `window.__sceneProbe.playCalls.filter((entry) => entry.id === ${JSON.stringify(breezeId)}).length >= 2`,
      "退出静谧模式后 breeze 恢复",
    );
    await evaluate(client, `(() => {
      const video = document.querySelector(".scene-video.is-active");
      video.dispatchEvent(new Event("ended"));
      return true;
    })()`);
    await waitForEvaluation(
      client,
      `!document.documentElement.dataset.sceneAction
        && document.querySelectorAll(".scene-video.is-active").length === 0`,
      "ended 清除 breeze lifecycle",
    );
    result = await snapshot(client);
    assert(result.action === "", "breeze ended 后 data-scene-action 未清除。", result);
    assert(result.maxActive <= 1, "breeze 生命周期中出现多个 active video。", result);
    return {
      maxActive: result.maxActive,
      pauseCount: result.pauseCalls.filter((entry) => entry.id === breezeId).length,
      playCount: result.playCalls.filter((entry) => entry.id === breezeId).length,
    };
  });
}

async function testPresenceRoiAndCooldown(chrome, origin) {
  const glanceId = "runtime-presence-glance";
  const manifest = makeManifest([
    makeClip(glanceId, "idle", "glance"),
  ], {
    initial_idle_delay_ms: 60_000,
    presence_actions: ["glance"],
    presence_initial_delay_ms: [0, 0],
    presence_cooldown_ms: [1000, 1000],
  }, {
    presence_roi: {
      enter: [0.55, 0.06, 0.9, 0.6],
      exit: [0.48, 0.01, 0.96, 0.69],
    },
  });

  return withTestPage(chrome, origin, { manifest }, async (client) => {
    await evaluate(client, `(() => {
      window.__moveScenePointer = (normalizedX, normalizedY) => {
        const stage = document.querySelector(".hero-stage");
        const layer = document.querySelector("#sceneLayer");
        const rect = layer.getBoundingClientRect();
        const mediaWidth = 1536;
        const mediaHeight = 1024;
        const scale = Math.min(rect.width / mediaWidth, rect.height / mediaHeight);
        const renderedWidth = mediaWidth * scale;
        const renderedHeight = mediaHeight * scale;
        const offsetX = rect.width - renderedWidth;
        const offsetY = (rect.height - renderedHeight) / 2;
        stage.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true,
          clientX: rect.left + offsetX + renderedWidth * normalizedX,
          clientY: rect.top + offsetY + renderedHeight * normalizedY,
          pointerType: "mouse",
        }));
      };
      window.__moveScenePointer(0.2, 0.8);
      return true;
    })()`);
    await sleep(700);
    let result = await snapshot(client);
    assert(result.playCalls.length === 0, "人物区域外的指针移动触发了 presence 动作。", result);

    await evaluate(client, "window.__moveScenePointer(0.7, 0.35); true");
    await waitForEvaluation(
      client,
      `window.__sceneProbe.playCalls.filter((entry) => entry.id === ${JSON.stringify(glanceId)}).length === 1`,
      "进入人物 ROI 并停留后触发 glance",
      2500,
    );
    result = await snapshot(client);
    assert(result.action === "glance" && result.active[0] === glanceId, "presence glance 生命周期不正确。", result);

    await evaluate(client, `(() => {
      document.querySelector(".scene-video.is-active").dispatchEvent(new Event("ended"));
      window.__moveScenePointer(0.2, 0.8);
      return true;
    })()`);
    await sleep(120);
    await evaluate(client, "window.__moveScenePointer(0.7, 0.35); true");
    await sleep(700);
    result = await snapshot(client);
    assert(
      result.playCalls.filter((entry) => entry.id === glanceId).length === 1,
      "presence 冷却期内重复触发了 glance。",
      result,
    );
    await waitForEvaluation(
      client,
      `window.__sceneProbe.playCalls.filter((entry) => entry.id === ${JSON.stringify(glanceId)}).length === 2`,
      "presence 冷却结束后允许再次回应",
      2500,
    );
    result = await snapshot(client);
    assert(result.maxActive <= 1, "presence 回应期间出现多个 active video。", result);
    return {
      maxActive: result.maxActive,
      playCount: result.playCalls.filter((entry) => entry.id === glanceId).length,
    };
  });
}

async function testConsistentSceneCompositing(chrome, origin) {
  const clipId = "runtime-compositing-blink";
  const manifest = makeManifest([makeClip(clipId, "idle", "blink")]);
  return withTestPage(chrome, origin, { manifest }, async (client) => {
    await waitForEvaluation(
      client,
      `window.__sceneProbe.playCalls.some((entry) => entry.id === ${JSON.stringify(clipId)})`,
      "compositing 测试视频开始播放",
    );
    const layers = await evaluate(client, `(() => {
      const read = (selector) => {
        const style = getComputedStyle(document.querySelector(selector));
        return { filter: style.filter, zIndex: Number(style.zIndex) };
      };
      return {
        base: read(".scene-base"),
        video: read(".scene-video.is-active"),
        stars: read(".star-field"),
        vignette: read(".scene-vignette"),
        grain: read(".scene-grain"),
      };
    })()`);
    assert(
      layers.stars.zIndex > layers.video.zIndex
        && layers.vignette.zIndex > layers.video.zIndex
        && layers.grain.zIndex > layers.video.zIndex,
      "视频层盖住了星尘、暗角或颗粒，底图/视频会出现明暗跳变。",
      layers,
    );
    assert(
      layers.video.filter.includes("brightness(1.025)") && layers.base.filter === "none",
      "视频编码亮度补偿没有按预期生效。",
      layers,
    );
    return layers;
  });
}

async function testReducedMotion(chrome, origin) {
  const breezeId = "runtime-reduced-breeze";
  const manifest = makeManifest([makeClip(breezeId, "idle", "breeze")]);

  return withTestPage(chrome, origin, { manifest, reducedMotion: true }, async (client) => {
    await sleep(900);
    await evaluate(client, `(() => {
      const stage = document.querySelector(".hero-stage");
      const layer = document.querySelector("#sceneLayer");
      const rect = layer.getBoundingClientRect();
      stage.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        clientX: rect.left + rect.width * 0.7,
        clientY: rect.top + rect.height * 0.35,
        pointerType: "mouse",
      }));
      return true;
    })()`);
    await sleep(900);
    const result = await snapshot(client);
    assert(result.playCalls.length === 0, "reduced-motion 下仍播放了场景视频。", result);
    assert(result.active.length === 0 && result.maxActive === 0, "reduced-motion 下出现 active video。", result);
    assert(result.action === "", "reduced-motion 下仍设置了环境 action。", result);
    assert(result.windStrokes === 0, "reduced-motion 下仍绘制了 breeze 风痕。", result);
    return { maxActive: result.maxActive, playCount: result.playCalls.length, windStrokes: result.windStrokes };
  });
}

async function main() {
  const server = await startStaticServer();
  let chrome;
  const results = [];
  try {
    chrome = await startChrome();
    const tests = [
      ["max active + stale play promise", testStateSwitchAndStalePromise],
      ["preferred action failure recovery", testPreferredActionFailureRecovery],
      ["breeze data lifecycle", testBreezeLifecycle],
      ["presence ROI + cooldown", testPresenceRoiAndCooldown],
      ["consistent base/video compositing", testConsistentSceneCompositing],
      ["reduced-motion blocks video and wind streaks", testReducedMotion],
    ];
    for (const [name, test] of tests) {
      const startedAt = performance.now();
      const details = await test(chrome, server.origin);
      const durationMs = Math.round(performance.now() - startedAt);
      results.push({ name, durationMs, details });
      console.log(`PASS ${name} (${durationMs} ms)`);
    }
    console.log(`\n${results.length}/${results.length} scene runtime smoke tests passed.`);
  } finally {
    if (chrome) await stopChrome(chrome);
    await server.close();
  }
}

main().catch((error) => {
  console.error(`FAIL ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
