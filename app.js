(() => {
  "use strict";

  const state = {
    activeView: "overview",
    bootstrap: null,
    modelMap: {},
    busy: new Set(),
    refreshTimer: 0,
    sceneTimer: 0,
    sceneIndex: 0,
    sceneEmotionEpoch: 0,
    sceneController: null,
    quiet: false,
    companion: {
      sessionId: "",
      settings: {},
      lastActivityAt: Date.now(),
      checking: false,
      pollTimer: 0,
    },
    music: {
      enabled: localStorage.getItem("yeshuang.music.enabled") !== "false",
      volume: 0.18,
      selected: "yeshuang-ambient",
      tracks: [],
      audioContext: null,
      source: null,
      analyser: null,
      samples: null,
    },
    voice: {
      recognition: null,
      supported: false,
      nativeSupported: true,
      nativeListening: false,
      nativeAbort: null,
      listening: false,
      finalText: "",
      interimText: "",
      sent: false,
      autoSpeak: true,
      continuousActive: false,
      continuousTimer: 0,
      cosy: {
        enabled: true,
        autoStart: true,
        running: false,
        ready: false,
        referenceReady: false,
        sampleRate: 24000,
        status: "",
        selectedStyle: "clear",
        interactionMode: "hold",
        styles: [],
      },
      streamAbort: null,
      audioContext: null,
      outputAnalyser: null,
      outputSamples: null,
      outputAnalyserContext: null,
      micStream: null,
      micAudioContext: null,
      micSource: null,
      micAnalyser: null,
      micSamples: null,
      micRequestToken: 0,
      scheduledSources: new Set(),
      cosyPoll: 0,
      playbackToken: 0,
    },
    audioReactive: {
      frame: 0,
      level: 0,
      source: "idle",
      reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false,
    },
  };

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function setText(selector, value, fallback = "暂无") {
    const element = qs(selector);
    if (element) {
      element.textContent = value === undefined || value === null || value === "" ? fallback : String(value);
    }
  }

  function filename(path) {
    const text = String(path || "").replaceAll("\\", "/");
    return text.split("/").filter(Boolean).at(-1) || "暂无记录";
  }

  function localTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function isTruthyStatus(value) {
    const text = String(value || "").toLowerCase();
    return !["", "unknown", "off", "false", "sleeping", "stopped", "error", "disabled"].includes(text);
  }

  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), options.timeout || 15000);
    const request = {
      method: options.method || "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    };
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    if (options.body !== undefined) {
      request.headers["Content-Type"] = "application/json";
      request.body = JSON.stringify(options.body);
    }
    try {
      const response = await fetch(path, request);
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `请求失败：HTTP ${response.status}`);
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("本地服务响应超时。");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function toast(message, type = "info") {
    const region = qs("#toastRegion");
    if (!region) return;
    const item = document.createElement("div");
    item.className = `toast${type === "error" ? " is-error" : ""}`;
    item.textContent = String(message || "");
    region.append(item);
    window.setTimeout(() => item.remove(), 4200);
  }

  function setBusy(key, value) {
    if (value) state.busy.add(key);
    else state.busy.delete(key);
  }

  function showView(name, { updateHash = true } = {}) {
    const target = qs(`[data-view-panel="${name}"]`);
    if (!target) return;
    state.activeView = name;
    document.documentElement.dataset.view = name;
    qsa("[data-view-panel]").forEach((panel) => {
      const active = panel.dataset.viewPanel === name;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
      panel.style.setProperty("display", active ? (name === "chat" ? "flex" : "block") : "none", "important");
    });
    qsa("[data-view]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.view === name);
    });
    if (updateHash) {
      history.replaceState(null, "", `#${name}`);
    }
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    qs("#workspace")?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderConnection(online, message) {
    const indicator = qs("#connectionState");
    if (!indicator) return;
    indicator.classList.toggle("is-online", online);
    indicator.classList.toggle("is-error", !online);
    const label = qs("span", indicator);
    if (label) label.textContent = message;
  }

  function renderBootstrap(payload) {
    state.bootstrap = payload;
    const snap = payload.snapshot || {};
    const daemon = payload.daemon || {};
    const model = payload.model || {};
    const companion = payload.companion || {};
    const running = Boolean(daemon.running || snap.daemon_running);
    const game = snap.cottage_game || {};

    document.documentElement.dataset.daemon = running ? "awake" : "sleeping";
    qs("#appShell")?.setAttribute("data-ready", "true");
    renderConnection(true, running ? "夜霜运行中" : "控制中枢在线，夜霜正在休息");
    setText("#serverTime", String(snap.server_time || "").split(" ").at(-1)?.slice(0, 5), "--:--");

    setText("#presenceTitle", running ? "夜霜已经醒来" : "夜霜正在休息");
    setText(
      "#presenceSummary",
      running
        ? "守护进程已接管对话、日记、生活观察和记忆门控。"
        : "控制中枢仍然在线。启动守护进程后，后台任务会继续运行。",
    );
    setText("#daemonStatus", running ? "运行中" : "已休眠");
    setText("#daemonDetail", running ? `PID ${daemon.pid || snap.daemon_pid || "未知"}` : "未检测到守护进程");
    qs("#daemonStatus")?.classList.toggle("is-awake", running);

    const primaryButton = qs("#daemonPrimaryButton");
    if (primaryButton) {
      primaryButton.disabled = state.busy.has("daemon");
      primaryButton.textContent = running ? "让夜霜休息" : "启动夜霜";
      primaryButton.dataset.action = running ? "stop" : "start";
      primaryButton.classList.toggle("button-primary", !running);
      primaryButton.classList.toggle("button-secondary", running);
    }
    const restartButton = qs("#daemonRestartButton");
    if (restartButton) restartButton.disabled = state.busy.has("daemon") || !running;

    setText("#llmRoute", snap.actual_llm_route || snap.llm_route || "unknown");
    setText("#fallbackStatus", snap.fallback_status || "未使用备用模型");
    setText("#lifeObserver", snap.life_observer || "unknown");
    setText("#deviceSyncStatus", `设备同步：${snap.device_sync_status || "unknown"}`);
    setText("#messageBacklog", snap.message_backlog ?? 0, "0");
    setText("#activity", snap.activity || "夜霜正在安静地整理近期状态。");
    setText("#heroReplyMeta", running ? "夜霜正在整理近期状态" : "夜霜已经准备好听你说话");
    setText("#currentRoom", snap.current_room || "中央地毯");
    setText("#movementTarget", snap.movement_target || "自由巡屋");
    setText("#latestDiaryName", filename(snap.latest_diary));
    setText("#latestTimelineName", filename(snap.latest_timeline));
    setText("#contextBrokerPreview", snap.context_broker || "暂无上下文包");
    setText("#contextBroker", snap.context_broker || "暂无上下文包");
    setText("#latestTask", snap.latest_task || "暂无待办");
    setText("#personaReview", snap.persona_review || "暂无候选");
    setText("#lastArchive", snap.last_archive || "暂无归档");
    setText("#moodValue", snap.mood_status || game.mood || "--");
    setText("#bondValue", snap.bond_status || game.bond || "--");

    const presenceDot = qs("#presenceStateDot");
    presenceDot?.classList.toggle("is-online", running);
    setText("#presenceStateText", running ? "正在小屋中活动" : "正在休息");

    renderActivity(snap.recent_lines || []);
    renderRuntime(snap, daemon);
    renderModelSettings(model);
    applyCompanionSettings(companion);
    renderChat(payload.chat || []);
  }

  function renderActivity(lines) {
    const feed = qs("#recentActivity");
    if (!feed) return;
    feed.replaceChildren();
    const items = Array.isArray(lines) ? lines.filter(Boolean).slice(0, 8) : [];
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "empty-line";
      empty.textContent = "暂无新的小屋事件。";
      feed.append(empty);
      return;
    }
    items.forEach((line) => {
      const item = document.createElement("div");
      item.className = "activity-line";
      const text = document.createElement("span");
      text.textContent = String(line);
      item.append(text);
      feed.append(item);
    });
  }

  function renderRuntime(snap, daemon) {
    const running = Boolean(daemon.running || snap.daemon_running);
    setService("daemon", running, running ? `运行中，PID ${daemon.pid || snap.daemon_pid || "未知"}` : "已停止");
    setService(
      "model",
      !snap.model_alert,
      snap.model_alert || `${snap.actual_llm_route || snap.llm_route || "unknown"} 可用`,
    );
    setService("life", isTruthyStatus(snap.life_observer), snap.life_observer || "unknown");
    setService("sync", isTruthyStatus(snap.device_sync_status), snap.device_sync_status || "unknown");

    setText("#configuredRoute", snap.configured_llm || snap.llm_route || "unknown");
    setText("#actualRoute", snap.actual_llm_route || "unknown");
    setText("#lastProbe", snap.last_probe || "暂无探针");
    const cooldowns = Array.isArray(snap.provider_cooldowns) ? snap.provider_cooldowns : [];
    setText("#providerCooldowns", cooldowns.join("、") || "无");

    const issues = Array.isArray(snap.runtime_issues) ? snap.runtime_issues : [];
    const container = qs("#runtimeIssues");
    if (!container) return;
    container.replaceChildren();
    if (!issues.length) {
      const empty = document.createElement("p");
      empty.className = "empty-line";
      empty.textContent = "暂无运行问题。";
      container.append(empty);
      return;
    }
    issues.forEach((issue) => {
      const item = document.createElement("p");
      item.className = "issue-item";
      item.textContent = String(issue);
      container.append(item);
    });
  }

  function setService(name, online, detail) {
    const dot = qs(`[data-service="${name}"]`);
    dot?.classList.toggle("is-online", Boolean(online));
    dot?.classList.toggle("is-error", !online);
    const suffix = name[0].toUpperCase() + name.slice(1);
    setText(`#service${suffix}`, detail);
  }

  function renderModelSettings(model) {
    const provider = String(model.primary_provider || "codex");
    state.modelMap = { ...(model.models || {}) };
    const select = qs("#providerSelect");
    if (select) select.value = provider;
    const input = qs("#modelInput");
    if (input) input.value = state.modelMap[provider] || "";
    setText("#diarySchedule", model.daily_diary_time || "23:30");
    setText("#chatRoute", `${provider}/${state.modelMap[provider] || "unknown"}`);
  }

  function renderChat(entries) {
    const history = qs("#chatHistory");
    if (!history) return;
    history.replaceChildren();
    const items = Array.isArray(entries) ? entries : [];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const title = document.createElement("strong");
      title.textContent = "这里还很安静";
      const text = document.createElement("p");
      text.textContent = "说一句话，夜霜会从当前人格和安全记忆上下文中回应你。";
      empty.append(title, text);
      history.append(empty);
      return;
    }
    items.forEach((entry) => appendChatPair(entry, false));
    history.scrollTop = history.scrollHeight;
  }

  function appendChatPair(entry, scroll = true) {
    const history = qs("#chatHistory");
    if (!history) return;
    qs(".empty-state", history)?.remove();
    if (String(entry.user || "").trim()) appendChatMessage("user", entry.user, entry.time);
    appendChatMessage("yeshuang", entry.reply, entry.time, entry.kind || "");
    if (scroll) history.scrollTop = history.scrollHeight;
  }

  function appendChatMessage(role, content, time, kind = "") {
    const history = qs("#chatHistory");
    if (!history) return;
    const item = document.createElement("article");
    item.className = `chat-message is-${role}`;
    const text = document.createElement("p");
    text.textContent = String(content || "");
    const meta = document.createElement("small");
    const kindLabel = kind === "greeting" ? "启动问候" : kind === "proactive" ? "主动话题" : "";
    meta.textContent = role === "yeshuang"
      ? `夜霜${kindLabel ? ` · ${kindLabel}` : ""} · ${localTime(time)}`
      : `父亲 · ${localTime(time)}`;
    item.append(text, meta);
    history.append(item);
  }

  async function loadDocuments() {
    const jobs = [
      ["diary", "/api/latest-diary"],
      ["timeline", "/api/latest-timeline"],
      ["digest", "/api/latest-digest"],
    ];
    await Promise.all(
      jobs.map(async ([kind, path]) => {
        try {
          const result = await api(path);
          renderDocument(kind, result);
        } catch (error) {
          renderDocument(kind, { ok: false, title: "", content: error.message });
        }
      }),
    );
  }

  function renderDocument(kind, documentData) {
    const title = documentData.title || "暂无记录";
    const content = String(documentData.content || "").trim();
    if (kind === "diary") {
      setText("#diaryTitle", title);
      setText("#diaryPath", documentData.path || title);
      setText("#diaryState", documentData.ok ? "已读取" : "暂无可用日记");
      const reader = qs("#diaryContent");
      if (reader) {
        reader.textContent = content || "还没有可显示的日记。";
      }
      return;
    }
    setText(`#${kind}Title`, title);
    setText(`#${kind}Content`, content || `暂无${kind === "timeline" ? "时间线" : "生活摘要"}。`);
  }

  async function refresh({ quiet = false } = {}) {
    if (state.busy.has("refresh")) return false;
    setBusy("refresh", true);
    try {
      const payload = await api("/api/app/bootstrap");
      renderBootstrap(payload);
      await loadDocuments();
      if (!quiet) toast("状态已刷新。");
      return true;
    } catch (error) {
      renderConnection(false, "无法连接本地运行时");
      if (!quiet) toast(error.message, "error");
      return false;
    } finally {
      setBusy("refresh", false);
    }
  }

  async function refreshReadonlySection(section) {
    const key = `${section}-refresh`;
    if (state.busy.has(key) || state.busy.has("refresh")) return;
    const isLife = section === "life";
    const button = qs(isLife ? "#lifeRefreshButton" : "#memoryRefreshButton");
    const stateNode = qs(isLife ? "#lifeRefreshState" : "#memoryRefreshState");
    const idleLabel = isLife ? "刷新摘要" : "刷新索引";
    setBusy(key, true);
    if (button) {
      button.disabled = true;
      button.textContent = "正在刷新";
    }
    if (stateNode) stateNode.textContent = "正在读取本地只读数据…";
    const ok = await refresh({ quiet: true });
    if (stateNode) {
      stateNode.textContent = ok
        ? (isLife ? "只读摘要已同步" : "只读索引已同步")
        : "刷新失败，请重试";
      stateNode.classList.toggle("is-error", !ok);
      stateNode.classList.toggle("is-success", ok);
    }
    if (button) {
      button.disabled = false;
      button.textContent = ok ? "已刷新" : "重试";
      window.setTimeout(() => {
        if (!state.busy.has(key)) button.textContent = idleLabel;
      }, 1200);
    }
    setBusy(key, false);
  }

  async function controlDaemon(action) {
    if (state.busy.has("daemon")) return;
    if (action === "stop" && !window.confirm("让夜霜进入休息状态？本地控制中枢会继续运行。")) return;
    setBusy("daemon", true);
    const primary = qs("#daemonPrimaryButton");
    const restart = qs("#daemonRestartButton");
    if (primary) primary.disabled = true;
    if (restart) restart.disabled = true;
    try {
      const result = await api("/api/app/daemon", {
        method: "POST",
        body: { action },
        timeout: 20000,
      });
      toast(
        action === "stop"
          ? "夜霜已经进入休息状态。"
          : action === "restart"
            ? "夜霜正在重新启动。"
            : "夜霜正在醒来。",
      );
      window.setTimeout(() => refresh({ quiet: true }), 1000);
      return result;
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy("daemon", false);
      window.setTimeout(() => refresh({ quiet: true }), 1700);
    }
  }

  async function sendChat(message, { voice = false } = {}) {
    const text = String(message || "").trim();
    if (!text || state.busy.has("chat")) return;
    setBusy("chat", true);
    const button = qs("#chatSendButton");
    const heroButton = qs("#heroSendButton");
    const input = qs("#chatInput");
    const heroInput = qs("#heroChatInput");
    setVoiceMode("thinking", "思考中", "夜霜正在组织语言");
    setHeroReply("……", voice ? `听见了：“${text.slice(0, 42)}”` : "夜霜正在组织语言");
    if (button) {
      button.disabled = true;
      button.textContent = "思考中";
    }
    if (heroButton) heroButton.disabled = true;
    if (input) input.disabled = true;
    if (heroInput) heroInput.disabled = true;
    appendChatMessage("user", text, new Date().toISOString());
    qs("#chatHistory")?.scrollTo({ top: qs("#chatHistory").scrollHeight, behavior: "smooth" });
    let completed = false;
    try {
      const result = await api("/api/app/chat", {
        method: "POST",
        body: { message: text },
        timeout: 180000,
      });
      appendChatMessage("yeshuang", result.reply, result.time);
      if (input) input.value = "";
      if (heroInput) heroInput.value = "";
      const route = result.route || {};
      setText("#chatRoute", `${route.provider || "unknown"}/${route.model || "unknown"}`);
      setHeroReply(result.reply, `${route.provider || "unknown"} / ${route.model || "unknown"}`);
      if (state.voice.autoSpeak) await speakReply(result.reply);
      else setVoiceMode("idle", "按住说话", "也可以直接输入文字");
      playReplyEmotion(result.reply);
      completed = true;
    } catch (error) {
      appendChatMessage("yeshuang", `这次没有连上模型：${error.message}`, new Date().toISOString());
      setHeroReply("这次没有连上模型。", error.message);
      setVoiceMode("error", "没有听清", "可以改用文字输入");
      toast(error.message, "error");
    } finally {
      setBusy("chat", false);
      if (button) {
        button.disabled = false;
        button.textContent = "发送";
      }
      if (heroButton) heroButton.disabled = false;
      if (input) {
        input.disabled = false;
      }
      if (heroInput) heroInput.disabled = false;
      const history = qs("#chatHistory");
      if (history) history.scrollTop = history.scrollHeight;
    }
    if (completed) scheduleContinuousListening();
    return completed;
  }

  async function generateDiary(date) {
    if (state.busy.has("diary")) return;
    setBusy("diary", true);
    const button = qs("#diaryGenerateButton");
    if (button) {
      button.disabled = true;
      button.textContent = "正在书写";
    }
    setText("#diaryState", "正在调用模型");
    try {
      const result = await api("/api/app/diary", {
        method: "POST",
        body: { date },
        timeout: 180000,
      });
      setText("#diaryTitle", `${result.date} 夜霜数字日记`);
      setText("#diaryPath", result.path);
      setText("#diaryState", result.replaced_invalid ? "已替换错误记录" : result.changed ? "已写入" : "内容已存在");
      const reader = qs("#diaryContent");
      if (reader) reader.textContent = result.content || "";
      toast(result.replaced_invalid ? "错误记录已替换为完整日记。" : "日记已经写好。");
      await refresh({ quiet: true });
    } catch (error) {
      setText("#diaryState", "生成失败，未写入");
      toast(error.message, "error");
    } finally {
      setBusy("diary", false);
      if (button) {
        button.disabled = false;
        button.textContent = "生成日记";
      }
    }
  }

  async function saveModelSettings(provider, model) {
    if (state.busy.has("settings")) return;
    setBusy("settings", true);
    const button = qs("#modelSaveButton");
    if (button) button.disabled = true;
    setText("#settingsState", "正在保存");
    try {
      const result = await api("/api/app/model", {
        method: "POST",
        body: { provider, model },
      });
      state.modelMap[result.primary_provider] = result.model;
      setText("#settingsState", "已保存，下一次模型调用生效");
      toast("模型设置已保存。");
      await refresh({ quiet: true });
    } catch (error) {
      setText("#settingsState", "保存失败");
      toast(error.message, "error");
    } finally {
      setBusy("settings", false);
      if (button) button.disabled = false;
    }
  }

  async function probeModel() {
    if (state.busy.has("probe")) return;
    setBusy("probe", true);
    const button = qs("#modelProbeButton");
    if (button) {
      button.disabled = true;
      button.textContent = "探针运行中";
    }
    try {
      const result = await api("/api/app/probe", {
        method: "POST",
        body: {},
        timeout: 180000,
      });
      const route = result.result?.route || {};
      toast(`模型可用：${route.selected_provider || "unknown"}/${route.selected_model || "unknown"}`);
      await refresh({ quiet: true });
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy("probe", false);
      if (button) {
        button.disabled = false;
        button.textContent = "运行模型探针";
      }
    }
  }

  async function queueCottageAction(button) {
    const action = button.dataset.cottageAction;
    const payload = button.dataset.kind ? { kind: button.dataset.kind } : {};
    button.disabled = true;
    try {
      await api("/api/cottage/action", {
        method: "POST",
        body: { action, payload },
      });
      setText("#cottageHint", "动作已进入队列，夜霜稍后会回应。");
      toast("小屋动作已送达。");
      window.setTimeout(() => refresh({ quiet: true }), 1200);
    } catch (error) {
      setText("#cottageHint", error.message);
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  function setHeroReply(reply, meta = "") {
    setText("#heroReply", reply, "我在。");
    setText("#heroReplyMeta", meta, "夜霜已经准备好听你说话");
    const panel = qs("#heroReplyPanel");
    if (!panel?.animate) return;
    panel.animate(
      [
        { opacity: 0.3, transform: "translateY(5px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 420, easing: "cubic-bezier(.2,.7,.2,1)" },
    );
  }

  function setVoiceMode(mode, label, hint) {
    state.sceneEmotionEpoch += 1;
    document.documentElement.dataset.voice = mode;
    state.sceneController?.setState?.(
      ["idle", "listening", "thinking", "speaking"].includes(mode) ? mode : "idle",
    );
    setText("#voiceState", label, "按住说话");
    setText("#voiceHint", hint, "也可以直接输入文字");
    const voiceButton = qs("#voiceButton");
    voiceButton?.setAttribute("aria-pressed", mode === "listening" ? "true" : "false");
    voiceButton?.setAttribute("aria-label", `${label || "语音"}。${hint || ""}`.trim());
    qs("#chatVoiceButton")?.classList.toggle("is-listening", mode === "listening");
  }

  function voiceIdleCopy() {
    const mode = state.voice.cosy.interactionMode;
    if (mode === "toggle") return ["点击开始", "再次点击即可结束并发送"];
    if (mode === "continuous") {
      return state.voice.continuousActive
        ? ["连续对话中", "夜霜说完后会继续听你说话"]
        : ["开始连续对话", "点击后无需一直按住"];
    }
    return ["按住说话", "也可以直接输入文字"];
  }

  function setVoiceIdle() {
    const [label, hint] = voiceIdleCopy();
    setVoiceMode("idle", label, hint);
  }

  function playReplyEmotion(reply) {
    const text = String(reply || "");
    const warmEmotion = /开心|高兴|喜欢|谢谢|真好|太好|愿意|晚安|早安|辛苦|抱抱|可爱|温柔|微笑|笑了|☺|😊|✨/u;
    if (!warmEmotion.test(text)) return;
    const emotionEpoch = state.sceneEmotionEpoch;
    window.setTimeout(() => {
      if (emotionEpoch !== state.sceneEmotionEpoch) return;
      const voiceMode = document.documentElement.dataset.voice || "idle";
      if (voiceMode !== "idle" || state.voice.listening || state.voice.nativeListening) return;
      state.sceneController?.playEmotion?.();
    }, 260);
  }

  function clampAudioLevel(value) {
    return Math.min(1, Math.max(0, Number(value) || 0));
  }

  function readAnalyserLevel(analyser, samples, { noiseFloor = 0.008, gain = 7 } = {}) {
    if (!analyser || !samples) return 0;
    try {
      analyser.getFloatTimeDomainData(samples);
    } catch {
      return 0;
    }
    let energy = 0;
    for (let index = 0; index < samples.length; index += 1) {
      energy += samples[index] * samples[index];
    }
    const rms = Math.sqrt(energy / Math.max(1, samples.length));
    return clampAudioLevel((rms - noiseFloor) * gain);
  }

  function applyReactiveVoiceLevel(targetLevel, source) {
    const reactive = state.audioReactive;
    const target = clampAudioLevel(targetLevel);
    const smoothing = target > reactive.level ? 0.38 : 0.14;
    reactive.level += (target - reactive.level) * smoothing;
    if (reactive.level < 0.002) reactive.level = 0;
    reactive.source = source;

    const motionLevel = reactive.reducedMotion ? Math.min(reactive.level, 0.18) : reactive.level;
    const root = document.documentElement;
    root.style.setProperty("--voice-level", reactive.level.toFixed(3));
    root.style.setProperty("--voice-core-scale", (1 + motionLevel * 0.072).toFixed(4));
    root.style.setProperty("--voice-aura-scale", (0.96 + motionLevel * 0.18).toFixed(4));
    root.style.setProperty("--voice-aura-opacity", (0.08 + reactive.level * 0.64).toFixed(3));
    root.style.setProperty("--voice-meter-scale", (0.2 + reactive.level * 0.8).toFixed(3));
    root.style.setProperty("--voice-reactive-glow", `${Math.round(10 + reactive.level * 34)}px`);
    root.dataset.voiceReactiveSource = source;
  }

  function updateAudioReactivity(now = performance.now()) {
    const mode = document.documentElement.dataset.voice || "idle";
    let target = 0;
    let source = "idle";

    if (mode === "listening") {
      source = state.voice.micAnalyser ? "microphone" : "listening";
      target = state.voice.micAnalyser
        ? readAnalyserLevel(state.voice.micAnalyser, state.voice.micSamples, {
            noiseFloor: 0.012,
            gain: 10,
          })
        : 0.07;
    } else if (mode === "thinking") {
      source = "thinking";
      target = 0.1 + ((Math.sin(now / 360) + 1) / 2) * 0.08;
    } else if (mode === "speaking") {
      const measured = readAnalyserLevel(state.voice.outputAnalyser, state.voice.outputSamples, {
        noiseFloor: 0.004,
        gain: 6.5,
      });
      source = measured > 0.01 ? "voice" : "speaking";
      target = measured > 0.01 ? measured : 0.14 + ((Math.sin(now / 115) + 1) / 2) * 0.09;
    } else {
      const music = qs("#backgroundMusic");
      if (
        state.music.enabled
        && !state.quiet
        && music
        && !music.paused
        && !music.muted
      ) {
        const measured = readAnalyserLevel(state.music.analyser, state.music.samples, {
          noiseFloor: 0.01,
          gain: 5.5,
        });
        source = measured > 0.008 ? "music" : "idle";
        target = Math.min(0.3, measured * 0.32);
      }
    }

    applyReactiveVoiceLevel(target, source);
    state.audioReactive.frame = window.requestAnimationFrame(updateAudioReactivity);
  }

  function initializeAudioReactivity() {
    if (state.audioReactive.frame) return;
    applyReactiveVoiceLevel(0, "idle");
    state.audioReactive.frame = window.requestAnimationFrame(updateAudioReactivity);
  }

  function stopMicrophoneMeter() {
    state.voice.micRequestToken += 1;
    state.voice.micStream?.getTracks().forEach((track) => track.stop());
    state.voice.micStream = null;
    state.voice.micSource = null;
    state.voice.micAnalyser = null;
    state.voice.micSamples = null;
    const context = state.voice.micAudioContext;
    state.voice.micAudioContext = null;
    if (context && context.state !== "closed") void context.close().catch(() => {});
  }

  async function startMicrophoneMeter() {
    if (!navigator.mediaDevices?.getUserMedia) return false;
    stopMicrophoneMeter();
    const requestToken = state.voice.micRequestToken;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (requestToken !== state.voice.micRequestToken) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      const context = new AudioContextClass({ latencyHint: "interactive" });
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      const source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      await context.resume();
      state.voice.micStream = stream;
      state.voice.micAudioContext = context;
      state.voice.micSource = source;
      state.voice.micAnalyser = analyser;
      state.voice.micSamples = new Float32Array(analyser.fftSize);
      return true;
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      return false;
    }
  }

  function scheduleContinuousListening(delayMs = 350) {
    window.clearTimeout(state.voice.continuousTimer);
    if (
      !state.voice.continuousActive
      || state.voice.cosy.interactionMode !== "continuous"
      || state.quiet
      || document.hidden
    ) return;
    state.voice.continuousTimer = window.setTimeout(() => {
      if (!state.busy.has("chat") && document.documentElement.dataset.voice === "idle") {
        startVoiceCapture();
      }
    }, delayMs);
  }

  function setSceneSpeaking(speaking) {
    document.documentElement.dataset.sceneSpeaking = String(Boolean(speaking));
    state.sceneController?.setSpeaking(Boolean(speaking));
  }

  function preferredChineseVoice() {
    if (!("speechSynthesis" in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    return (
      voices.find((voice) => /^zh[-_](CN|Hans)/i.test(voice.lang) && /huihui|xiaoxiao|xiaoyi|female/i.test(voice.name)) ||
      voices.find((voice) => /^zh/i.test(voice.lang)) ||
      null
    );
  }

  function initializeMusicAnalyser() {
    if (state.music.source && state.music.analyser) return true;
    const music = qs("#backgroundMusic");
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!music || !AudioContextClass) return false;
    try {
      const context = state.music.audioContext || new AudioContextClass({ latencyHint: "playback" });
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.84;
      const source = context.createMediaElementSource(music);
      source.connect(analyser);
      analyser.connect(context.destination);
      state.music.audioContext = context;
      state.music.source = source;
      state.music.analyser = analyser;
      state.music.samples = new Float32Array(analyser.fftSize);
      return true;
    } catch {
      return false;
    }
  }

  function setMusicDuck(ducked) {
    const music = qs("#backgroundMusic");
    if (!music) return;
    music.volume = ducked ? 0.045 : state.music.volume;
  }

  function playBackgroundMusic() {
    const music = qs("#backgroundMusic");
    if (!music || !state.music.enabled || state.quiet) return;
    initializeMusicAnalyser();
    if (state.music.audioContext?.state === "suspended") {
      void state.music.audioContext.resume().catch(() => {});
    }
    music.muted = false;
    setMusicDuck(document.documentElement.dataset.voice === "speaking");
    void music.play().catch(() => {});
  }

  function initializeBackgroundMusic() {
    const music = qs("#backgroundMusic");
    if (!music) return;
    initializeMusicAnalyser();
    music.loop = true;
    music.volume = state.music.volume;
    music.muted = !state.music.enabled;
    if (state.music.enabled) playBackgroundMusic();
    const resume = () => playBackgroundMusic();
    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
  }

  function applyMusicLibrary(payload, { announce = false } = {}) {
    const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
    const selected = String(payload?.selected || tracks[0]?.id || "yeshuang-ambient");
    state.music.tracks = tracks;
    state.music.selected = selected;

    const select = qs("#musicSelect");
    if (select) {
      select.replaceChildren();
      tracks.forEach((track) => {
        const option = document.createElement("option");
        option.value = String(track.id || "");
        option.textContent = String(track.name || "未命名曲目");
        select.append(option);
      });
      select.value = selected;
    }

    const track = tracks.find((item) => String(item.id) === selected) || tracks[0];
    const music = qs("#backgroundMusic");
    if (track && music) {
      const source = String(track.url || "");
      if (source && music.getAttribute("src") !== source) {
        music.setAttribute("src", source);
        music.load();
      }
      playBackgroundMusic();
      setText("#musicState", String(track.name || "已选择"));
      if (announce) toast(`背景音乐已切换为：${track.name}`);
    }
  }

  async function loadMusicLibrary() {
    try {
      applyMusicLibrary(await api("/api/app/music"));
    } catch (error) {
      setText("#musicState", error.message);
    }
  }

  async function selectMusic(trackId) {
    const id = String(trackId || "").trim();
    if (!id) return;
    setText("#musicState", "正在切换…");
    try {
      const payload = await api("/api/app/music/select", {
        method: "POST",
        body: { id },
      });
      applyMusicLibrary(payload, { announce: true });
    } catch (error) {
      setText("#musicState", error.message);
      toast(error.message, "error");
    }
  }

  async function importMusic(input) {
    const file = input?.files?.[0];
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) {
      toast("单个音乐文件不能超过 100 MB。", "error");
      input.value = "";
      return;
    }
    input.disabled = true;
    setText("#musicState", "正在导入…");
    try {
      const response = await fetch("/api/app/music/import", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": file.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
        },
        body: file,
      });
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
      if (!response.ok || payload.ok === false) throw new Error(payload.error || "音乐导入失败。");
      applyMusicLibrary(payload, { announce: true });
    } catch (error) {
      setText("#musicState", error.message);
      toast(error.message, "error");
    } finally {
      input.disabled = false;
      input.value = "";
    }
  }

  function applyCosyVoice(payload, { announce = false } = {}) {
    const cosy = state.voice.cosy;
    cosy.enabled = payload?.enabled !== false;
    cosy.autoStart = payload?.auto_start !== false;
    cosy.running = Boolean(payload?.running);
    cosy.ready = Boolean(payload?.ready);
    cosy.referenceReady = Boolean(payload?.reference_ready);
    cosy.sampleRate = Number(payload?.sample_rate || 24000);
    cosy.status = String(payload?.status || "CosyVoice 3 状态未知");
    cosy.selectedStyle = String(payload?.selected_style || cosy.selectedStyle || "clear");
    cosy.interactionMode = String(payload?.interaction_mode || cosy.interactionMode || "hold");
    cosy.styles = Array.isArray(payload?.styles) ? payload.styles : cosy.styles;

    const enabled = qs("#cosyVoiceEnabled");
    const autoStart = qs("#cosyVoiceAutoStart");
    const mode = qs("#cosyVoiceMode");
    const style = qs("#cosyVoiceStyle");
    const interactionMode = qs("#voiceInteractionMode");
    const prompt = qs("#cosyVoicePromptText");
    const instruction = qs("#cosyVoiceInstruction");
    if (enabled) enabled.checked = cosy.enabled;
    if (autoStart) autoStart.checked = cosy.autoStart;
    if (mode && payload?.mode) mode.value = String(payload.mode);
    if (style) {
      if (cosy.styles.length) {
        style.replaceChildren();
        cosy.styles.forEach((profile) => {
          const option = document.createElement("option");
          option.value = String(profile.id || "");
          option.textContent = `${profile.label || profile.id}${profile.warmed ? " · 已预热" : ""}`;
          style.append(option);
        });
      }
      style.value = cosy.selectedStyle;
    }
    if (interactionMode) interactionMode.value = cosy.interactionMode;
    if (prompt && document.activeElement !== prompt) prompt.value = String(payload?.prompt_text || "");
    if (instruction && document.activeElement !== instruction) {
      instruction.value = String(payload?.instruction || "").replace(/<\|endofprompt\|>/g, "");
    }

    setText("#cosyVoiceState", cosy.status);
    const referenceLabel = payload?.reference_ready
      ? `${payload.reference_name || "参考声线"} · ${Number(payload.reference_duration || 0).toFixed(1)} 秒 · 仅本机`
      : "需要 2–60 秒 WAV。仅使用本人或明确授权的人声，文件只保存在本机。";
    setText("#cosyVoiceReferenceState", referenceLabel);

    const toggle = qs("#cosyVoiceToggleButton");
    if (toggle) {
      toggle.textContent = cosy.running ? "停止语音引擎" : "启动语音引擎";
      toggle.dataset.action = cosy.running ? "stop" : "start";
      toggle.disabled = !cosy.running && !(
        payload?.environment_ready && payload?.repository_ready && payload?.model_ready
      );
    }
    if (announce) toast(cosy.status, payload?.error ? "error" : "info");
    if (cosy.running && !cosy.ready) scheduleCosyVoicePoll();
    else window.clearTimeout(state.voice.cosyPoll);
  }

  async function loadCosyVoice({ announce = false } = {}) {
    try {
      applyCosyVoice(await api("/api/app/voice/cosyvoice", { timeout: 5000 }), { announce });
    } catch (error) {
      setText("#cosyVoiceState", error.message);
    }
  }

  async function waitForCosyVoiceReady(playbackToken, timeoutMs = 24000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && state.voice.playbackToken === playbackToken) {
      try {
        const payload = await api("/api/app/voice/cosyvoice", { timeout: 5000 });
        applyCosyVoice(payload);
        if (state.voice.cosy.ready) return true;
      } catch {
        // The worker may be between process startup and opening its health port.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }
    return false;
  }

  function scheduleCosyVoicePoll() {
    window.clearTimeout(state.voice.cosyPoll);
    state.voice.cosyPoll = window.setTimeout(() => {
      if (!document.hidden) void loadCosyVoice();
    }, 1800);
  }

  async function saveCosyVoiceSettings() {
    const button = qs("#cosyVoiceSaveButton");
    if (button) button.disabled = true;
    setText("#cosyVoiceState", "正在保存声线设置…");
    try {
      const payload = await api("/api/app/voice/cosyvoice/settings", {
        method: "POST",
        body: {
          enabled: Boolean(qs("#cosyVoiceEnabled")?.checked),
          auto_start: Boolean(qs("#cosyVoiceAutoStart")?.checked),
          mode: qs("#cosyVoiceMode")?.value || "instruct2",
          selected_style: qs("#cosyVoiceStyle")?.value || "clear",
          interaction_mode: qs("#voiceInteractionMode")?.value || "hold",
          prompt_text: qs("#cosyVoicePromptText")?.value || "",
          instruction: qs("#cosyVoiceInstruction")?.value || "",
        },
      });
      applyCosyVoice(payload, { announce: true });
    } catch (error) {
      setText("#cosyVoiceState", error.message);
      toast(error.message, "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function controlCosyVoice(action) {
    const button = qs("#cosyVoiceToggleButton");
    if (button) button.disabled = true;
    setText("#cosyVoiceState", action === "stop" ? "正在停止语音引擎…" : "正在启动并加载模型…");
    try {
      const payload = await api("/api/app/voice/cosyvoice/control", {
        method: "POST",
        body: { action },
        timeout: 10000,
      });
      applyCosyVoice(payload, { announce: action === "stop" });
    } catch (error) {
      setText("#cosyVoiceState", error.message);
      toast(error.message, "error");
      await loadCosyVoice();
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function importCosyVoiceReference(input) {
    const file = input?.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      toast("参考声线不能超过 25 MB。", "error");
      input.value = "";
      return;
    }
    input.disabled = true;
    setText("#cosyVoiceReferenceState", "正在导入参考声线…");
    try {
      const response = await fetch("/api/app/voice/cosyvoice/reference", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": file.type || "audio/wav",
          "X-File-Name": encodeURIComponent(file.name),
          "X-Prompt-Text": encodeURIComponent(qs("#cosyVoicePromptText")?.value || ""),
        },
        body: file,
      });
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
      if (!response.ok || payload.ok === false) throw new Error(payload.error || "参考声线导入失败。");
      applyCosyVoice(payload, { announce: true });
    } catch (error) {
      setText("#cosyVoiceReferenceState", error.message);
      toast(error.message, "error");
    } finally {
      input.disabled = false;
      input.value = "";
    }
  }

  function applyCompanionSettings(payload) {
    if (!payload || typeof payload !== "object") return;
    state.companion.sessionId = String(payload.session_id || state.companion.sessionId || "");
    state.companion.settings = { ...state.companion.settings, ...payload };
    state.voice.autoSpeak = payload.auto_speak !== false;
    const values = {
      "#companionEnabled": payload.enabled !== false,
      "#startupGreetingEnabled": payload.startup_greeting_enabled !== false,
      "#companionAutoSpeak": payload.auto_speak !== false,
      "#proactiveEnabled": payload.proactive_enabled !== false,
    };
    Object.entries(values).forEach(([selector, checked]) => {
      const input = qs(selector);
      if (input && document.activeElement !== input) input.checked = checked;
    });
    const numberValues = {
      "#proactiveIdleMin": Math.round(Number(payload.idle_min_seconds || 480) / 60),
      "#proactiveIdleMax": Math.round(Number(payload.idle_max_seconds || 720) / 60),
      "#proactiveCooldown": Math.round(Number(payload.cooldown_seconds || 1800) / 60),
      "#proactiveDailyLimit": Number(payload.daily_limit ?? 3),
    };
    Object.entries(numberValues).forEach(([selector, value]) => {
      const input = qs(selector);
      if (input && document.activeElement !== input) input.value = String(value);
    });
    const quietStart = qs("#companionQuietStart");
    const quietEnd = qs("#companionQuietEnd");
    if (quietStart && document.activeElement !== quietStart) quietStart.value = String(payload.quiet_start || "22:30");
    if (quietEnd && document.activeElement !== quietEnd) quietEnd.value = String(payload.quiet_end || "08:00");
    const used = Number(payload.proactive_count || 0);
    const limit = Number(payload.daily_limit ?? 3);
    setText("#companionUsageState", `今天已主动开启 ${used}/${limit} 次`);
    setText("#companionSettingsState", payload.proactive_enabled === false ? "主动话题已关闭" : "设置已同步");
  }

  async function saveCompanionSettings() {
    const button = qs("#companionSettingsSaveButton");
    if (button) button.disabled = true;
    setText("#companionSettingsState", "正在保存…");
    try {
      const payload = await api("/api/app/companion/settings", {
        method: "POST",
        body: {
          enabled: Boolean(qs("#companionEnabled")?.checked),
          startup_greeting_enabled: Boolean(qs("#startupGreetingEnabled")?.checked),
          auto_speak: Boolean(qs("#companionAutoSpeak")?.checked),
          proactive_enabled: Boolean(qs("#proactiveEnabled")?.checked),
          idle_min_seconds: Math.round(Number(qs("#proactiveIdleMin")?.value || 8) * 60),
          idle_max_seconds: Math.round(Number(qs("#proactiveIdleMax")?.value || 12) * 60),
          cooldown_seconds: Math.round(Number(qs("#proactiveCooldown")?.value || 30) * 60),
          daily_limit: Number(qs("#proactiveDailyLimit")?.value || 0),
          quiet_start: qs("#companionQuietStart")?.value || "22:30",
          quiet_end: qs("#companionQuietEnd")?.value || "08:00",
        },
      });
      applyCompanionSettings(payload.companion || {});
      toast("陪伴设置已保存。");
    } catch (error) {
      setText("#companionSettingsState", error.message);
      toast(error.message, "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function acknowledgeCompanionCandidate(candidate, status) {
    return api("/api/app/companion/message/ack", {
      method: "POST",
      body: { id: candidate.id, status },
      timeout: 10000,
    });
  }

  async function deliverCompanionCandidate(candidate) {
    if (!candidate?.id || !String(candidate.text || "").trim()) return false;
    const result = await acknowledgeCompanionCandidate(candidate, "delivered");
    if (result.status !== "delivered" || !result.entry) return false;
    appendChatPair(result.entry);
    setHeroReply(result.entry.reply, candidate.kind === "greeting" ? "夜霜的启动问候" : "夜霜主动想和你聊聊");
    state.companion.lastActivityAt = Date.now();
    if (candidate.should_speak && state.voice.autoSpeak && !state.quiet) {
      await speakReply(result.entry.reply);
    }
    playReplyEmotion(result.entry.reply);
    return true;
  }

  async function deliverStartupGreeting() {
    const sessionId = state.companion.sessionId;
    if (!sessionId) return;
    const storageKey = `yeshuang.greeted.${sessionId}`;
    if (sessionStorage.getItem(storageKey) === "true") return;
    try {
      const result = await api("/api/app/companion/greeting", {
        method: "POST",
        body: { session_id: sessionId },
        timeout: 10000,
      });
      if (result.status === "candidate" && result.candidate) {
        await deliverCompanionCandidate(result.candidate);
      }
      sessionStorage.setItem(storageKey, "true");
    } catch (error) {
      setText("#heroReplyMeta", `启动问候暂时不可用：${error.message}`);
    }
  }

  function markUserActivity() {
    state.companion.lastActivityAt = Date.now();
  }

  async function checkProactiveTopic() {
    if (
      state.companion.checking
      || !state.companion.sessionId
      || document.hidden
      || state.busy.size
      || document.documentElement.dataset.voice !== "idle"
    ) return;
    const activityAt = state.companion.lastActivityAt;
    const idleSeconds = Math.floor((Date.now() - activityAt) / 1000);
    state.companion.checking = true;
    try {
      const result = await api("/api/app/companion/proactive/check", {
        method: "POST",
        body: {
          session_id: state.companion.sessionId,
          visible: !document.hidden,
          idle_seconds: idleSeconds,
          active_view: state.activeView,
          voice_state: document.documentElement.dataset.voice || "idle",
          busy: Boolean(state.busy.size),
        },
        timeout: 180000,
      });
      if (result.status !== "candidate" || !result.candidate) return;
      const stillEligible = (
        !document.hidden
        && state.companion.lastActivityAt === activityAt
        && !state.busy.size
        && document.documentElement.dataset.voice === "idle"
      );
      if (!stillEligible) {
        await acknowledgeCompanionCandidate(result.candidate, "dismissed");
        return;
      }
      await deliverCompanionCandidate(result.candidate);
      await refresh({ quiet: true });
    } catch (error) {
      if (!String(error?.message || "").includes("超时")) {
        setText("#companionSettingsState", `主动话题暂不可用：${error.message}`);
      }
    } finally {
      state.companion.checking = false;
    }
  }

  function startCompanionPolling() {
    window.clearInterval(state.companion.pollTimer);
    state.companion.pollTimer = window.setInterval(() => {
      void checkProactiveTopic();
    }, 30_000);
  }

  function stopCosyVoicePlayback() {
    state.voice.streamAbort?.abort();
    state.voice.streamAbort = null;
    state.voice.scheduledSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // A source may already have naturally ended.
      }
    });
    state.voice.scheduledSources.clear();
  }

  function ensureVoiceOutputAnalyser(context) {
    if (
      state.voice.outputAnalyser
      && state.voice.outputAnalyserContext === context
    ) return state.voice.outputAnalyser;
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.68;
    analyser.connect(context.destination);
    state.voice.outputAnalyser = analyser;
    state.voice.outputSamples = new Float32Array(analyser.fftSize);
    state.voice.outputAnalyserContext = context;
    return analyser;
  }

  function ensureVoiceAudioContext(sampleRate) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("当前桌面环境不支持流式音频。");
    if (!state.voice.audioContext || state.voice.audioContext.state === "closed") {
      state.voice.audioContext = new AudioContextClass({
        latencyHint: "interactive",
        sampleRate: Number(sampleRate || 24000),
      });
      state.voice.outputAnalyser = null;
      state.voice.outputSamples = null;
      state.voice.outputAnalyserContext = null;
    }
    ensureVoiceOutputAnalyser(state.voice.audioContext);
    return state.voice.audioContext;
  }

  async function playCosyVoiceStream(content) {
    const controller = new AbortController();
    state.voice.streamAbort = controller;
    const response = await fetch("/api/app/voice/stream", {
      method: "POST",
      headers: {
        Accept: "audio/L16, application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: content, style_id: state.voice.cosy.selectedStyle }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `CosyVoice 3 请求失败：HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("CosyVoice 3 没有返回音频流。");

    const sampleRate = Number(response.headers.get("X-Sample-Rate") || state.voice.cosy.sampleRate || 24000);
    const context = ensureVoiceAudioContext(sampleRate);
    await context.resume();
    const reader = response.body.getReader();
    let carry = null;
    let scheduledAt = context.currentTime + 0.08;
    let receivedAudio = false;
    const speakingVideoLeadSeconds = 0.22;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let bytes = value;
      if (carry !== null) {
        const joined = new Uint8Array(bytes.length + 1);
        joined[0] = carry;
        joined.set(bytes, 1);
        bytes = joined;
        carry = null;
      }
      if (bytes.length % 2) {
        carry = bytes[bytes.length - 1];
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (!bytes.length) continue;

      const frameCount = bytes.length / 2;
      const buffer = context.createBuffer(1, frameCount, sampleRate);
      const channel = buffer.getChannelData(0);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let index = 0; index < frameCount; index += 1) {
        channel[index] = view.getInt16(index * 2, true) / 32768;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(ensureVoiceOutputAnalyser(context));
      source.onended = () => state.voice.scheduledSources.delete(source);
      state.voice.scheduledSources.add(source);
      if (!receivedAudio) {
        receivedAudio = true;
        setSceneSpeaking(true);
        scheduledAt = Math.max(scheduledAt, context.currentTime + speakingVideoLeadSeconds);
        setVoiceMode("speaking", "正在说话", "CosyVoice 3 · 清灵夜霜 · 再次按住可以打断");
      }
      scheduledAt = Math.max(scheduledAt, context.currentTime + 0.025);
      source.start(scheduledAt);
      scheduledAt += buffer.duration;
    }
    if (!receivedAudio) throw new Error("CosyVoice 3 返回了空音频。");
    const remainingMs = Math.max(0, (scheduledAt - context.currentTime) * 1000);
    const visualReleaseLeadMs = Math.min(110, remainingMs);
    await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, remainingMs - visualReleaseLeadMs)));
    setSceneSpeaking(false);
    await new Promise((resolve) => window.setTimeout(resolve, visualReleaseLeadMs + 80));
    if (state.voice.streamAbort === controller) state.voice.streamAbort = null;
  }

  function stopSpeaking() {
    state.voice.playbackToken += 1;
    setSceneSpeaking(false);
    stopCosyVoicePlayback();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setMusicDuck(false);
    void api("/api/app/voice/stop", { method: "POST", body: {}, timeout: 5000 }).catch(() => {});
  }

  function shutdownAudio() {
    window.clearInterval(state.refreshTimer);
    window.clearTimeout(state.sceneTimer);
    window.clearTimeout(state.voice.cosyPoll);
    window.clearTimeout(state.voice.continuousTimer);
    window.clearInterval(state.companion.pollTimer);
    window.cancelAnimationFrame(state.audioReactive.frame);
    state.audioReactive.frame = 0;
    state.voice.nativeAbort?.abort();
    stopMicrophoneMeter();
    stopCosyVoicePlayback();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    const voiceContext = state.voice.audioContext;
    state.voice.audioContext = null;
    state.voice.outputAnalyser = null;
    state.voice.outputSamples = null;
    state.voice.outputAnalyserContext = null;
    if (voiceContext && voiceContext.state !== "closed") void voiceContext.close().catch(() => {});
    const musicContext = state.music.audioContext;
    state.music.audioContext = null;
    state.music.source = null;
    state.music.analyser = null;
    state.music.samples = null;
    if (musicContext && musicContext.state !== "closed") void musicContext.close().catch(() => {});
    try {
      state.voice.recognition?.abort();
    } catch {
      // The recognizer may already have been released by the WebView.
    }
    qsa("audio, video").forEach((media) => {
      media.muted = true;
      media.volume = 0;
      media.pause();
    });
    void fetch("/api/app/voice/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      keepalive: true,
    }).catch(() => {});
  }

  async function speakReply(text) {
    const content = String(text || "").trim();
    if (!content || !state.voice.autoSpeak || state.quiet) {
      setVoiceIdle();
      return;
    }
    stopSpeaking();
    const playbackToken = state.voice.playbackToken;
    if (
      state.voice.cosy.enabled
      && state.voice.cosy.referenceReady
      && !state.voice.cosy.ready
    ) {
      setVoiceMode("thinking", "思考中", "正在唤醒清灵声线");
      const ready = await waitForCosyVoiceReady(playbackToken);
      if (state.voice.playbackToken !== playbackToken) return;
      if (!ready) {
        setText("#cosyVoiceState", "CosyVoice 3 本次预热超时 · 临时使用备用女声");
      }
    }
    if (state.voice.cosy.enabled && state.voice.cosy.ready && state.voice.cosy.referenceReady) {
      setVoiceMode("thinking", "思考中", "CosyVoice 3 正在生成首段语音");
      setMusicDuck(true);
      try {
        await playCosyVoiceStream(content);
        setMusicDuck(false);
        setVoiceIdle();
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
        state.voice.cosy.ready = false;
        setText("#cosyVoiceState", `${error.message} · 本句已切换备用女声`);
        void loadCosyVoice();
      }
    }

    setVoiceMode("speaking", "正在说话", "Windows 本地清冷女声 · CosyVoice 备用链路");
    setMusicDuck(true);
    try {
      setSceneSpeaking(true);
      await api("/api/app/voice/speak", {
        method: "POST",
        body: { text: content, language: "zh-CN" },
        timeout: 8000,
      });
      const fallbackDuration = Math.min(15000, Math.max(1800, content.length * 240));
      await new Promise((resolve) => window.setTimeout(resolve, fallbackDuration));
      setMusicDuck(false);
      setSceneSpeaking(false);
      if (document.documentElement.dataset.voice === "speaking") setVoiceIdle();
      return;
    } catch {
      setSceneSpeaking(false);
      // Web Speech remains a last-resort fallback for machines without System.Speech.
    }
    if (!("speechSynthesis" in window)) {
      setMusicDuck(false);
      setVoiceMode("idle", "按住说话", "语音朗读暂时不可用");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(content);
    utterance.lang = "zh-CN";
    utterance.rate = 0.9;
    utterance.pitch = 0.88;
    utterance.volume = 0.9;
    const voice = preferredChineseVoice();
    if (voice) utterance.voice = voice;
    utterance.onstart = () => {
      setSceneSpeaking(true);
      setMusicDuck(true);
      setVoiceMode("speaking", "正在说话", "清冷女声 · 再次按住可以打断");
    };
    await new Promise((resolve) => {
      utterance.onend = () => {
        setSceneSpeaking(false);
        setMusicDuck(false);
        setVoiceIdle();
        resolve();
      };
      utterance.onerror = () => {
        setSceneSpeaking(false);
        setMusicDuck(false);
        setVoiceMode("idle", "按住说话", "语音朗读暂时不可用");
        resolve();
      };
      window.speechSynthesis.speak(utterance);
    });
  }

  function mirrorVoiceTranscript(text) {
    const value = String(text || "").trim();
    const heroInput = qs("#heroChatInput");
    const chatInput = qs("#chatInput");
    if (heroInput) heroInput.value = value;
    if (chatInput) chatInput.value = value;
  }

  function initializeVoiceRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    state.voice.supported = Boolean(Recognition);
    if (!Recognition) {
      setVoiceMode("idle", "按住说话", "使用 Windows 本地语音");
      return;
    }

    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      state.voice.listening = true;
      state.voice.finalText = "";
      state.voice.interimText = "";
      state.voice.sent = false;
      stopSpeaking();
      const hint = state.voice.cosy.interactionMode === "hold" ? "松开后发送" : "再次点击即可结束并发送";
      setVoiceMode("listening", "正在听", hint);
      setHeroReply("我在听。", "可以自然地说完整一句话");
    };
    recognition.onresult = (event) => {
      let interim = "";
      let finalText = state.voice.finalText;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = String(event.results[index][0]?.transcript || "");
        if (event.results[index].isFinal) finalText += transcript;
        else interim += transcript;
      }
      state.voice.finalText = finalText.trim();
      state.voice.interimText = interim.trim();
      mirrorVoiceTranscript(state.voice.finalText || state.voice.interimText);
      setText("#voiceHint", state.voice.finalText || state.voice.interimText || "松开后发送");
    };
    recognition.onerror = (event) => {
      state.voice.listening = false;
      state.voice.continuousActive = false;
      stopMicrophoneMeter();
      const messages = {
        "not-allowed": "需要麦克风权限",
        "audio-capture": "没有检测到麦克风",
        "no-speech": "没有听见声音",
        network: "语音识别服务暂时不可用",
      };
      const message = messages[event.error] || "语音识别没有完成";
      setVoiceMode("error", message, "可以改用文字输入");
      setHeroReply("我没有听清。", message);
    };
    recognition.onend = () => {
      state.voice.listening = false;
      stopMicrophoneMeter();
      const message = String(state.voice.finalText || state.voice.interimText || "").trim();
      if (message && !state.voice.sent) {
        state.voice.sent = true;
        void sendChat(message, { voice: true });
      } else if (document.documentElement.dataset.voice === "listening") {
        setVoiceIdle();
        if (state.voice.continuousActive) scheduleContinuousListening(900);
      }
    };
    state.voice.recognition = recognition;
  }

  function startVoiceCapture() {
    if (!state.voice.supported || !state.voice.recognition) {
      startNativeVoiceCapture();
      return;
    }
    if (state.voice.listening || state.busy.has("chat")) return;
    if (state.voice.cosy.interactionMode === "continuous") state.voice.continuousActive = true;
    try {
      void startMicrophoneMeter();
      state.voice.recognition.start();
    } catch (error) {
      stopMicrophoneMeter();
      if (!String(error?.message || "").toLowerCase().includes("already")) {
        setVoiceMode("error", "麦克风没有启动", "请稍后再试");
      }
    }
  }

  function stopVoiceCapture() {
    if (state.voice.nativeListening) {
      setVoiceMode("listening", "正在听", "说完后会自动发送");
      return;
    }
    if (!state.voice.listening || !state.voice.recognition) return;
    try {
      stopMicrophoneMeter();
      state.voice.recognition.stop();
      setVoiceMode("thinking", "思考中", "马上发送给夜霜");
    } catch {
      state.voice.listening = false;
    }
  }

  async function startNativeVoiceCapture() {
    if (!state.voice.nativeSupported || state.voice.nativeListening || state.busy.has("chat")) return;
    state.voice.nativeListening = true;
    const controller = new AbortController();
    state.voice.nativeAbort = controller;
    stopSpeaking();
    void startMicrophoneMeter();
    setVoiceMode("listening", "正在听", "说完后会自动发送");
    setHeroReply("我在听。", "Windows 本地语音识别已经启动");
    let completed = false;
    try {
      const result = await api("/api/app/voice/listen", {
        method: "POST",
        body: { language: "zh-CN", timeout: 9 },
        timeout: 16000,
        signal: controller.signal,
      });
      const message = String(result.text || "").trim();
      if (!message) throw new Error("没有听见清晰的声音");
      mirrorVoiceTranscript(message);
      setVoiceMode("thinking", "思考中", "马上发送给夜霜");
      completed = await sendChat(message, { voice: true });
    } catch (error) {
      if (controller.signal.aborted) {
        setVoiceIdle();
      } else {
        state.voice.continuousActive = false;
        setVoiceMode("error", "我没有听清", "可以再试一次或直接输入文字");
        setHeroReply("我没有听清。", error.message);
      }
    } finally {
      stopMicrophoneMeter();
      state.voice.nativeListening = false;
      if (state.voice.nativeAbort === controller) state.voice.nativeAbort = null;
      if (completed) scheduleContinuousListening();
    }
  }

  function bindHoldToTalk(button) {
    if (!button) return;
    button.style.touchAction = "none";
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (state.voice.cosy.interactionMode !== "hold") return;
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      startVoiceCapture();
    });
    button.addEventListener("pointerup", (event) => {
      if (state.voice.cosy.interactionMode !== "hold") return;
      event.preventDefault();
      stopVoiceCapture();
    });
    button.addEventListener("pointercancel", () => {
      if (state.voice.cosy.interactionMode === "hold") stopVoiceCapture();
    });
    button.addEventListener("keydown", (event) => {
      if ((event.key === " " || event.key === "Enter") && !event.repeat) {
        event.preventDefault();
        if (state.voice.cosy.interactionMode === "hold") startVoiceCapture();
        else toggleVoiceCapture();
      }
    });
    button.addEventListener("keyup", (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        if (state.voice.cosy.interactionMode === "hold") stopVoiceCapture();
      }
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (event.detail !== 0 && state.voice.cosy.interactionMode !== "hold") toggleVoiceCapture();
    });
  }

  function toggleVoiceCapture() {
    const active = state.voice.listening || state.voice.nativeListening;
    if (active) {
      stopVoiceCapture();
      return;
    }
    if (state.voice.cosy.interactionMode === "continuous") state.voice.continuousActive = true;
    startVoiceCapture();
  }

  function stopVoiceSession() {
    state.voice.continuousActive = false;
    window.clearTimeout(state.voice.continuousTimer);
    state.voice.nativeAbort?.abort();
    state.voice.nativeAbort = null;
    try {
      state.voice.recognition?.abort();
    } catch {
      // Recognition may already be stopping.
    }
    state.voice.listening = false;
    stopMicrophoneMeter();
    stopSpeaking();
    setVoiceIdle();
  }

  async function updateVoicePreference(kind, value) {
    const previousInteraction = state.voice.cosy.interactionMode;
    const style = kind === "style" ? String(value || "clear") : state.voice.cosy.selectedStyle;
    const interaction = kind === "interaction" ? String(value || "hold") : state.voice.cosy.interactionMode;
    state.voice.cosy.selectedStyle = style;
    state.voice.cosy.interactionMode = interaction;
    if (previousInteraction !== interaction && (
      state.voice.listening
      || state.voice.nativeListening
      || state.voice.continuousActive
    )) stopVoiceSession();
    if (interaction !== "continuous") state.voice.continuousActive = false;
    const styleSelect = qs("#cosyVoiceStyle");
    const interactionSelect = qs("#voiceInteractionMode");
    if (styleSelect) styleSelect.value = style;
    if (interactionSelect) interactionSelect.value = interaction;
    setVoiceIdle();
    try {
      const payload = await api("/api/app/voice/cosyvoice/settings", {
        method: "POST",
        body: { selected_style: style, interaction_mode: interaction },
      });
      applyCosyVoice(payload);
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function updateSoundToggle() {
    const button = qs("#soundToggle");
    if (!button) return;
    button.classList.toggle("is-active", state.music.enabled);
    button.setAttribute("aria-pressed", state.music.enabled ? "true" : "false");
    button.title = state.music.enabled ? "背景音乐已开启" : "背景音乐已关闭";
  }

  function toggleSound() {
    const music = qs("#backgroundMusic");
    state.music.enabled = !state.music.enabled;
    localStorage.setItem("yeshuang.music.enabled", String(state.music.enabled));
    if (!state.music.enabled) {
      if (music) {
        music.muted = true;
        music.pause();
      }
    } else {
      playBackgroundMusic();
    }
    updateSoundToggle();
  }

  async function initializeSceneVideos() {
    const sceneBase = qs("#sceneBase");
    const mount = qs("#sceneVideoMount");
    const layer = qs("#sceneLayer");
    const fallbackAnchor = { x: 0.19531, y: 0.45508 };
    let manifest = {};
    try {
      const response = await fetch("./assets/scene-pack/manifest.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      manifest = await response.json();
    } catch (error) {
      console.warn("夜霜动作视频包暂时不可用，将保留基准画面。", error);
    }

    const baseConfig = manifest?.base && typeof manifest.base === "object" ? manifest.base : {};
    const layoutConfig = manifest?.layout && typeof manifest.layout === "object" ? manifest.layout : {};
    const playbackConfig = (
      manifest?.playback && typeof manifest.playback === "object"
        ? manifest.playback
        : {}
    );
    const manifestAnchor = (
      layoutConfig.voice_anchor && typeof layoutConfig.voice_anchor === "object"
        ? layoutConfig.voice_anchor
        : {}
    );
    const circleAnchor = {
      x: Number.isFinite(Number(manifestAnchor.x)) ? Number(manifestAnchor.x) : fallbackAnchor.x,
      y: Number.isFinite(Number(manifestAnchor.y)) ? Number(manifestAnchor.y) : fallbackAnchor.y,
    };
    const presenceRoiConfig = (
      layoutConfig.presence_roi && typeof layoutConfig.presence_roi === "object"
        ? layoutConfig.presence_roi
        : {}
    );
    const normalizeRoi = (value, fallback) => {
      if (!Array.isArray(value) || value.length !== 4) return fallback;
      const bounds = value.map(Number);
      if (
        bounds.some((item) => !Number.isFinite(item) || item < 0 || item > 1)
        || bounds[0] >= bounds[2]
        || bounds[1] >= bounds[3]
      ) return fallback;
      return bounds;
    };
    const presenceEnterRoi = normalizeRoi(presenceRoiConfig.enter, [0.55, 0.06, 0.9, 0.6]);
    const presenceExitRoi = normalizeRoi(presenceRoiConfig.exit, [0.48, 0.01, 0.96, 0.69]);
    const baseSrc = String(baseConfig.src || "assets/scene-pack/base/yeshuang-base.png");
    if (sceneBase && sceneBase.getAttribute("src") !== baseSrc) sceneBase.src = baseSrc;

    const clipConfigs = Array.isArray(manifest?.clips)
      ? manifest.clips.filter((clip) => clip && clip.enabled !== false && clip.src)
      : [];
    if (mount) mount.replaceChildren();
    const videos = clipConfigs.map((clip, index) => {
      const video = document.createElement("video");
      video.className = "scene-video";
      video.id = `sceneClip-${String(clip.id || index).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      video.dataset.sceneId = String(clip.id || `clip-${index}`);
      video.dataset.sceneRole = String(clip.state || "idle");
      video.dataset.sceneAction = String(clip.action || clip.id || `clip-${index}`);
      video.dataset.scenePlayback = clip.playback === "loop" ? "loop" : "once";
      const weight = Number(clip.weight ?? 1);
      video.dataset.sceneWeight = String(Number.isFinite(weight) ? Math.max(0.01, weight) : 1);
      const cooldownSeconds = Number(clip.cooldown_seconds ?? 0);
      video.dataset.sceneCooldownMs = String(
        Number.isFinite(cooldownSeconds) ? Math.max(0, cooldownSeconds * 1000) : 0,
      );
      if (
        Array.isArray(clip.gap_after_ms)
        && clip.gap_after_ms.length === 2
        && clip.gap_after_ms.every((value) => Number.isFinite(Number(value)))
      ) {
        video.dataset.sceneGapMinMs = String(Math.max(0, Number(clip.gap_after_ms[0])));
        video.dataset.sceneGapMaxMs = String(
          Math.max(Number(video.dataset.sceneGapMinMs), Number(clip.gap_after_ms[1])),
        );
      }
      video.src = String(clip.src);
      video.poster = baseSrc;
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.loop = false;
      mount?.append(video);
      return video;
    });

    const updateAnchorFromMedia = (media) => {
      if (!media || !layer) return;
      const mediaWidth = Number(media.videoWidth || media.naturalWidth || baseConfig.width || 1536);
      const mediaHeight = Number(media.videoHeight || media.naturalHeight || baseConfig.height || 1024);
      if (!mediaWidth || !mediaHeight) return;
      const rect = layer.getBoundingClientRect();
      const scale = Math.min(rect.width / mediaWidth, rect.height / mediaHeight);
      const renderedWidth = mediaWidth * scale;
      const renderedHeight = mediaHeight * scale;
      const offsetX = rect.width - renderedWidth;
      const offsetY = (rect.height - renderedHeight) / 2;
      const stageRect = qs(".hero-stage")?.getBoundingClientRect() || { left: 0, top: 0 };
      const voiceRadius = (qs("#voiceButton")?.getBoundingClientRect().width || 240) / 2;
      const naturalAnchorX = offsetX + mediaWidth * circleAnchor.x * scale;
      const anchorX = Math.max(naturalAnchorX, stageRect.left + voiceRadius + 20);
      const anchorY = offsetY + mediaHeight * circleAnchor.y * scale;
      document.documentElement.style.setProperty("--scene-circle-x", `${anchorX.toFixed(2)}px`);
      document.documentElement.style.setProperty("--scene-circle-y", `${anchorY.toFixed(2)}px`);
      document.documentElement.style.setProperty(
        "--scene-circle-local-x",
        `${(anchorX - stageRect.left).toFixed(2)}px`,
      );
      document.documentElement.style.setProperty(
        "--scene-circle-local-y",
        `${(anchorY - stageRect.top).toFixed(2)}px`,
      );
    };
    const updateSceneAnchor = () => updateAnchorFromMedia(activeVideo || sceneBase);
    const observeSceneAnchor = () => {
      window.addEventListener("resize", updateSceneAnchor, { passive: true });
      if ("ResizeObserver" in window) {
        const anchorObserver = new ResizeObserver(updateSceneAnchor);
        if (layer) anchorObserver.observe(layer);
        const stage = qs(".hero-stage");
        if (stage) anchorObserver.observe(stage);
      }
    };

    const groups = {};
    videos.forEach((video) => {
      const role = video.dataset.sceneRole || "idle";
      if (!groups[role]) groups[role] = [];
      groups[role].push(video);
    });
    const idleGap = Array.isArray(playbackConfig.idle_gap_ms)
      ? playbackConfig.idle_gap_ms.map(Number)
      : [3500, 9000];
    const modeGapConfig = (
      playbackConfig.mode_gap_ms && typeof playbackConfig.mode_gap_ms === "object"
        ? playbackConfig.mode_gap_ms
        : {}
    );
    const modeGapDefaults = {
      listening: [1800, 4200],
      thinking: [1400, 3600],
      speaking: [80, 220],
    };
    const idleSkipChance = Math.min(
      0.8,
      Math.max(0, Number(playbackConfig.idle_skip_chance ?? 0.3)),
    );
    const idleRateConfig = Array.isArray(playbackConfig.idle_playback_rate)
      ? playbackConfig.idle_playback_rate.map(Number)
      : [0.96, 1.04];
    const idlePlaybackRate = [
      Math.min(1.15, Math.max(0.85, Number(idleRateConfig[0]) || 0.96)),
      Math.min(1.15, Math.max(0.85, Number(idleRateConfig[1]) || 1.04)),
    ];
    idlePlaybackRate[1] = Math.max(idlePlaybackRate[0], idlePlaybackRate[1]);
    const presenceCooldown = Array.isArray(playbackConfig.presence_cooldown_ms)
      ? playbackConfig.presence_cooldown_ms.map(Number)
      : [22000, 42000];
    const presenceInitialDelay = Array.isArray(playbackConfig.presence_initial_delay_ms)
      ? playbackConfig.presence_initial_delay_ms.map(Number)
      : [5000, 9000];
    const presenceActions = Array.isArray(playbackConfig.presence_actions)
      ? playbackConfig.presence_actions.map(String).filter(Boolean)
      : ["glance"];
    const presenceAwayThreshold = Math.max(
      3000,
      Number(playbackConfig.presence_away_threshold_ms || 8000),
    );
    const motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let reducedMotion = Boolean(motionQuery?.matches);
    const safeStart = Math.max(0, Number(playbackConfig.safe_start_seconds || 0));
    const transitionMs = Math.max(80, Number(playbackConfig.transition_ms || 420));
    const modeTransitionMs = Math.max(80, Number(playbackConfig.mode_transition_ms || 220));
    const initialIdleDelay = Math.max(300, Number(playbackConfig.initial_idle_delay_ms || 900));
    const lastVideoByMode = new Map();
    const lastPlayedAtByAction = new Map();
    const recentActions = [];
    let activeVideo = null;
    let currentMode = "idle";
    let modeEpoch = 0;
    let actionTimer = 0;
    let presenceReadyAt = 0;
    let presenceRequestPending = "";
    let presenceTimer = 0;
    let paused = false;

    const clearActionTimer = () => {
      window.clearTimeout(actionTimer);
      actionTimer = 0;
    };
    const randomBetween = (bounds, fallback) => {
      const lower = Math.max(0, Number(bounds?.[0]));
      const upper = Math.max(lower, Number(bounds?.[1]));
      if (!Number.isFinite(lower) || !Number.isFinite(upper)) return fallback;
      return lower + Math.random() * (upper - lower);
    };
    presenceReadyAt = Date.now() + randomBetween(presenceInitialDelay, 7000);
    const modeGap = (mode) => {
      const configured = modeGapConfig[mode];
      return Array.isArray(configured) ? configured.map(Number) : modeGapDefaults[mode];
    };
    const rewind = (video) => {
      if (!video) return;
      const apply = () => {
        try {
          video.currentTime = Math.min(safeStart, Math.max(0, (video.duration || safeStart) - 0.04));
        } catch {
          // Metadata may still be settling in WebView2.
        }
      };
      if (video.readyState >= 1) apply();
      else video.addEventListener("loadedmetadata", apply, { once: true });
    };
    const cooldownRemaining = (video, now = Date.now()) => {
      const action = video.dataset.sceneAction || video.dataset.sceneId;
      const lastPlayedAt = Number(lastPlayedAtByAction.get(action) || 0);
      const cooldownMs = Math.max(0, Number(video.dataset.sceneCooldownMs || 0));
      return Math.max(0, lastPlayedAt + cooldownMs - now);
    };
    const selectVideo = (mode, preferredAction = "") => {
      let candidates = (groups[mode] || []).filter((video) => video.dataset.sceneFailed !== "true");
      if (preferredAction) {
        candidates = candidates.filter(
          (video) => (video.dataset.sceneAction || video.dataset.sceneId) === preferredAction,
        );
      }
      if (!candidates.length) return { video: null, retryDelay: null };
      const now = Date.now();
      let pool = candidates.filter((video) => cooldownRemaining(video, now) <= 0);
      if (!pool.length) {
        const retryDelay = Math.min(...candidates.map((video) => cooldownRemaining(video, now)));
        return { video: null, retryDelay };
      }
      const freshActions = pool.filter(
        (video) => !recentActions.includes(video.dataset.sceneAction || video.dataset.sceneId),
      );
      if (freshActions.length) pool = freshActions;
      const previous = lastVideoByMode.get(mode);
      const withoutPrevious = pool.length > 1 ? pool.filter((video) => video !== previous) : pool;
      if (withoutPrevious.length) pool = withoutPrevious;
      const totalWeight = pool.reduce(
        (sum, video) => sum + Math.max(0.01, Number(video.dataset.sceneWeight || 1)),
        0,
      );
      let cursor = Math.random() * totalWeight;
      for (const video of pool) {
        cursor -= Math.max(0.01, Number(video.dataset.sceneWeight || 1));
        if (cursor <= 0) return { video, retryDelay: 0 };
      }
      return { video: pool[pool.length - 1], retryDelay: 0 };
    };
    const setSceneLifecycle = (video = null) => {
      document.documentElement.dataset.sceneMode = currentMode;
      const action = video?.dataset.sceneAction || video?.dataset.sceneId || "";
      if (action) document.documentElement.dataset.sceneAction = action;
      else delete document.documentElement.dataset.sceneAction;
    };
    const scheduleCurrentMode = (delayMs, preferredAction = "") => {
      clearActionTimer();
      if (paused || reducedMotion || state.quiet || document.hidden) return;
      const scheduledMode = currentMode;
      const scheduledEpoch = modeEpoch;
      const scheduledAction = preferredAction;
      actionTimer = window.setTimeout(() => {
        actionTimer = 0;
        if (
          paused
          || reducedMotion
          || state.quiet
          || document.hidden
          || scheduledMode !== currentMode
          || scheduledEpoch !== modeEpoch
        ) return;
        if (currentMode === "idle" && !scheduledAction && Math.random() < idleSkipChance) {
          scheduleCurrentMode(randomBetween(idleGap, 5600));
          return;
        }
        const selection = selectVideo(currentMode, scheduledAction);
        const next = selection.video;
        if (!next) {
          if (scheduledAction) {
            if (presenceRequestPending === scheduledAction) presenceRequestPending = "";
            scheduleCurrentMode(800);
            return;
          }
          if (Number.isFinite(selection.retryDelay)) {
            scheduleCurrentMode(Math.max(800, Math.min(selection.retryDelay, 30000)));
          }
          return;
        }
        const activeTransitionMs = currentMode === "idle" ? transitionMs : modeTransitionMs;
        const previous = activeVideo;
        if (previous && previous !== next) {
          previous.style.transitionDuration = `${activeTransitionMs}ms`;
          previous.classList.remove("is-active");
          previous.pause();
        }
        rewind(next);
        next.style.transitionDuration = `${activeTransitionMs}ms`;
        next.classList.remove("is-revealing", "is-reveal-active");
        next.classList.add("is-active");
        activeVideo = next;
        lastVideoByMode.set(currentMode, next);
        const action = next.dataset.sceneAction || next.dataset.sceneId;
        const startedAt = Date.now();
        if (presenceRequestPending === action && scheduledAction === action) {
          presenceRequestPending = "";
          presenceReadyAt = startedAt + randomBetween(presenceCooldown, 32000);
        }
        lastPlayedAtByAction.set(action, startedAt);
        const recentIndex = recentActions.indexOf(action);
        if (recentIndex >= 0) recentActions.splice(recentIndex, 1);
        recentActions.push(action);
        while (recentActions.length > 2) recentActions.shift();
        state.sceneIndex = videos.indexOf(next);
        next.playbackRate = currentMode === "idle"
          ? randomBetween(idlePlaybackRate, 1)
          : 1;
        setSceneLifecycle(next);
        updateSceneAnchor();
        const startedMode = currentMode;
        const startedEpoch = modeEpoch;
        const playPromise = next.play();
        playPromise?.catch(() => {
          if (
            activeVideo !== next
            || currentMode !== startedMode
            || modeEpoch !== startedEpoch
          ) return;
          next.dataset.sceneFailed = "true";
          next.classList.remove("is-active");
          activeVideo = null;
          state.sceneIndex = -1;
          if (lastPlayedAtByAction.get(action) === startedAt) lastPlayedAtByAction.delete(action);
          setSceneLifecycle();
          updateSceneAnchor();
          scheduleCurrentMode(800);
        });
      }, Math.max(0, delayMs));
    };
    const settleOnBase = ({ schedule = true } = {}) => {
      const finished = activeVideo;
      activeVideo = null;
      state.sceneIndex = -1;
      if (finished) {
        finished.style.transitionDuration = `${
          currentMode === "idle" ? transitionMs : modeTransitionMs
        }ms`;
        finished.classList.remove("is-active", "is-revealing", "is-reveal-active");
        finished.pause();
        rewind(finished);
      }
      setSceneLifecycle();
      updateSceneAnchor();
      if (!schedule) return;
      if (currentMode === "idle") {
        const customGap = finished?.dataset.sceneGapMinMs === undefined
          ? idleGap
          : [
              Number(finished.dataset.sceneGapMinMs),
              Number(finished.dataset.sceneGapMaxMs),
            ];
        scheduleCurrentMode(randomBetween(customGap, 5600));
      } else if (["listening", "thinking", "speaking"].includes(currentMode)) {
        scheduleCurrentMode(randomBetween(modeGap(currentMode), 1200));
      }
    };
    const setMode = (mode) => {
      const requestedMode = ["idle", "listening", "thinking", "speaking", "emotion"].includes(mode)
        ? mode
        : "idle";
      if (requestedMode === currentMode && (activeVideo || actionTimer)) return;
      modeEpoch += 1;
      currentMode = requestedMode;
      if (currentMode !== "idle") presenceRequestPending = "";
      clearActionTimer();
      settleOnBase({ schedule: false });
      setSceneLifecycle();
      if (!groups[currentMode]?.length) return;
      scheduleCurrentMode(currentMode === "idle" ? 350 : 20);
    };
    const requestIdleAction = (action) => {
      const requestedAction = String(action || "");
      if (
        !requestedAction
        || currentMode !== "idle"
        || paused
        || reducedMotion
        || state.quiet
        || document.hidden
        || document.documentElement.dataset.view !== "overview"
      ) return false;
      const canPlay = (groups.idle || []).some((video) => (
        video.dataset.sceneFailed !== "true"
        && (video.dataset.sceneAction || video.dataset.sceneId) === requestedAction
        && cooldownRemaining(video) <= 0
      ));
      if (!canPlay) return false;
      if (activeVideo) {
        clearActionTimer();
        settleOnBase({ schedule: false });
      }
      scheduleCurrentMode(randomBetween([280, 720], 480), requestedAction);
      return true;
    };
    const reactToPresence = () => {
      const now = Date.now();
      if (reducedMotion || now < presenceReadyAt) return false;
      const availableActions = presenceActions.filter((action) => (
        (groups.idle || []).some((video) => (
          video.dataset.sceneFailed !== "true"
          && (video.dataset.sceneAction || video.dataset.sceneId) === action
          && cooldownRemaining(video, now) <= 0
        ))
      ));
      if (!availableActions.length) return false;
      const action = availableActions[Math.floor(Math.random() * availableActions.length)];
      if (!requestIdleAction(action)) return false;
      presenceRequestPending = action;
      return true;
    };
    const clearPresenceTimer = () => {
      window.clearTimeout(presenceTimer);
      presenceTimer = 0;
    };
    const queuePresenceReaction = (delayBounds = [350, 700]) => {
      clearPresenceTimer();
      if (paused || reducedMotion || state.quiet || document.hidden) return;
      presenceTimer = window.setTimeout(() => {
        presenceTimer = 0;
        reactToPresence();
      }, randomBetween(delayBounds, 520));
    };

    videos.forEach((video) => {
      video.addEventListener("ended", () => {
        if (video !== activeVideo) return;
        if (currentMode === "speaking" && video.dataset.scenePlayback === "loop") {
          rewind(video);
          video.play().catch(() => {});
          return;
        }
        if (currentMode === "emotion") {
          setMode("idle");
          return;
        }
        settleOnBase();
      });
      video.addEventListener("error", () => {
        video.dataset.sceneFailed = "true";
        if (video === activeVideo) settleOnBase();
      });
    });
    if (sceneBase && !sceneBase.complete) {
      sceneBase.addEventListener("load", updateSceneAnchor, { once: true });
    }
    observeSceneAnchor();
    updateSceneAnchor();
    state.sceneIndex = -1;
    setSceneLifecycle();
    state.sceneController = {
      setState: setMode,
      setSpeaking(speaking) {
        setMode(speaking ? "speaking" : "idle");
      },
      playEmotion() {
        if (currentMode !== "idle" || paused || reducedMotion || state.quiet || document.hidden) return;
        setMode("emotion");
      },
      playAction(action) {
        return requestIdleAction(action);
      },
      reactToPresence,
      pause() {
        paused = true;
        presenceRequestPending = "";
        clearActionTimer();
        clearPresenceTimer();
        settleOnBase({ schedule: false });
      },
      resume() {
        paused = false;
        if (reducedMotion) {
          settleOnBase({ schedule: false });
          return;
        }
        if (groups[currentMode]?.length) scheduleCurrentMode(180);
      },
      updateAnchor: updateSceneAnchor,
    };
    const handleMotionPreference = (event) => {
      reducedMotion = Boolean(event.matches);
      state.audioReactive.reducedMotion = reducedMotion;
      presenceRequestPending = "";
      clearActionTimer();
      clearPresenceTimer();
      settleOnBase({ schedule: false });
      if (!reducedMotion && !paused && !state.quiet && !document.hidden && groups[currentMode]?.length) {
        scheduleCurrentMode(600);
      }
    };
    motionQuery?.addEventListener?.("change", handleMotionPreference);
    const presenceStage = qs(".hero-stage");
    const pointerPositionInScene = (event) => {
      if (!layer) return null;
      const media = activeVideo || sceneBase;
      const mediaWidth = Number(media?.videoWidth || media?.naturalWidth || baseConfig.width || 1536);
      const mediaHeight = Number(media?.videoHeight || media?.naturalHeight || baseConfig.height || 1024);
      const rect = layer.getBoundingClientRect();
      if (!mediaWidth || !mediaHeight || !rect.width || !rect.height) return null;
      const scale = Math.min(rect.width / mediaWidth, rect.height / mediaHeight);
      const renderedWidth = mediaWidth * scale;
      const renderedHeight = mediaHeight * scale;
      const offsetX = rect.width - renderedWidth;
      const offsetY = (rect.height - renderedHeight) / 2;
      return {
        x: (event.clientX - rect.left - offsetX) / renderedWidth,
        y: (event.clientY - rect.top - offsetY) / renderedHeight,
      };
    };
    const insideRoi = (point, bounds) => Boolean(
      point
      && point.x >= bounds[0]
      && point.y >= bounds[1]
      && point.x <= bounds[2]
      && point.y <= bounds[3]
    );
    const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches || false;
    let pointerNearPortrait = false;
    let lastPointerProbeAt = 0;
    presenceStage?.addEventListener("pointermove", (event) => {
      if (coarsePointer || (event.pointerType && !["mouse", "pen"].includes(event.pointerType))) return;
      const now = Date.now();
      if (now - lastPointerProbeAt < 80) return;
      lastPointerProbeAt = now;
      const point = pointerPositionInScene(event);
      if (pointerNearPortrait) {
        if (!insideRoi(point, presenceExitRoi)) {
          pointerNearPortrait = false;
          clearPresenceTimer();
        }
        return;
      }
      if (!insideRoi(point, presenceEnterRoi)) return;
      pointerNearPortrait = true;
      const readinessDelay = Math.max(0, presenceReadyAt - now);
      queuePresenceReaction([readinessDelay + 320, readinessDelay + 520]);
    }, { passive: true });
    presenceStage?.addEventListener("pointerleave", () => {
      pointerNearPortrait = false;
      clearPresenceTimer();
    }, { passive: true });
    let awayStartedAt = 0;
    const markPresenceAway = () => {
      if (!awayStartedAt) awayStartedAt = Date.now();
      clearPresenceTimer();
    };
    const maybeReactOnReturn = () => {
      if (document.hidden || (document.hasFocus && !document.hasFocus())) return;
      const awayDuration = awayStartedAt ? Date.now() - awayStartedAt : 0;
      awayStartedAt = 0;
      if (awayDuration >= presenceAwayThreshold) queuePresenceReaction([420, 980]);
    };
    window.addEventListener("blur", markPresenceAway);
    window.addEventListener("focus", maybeReactOnReturn);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        markPresenceAway();
        state.sceneController?.pause();
        return;
      }
      if (!state.quiet) state.sceneController?.resume();
      maybeReactOnReturn();
    });
    if (groups.idle?.length) scheduleCurrentMode(initialIdleDelay);
  }

  function toggleQuietMode() {
    state.quiet = !state.quiet;
    document.documentElement.dataset.quiet = String(state.quiet);
    if (state.quiet) {
      state.voice.continuousActive = false;
      window.clearTimeout(state.voice.continuousTimer);
      state.sceneController?.pause();
    }
    else state.sceneController?.resume();
    if (state.quiet) {
      qs("#backgroundMusic")?.pause();
      stopSpeaking();
    } else {
      playBackgroundMusic();
    }
    qs("#quietToggle")?.classList.toggle("is-active", state.quiet);
    toast(state.quiet ? "已进入静谧模式。" : "动态场景已恢复。");
  }

  async function toggleFullscreen() {
    try {
      const nativeApi = window.pywebview?.api;
      if (nativeApi?.toggle_fullscreen) {
        const result = await nativeApi.toggle_fullscreen();
        if (result?.ok === false) throw new Error(result.error || "无法切换窗口全屏。");
        const button = qs("#fullscreenToggle");
        if (button) {
          const fullscreen = result?.fullscreen !== false;
          button.classList.toggle("is-active", fullscreen);
          button.title = fullscreen ? "退出全屏" : "进入全屏";
          button.setAttribute("aria-label", fullscreen ? "退出全屏" : "进入全屏");
        }
        return;
      }
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      toast("当前窗口不支持页面全屏。", "error");
    }
  }

  async function closeDesktopApp() {
    shutdownAudio();
    try {
      const nativeApi = window.pywebview?.api;
      if (nativeApi?.close) {
        await nativeApi.close();
        return;
      }
      window.close();
    } catch {
      toast("暂时无法关闭窗口，请再试一次。", "error");
    }
  }

  function initializeStarField() {
    const canvas = qs("#starField");
    const context = canvas?.getContext?.("2d");
    if (!canvas || !context) return;
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduceMotion = motionQuery.matches;
    let stars = [];
    let breezeLevel = 0;
    let lastFrameTime = 0;
    let staticFrameDrawn = false;
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      staticFrameDrawn = false;
      stars = Array.from({ length: Math.max(28, Math.round(width / 27)) }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: 0.35 + Math.random() * 1.15,
        a: 0.18 + Math.random() * 0.58,
        speed: 0.08 + Math.random() * 0.22,
        phase: Math.random() * Math.PI * 2,
      }));
    };
    const draw = (time) => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const deltaScale = lastFrameTime
        ? Math.min(2, Math.max(0.25, (time - lastFrameTime) / (1000 / 60)))
        : 1;
      lastFrameTime = time;
      const animateScene = !state.quiet && !document.hidden && !reduceMotion;
      const breezeTarget = (
        animateScene
        && document.documentElement.dataset.sceneAction === "breeze"
      ) ? 1 : 0;
      if (animateScene) {
        const baseSmoothing = breezeTarget ? 0.045 : 0.075;
        const smoothing = 1 - Math.pow(1 - baseSmoothing, deltaScale);
        breezeLevel += (breezeTarget - breezeLevel) * smoothing;
      } else {
        breezeLevel = 0;
      }
      if (!animateScene && staticFrameDrawn) {
        window.requestAnimationFrame(draw);
        return;
      }
      context.clearRect(0, 0, width, height);
      stars.forEach((star) => {
        if (animateScene) {
          star.y -= star.speed * (1 - breezeLevel * 0.35) * deltaScale;
          star.x += breezeLevel * (0.06 + star.speed * 0.45) * deltaScale;
          if (star.y < -4) {
            star.y = height + 4;
            star.x = Math.random() * width;
          }
          if (star.x > width + 8) {
            star.x = -8;
            star.y = Math.random() * height;
          }
        }
        const alphaTime = animateScene ? time : 0;
        const alpha = star.a * (0.65 + Math.sin(alphaTime / 900 + star.phase) * 0.35);
        if (breezeLevel > 0.015) {
          const streakLength = (3 + star.r * 4) * breezeLevel;
          context.beginPath();
          context.strokeStyle = `rgba(188, 206, 255, ${Math.max(0.012, alpha * breezeLevel * 0.18)})`;
          context.lineWidth = Math.max(0.4, star.r * 0.7);
          context.lineCap = "round";
          context.moveTo(star.x - streakLength, star.y + breezeLevel);
          context.lineTo(star.x, star.y);
          context.stroke();
        }
        context.beginPath();
        context.fillStyle = `rgba(192, 200, 255, ${Math.max(0.04, alpha)})`;
        context.shadowBlur = star.r > 0.9 ? 8 : 3;
        context.shadowColor = "rgba(124, 140, 255, .8)";
        context.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        context.fill();
      });
      context.shadowBlur = 0;
      staticFrameDrawn = !animateScene;
      window.requestAnimationFrame(draw);
    };
    resize();
    window.addEventListener("resize", resize);
    motionQuery.addEventListener?.("change", (event) => {
      reduceMotion = Boolean(event.matches);
      staticFrameDrawn = false;
    });
    window.requestAnimationFrame(draw);
  }

  function toggleCottageDrawer() {
    const drawer = qs("#cottageDrawer");
    const button = qs("#cottageToggle");
    if (!drawer || !button) return;
    const open = drawer.hidden;
    drawer.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  }

  function bindEvents() {
    window.__yeshuangStopAllAudio = shutdownAudio;
    window.addEventListener("beforeunload", shutdownAudio);
    window.addEventListener("pagehide", shutdownAudio);
    qsa("[data-view]").forEach((button) => {
      button.addEventListener("click", () => showView(button.dataset.view));
    });
    qsa("[data-open-view]").forEach((button) => {
      button.addEventListener("click", () => showView(button.dataset.openView));
    });
    qs("#refreshButton")?.addEventListener("click", () => refresh());
    qs("#soundToggle")?.addEventListener("click", toggleSound);
    qs("#fullscreenToggle")?.addEventListener("click", toggleFullscreen);
    qs("#quietToggle")?.addEventListener("click", toggleQuietMode);
    qs("#closeAppButton")?.addEventListener("click", closeDesktopApp);
    qs("#cottageToggle")?.addEventListener("click", toggleCottageDrawer);
    qs("#chatStopVoiceButton")?.addEventListener("click", stopVoiceSession);
    qs("#daemonPrimaryButton")?.addEventListener("click", (event) => controlDaemon(event.currentTarget.dataset.action));
    qs("#daemonRestartButton")?.addEventListener("click", () => controlDaemon("restart"));

    qs("#heroChatForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      sendChat(qs("#heroChatInput")?.value);
    });
    qs("#chatForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      sendChat(qs("#chatInput")?.value);
    });
    qs("#chatInput")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        qs("#chatForm")?.requestSubmit();
      }
    });
    bindHoldToTalk(qs("#voiceButton"));
    bindHoldToTalk(qs("#chatVoiceButton"));

    qs("#diaryForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      generateDiary(qs("#diaryDate")?.value || "");
    });
    qs("#lifeRefreshButton")?.addEventListener("click", () => refreshReadonlySection("life"));
    qs("#memoryRefreshButton")?.addEventListener("click", () => refreshReadonlySection("memory"));
    qs("#providerSelect")?.addEventListener("change", (event) => {
      const provider = event.currentTarget.value;
      const input = qs("#modelInput");
      if (input) input.value = state.modelMap[provider] || "";
      setText("#settingsState", "尚未保存");
    });
    qs("#modelInput")?.addEventListener("input", () => setText("#settingsState", "尚未保存"));
    qs("#modelSettingsForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      saveModelSettings(qs("#providerSelect")?.value, qs("#modelInput")?.value);
    });
    qs("#musicSelect")?.addEventListener("change", (event) => {
      selectMusic(event.currentTarget.value);
    });
    qs("#musicFileInput")?.addEventListener("change", (event) => {
      importMusic(event.currentTarget);
    });
    qs("#cosyVoiceReferenceInput")?.addEventListener("change", (event) => {
      importCosyVoiceReference(event.currentTarget);
    });
    qs("#cosyVoiceSaveButton")?.addEventListener("click", saveCosyVoiceSettings);
    qs("#cosyVoiceToggleButton")?.addEventListener("click", (event) => {
      controlCosyVoice(event.currentTarget.dataset.action || "start");
    });
    qs("#cosyVoiceMode")?.addEventListener("change", (event) => {
      const prompt = qs("#cosyVoicePromptText");
      if (prompt) prompt.closest(".field")?.classList.toggle("is-required", event.currentTarget.value === "zero_shot");
    });
    qs("#cosyVoiceStyle")?.addEventListener("change", (event) => {
      void updateVoicePreference("style", event.currentTarget.value);
    });
    qs("#voiceInteractionMode")?.addEventListener("change", (event) => {
      void updateVoicePreference("interaction", event.currentTarget.value);
    });
    qs("#companionSettingsSaveButton")?.addEventListener("click", saveCompanionSettings);
    qs("#modelProbeButton")?.addEventListener("click", probeModel);
    qsa("[data-cottage-action]").forEach((button) => {
      button.addEventListener("click", () => queueCottageAction(button));
    });
    window.addEventListener("hashchange", () => {
      const target = location.hash.slice(1);
      if (qs(`[data-view-panel="${target}"]`)) showView(target, { updateHash: false });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !qs("#cottageDrawer")?.hidden) toggleCottageDrawer();
      if (event.key === "Escape" && state.voice.continuousActive) stopVoiceSession();
    });
    ["pointerdown", "keydown", "input", "wheel"].forEach((eventName) => {
      document.addEventListener(eventName, markUserActivity, { passive: true });
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && state.voice.continuousActive) stopVoiceSession();
    });
  }

  function initializeDate() {
    const input = qs("#diaryDate");
    if (!input) return;
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    input.value = local;
    input.max = local;
  }

  async function init() {
    document.documentElement.dataset.voice = "idle";
    document.documentElement.dataset.quiet = "false";
    bindEvents();
    initializeDate();
    initializeVoiceRecognition();
    initializeBackgroundMusic();
    initializeAudioReactivity();
    await initializeSceneVideos();
    initializeStarField();
    updateSoundToggle();
    const requestedView = location.hash.slice(1);
    showView(qs(`[data-view-panel="${requestedView}"]`) ? requestedView : "overview", { updateHash: false });
    qs("#yeshuangPortrait")?.addEventListener("error", (event) => {
      event.currentTarget.style.display = "none";
    });
    await Promise.all([
      refresh({ quiet: true }),
      loadMusicLibrary(),
      loadCosyVoice(),
    ]);
    await deliverStartupGreeting();
    startCompanionPolling();
    state.refreshTimer = window.setInterval(() => {
      if (!document.hidden && !state.busy.size) refresh({ quiet: true });
    }, 15000);
  }

  init();
})();
