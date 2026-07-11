(() => {
  "use strict";

  const DB_NAME = "reMemoryMvp";
  const DB_VERSION = 3;
  const STAGE_UNLOCK_COUNTS = {
    1: 1,
    2: 3,
    3: 5,
    4: 7
  };
  const REQUIRED_HIDDEN_FRAGMENT_INDEX = 4;
  const OPTIONAL_HIDDEN_FRAGMENT_INDEXES = [3, 5, 1, 7];
  const ANALYSIS_VERSION = 1;
  const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
  const MAX_IMAGE_DIMENSION = 12000;
  const MAX_IMAGE_PIXELS = 40_000_000;
  const REUNION_TIMING_OPTIONS = {
    1: "1日後",
    7: "7日後",
    30: "30日後",
    90: "90日後",
    365: "365日後"
  };
  const app = document.querySelector("#app");
  const SUPABASE_URL = document.querySelector('meta[name="supabase-url"]')?.content?.trim() || "";
  const SUPABASE_PUBLISHABLE_KEY = document.querySelector('meta[name="supabase-publishable-key"]')?.content?.trim() || "";
  const supabaseClient = window.supabase?.createClient && SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        flowType: "pkce",
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true
      }
    })
    : null;
  const state = {
    route: "home",
    memories: [],
    fragments: [],
    reflections: [],
    images: new Map(),
    urls: new Map(),
    selectedFile: null,
    selectedPreviewUrl: "",
    activeMemoryId: "",
    transientOriginalMemoryId: "",
    busy: false,
    error: "",
    settings: {
      authSession: null
    },
    supabaseUser: null,
    cloudSyncing: false
  };

  const statusLabels = {
    sleeping: "表示日を待っています",
    fragmenting: "思い出のかけらを確認中",
    viewed_original: "写真を見ました",
    not_yet: "まだ写真を見ていない",
    kept_closed: "写真を見ないで残す"
  };

  const finalChoiceLabels = {
    viewed: "写真を見た",
    wait: "あとでまた選ぶ",
    keep: "写真を見ないで残す"
  };
  let dbPromise;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("memories")) db.createObjectStore("memories", { keyPath: "id" });
        if (!db.objectStoreNames.contains("fragments")) {
          const store = db.createObjectStore("fragments", { keyPath: "id" });
          store.createIndex("memoryId", "memoryId", { unique: false });
        }
        if (!db.objectStoreNames.contains("reflections")) {
          const store = db.createObjectStore("reflections", { keyPath: "id" });
          store.createIndex("memoryId", "memoryId", { unique: false });
        }
        if (!db.objectStoreNames.contains("images")) db.createObjectStore("images", { keyPath: "path" });
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function tx(storeNames, mode, callback) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeNames, mode);
      const stores = Array.isArray(storeNames)
        ? Object.fromEntries(storeNames.map((name) => [name, transaction.objectStore(name)]))
        : transaction.objectStore(storeNames);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      result = callback(stores);
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getAll(storeName) {
    const db = await openDb();
    const transaction = db.transaction(storeName, "readonly");
    return requestToPromise(transaction.objectStore(storeName).getAll());
  }

  async function getSetting(key, fallback) {
    const db = await openDb();
    const transaction = db.transaction("settings", "readonly");
    const result = await requestToPromise(transaction.objectStore("settings").get(key));
    return result ? result.value : fallback;
  }

  async function saveSetting(key, value) {
    await tx("settings", "readwrite", (store) => store.put({ key, value }));
  }

  function normalizeAuthSession(value) {
    if (!value || typeof value !== "object") return null;
    if (value.provider !== "google") return null;
    const userId = String(value.userId || "").trim();
    if (!userId) return null;
    return {
      provider: "google",
      userId,
      name: String(value.name || "re:Memoryユーザー").trim() || "re:Memoryユーザー",
      email: String(value.email || "").trim(),
      picture: String(value.picture || "").trim(),
      signedInAt: String(value.signedInAt || realNowIso())
    };
  }

  function isSignedIn() {
    return Boolean(supabaseClient && state.supabaseUser);
  }

  async function saveAuthSession(session) {
    state.settings.authSession = normalizeAuthSession(session);
    await saveSetting("authSession", state.settings.authSession);
  }

  function authSessionFromSupabaseUser(user) {
    if (!user?.id) return null;
    const metadata = user.user_metadata || {};
    return {
      provider: "google",
      userId: user.id,
      name: metadata.full_name || metadata.name || user.email || "Googleユーザー",
      email: user.email || "",
      picture: metadata.avatar_url || metadata.picture || "",
      signedInAt: realNowIso()
    };
  }

  async function initializeSupabaseAuth() {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    state.supabaseUser = data.session?.user || null;
  }

  async function loadSettings() {
    state.settings = {
      authSession: normalizeAuthSession(await getSetting("authSession", null))
    };
    if (state.supabaseUser) {
      state.settings.authSession = normalizeAuthSession(authSessionFromSupabaseUser(state.supabaseUser));
    } else if (supabaseClient && state.settings.authSession?.provider === "google") {
      state.settings.authSession = null;
    }
  }

  function id(prefix) {
    const randomId = crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, "0")).join("");
    return `${prefix}_${randomId}`;
  }

  function realNow() {
    return new Date();
  }

  function realNowIso() {
    return new Date().toISOString();
  }

  function appNow() {
    return realNow();
  }

  function appNowIso() {
    return appNow().toISOString();
  }

  function localDateKey(value = appNow()) {
    const date = value instanceof Date ? value : new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function startOfLocalDay(value = appNow()) {
    const date = value instanceof Date ? new Date(value) : new Date(value);
    if (Number.isNaN(date.getTime())) return startOfLocalDay(appNow());
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function addDaysFrom(dateValue, days) {
    const date = dateValue instanceof Date ? new Date(dateValue) : new Date(dateValue);
    date.setDate(date.getDate() + days);
    return date.toISOString();
  }

  function addAppDays(days) {
    return addDaysFrom(appNow(), days);
  }

  function addLocalDaysFrom(dateValue, days) {
    const date = startOfLocalDay(dateValue);
    date.setDate(date.getDate() + days);
    return date.toISOString();
  }

  function addAppDaysAtStart(days) {
    return addLocalDaysFrom(appNow(), days);
  }

  function daysBetweenLocal(fromValue, toValue) {
    const from = startOfLocalDay(fromValue);
    const to = startOfLocalDay(toValue);
    const days = Math.round((to.getTime() - from.getTime()) / 86400000);
    return Number.isFinite(days) ? days : 1;
  }

  function formatDate(value) {
    if (!value) return "未定";
    return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  }

  function reunionMessage(memory) {
    if (memory.status === "viewed_original") {
      return isAvailable(memory)
        ? "この写真をもう一度見られます。"
        : `${formatDate(nextDisplayDate(memory))}から、もう一度写真を見られます。`;
    }
    if (memory.status === "not_yet") {
      return isAvailable(memory)
        ? "写真を見るか、もう少し待つかを選べます。"
        : `${formatDate(nextDisplayDate(memory))}から、写真を見るかどうかをもう一度選べます。`;
    }
    if (memory.status === "kept_closed") {
      return "この写真は見ないで残しています。あとから写真を見ることもできます。";
    }
    if (!isAvailable(memory)) {
      return `${formatDate(nextDisplayDate(memory))}から思い出のかけらを確認できます。`;
    }
    return "思い出のかけらを確認できます。";
  }
  function escapeHtml(value = "") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function reportError(_context, _error, message) {
    state.error = message;
  }

  function isAvailable(memory) {
    return isDateAvailable(memory.nextAvailableDate || memory.availableAt);
  }

  function isDateAvailable(value) {
    if (!value) return true;
    return localDateKey(value) <= localDateKey();
  }

  function byMemory(memoryId, list) {
    return list.filter((item) => item.memoryId === memoryId);
  }

  function chooseHiddenFragmentIndexes() {
    const extra = OPTIONAL_HIDDEN_FRAGMENT_INDEXES[0];
    return [REQUIRED_HIDDEN_FRAGMENT_INDEX, extra].sort((a, b) => a - b);
  }

  function normalizeHiddenFragmentIndexes(value) {
    const parsed = Array.isArray(value)
      ? [...new Set(value.map(Number).filter((index) => Number.isInteger(index) && index >= 0 && index <= 8))]
      : [];
    if (parsed.length >= 2) return parsed.slice(0, 2).sort((a, b) => a - b);
    if (parsed.length === 1) {
      const extra = [REQUIRED_HIDDEN_FRAGMENT_INDEX, ...OPTIONAL_HIDDEN_FRAGMENT_INDEXES].find((index) => index !== parsed[0]) ?? 0;
      return [parsed[0], extra].sort((a, b) => a - b);
    }
    return chooseHiddenFragmentIndexes();
  }
  function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
  }

  function fragmentCenterProximity(index) {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const distance = Math.hypot(col - 1, row - 1);
    return clamp01(1 - distance / Math.SQRT2);
  }

  function defaultFragmentAnalysis(index, status = "fallback") {
    const centerProximity = fragmentCenterProximity(index);
    const edgeBias = [0.12, 0.18, 0.12, 0.18, 0.38, 0.18, 0.12, 0.18, 0.12][index] || 0.12;
    const recognitionRisk = clamp01(centerProximity * 0.55 + edgeBias);
    return {
      analysisLabels: centerProximity > 0.65 ? ["center-area"] : ["quiet-area"],
      containsFace: false,
      containsPerson: false,
      containsText: false,
      containsImportantObject: centerProximity > 0.65,
      centerProximity,
      importanceScore: recognitionRisk,
      recognitionRisk,
      displayPriority: index + 1,
      analysisStatus: status,
      analysisVersion: ANALYSIS_VERSION,
      analysisReason: status === "fallback" ? "fallback-center-priority" : "default"
    };
  }

  function ensureFragmentAnalysis(fragment) {
    const fallback = defaultFragmentAnalysis(Number(fragment.index || 0), "fallback");
    let changed = false;
    for (const [key, value] of Object.entries(fallback)) {
      if (!(key in fragment)) {
        fragment[key] = value;
        changed = true;
      }
    }
    if (!Array.isArray(fragment.analysisLabels)) {
      fragment.analysisLabels = fallback.analysisLabels;
      changed = true;
    }
    fragment.centerProximity = clamp01(fragment.centerProximity);
    fragment.importanceScore = clamp01(fragment.importanceScore);
    fragment.recognitionRisk = clamp01(fragment.recognitionRisk);
    return changed;
  }

  function analyzeFragmentCanvas(canvas, index) {
    try {
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const { width, height } = canvas;
      const data = context.getImageData(0, 0, width, height).data;
      const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 9000)));
      let count = 0;
      let luminanceSum = 0;
      let luminanceSqSum = 0;
      let saturationSum = 0;
      let skinCount = 0;
      let edgeSum = 0;
      let darkCount = 0;
      let lightCount = 0;
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const offset = (y * width + x) * 4;
          const r = data[offset];
          const g = data[offset + 1];
          const b = data[offset + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          const saturation = max === 0 ? 0 : (max - min) / max;
          if (luminance < 0.22) darkCount += 1;
          if (luminance > 0.78) lightCount += 1;
          if (r > 95 && g > 40 && b > 20 && max - min > 15 && Math.abs(r - g) > 12 && r > g && r > b) skinCount += 1;
          if (x >= step) {
            const prev = (y * width + x - step) * 4;
            const prevLum = (0.2126 * data[prev] + 0.7152 * data[prev + 1] + 0.0722 * data[prev + 2]) / 255;
            edgeSum += Math.abs(luminance - prevLum);
          }
          if (y >= step) {
            const prev = ((y - step) * width + x) * 4;
            const prevLum = (0.2126 * data[prev] + 0.7152 * data[prev + 1] + 0.0722 * data[prev + 2]) / 255;
            edgeSum += Math.abs(luminance - prevLum);
          }
          luminanceSum += luminance;
          luminanceSqSum += luminance * luminance;
          saturationSum += saturation;
          count += 1;
        }
      }
      const averageLuminance = luminanceSum / Math.max(1, count);
      const contrast = clamp01(Math.sqrt(Math.max(0, luminanceSqSum / Math.max(1, count) - averageLuminance * averageLuminance)) * 2.8);
      const saturation = clamp01(saturationSum / Math.max(1, count));
      const skinRatio = clamp01(skinCount / Math.max(1, count) * 5);
      const edgeDensity = clamp01(edgeSum / Math.max(1, count) * 3.6);
      const centerProximity = fragmentCenterProximity(index);
      const textScore = clamp01(edgeDensity * 0.55 + contrast * 0.35 + (1 - saturation) * 0.1);
      const containsFace = skinRatio > 0.22 && centerProximity > 0.25;
      const containsPerson = skinRatio > 0.14 || (centerProximity > 0.55 && edgeDensity > 0.28 && contrast > 0.28);
      const containsText = textScore > 0.56 && contrast > 0.32;
      const containsImportantObject = centerProximity > 0.62 || (edgeDensity > 0.45 && contrast > 0.38) || saturation > 0.48;
      const quietArea = edgeDensity < 0.18 && contrast < 0.18 && saturation < 0.28;
      const importanceScore = clamp01(centerProximity * 0.24 + edgeDensity * 0.24 + contrast * 0.2 + saturation * 0.16 + skinRatio * 0.16);
      const recognitionRisk = clamp01(
        centerProximity * 0.23
        + edgeDensity * 0.18
        + contrast * 0.15
        + skinRatio * 0.24
        + (containsText ? 0.18 : textScore * 0.08)
        + (containsImportantObject ? 0.08 : 0)
      );
      const labels = [];
      if (containsFace) labels.push("face-like-area");
      if (containsPerson) labels.push("person-like-area");
      if (containsText) labels.push("text-like-area");
      if (containsImportantObject) labels.push("salient-object-like-area");
      if (quietArea) labels.push("quiet-background");
      if (!labels.length) labels.push("general-visual-area");
      return {
        analysisLabels: labels,
        containsFace,
        containsPerson,
        containsText,
        containsImportantObject,
        centerProximity,
        importanceScore,
        recognitionRisk,
        displayPriority: index + 1,
        analysisStatus: "completed",
        analysisVersion: ANALYSIS_VERSION,
        analysisReason: `edge:${edgeDensity.toFixed(2)} contrast:${contrast.toFixed(2)} skin:${skinRatio.toFixed(2)} center:${centerProximity.toFixed(2)}`
      };
    } catch (error) {
      return {
        ...defaultFragmentAnalysis(index, "failed"),
        analysisReason: "analysis-failed"
      };
    }
  }

  function decideFragmentOrdering(fragments) {
    const prepared = fragments.map((fragment) => ({ ...fragment }));
    prepared.forEach(ensureFragmentAnalysis);
    const highRisk = [...prepared].sort((a, b) => {
      const risk = b.recognitionRisk - a.recognitionRisk;
      if (Math.abs(risk) > 0.0001) return risk;
      return b.centerProximity - a.centerProximity;
    });
    const hidden = highRisk.slice(0, 2).map((fragment) => fragment.index);
    while (hidden.length < 2) {
      const fallbackIndex = [4, 3, 5, 1, 7].find((index) => !hidden.includes(index));
      hidden.push(fallbackIndex ?? hidden.length);
    }
    const hiddenSet = new Set(hidden);
    const visibleOrder = prepared
      .filter((fragment) => !hiddenSet.has(fragment.index))
      .sort((a, b) => {
        const risk = a.recognitionRisk - b.recognitionRisk;
        if (Math.abs(risk) > 0.0001) return risk;
        return a.centerProximity - b.centerProximity;
      });
    const finalOrder = [...visibleOrder, ...prepared.filter((fragment) => hiddenSet.has(fragment.index)).sort((a, b) => b.recognitionRisk - a.recognitionRisk)];
    finalOrder.forEach((fragment, orderIndex) => {
      const target = fragments.find((item) => item.index === fragment.index);
      if (target) target.displayPriority = orderIndex + 1;
    });
    return {
      hiddenFragmentIndexes: hidden.sort((a, b) => a - b),
      displayOrder: finalOrder.map((fragment) => fragment.index)
    };
  }

  function textDensity(value, maxLength) {
    return clamp01(String(value || "").trim().length / maxLength);
  }

  function recommendReunionTiming(input, fragments) {
    const prepared = fragments.map((fragment) => ({ ...fragment }));
    prepared.forEach(ensureFragmentAnalysis);
    const averageImportance = prepared.reduce((sum, fragment) => sum + Number(fragment.importanceScore || 0), 0) / Math.max(1, prepared.length);
    const averageRisk = prepared.reduce((sum, fragment) => sum + Number(fragment.recognitionRisk || 0), 0) / Math.max(1, prepared.length);
    const strongCueCount = prepared.filter((fragment) => Number(fragment.importanceScore || 0) > 0.48 || Number(fragment.recognitionRisk || 0) > 0.5).length;
    const hasPeopleCue = prepared.some((fragment) => fragment.containsPerson || fragment.containsFace) || Boolean(String(input.people || "").trim());
    const hasTextCue = prepared.some((fragment) => fragment.containsText);
    const contextScore = clamp01(
      textDensity(input.title, 32) * 0.18
      + textDensity(input.initialNote, 180) * 0.34
      + textDensity(input.initialEmotion, 60) * 0.22
      + textDensity(input.people, 60) * 0.26
    );
    const imageCueScore = clamp01(averageImportance * 0.42 + averageRisk * 0.38 + Math.min(strongCueCount, 4) * 0.05);
    const anchorScore = clamp01(contextScore * 0.45 + imageCueScore * 0.4 + (hasPeopleCue ? 0.1 : 0) + (hasTextCue ? 0.05 : 0));
    let days = 30;
    if (anchorScore < 0.22) days = 1;
    else if (anchorScore < 0.38) days = 7;
    else if (anchorScore < 0.62) days = 30;
    else if (anchorScore < 0.82) days = 90;
    else days = 365;

    const reasons = [];
    if (contextScore >= 0.45) reasons.push("預けたときの言葉が十分に残っている");
    else if (contextScore <= 0.16) reasons.push("言葉の手がかりが少ない");
    if (imageCueScore >= 0.55) reasons.push("写真の中に思い出す手がかりが多い");
    else if (imageCueScore <= 0.28) reasons.push("写真の手がかりが穏やかで、早めの再会が合いそう");
    if (hasPeopleCue) reasons.push("人に関する情報がある");
    if (hasTextCue) reasons.push("文字のような手がかりがある");
    if (!reasons.length) reasons.push("入力内容と写真の情報量のバランスが中くらい");

    return {
      days,
      label: REUNION_TIMING_OPTIONS[days],
      score: anchorScore,
      reasons
    };
  }

  function sortedFragments(memoryId) {
    return byMemory(memoryId, state.fragments).sort((a, b) => a.index - b.index);
  }

  function sortedReflections(memoryId) {
    return byMemory(memoryId, state.reflections).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  function getBlobUrl(path) {
    if (!path) return "";
    if (state.urls.has(path)) return state.urls.get(path);
    const image = state.images.get(path);
    if (!image || !image.blob) return "";
    const url = URL.createObjectURL(image.blob);
    state.urls.set(path, url);
    return url;
  }

  function cloudUserId() {
    return state.supabaseUser?.id || "";
  }

  function cloudStoragePath(localPath, userId = cloudUserId()) {
    if (!localPath || !userId) return "";
    const relative = String(localPath).replace(/^indexeddb:\/\/images\//, "").replace(/^\/+/, "");
    return `${userId}/${relative}`;
  }

  function memoryCloudRow(memory) {
    const userId = cloudUserId();
    return {
      id: memory.id,
      user_id: userId,
      title: memory.title || "",
      status: memory.status || "sleeping",
      original_image_path: cloudStoragePath(memory.originalImagePath, userId),
      created_at: memory.createdAt || realNowIso(),
      available_at: memory.availableAt || null,
      payload: { ...memory, ownerId: userId }
    };
  }

  function fragmentCloudRow(fragment) {
    const userId = cloudUserId();
    return {
      id: fragment.id,
      memory_id: fragment.memoryId,
      user_id: userId,
      fragment_index: Number(fragment.index),
      image_path: cloudStoragePath(fragment.imagePath, userId),
      is_unlocked: Boolean(fragment.isUnlocked),
      unlocked_at: fragment.unlockedAt || null,
      payload: { ...fragment, ownerId: userId }
    };
  }

  function reflectionCloudRow(reflection) {
    const userId = cloudUserId();
    return {
      id: reflection.id,
      memory_id: reflection.memoryId,
      user_id: userId,
      fragment_stage: reflection.fragmentStage == null ? null : Number(reflection.fragmentStage),
      reflection_type: reflection.reflectionType || "fragment",
      body: reflection.text || "",
      could_not_remember: Boolean(reflection.couldNotRemember),
      created_at: reflection.createdAt || realNowIso(),
      local_date: reflection.localDate || null,
      payload: { ...reflection, ownerId: userId }
    };
  }

  async function upsertCloudRecord(table, row) {
    if (!supabaseClient || !cloudUserId()) return;
    const { error } = await supabaseClient.from(table).upsert(row);
    if (error) throw error;
  }

  async function uploadCloudImage(path, blob) {
    if (!supabaseClient || !cloudUserId() || !blob) return;
    const remotePath = cloudStoragePath(path);
    const { error } = await supabaseClient.storage.from("memory-images").upload(remotePath, blob, {
      upsert: true,
      contentType: blob.type || "image/jpeg",
      cacheControl: "3600"
    });
    if (error) throw error;
  }

  async function migrateLegacyLocalData() {
    const userId = cloudUserId();
    if (!userId || state.cloudSyncing) return;
    const migrationOwner = String(await getSetting("cloudMigrationOwnerId", "") || "");
    const legacyMemories = state.memories.filter((memory) => !memory.ownerId);
    if (migrationOwner && migrationOwner !== userId) return;
    state.cloudSyncing = true;
    try {
      const ownedMemoryIds = new Set();
      for (const memory of state.memories) {
        if (!memory.ownerId) memory.ownerId = userId;
        if (memory.ownerId !== userId) continue;
        ownedMemoryIds.add(memory.id);
        await tx("memories", "readwrite", (store) => store.put(memory));
        await upsertCloudRecord("memories", memoryCloudRow(memory));
      }
      for (const fragment of state.fragments) {
        if (!ownedMemoryIds.has(fragment.memoryId)) continue;
        fragment.ownerId = userId;
        await tx("fragments", "readwrite", (store) => store.put(fragment));
        await upsertCloudRecord("memory_fragments", fragmentCloudRow(fragment));
      }
      for (const reflection of state.reflections) {
        if (!ownedMemoryIds.has(reflection.memoryId)) continue;
        reflection.ownerId = userId;
        await tx("reflections", "readwrite", (store) => store.put(reflection));
        await upsertCloudRecord("memory_reflections", reflectionCloudRow(reflection));
      }
      for (const image of state.images.values()) {
        const belongsToOwnedMemory = [...ownedMemoryIds].some((memoryId) => String(image.path).includes(`/${memoryId}/`));
        if (belongsToOwnedMemory) await uploadCloudImage(image.path, image.blob);
      }
      if (!migrationOwner || legacyMemories.length) await saveSetting("cloudMigrationOwnerId", userId);
    } finally {
      state.cloudSyncing = false;
    }
  }

  async function loadCloudRecords() {
    if (!supabaseClient || !cloudUserId()) return;
    const [memoriesResult, fragmentsResult, reflectionsResult] = await Promise.all([
      supabaseClient.from("memories").select("payload").order("created_at", { ascending: false }),
      supabaseClient.from("memory_fragments").select("payload"),
      supabaseClient.from("memory_reflections").select("payload").order("created_at", { ascending: true })
    ]);
    const error = memoriesResult.error || fragmentsResult.error || reflectionsResult.error;
    if (error) throw error;
    state.memories = (memoriesResult.data || []).map((row) => row.payload).filter(Boolean);
    state.fragments = (fragmentsResult.data || []).map((row) => row.payload).filter(Boolean);
    state.reflections = (reflectionsResult.data || []).map((row) => row.payload).filter(Boolean);

    for (const item of [...state.memories, ...state.fragments]) {
      const path = item.originalImagePath || item.imagePath;
      if (!path || state.images.has(path)) continue;
      const { data, error: downloadError } = await supabaseClient.storage.from("memory-images").download(cloudStoragePath(path));
      if (downloadError) continue;
      const image = { path, blob: data, savedAt: realNowIso() };
      await tx("images", "readwrite", (store) => store.put(image));
      state.images.set(path, image);
    }
  }

  function clearRuntimeData() {
    for (const url of state.urls.values()) URL.revokeObjectURL(url);
    if (state.selectedPreviewUrl) URL.revokeObjectURL(state.selectedPreviewUrl);
    state.memories = [];
    state.fragments = [];
    state.reflections = [];
    state.images = new Map();
    state.urls = new Map();
    state.activeMemoryId = "";
    state.transientOriginalMemoryId = "";
    state.selectedFile = null;
    state.selectedPreviewUrl = "";
  }

  function filterLocalCacheForUser(userId) {
    const ownedMemories = state.memories.filter((memory) => memory.ownerId === userId);
    const ownedMemoryIds = new Set(ownedMemories.map((memory) => memory.id));
    state.memories = ownedMemories;
    state.fragments = state.fragments.filter((fragment) => fragment.ownerId === userId && ownedMemoryIds.has(fragment.memoryId));
    state.reflections = state.reflections.filter((reflection) => reflection.ownerId === userId && ownedMemoryIds.has(reflection.memoryId));
    state.images = new Map(
      [...state.images].filter(([path]) => [...ownedMemoryIds].some((memoryId) => String(path).includes(`/${memoryId}/`)))
    );
  }

  async function loadData() {
    await loadSettings();
    const userId = cloudUserId();
    if (!userId) {
      clearRuntimeData();
      return;
    }
    state.memories = await getAll("memories");
    state.fragments = await getAll("fragments");
    state.reflections = await getAll("reflections");
    const images = await getAll("images");
    state.images = new Map(images.map((image) => [image.path, image]));
    try {
      await migrateLegacyLocalData();
      filterLocalCacheForUser(userId);
      await loadCloudRecords();
    } catch (error) {
      filterLocalCacheForUser(userId);
      reportError(
        "cloud-load",
        error,
        "Googleログインは完了しました。クラウドの記録を読み込めなかったため、このアカウントの端末内キャッシュだけを表示しています。"
      );
    }
    await normalizeLoadedMemories();
    await wakeDueMemories();
  }

  async function saveMemory(memory) {
    if (cloudUserId()) memory.ownerId = cloudUserId();
    await tx("memories", "readwrite", (store) => store.put(memory));
    if (cloudUserId() && !state.cloudSyncing) await upsertCloudRecord("memories", memoryCloudRow(memory));
  }

  async function saveFragment(fragment) {
    if (cloudUserId()) fragment.ownerId = cloudUserId();
    await tx("fragments", "readwrite", (store) => store.put(fragment));
    if (cloudUserId() && !state.cloudSyncing) await upsertCloudRecord("memory_fragments", fragmentCloudRow(fragment));
  }

  async function saveReflection(reflection) {
    if (cloudUserId()) reflection.ownerId = cloudUserId();
    await tx("reflections", "readwrite", (store) => store.put(reflection));
    if (cloudUserId() && !state.cloudSyncing) await upsertCloudRecord("memory_reflections", reflectionCloudRow(reflection));
  }

  async function saveImage(path, blob) {
    await tx("images", "readwrite", (store) => store.put({ path, blob, savedAt: realNowIso() }));
    if (cloudUserId() && !state.cloudSyncing) await uploadCloudImage(path, blob);
  }

  async function deleteRecord(storeName, key) {
    await tx(storeName, "readwrite", (store) => store.delete(key));
    if (!supabaseClient || !cloudUserId()) return;
    const table = { memories: "memories", fragments: "memory_fragments", reflections: "memory_reflections" }[storeName];
    if (!table) return;
    const { error } = await supabaseClient.from(table).delete().eq("id", key);
    if (error) throw error;
  }

  async function clearStore(storeName) {
    await tx(storeName, "readwrite", (store) => store.clear());
  }

  async function normalizeLoadedMemories() {
    let changed = false;
    for (const memory of state.memories) {
      if (Array.isArray(memory.hiddenFragmentIndexes) && memory.hiddenFragmentIndexes.length >= 2) {
        const normalizedHidden = normalizeHiddenFragmentIndexes(memory.hiddenFragmentIndexes);
        if (normalizedHidden.join(",") !== memory.hiddenFragmentIndexes.join(",")) {
          memory.hiddenFragmentIndexes = normalizedHidden;
          changed = true;
        }
      }
      const fragments = sortedFragments(memory.id);
      let fragmentAnalysisChanged = false;
      for (const fragment of fragments) {
        if (ensureFragmentAnalysis(fragment)) fragmentAnalysisChanged = true;
      }
      if (!Array.isArray(memory.displayOrder) || memory.displayOrder.length !== 9 || !Array.isArray(memory.hiddenFragmentIndexes) || memory.hiddenFragmentIndexes.length < 2) {
        const ordering = decideFragmentOrdering(fragments);
        memory.displayOrder = ordering.displayOrder;
        if (!Array.isArray(memory.hiddenFragmentIndexes) || memory.hiddenFragmentIndexes.length < 2) {
          memory.hiddenFragmentIndexes = ordering.hiddenFragmentIndexes;
        }
        memory.imageAnalysisStatus = fragments.some((fragment) => fragment.analysisStatus === "completed") ? "completed" : "fallback";
        memory.imageAnalysisVersion = ANALYSIS_VERSION;
        changed = true;
        fragmentAnalysisChanged = true;
      }
      if (fragmentAnalysisChanged) {
        for (const fragment of fragments) await saveFragment(fragment);
      }
      if (!memory.hasViewedOriginal) {
        for (const fragment of fragments) {
          if (memory.hiddenFragmentIndexes.includes(fragment.index) && fragment.isUnlocked) {
            fragment.isUnlocked = false;
            fragment.unlockedAt = "";
            await saveFragment(fragment);
            changed = true;
          }
        }
      }
      const unlocked = fragments.filter((fragment) => fragment.isUnlocked).length;
      const memoryReflections = sortedReflections(memory.id).filter((reflection) => reflection.reflectionType !== "今の自分にとっての意味");
      if (!memory.currentStage) {
        if (memory.status === "viewed_original" || memory.status === "kept_closed" || memory.status === "not_yet") {
          memory.currentStage = 5;
        } else if (memoryReflections.length >= 4) {
          memory.currentStage = 5;
        } else if (unlocked >= 6) {
          memory.currentStage = 4;
        } else if (unlocked >= 3) {
          memory.currentStage = 3;
        } else {
          memory.currentStage = 1;
        }
        changed = true;
      }
      if (!("lastReflectedDate" in memory)) {
        const last = memoryReflections[memoryReflections.length - 1];
        memory.lastReflectedDate = last?.localDate || (last ? localDateKey(last.createdAt) : null);
        changed = true;
      }
      if (!memory.nextAvailableDate) {
        memory.nextAvailableDate = memory.availableAt || memory.createdAt || realNowIso();
        changed = true;
      }
      if (!memory.availableAt) {
        memory.availableAt = memory.nextAvailableDate;
        changed = true;
      }
      if (!("selectedDelayDays" in memory)) {
        memory.selectedDelayDays = Math.max(1, daysBetweenLocal(memory.createdAt || realNowIso(), memory.availableAt || memory.nextAvailableDate || realNowIso()));
        changed = true;
      }
      if (!("revisitIntervalDays" in memory)) {
        memory.revisitIntervalDays = Math.max(1, Number(memory.selectedDelayDays || 30));
        changed = true;
      }
      if (!("reunionTimingMode" in memory)) {
        memory.reunionTimingMode = memory.aiRecommendedDelayDays ? "ai" : "manual";
        changed = true;
      }
      if (!Array.isArray(memory.aiRecommendationReasons)) {
        memory.aiRecommendationReasons = [];
        changed = true;
      }
      const isSameRealDayAsCreated = memory.createdAt && localDateKey(memory.createdAt) === localDateKey(realNow());
      const isUnansweredImmediateMemory = memory.status === "fragmenting"
        && Number(memory.currentStage || 1) === 1
        && memoryReflections.length === 0
        && isSameRealDayAsCreated
        && isDateAvailable(memory.nextAvailableDate);
      if (isUnansweredImmediateMemory) {
        memory.status = "sleeping";
        memory.availableAt = addLocalDaysFrom(memory.createdAt || realNowIso(), 1);
        memory.nextAvailableDate = memory.availableAt;
        memory.previewFragmentCount = 0;
        memory.lastReflectedDate = null;
        for (const fragment of fragments) {
          if (fragment.isUnlocked) {
            fragment.isUnlocked = false;
            fragment.unlockedAt = "";
            await saveFragment(fragment);
          }
        }
        changed = true;
      }
      if (!("hasViewedOriginal" in memory)) {
        memory.hasViewedOriginal = memory.status === "viewed_original";
        changed = true;
      }
      if (!("finalChoice" in memory)) {
        memory.finalChoice = "";
        changed = true;
      }
      if (memory.status === "viewed_original" && !memory.lastViewedAt) {
        memory.lastViewedAt = realNowIso();
        memory.lastViewedLocalDate = localDateKey(realNow());
        memory.nextAvailableDate = addLocalDaysFrom(realNow(), Math.max(1, Number(memory.revisitIntervalDays || memory.selectedDelayDays || 30)));
        changed = true;
      }
      if (!("previewFragmentCount" in memory) || Number(memory.previewFragmentCount) !== Math.min(unlocked, 7)) {
        memory.previewFragmentCount = Math.min(unlocked, 7);
        changed = true;
      }
    }
    if (changed) {
      for (const memory of state.memories) await saveMemory(memory);
    }
  }

  async function unlockFragmentsForStage(memory) {
    const target = STAGE_UNLOCK_COUNTS[Math.min(Number(memory.currentStage || 1), 4)] || 0;
    memory.hiddenFragmentIndexes = normalizeHiddenFragmentIndexes(memory.hiddenFragmentIndexes);
    const fragments = sortedFragments(memory.id);
    let unlocked = fragments.filter((fragment) => fragment.isUnlocked).length;
    while (unlocked < target) {
      const fragment = await unlockNextFragment(memory.id, memory.hiddenFragmentIndexes);
      if (!fragment) break;
      unlocked += 1;
    }
    memory.previewFragmentCount = Math.min(unlocked, 7);
    await saveMemory(memory);
  }

  async function wakeDueMemories() {
    const due = state.memories.filter((memory) => {
      const fragments = byMemory(memory.id, state.fragments);
      return memory.status === "sleeping" && isAvailable(memory) && fragments.length > 0;
    });
    for (const memory of due) {
      memory.status = "fragmenting";
      memory.currentStage = Math.max(1, Number(memory.currentStage || 1));
      memory.nextAvailableDate = memory.nextAvailableDate || memory.availableAt || appNowIso();
      await unlockFragmentsForStage(memory);
      await saveMemory(memory);
    }
    const availableFragments = state.memories.filter((memory) => {
      return memory.status === "fragmenting" && Number(memory.currentStage || 1) <= 4 && isAvailable(memory);
    });
    for (const memory of availableFragments) {
      await unlockFragmentsForStage(memory);
    }
    if (due.length > 0 || availableFragments.length > 0) {
      state.memories = await getAll("memories");
      state.fragments = await getAll("fragments");
    }
  }

  async function unlockNextFragment(memoryId, excludedIndexes = []) {
    const excluded = new Set(excludedIndexes.map(Number));
    const locked = byMemory(memoryId, state.fragments)
      .filter((fragment) => !fragment.isUnlocked && !excluded.has(fragment.index))
      .sort((a, b) => (Number(a.displayPriority || 99) - Number(b.displayPriority || 99)) || (a.index - b.index));
    if (locked.length === 0) return null;
    const fragment = locked[0];
    fragment.isUnlocked = true;
    fragment.unlockedAt = appNowIso();
    await saveFragment(fragment);
    return fragment;
  }
  function canReflectToday(memory) {
    return memory.status === "fragmenting"
      && Number(memory.currentStage || 1) <= 4
      && isDateAvailable(memory.nextAvailableDate)
      && memory.lastReflectedDate !== localDateKey();
  }

  function stageLabel(memory) {
    if (memory.status === "fragmenting" && Number(memory.currentStage || 1) >= 5) return "写真を見るか選ぶ";
    if (memory.status === "fragmenting") return `確認 ${Number(memory.currentStage || 1)}日目`;
    return statusLabels[memory.status] || "記録";
  }

  function nextDisplayDate(memory) {
    return memory.nextAvailableDate || memory.availableAt;
  }

  function reunionTimingLabel(memory) {
    const base = REUNION_TIMING_OPTIONS[Number(memory.selectedDelayDays)] || `${Number(memory.selectedDelayDays || 0)}日後`;
    if (memory.reunionTimingMode === "ai") return `AIにまかせた提案（${base}）`;
    return base;
  }

  function isHiddenUntilOriginal(memory, fragment) {
    return !memory.hasViewedOriginal && normalizeHiddenFragmentIndexes(memory.hiddenFragmentIndexes).includes(fragment.index);
  }

  function memoryHint(memory) {
    const created = new Date(memory.createdAt || realNowIso());
    const month = created.getMonth() + 1;
    const season = month <= 2 || month === 12 ? "冬" : month <= 5 ? "春" : month <= 8 ? "夏" : "秋";
    const hour = created.getHours();
    const timeOfDay = hour < 5 ? "夜明け前" : hour < 11 ? "朝" : hour < 15 ? "昼過ぎ" : hour < 18 ? "夕方" : "夜";
    const people = memory.people ? "一緒にいた人の情報があります。" : "一緒にいた人は未入力です。";
    const feeling = memory.initialEmotion ? "当時の気持ちが登録されています。" : "当時の気持ちは未入力です。";
    return `${season}の${timeOfDay}に登録した写真です。${people}${feeling}`;
  }

  function renderPromptAnswers(reflection) {
    const answers = reflection.promptAnswers;
    if (!answers || typeof answers !== "object") return "";
    const rows = [
      ["誰といたと思うか", answers.people],
      ["どこで撮ったと思うか", answers.place],
      ["どんな気持ちだったか", answers.feeling]
    ].filter(([, value]) => String(value || "").trim());
    if (!rows.length) return "";
    return `<dl class="answer-details">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
  }

  function renderEmotionLabels(reflection) {
    const emotions = Array.isArray(reflection.emotions) ? reflection.emotions : [];
    if (!emotions.length) return "";
    return `<div class="emotion-list">${emotions.map((emotion) => `<span>${escapeHtml(emotion)}</span>`).join("")}</div>`;
  }

  async function createBitmap(blob) {
    if ("createImageBitmap" in window) {
      try {
        return await createImageBitmap(blob, { imageOrientation: "from-image" });
      } catch (_error) {
        return await createImageBitmap(blob);
      }
    }
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(blob);
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("画像を読み込めませんでした。"));
      };
      image.src = url;
    });
  }

  function canvasToBlob(canvas, type = "image/jpeg", quality = 0.9) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("画像の保存形式を作れませんでした。"));
      }, type, quality);
    });
  }

  async function splitImage(memoryId, originalBlob) {
    const bitmap = await createBitmap(originalBlob);
    const maxSide = 1536;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(3, Math.floor(bitmap.width * scale / 3) * 3);
    const height = Math.max(3, Math.floor(bitmap.height * scale / 3) * 3);
    const normalized = document.createElement("canvas");
    normalized.width = width;
    normalized.height = height;
    normalized.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    const normalizedOriginalBlob = await canvasToBlob(normalized, "image/jpeg", 0.92);

    const fragmentWidth = width / 3;
    const fragmentHeight = height / 3;
    const fragments = [];
    for (let index = 0; index < 9; index += 1) {
      const col = index % 3;
      const row = Math.floor(index / 3);
      const canvas = document.createElement("canvas");
      canvas.width = fragmentWidth;
      canvas.height = fragmentHeight;
      canvas
        .getContext("2d")
        .drawImage(normalized, col * fragmentWidth, row * fragmentHeight, fragmentWidth, fragmentHeight, 0, 0, fragmentWidth, fragmentHeight);
      const analysis = analyzeFragmentCanvas(canvas, index);
      const blob = await canvasToBlob(canvas, "image/jpeg", 0.88);
      const fragmentId = id("fragment");
      const imagePath = `indexeddb://images/${memoryId}/fragment-${index}.jpg`;
      await saveImage(imagePath, blob);
      fragments.push({
        id: fragmentId,
        memoryId,
        index,
        imagePath,
        isUnlocked: false,
        unlockedAt: "",
        ...analysis
      });
    }
    if (typeof bitmap.close === "function") bitmap.close();
    const ordering = decideFragmentOrdering(fragments);
    return { fragments, width, height, originalBlob: normalizedOriginalBlob, ...ordering };
  }

  function shell(content) {
    return `
      <a class="skip-link" href="#main-content">本文へ移動</a>
      <header class="topbar">
        <a class="brand" href="./index.html" aria-label="re:Memoryのホームへ">
          <img src="./assets/logo.png" alt="" aria-hidden="true">
          <span>re:Memory</span>
        </a>
        <nav class="nav-tabs" aria-label="アプリ内ナビゲーション">
          ${tab("home", "ホーム")}
          ${tab("capture", "登録")}
          ${tab("list", "思い出")}
        </nav>
        ${renderAuthArea()}
      </header>
      ${state.error ? `<div class="error" role="alert"><strong>続けられませんでした</strong><p>${escapeHtml(state.error)}</p></div>` : ""}
      ${state.busy ? `<div class="busy-indicator" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span>処理中です。しばらくお待ちください。</span></div>` : ""}
      <main id="main-content" class="screen" tabindex="-1">
        ${content}
      </main>
      <footer class="app-footer">
        <p>© 2026 re:Memory</p>
        <nav class="app-footer-links" aria-label="フッターナビゲーション">
          <a href="https://yukitomiyatake-gif.github.io/rememory-LP/">re:Memoryについて</a>
          <a href="https://yukitomiyatake-gif.github.io/rememory-LP/privacy.html">プライバシーポリシー</a>
          <a href="https://yukitomiyatake-gif.github.io/rememory-LP/terms.html">利用規約</a>
          <a href="https://github.com/yukitomiyatake-gif">お問い合わせ</a>
        </nav>
      </footer>
    `;
  }

  function renderAuthArea() {
    const session = normalizeAuthSession(state.settings.authSession);
    if (!session) {
      return `<div class="auth-area"><button class="auth-link" type="button" data-route="login">ログイン</button></div>`;
    }
    const initial = escapeHtml((session.name || "U").slice(0, 1));
    return `
      <div class="auth-area signed-in">
        ${session.picture ? `<img class="auth-avatar" src="${escapeHtml(session.picture)}" alt="">` : `<span class="auth-avatar fallback" aria-hidden="true">${initial}</span>`}
        <div class="auth-user">
          <strong>${escapeHtml(session.name)}</strong>
          <span>Googleでログイン中</span>
        </div>
        <button class="auth-link" type="button" data-action="logout">ログアウト</button>
      </div>
    `;
  }

  function renderLogin() {
    const googleReady = Boolean(supabaseClient);
    return shell(`
      <section class="login-stage">
        <div class="login-panel">
          <header class="page-header">
            <span class="eyebrow">ログイン</span>
            <h1>あなたの思い出を、あなたのアカウントで守ります。</h1>
            <p>Googleでログインすると、写真と記録を暗号化通信でSupabaseへ保存し、この端末のIndexedDBをオフライン用キャッシュとして使います。</p>
          </header>
          <div class="login-options production-login-options">
            <div class="login-option">
              <h2>Googleで続ける</h2>
              <p>Googleアカウントを選び、安全にログインします。</p>
              ${googleReady
                ? `<button class="button google-oauth-button" type="button" data-action="google-oauth">Googleでログイン</button>`
                : `<p class="auth-note">Googleログインを準備できませんでした。</p>`}
            </div>
          </div>
          <p class="form-note">ログイン後の写真と記録は、アカウントごとに分離して保存されます。</p>
          <p class="login-legal">続行すると、<a href="https://yukitomiyatake-gif.github.io/rememory-LP/terms.html">利用規約</a>と<a href="https://yukitomiyatake-gif.github.io/rememory-LP/privacy.html">プライバシーポリシー</a>に同意したものとみなされます。</p>
        </div>
      </section>
    `);
  }

  function tab(route, label) {
    return `<button type="button" data-route="${route}" ${state.route === route ? 'aria-current="page"' : ""}><span>${label}</span></button>`;
  }

  function counts() {
    return {
      today: state.memories.filter((memory) => memory.status === "fragmenting" && isAvailable(memory)).length,
      sleeping: state.memories.filter((memory) => memory.status === "sleeping" || (memory.status === "not_yet" && !isAvailable(memory))).length,
      waiting: state.memories.filter((memory) => memory.status === "fragmenting").length,
      met: state.memories.filter((memory) => memory.status === "viewed_original").length
    };
  }

  function renderHome() {
    const c = counts();
    const todays = state.memories.filter((memory) => memory.status === "fragmenting" && isAvailable(memory));
    const sleeping = state.memories.filter((memory) => memory.status === "sleeping" || (memory.status === "not_yet" && !isAvailable(memory))).slice(0, 3);
    const met = state.memories.filter((memory) => ["viewed_original", "kept_closed", "not_yet"].includes(memory.status)).slice(0, 3);
    const focusTitle = todays.length
      ? `今日確認できる思い出が${todays.length}件あります。`
      : "今日確認できる思い出はありません。";
    const focusText = todays.length
      ? "思い出のかけらを見ながら、思い出したことを記録できます。"
      : "写真を登録すると、選んだ日から少しずつ確認できます。";
    return shell(`
      <section class="home-focus">
        <div class="home-focus-copy">
          <span class="eyebrow">今日の思い出</span>
          <h1>${focusTitle}</h1>
          <p class="lead">${focusText}</p>
          <div class="actions">
            <button class="button" type="button" data-route="capture">思い出を預ける</button>
            <button class="button secondary" type="button" data-route="list">一覧を見る</button>
          </div>
        </div>
        <dl class="memory-summary" aria-label="思い出の状態">
          <div><dt>今日確認できる</dt><dd>${c.today}</dd></div>
          <div><dt>表示日待ち</dt><dd>${c.sleeping}</dd></div>
          <div><dt>確認中</dt><dd>${c.waiting}</dd></div>
          <div><dt>写真を見た</dt><dd>${c.met}</dd></div>
        </dl>
      </section>
      ${todays.length ? `
        <section class="section today-section">
          <div class="section-head"><div><span class="section-kicker">今日確認できます</span><h2>今日の思い出</h2></div><span class="count-label">${todays.length}件</span></div>
          <div class="grid">${todays.map(memoryCard).join("")}</div>
        </section>
      ` : ""}
      <section class="section">
        <div class="section-head"><div><span class="section-kicker">まだ表示しません</span><h2>表示日を待っている思い出</h2></div><span class="count-label">${sleeping.length}件</span></div>
        ${sleeping.length ? `<div class="grid">${sleeping.map(memoryCard).join("")}</div>` : `<div class="empty compact"><p>表示日を待っている思い出はありません。</p></div>`}
      </section>
      <section class="section">
        <div class="section-head"><div><span class="section-kicker">これまでの記録</span><h2>写真を見るか選んだ思い出</h2></div><span class="count-label">${met.length}件</span></div>
        ${met.length ? `<div class="grid">${met.map(memoryCard).join("")}</div>` : `<div class="empty compact"><p>まだ記録はありません。</p></div>`}
      </section>
    `);
  }

  function memoryCard(memory) {
    const canShowOriginal = memory.hasViewedOriginal && memory.status === "viewed_original" && state.transientOriginalMemoryId === memory.id;
    const thumb = canShowOriginal ? getBlobUrl(memory.originalImagePath) : "";
    const unlocked = sortedFragments(memory.id).filter((fragment) => fragment.isUnlocked && !isHiddenUntilOriginal(memory, fragment)).length;
    const title = memory.title || "名前のない思い出";
    const nextLabel = memory.status === "kept_closed" ? "必要になったとき" : formatDate(nextDisplayDate(memory));
    const nextTerm = memory.status === "viewed_original" ? "次回表示日" : "次に開く日";
    const actionLabel = memory.status === "fragmenting" ? "思い出のかけらを見る" : memory.status === "sleeping" ? "予定を見る" : "詳細を見る";
    return `
      <article class="memory-card">
        ${thumb ? `<img class="thumb memory-visual" src="${thumb}" alt="${escapeHtml(title)}の写真">` : `<div class="placeholder memory-visual" role="img" aria-label="写真はまだ表示されません"><span>写真はまだ表示されません</span></div>`}
        <div class="memory-card-heading">
          <span class="status-pill">${statusLabels[memory.status] || "記録"}</span>
          <h3>${escapeHtml(title)}</h3>
        </div>
        <dl class="memory-meta">
          <div><dt>登録日</dt><dd>${formatDate(memory.createdAt)}</dd></div>
          <div><dt>${nextTerm}</dt><dd>${nextLabel}</dd></div>
          <div><dt>表示まで</dt><dd>${escapeHtml(reunionTimingLabel(memory))}</dd></div>
          <div><dt>状態</dt><dd>${stageLabel(memory)}</dd></div>
          <div><dt>表示済み</dt><dd>${memory.hasViewedOriginal ? "元の写真を表示済み" : `${unlocked}/7`}</dd></div>
        </dl>
        <button class="button soft card-action" type="button" data-open-memory="${memory.id}">${actionLabel}</button>
      </article>
    `;
  }

  function renderCapture() {
    if (state.cameraActive) {
      return shell(`
        <section class="page-panel capture-box">
          <header class="page-header">
            <span class="eyebrow">カメラ</span>
            <h1>写真を撮影します。</h1>
            <p>写真は撮影後に確認できます。まだこの時点では保存されません。</p>
          </header>
          <video id="cameraPreview" class="camera-preview" autoplay playsinline muted aria-label="カメラのプレビュー"></video>
          ${state.cameraError ? `<p class="error">${escapeHtml(state.cameraError)}</p>` : ""}
          <div class="button-row">
            <button class="button" type="button" data-action="capture-camera-photo">写真を撮る</button>
            <button class="button secondary" type="button" data-action="stop-camera">カメラを閉じる</button>
          </div>
        </section>
      `);
    }
    if (state.selectedFile && state.selectedPreviewUrl) {
      return shell(`
        <section class="page-panel capture-box">
          <header class="page-header">
            <span class="eyebrow">撮影確認</span>
            <h1>この写真で登録しますか？</h1>
            <p>問題なければ、次の画面でタイトルやメモを入力します。</p>
          </header>
          <div class="photo-preview-frame">
            <img class="preview-photo" src="${state.selectedPreviewUrl}" alt="選択した写真">
          </div>
          <div class="button-row">
            <button class="button secondary" type="button" data-action="retake">撮り直す</button>
            <button class="button" type="button" data-action="show-form">この写真で登録する</button>
          </div>
        </section>
      `);
    }
    return shell(`
      <section class="page-panel capture-box">
          <header class="page-header">
            <span class="eyebrow">写真を登録</span>
          <h1>登録する写真を選んでください。</h1>
          <p>カメラで撮るか、端末にある写真を選べます。登録した写真は、指定した日まで表示されません。</p>
        </header>
        <input id="cameraInput" class="file-input" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" tabindex="-1" aria-hidden="true">
        <input id="libraryInput" class="file-input" type="file" accept="image/jpeg,image/png,image/webp" tabindex="-1" aria-hidden="true">
        <div class="capture-actions">
          <button class="button" type="button" data-action="start-camera">カメラで撮る</button>
          <button class="button secondary" type="button" data-action="open-library">写真から選ぶ</button>
        </div>
        <p class="helper-text">カメラが使えない場合は、「写真から選ぶ」を使ってください。</p>
        ${state.cameraError ? `<p class="notice">${escapeHtml(state.cameraError)}</p>` : ""}
      </section>
    `);
  }
  function renderMemoryForm() {
    return shell(`
      <section class="page-panel capture-box">
          <header class="page-header">
            <span class="eyebrow">写真の情報</span>
          <h1>写真の情報を入力します。</h1>
          <p>入力はすべて任意です。空欄のままでも登録できます。</p>
        </header>
        <form id="memoryForm" class="form-grid">
          <label class="field"><span class="field-label">タイトル <small>任意</small></span><input name="title" maxlength="80" placeholder="例：雨上がりの帰り道" autocomplete="off"></label>
          <label class="field"><span class="field-label">写真を表示するタイミング</span>
            <select name="delayDays" aria-describedby="reunion-help">
              <option value="ai">AIにまかせる</option>
              <option value="1">1日後（明日から試す）</option>
              <option value="7">7日後</option>
              <option value="30">30日後</option>
              <option value="90">90日後</option>
              <option value="365">365日後</option>
            </select>
            <small id="reunion-help" class="field-help">AIにまかせる場合は、写真の特徴と入力内容から表示日を選びます。元の写真はまだ表示されません。</small>
          </label>
          <label class="field full"><span class="field-label">一言メモ <small>任意</small></span><textarea name="initialNote" maxlength="500" placeholder="あとで見返したいことを自由に書けます。"></textarea></label>
          <label class="field"><span class="field-label">当時の気持ち <small>任意</small></span><input name="initialEmotion" maxlength="120" placeholder="例：ほっとした" autocomplete="off"></label>
          <label class="field"><span class="field-label">一緒にいた人 <small>任意</small></span><input name="people" maxlength="120" placeholder="名前でなくても大丈夫です" autocomplete="off"></label>
          <div class="form-actions full">
            <p class="helper-text">登録後は、選んだ日まで元の写真は表示されません。</p>
            <button class="button" type="submit" ${state.busy ? "disabled" : ""}>${state.busy ? `<span class="spinner" aria-hidden="true"></span>登録しています` : "登録する"}</button>
          </div>
        </form>
      </section>
    `);
  }

  function renderMemory(memoryId) {
    const memory = state.memories.find((item) => item.id === memoryId);
    if (!memory) return shell(`<p class="empty">思い出が見つかりませんでした。</p>`);
    const fragments = sortedFragments(memory.id);
    const reflections = sortedReflections(memory.id);
    const unlockedCount = fragments.filter((fragment) => fragment.isUnlocked && !isHiddenUntilOriginal(memory, fragment)).length;
    if (memory.status === "not_yet" && isAvailable(memory)) return renderChoice(memory, fragments, reflections);
    if (memory.status === "fragmenting" && Number(memory.currentStage || 1) >= 5 && isAvailable(memory)) return renderChoice(memory, fragments, reflections);
    if (memory.status === "viewed_original" && state.transientOriginalMemoryId === memory.id) return renderOriginal(memory, fragments, reflections);
    if (memory.status === "kept_closed" || memory.status === "not_yet" || !isAvailable(memory)) return renderClosedMemory(memory, fragments, reflections);
    const canAnswer = canReflectToday(memory);
    const stage = Math.min(4, Math.max(1, Number(memory.currentStage || 1)));
    return shell(`
      <section class="fragment-stage reflection-stage">
        <div class="fragment-column">
          <header class="memory-stage-header">
            <span class="eyebrow">${stageLabel(memory)}</span>
            <h1>この思い出のかけらを見て、思い出したことはありますか？</h1>
            <div class="memory-progress" role="progressbar" aria-label="写真確認の進行" aria-valuemin="1" aria-valuemax="4" aria-valuenow="${stage}">
              <div><span>進行状況</span><strong>${stage}/4日目</strong></div>
              <span class="progress-track" aria-hidden="true"><span style="width: ${stage * 25}%"></span></span>
              <small>表示中の思い出のかけら ${unlockedCount}/7</small>
            </div>
          </header>
          <aside class="memory-hint" aria-label="写真についてのヒント">
            <span>ヒント</span>
            <p>${memoryHint(memory)}</p>
          </aside>
          ${fragmentGrid(fragments, memory)}
        </div>
        <div class="reflection-column">
          ${canAnswer ? `
            <form id="reflectionForm" class="reflection-form">
              <header class="form-header">
                <span class="section-kicker">今日の記録</span>
                <h2>思い出したことを書いてください。</h2>
                <p>はっきり思い出せない場合は、空欄でも記録できます。</p>
              </header>
              <label class="field">
                <span class="field-label">思い出したこと <small>任意</small></span>
                <textarea name="text" maxlength="800" placeholder="思い出した場所、人、気持ちなどを書けます。"></textarea>
              </label>
              <details class="prompt-details">
                <summary>追加で入力する <small>任意</small></summary>
                <div class="memory-prompts">
                  <label class="field"><span class="field-label">誰といたと思いますか</span><input name="guessPeople" maxlength="120" placeholder="例：友人、家族、ひとり" autocomplete="off"></label>
                  <label class="field"><span class="field-label">どこで撮ったと思いますか</span><input name="guessPlace" maxlength="120" placeholder="例：駅、公園、旅行先" autocomplete="off"></label>
                  <label class="field"><span class="field-label">どんな気持ちだったと思いますか</span><input name="guessFeeling" maxlength="120" placeholder="例：楽しい、安心した、寂しい" autocomplete="off"></label>
                </div>
              </details>
              <div class="button-row">
                <button class="button" type="submit" data-reflection="remembered" ${state.busy ? "disabled" : ""}>思い出したことを残す</button>
                <button class="button secondary" type="submit" data-reflection="could-not" ${state.busy ? "disabled" : ""}>まだ思い出せない</button>
              </div>
              <p class="form-note">「まだ思い出せない」を選んでも問題ありません。その日の記録として保存します。</p>
            </form>
          ` : `
            <div class="waiting-message" role="status">
              <span class="section-kicker">今日の記録を残しました</span>
              <h2>次は${formatDate(nextDisplayDate(memory))}から確認できます。</h2>
              <p>今日はここまでです。元の写真はまだ表示されません。</p>
            </div>
          `}
          ${timeline(reflections)}
        </div>
      </section>
    `);
  }

  function fragmentGrid(fragments, memory) {
    const aspect = Number(memory?.imageWidth) > 0 && Number(memory?.imageHeight) > 0
      ? Number(memory.imageWidth) / Number(memory.imageHeight)
      : 1;
    return `
      <div class="fragment-grid" style="aspect-ratio: ${aspect} / 1;" role="grid" aria-label="思い出のかけら。現在7個のうち${fragments.filter((fragment) => fragment.isUnlocked && !isHiddenUntilOriginal(memory, fragment)).length}個が見えています">
        ${fragments.map((fragment) => {
          const hidden = isHiddenUntilOriginal(memory, fragment);
          const visible = fragment.isUnlocked && !hidden;
          const url = visible ? getBlobUrl(fragment.imagePath) : "";
          const classes = ["fragment-cell", visible ? "preview" : "locked", hidden ? "reserved" : ""].filter(Boolean).join(" ");
          const label = visible
            ? `表示されている思い出のかけら ${fragment.index + 1}`
            : hidden
              ? "写真を見るまで表示しないかけら"
              : "まだ表示されていないかけら";
          return `<div class="${classes}" role="gridcell" aria-label="${label}">${url ? `<img src="${url}" alt="">` : ""}</div>`;
        }).join("")}
      </div>
    `;
  }

  function timeline(reflections) {
    if (!reflections.length) {
      return `
        <section class="timeline-section">
          <div class="section-head compact"><h2>残した記録</h2><span class="count-label">0件</span></div>
          <div class="empty compact"><p>入力した記録が、ここに時系列で表示されます。</p></div>
        </section>
      `;
    }
    return `
      <section class="timeline-section">
        <div class="section-head compact"><h2>残した記録</h2><span class="count-label">${reflections.length}件</span></div>
        <div class="reflection-list">
        ${reflections.map((reflection) => `
          <article class="timeline-item ${reflection.couldNotRemember ? "is-unremembered" : ""}">
            <header>
              <span class="timeline-type">${escapeHtml(reflection.reflectionType)}</span>
              <time datetime="${escapeHtml(reflection.createdAt || "")}">${formatDate(reflection.createdAt)}</time>
            </header>
            ${renderEmotionLabels(reflection)}
            <p>${reflection.couldNotRemember ? "まだ思い出せない、と記録しました。" : escapeHtml(reflection.text || "未入力の記録")}</p>
            ${renderPromptAnswers(reflection)}
          </article>
        `).join("")}
        </div>
      </section>
    `;
  }

  function renderChoice(memory, fragments, reflections) {
    return shell(`
      <section class="choice-stage">
        <header class="choice-header">
          <span class="eyebrow">写真を見るか選ぶ</span>
          <h1>元の写真を見ますか？</h1>
          <p>今見るか、あとでまた選ぶかを決められます。</p>
        </header>
        <div class="choice-layout">
          <div class="choice-fragments">
            ${fragmentGrid(fragments, memory)}
            <p>残り2つのかけらと元の写真は、まだ表示していません。</p>
          </div>
          <div class="choice-panel">
            <p class="choice-prompt">次のどれかを選んでください。</p>
          <div class="choice-options">
            <button class="choice-option primary" type="button" data-choice="viewed">
              <strong>写真を見る</strong>
              <span>元の写真を表示します。これまでの記録も見返せます。</span>
            </button>
            <button class="choice-option" type="button" data-choice="wait">
              <strong>あとでまた選ぶ</strong>
              <span>今は開かず、7日後にもう一度この画面で選びます。</span>
            </button>
            <button class="choice-option quiet" type="button" data-choice="keep">
              <strong>写真を見ないで残す</strong>
              <span>元の写真は表示せず、記録だけ残します。</span>
            </button>
          </div>
            <p class="choice-note">どれを選んでも写真は削除されません。「写真を見る」を選んだときだけ元の写真を表示します。</p>
          </div>
        </div>
      </section>
      ${timeline(reflections)}
    `);
  }
  function renderClosedMemory(memory, fragments, reflections) {
    const nextLabel = memory.status === "kept_closed" ? "必要になったとき" : formatDate(nextDisplayDate(memory));
    const placeholderText = memory.status === "kept_closed"
      ? "元の写真は表示していません。"
      : memory.status === "viewed_original"
        ? "次回表示日まで、元の写真は表示されません。"
      : "元の写真は、まだ表示しません。";
    const visibleFragmentCount = fragments.filter((fragment) => fragment.isUnlocked && !isHiddenUntilOriginal(memory, fragment)).length;
    const shouldShowFragments = ["not_yet", "kept_closed"].includes(memory.status) && visibleFragmentCount > 0;
    return shell(`
      <section class="page-panel closed-memory">
        <header class="page-header">
          <span class="eyebrow">${statusLabels[memory.status] || "眠っている思い出"}</span>
          <h1>${escapeHtml(memory.title || "名前のない思い出")}</h1>
          <p>${reunionMessage(memory)}</p>
        </header>
        ${shouldShowFragments ? `
          <div class="closed-fragments">
            <div class="section-head compact"><h2>ここまで表示した思い出のかけら</h2><span class="count-label">${visibleFragmentCount}/7</span></div>
            ${fragmentGrid(fragments, memory)}
          </div>
        ` : `<div class="placeholder closed-placeholder" role="img" aria-label="元の写真は表示されていません"><span>${placeholderText}</span></div>`}
        <dl class="detail-list">
          <div><dt>登録日</dt><dd>${formatDate(memory.createdAt)}</dd></div>
          <div><dt>${memory.status === "kept_closed" ? "見返すタイミング" : "次回表示日"}</dt><dd>${nextLabel}</dd></div>
          <div><dt>表示まで</dt><dd>${escapeHtml(reunionTimingLabel(memory))}</dd></div>
          <div><dt>選んだこと</dt><dd>${finalChoiceLabels[memory.finalChoice] || "未選択"}</dd></div>
        </dl>
        ${meaningForm(memory)}
      </section>
      ${timeline(reflections)}
    `);
  }

  function renderOriginal(memory, fragments, reflections) {
    const originalUrl = getBlobUrl(memory.originalImagePath);
    return shell(`
      <section class="reunion-stage">
        <div class="reunion-photo-column">
          <header class="page-header">
          <span class="eyebrow">元の写真を表示中</span>
            <h1>${escapeHtml(memory.title || "名前のない思い出")}</h1>
            <p>登録時のメモと、写真を見る前に書いた記録を確認できます。</p>
          </header>
          <div class="photo-preview-frame original-frame">
            ${originalUrl ? `<img class="preview-photo" src="${originalUrl}" alt="${escapeHtml(memory.title || "思い出")}の元の写真">` : `<div class="placeholder"><span>写真を読み込めませんでした。記録はそのまま保持されています。</span></div>`}
          </div>
          <dl class="detail-list original-details">
            <div><dt>一言メモ</dt><dd>${escapeHtml(memory.initialNote || "未記入")}</dd></div>
            <div><dt>当時の気持ち</dt><dd>${escapeHtml(memory.initialEmotion || "未記入")}</dd></div>
            <div><dt>一緒にいた人</dt><dd>${escapeHtml(memory.people || "未記入")}</dd></div>
            <div><dt>次回表示日</dt><dd>${formatDate(nextDisplayDate(memory))}</dd></div>
            <div><dt>表示まで</dt><dd>${escapeHtml(reunionTimingLabel(memory))}</dd></div>
          </dl>
        </div>
        <div class="reunion-reflection-column">
          ${reunionFeelingForm(memory)}
          ${meaningForm(memory)}
        </div>
      </section>
      ${timeline(reflections)}
    `);
  }

  function reunionFeelingForm(memory) {
    if (memory.status !== "viewed_original") return "";
    const emotions = ["懐かしい", "忘れていた", "また行きたい", "少し寂しい", "ほっとした", "まだ言葉にできない"];
    return `
      <form id="feelingForm" class="reflection-form feeling-form">
        <header class="form-header">
        <span class="section-kicker">写真を見た後</span>
          <h2>写真を見て、どんな気持ちになりましたか？</h2>
          <p>近いものをいくつでも選んでください。</p>
        </header>
        <fieldset>
          <legend class="visually-hidden">写真を見た後の気持ち</legend>
          <div class="emotion-options">
            ${emotions.map((emotion) => `
              <label class="emotion-option">
                <input type="checkbox" name="emotions" value="${emotion}">
                <span>${emotion}</span>
              </label>
            `).join("")}
          </div>
        </fieldset>
        <label class="field">
          <span class="field-label">今の気持ちを一言 <small>任意</small></span>
          <textarea name="text" maxlength="700" placeholder="写真を見る前と後で変わったことなどを書けます。"></textarea>
        </label>
        <button class="button soft" type="submit" ${state.busy ? "disabled" : ""}>気持ちを保存する</button>
      </form>
    `;
  }
  function meaningForm(memory) {
    const viewLabel = memory.status === "kept_closed" ? "写真を見ることにする" : "写真を見る";
    return `
      <form id="meaningForm" class="reflection-form meaning-form">
        <header class="form-header">
          <span class="section-kicker">今の記録</span>
          <h2>今、この写真について残したいことはありますか？</h2>
          <p>あとから何度でも追加できます。</p>
        </header>
        <label class="field">
          <span class="visually-hidden">今この写真について残したいこと</span>
          <textarea name="text" maxlength="900" placeholder="今感じていることや、あとで残しておきたいことを書けます。"></textarea>
        </label>
        <button class="button soft" type="submit" ${state.busy ? "disabled" : ""}>記録を追加する</button>
      </form>
      <div class="button-row decision-actions">
        ${["kept_closed", "not_yet"].includes(memory.status) ? `<button class="button" type="button" data-choice="viewed">${viewLabel}</button>` : ""}
        ${memory.status === "not_yet" && isAvailable(memory) ? `<button class="button secondary" type="button" data-action="resume-fragments">写真を見るか選ぶ</button>` : ""}
      </div>
    `;
  }

  function renderList() {
    const groups = [
      ["sleeping", "表示日を待っている", (memory) => memory.status === "sleeping" || (memory.status === "not_yet" && !isAvailable(memory))],
      ["fragmenting", "思い出のかけらを確認中", (memory) => memory.status === "fragmenting"],
      ["viewed_original", "写真を見た", (memory) => memory.status === "viewed_original"],
      ["not_yet", "まだ写真を見ていない", (memory) => memory.status === "not_yet"],
      ["kept_closed", "写真を見ないで残す", (memory) => memory.status === "kept_closed"]
    ];
    const hasMemories = state.memories.length > 0;
    return shell(`
      <section class="list-page">
        <header class="page-header list-header">
          <span class="eyebrow">思い出</span>
          <h1>保存した思い出</h1>
          <p>写真を開いていない思い出は、ここでも元の写真を表示しません。</p>
        </header>
        ${!hasMemories ? `
          <div class="empty empty-state">
            <h2>まだ登録した思い出はありません。</h2>
            <p>写真を登録すると、ここに一覧で表示されます。</p>
            <button class="button" type="button" data-route="capture">思い出を預ける</button>
          </div>
        ` : groups.map(([, label, filter]) => {
          const items = state.memories.filter(filter);
          return `
            <section class="memory-group">
              <div class="section-head"><h2>${label}</h2><span class="count-label">${items.length}件</span></div>
              ${items.length ? `<div class="grid">${items.map(memoryCard).join("")}</div>` : `<div class="empty compact"><p>該当する思い出はありません。</p></div>`}
            </section>
          `;
        }).join("")}
        <section class="account-security" aria-labelledby="account-security-title">
          <div>
            <h2 id="account-security-title">アカウント管理</h2>
            <p>アカウントを削除すると、クラウドとこの端末に保存された写真・記録を復元できなくなります。</p>
          </div>
          <button class="button danger-soft" type="button" data-action="delete-account">アカウントを削除</button>
        </section>
      </section>
    `);
  }

  async function startGoogleOAuth() {
    if (!supabaseClient || state.busy) return;
    state.busy = true;
    state.error = "";
    render();
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}${window.location.pathname}`
      }
    });
    if (error) {
      state.busy = false;
      state.error = "Googleログインを開始できませんでした。少し待ってから、もう一度お試しください。";
      render();
    }
  }

  async function logout() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    state.supabaseUser = null;
    await saveAuthSession(null);
    clearRuntimeData();
    state.route = "login";
    state.activeMemoryId = "";
    state.transientOriginalMemoryId = "";
    render();
    resetViewPosition();
  }

  async function deleteAccount() {
    if (!supabaseClient || !state.supabaseUser || state.busy) return;
    if (!confirm("アカウントと保存済みの写真・記録をすべて削除します。この操作は取り消せません。続けますか？")) return;
    state.busy = true;
    state.error = "";
    render();
    const { error } = await supabaseClient.functions.invoke("delete-account", {
      body: { confirmation: "DELETE_MY_ACCOUNT" }
    });
    if (error) {
      state.busy = false;
      state.error = "アカウント削除の完了を確認できませんでした。再ログインできる場合は、時間をおいてもう一度お試しください。";
      render();
      return;
    }
    for (const storeName of ["memories", "fragments", "reflections", "images", "settings"]) await clearStore(storeName);
    state.supabaseUser = null;
    state.settings.authSession = null;
    clearRuntimeData();
    state.route = "login";
    state.busy = false;
    render();
    resetViewPosition();
  }

  function render() {
    if (!app) return;
    app.setAttribute("aria-busy", state.busy ? "true" : "false");
    if (!isSignedIn()) app.innerHTML = renderLogin();
    else if (state.route === "login") {
      state.route = "home";
      app.innerHTML = renderHome();
    } else if (state.route === "capture") app.innerHTML = renderCapture();
    else if (state.route === "form") app.innerHTML = renderMemoryForm();
    else if (state.route === "memory") app.innerHTML = renderMemory(state.activeMemoryId);
    else if (state.route === "list") app.innerHTML = renderList();
    else app.innerHTML = renderHome();
  }

  async function refresh() {
    await loadData();
    render();
    attachCameraStream();
  }

  function attachCameraStream() {
    const video = document.querySelector("#cameraPreview");
    if (!video || !state.cameraStream) return;
    if (video.srcObject !== state.cameraStream) video.srcObject = state.cameraStream;
    video.play().catch(() => {
      state.cameraError = "カメラのプレビューを開始できませんでした。端末やブラウザのカメラ許可を確認してください。";
    });
  }

  function stopCamera(options = {}) {
    if (state.cameraStream) {
      for (const track of state.cameraStream.getTracks()) track.stop();
    }
    state.cameraStream = null;
    state.cameraActive = false;
    if (!options.keepError) state.cameraError = "";
  }

  function triggerFileInput(selector) {
    const input = document.querySelector(selector);
    if (!input) return false;
    input.value = "";
    input.click();
    return true;
  }

  async function startCamera() {
    state.error = "";
    state.cameraError = "";
    if (!navigator.mediaDevices?.getUserMedia) {
      state.cameraError = "このブラウザでは直接カメラを起動できません。写真選択から続けてください。";
      render();
      triggerFileInput("#cameraInput");
      return;
    }
    try {
      stopCamera({ keepError: true });
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false
      });
      state.cameraStream = stream;
      state.cameraActive = true;
      state.cameraError = "";
      render();
      attachCameraStream();
    } catch (error) {
      stopCamera({ keepError: true });
      state.cameraError = "カメラを起動できませんでした。権限が拒否された場合はブラウザ設定を確認するか、写真から選んでください。";
      render();
      triggerFileInput("#cameraInput");
    }
  }

  async function captureCameraPhoto() {
    const video = document.querySelector("#cameraPreview");
    if (!video || !state.cameraStream || !video.videoWidth || !video.videoHeight) {
      state.cameraError = "カメラ映像をまだ取得できていません。少し待ってからもう一度撮影してください。";
      render();
      attachCameraStream();
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
    const file = new File([blob], `rememory-camera-${Date.now()}.jpg`, { type: "image/jpeg" });
    stopCamera();
    await handleFile(file);
  }

  function resetViewPosition() {
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      document.querySelector("#main-content")?.focus({ preventScroll: true });
    });
  }

  function setRoute(route) {
    state.error = "";
    state.route = route;
    if (route !== "memory") state.transientOriginalMemoryId = "";
    render();
    resetViewPosition();
  }

  async function handleFile(file) {
    if (!file) return;
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      state.error = "JPEG、PNG、WebP形式の画像を選んでください。";
      render();
      return;
    }
    if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
      state.error = "画像は15MB以下のファイルを選んでください。";
      render();
      return;
    }
    let bitmap;
    try {
      bitmap = await createBitmap(file);
      const width = Number(bitmap.width || bitmap.naturalWidth || 0);
      const height = Number(bitmap.height || bitmap.naturalHeight || 0);
      if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
        state.error = "画像の縦横サイズが大きすぎます。40メガピクセル以下の画像を選んでください。";
        render();
        return;
      }
    } catch (_error) {
      state.error = "画像の内容を確認できませんでした。別の画像を選んでください。";
      render();
      return;
    } finally {
      if (bitmap && typeof bitmap.close === "function") bitmap.close();
    }
    if (state.selectedPreviewUrl) URL.revokeObjectURL(state.selectedPreviewUrl);
    state.selectedFile = file;
    state.selectedPreviewUrl = URL.createObjectURL(file);
    state.error = "";
    state.route = "capture";
    render();
    resetViewPosition();
  }

  async function handleMemorySubmit(form) {
    if (!state.selectedFile || state.busy) return;
    state.busy = true;
    state.error = "";
    render();
    try {
      const formData = new FormData(form);
      const memoryId = id("memory");
      const originalPath = `indexeddb://images/${memoryId}/original.jpg`;
      const splitResult = await splitImage(memoryId, state.selectedFile);
      await saveImage(originalPath, splitResult.originalBlob);
      const fragments = splitResult.fragments;
      const timingInput = {
        title: String(formData.get("title") || "").trim(),
        initialNote: String(formData.get("initialNote") || "").trim(),
        initialEmotion: String(formData.get("initialEmotion") || "").trim(),
        people: String(formData.get("people") || "").trim()
      };
      const delayValue = String(formData.get("delayDays") || "ai");
      const aiTiming = delayValue === "ai" ? recommendReunionTiming(timingInput, fragments) : null;
      const firstAvailableDays = aiTiming ? aiTiming.days : Math.max(1, Number(delayValue || 1));
      const firstAvailableAt = addAppDaysAtStart(firstAvailableDays);
      const memory = {
        id: memoryId,
        title: timingInput.title,
        originalImagePath: originalPath,
        imageWidth: splitResult.width,
        imageHeight: splitResult.height,
        createdAt: realNowIso(),
        createdLocalDate: localDateKey(),
        reunionTimingMode: aiTiming ? "ai" : "manual",
        aiRecommendedDelayDays: aiTiming?.days || null,
        aiRecommendationScore: aiTiming ? Number(aiTiming.score.toFixed(3)) : null,
        aiRecommendationReasons: aiTiming?.reasons || [],
        selectedDelayDays: firstAvailableDays,
        revisitIntervalDays: firstAvailableDays,
        availableAt: firstAvailableAt,
        nextAvailableDate: firstAvailableAt,
        currentStage: 1,
        lastReflectedDate: null,
        hiddenFragmentIndexes: splitResult.hiddenFragmentIndexes || chooseHiddenFragmentIndexes(),
        displayOrder: splitResult.displayOrder || [],
        imageAnalysisStatus: splitResult.fragments.some((fragment) => fragment.analysisStatus === "completed") ? "completed" : "fallback",
        imageAnalysisVersion: ANALYSIS_VERSION,
        previewFragmentCount: 0,
        status: "sleeping",
        initialNote: timingInput.initialNote,
        initialEmotion: timingInput.initialEmotion,
        people: timingInput.people,
        hasViewedOriginal: false,
        finalChoice: ""
      };
      await saveMemory(memory);
      for (const fragment of fragments) await saveFragment(fragment);
      state.selectedFile = null;
      if (state.selectedPreviewUrl) URL.revokeObjectURL(state.selectedPreviewUrl);
      state.selectedPreviewUrl = "";
      state.activeMemoryId = memoryId;
      state.route = "memory";
      state.busy = false;
      await refresh();
      resetViewPosition();
    } catch (error) {
      reportError("memory-save", error, "写真を登録できませんでした。写真は削除されていません。少し待ってからもう一度お試しください。");
      state.busy = false;
      render();
    }
  }

  async function handleReflection(form, submitter) {
    if (!state.activeMemoryId || state.busy) return;
    const memory = state.memories.find((item) => item.id === state.activeMemoryId);
    if (!memory || !canReflectToday(memory)) return;
    state.busy = true;
    const formData = new FormData(form);
    const text = String(formData.get("text") || "").trim();
    const couldNotRemember = submitter?.dataset.reflection === "could-not";
    const promptAnswers = {
      people: String(formData.get("guessPeople") || "").trim(),
      place: String(formData.get("guessPlace") || "").trim(),
      feeling: String(formData.get("guessFeeling") || "").trim()
    };
    try {
      const unlockedCount = sortedFragments(state.activeMemoryId).filter((fragment) => fragment.isUnlocked).length;
      const reflectedStage = Number(memory.currentStage || 1);
      await saveReflection({
        id: id("reflection"),
        memoryId: state.activeMemoryId,
        fragmentStage: reflectedStage,
        text,
        promptAnswers,
        couldNotRemember,
        createdAt: realNowIso(),
        localDate: localDateKey(),
        reflectionType: couldNotRemember ? "まだ思い出せない" : "思い出したこと"
      });
      memory.lastReflectedDate = localDateKey();
      memory.currentStage = Math.min(5, reflectedStage + 1);
      memory.nextAvailableDate = addAppDaysAtStart(1);
      await saveMemory(memory);
      state.busy = false;
      await refresh();
    } catch (error) {
      reportError("reflection-save", error, "今日の記録を保存できませんでした。入力内容を確認して、もう一度お試しください。");
      state.busy = false;
      render();
    }
  }

  async function markOriginalViewed(memory) {
    memory.status = "viewed_original";
    memory.hasViewedOriginal = true;
    memory.finalChoice = "viewed";
    memory.lastViewedAt = realNowIso();
    memory.lastViewedLocalDate = localDateKey();
    memory.nextAvailableDate = addAppDaysAtStart(Math.max(1, Number(memory.revisitIntervalDays || memory.selectedDelayDays || 30)));
    await saveMemory(memory);
    state.transientOriginalMemoryId = memory.id;
  }

  async function handleChoice(choice) {
    const memory = state.memories.find((item) => item.id === state.activeMemoryId);
    if (!memory || state.busy) return;
    state.busy = true;
    try {
      if (choice === "viewed") {
        memory.status = "viewed_original";
        memory.hasViewedOriginal = true;
        memory.finalChoice = "viewed";
        const fragments = sortedFragments(memory.id);
        for (const fragment of fragments) {
          if (!fragment.isUnlocked) {
            fragment.isUnlocked = true;
            fragment.unlockedAt = appNowIso();
            await saveFragment(fragment);
          }
        }
        memory.previewFragmentCount = 9;
        await markOriginalViewed(memory);
      } else if (choice === "wait") {
        memory.status = "not_yet";
        memory.hasViewedOriginal = false;
        memory.finalChoice = "wait";
        memory.currentStage = 5;
        memory.previewFragmentCount = Math.min(memory.previewFragmentCount || 7, 7);
        memory.availableAt = addAppDaysAtStart(7);
        memory.nextAvailableDate = memory.availableAt;
      } else if (choice === "keep") {
        memory.status = "kept_closed";
        memory.hasViewedOriginal = false;
        memory.finalChoice = "keep";
        memory.currentStage = 5;
        memory.previewFragmentCount = Math.min(memory.previewFragmentCount || 7, 7);
        memory.nextAvailableDate = "";
      }
      await saveMemory(memory);
      await saveReflection({
        id: id("reflection"),
        memoryId: memory.id,
        fragmentStage: sortedFragments(memory.id).filter((fragment) => fragment.isUnlocked).length,
        text: finalChoiceLabels[choice] || "",
        couldNotRemember: false,
        createdAt: realNowIso(),
        localDate: localDateKey(),
        reflectionType: "写真を見るか選んだ結果"
      });
      state.busy = false;
      await refresh();
    } catch (error) {
      reportError("choice-save", error, "選んだ内容を残せませんでした。写真はまだ表示されていません。もう一度お試しください。");
      state.busy = false;
      render();
    }
  }

  async function resumeFragments() {
    const memory = state.memories.find((item) => item.id === state.activeMemoryId);
    if (!memory || state.busy || memory.status !== "not_yet" || !isAvailable(memory)) return;
    state.busy = true;
    try {
      memory.status = "fragmenting";
      await saveMemory(memory);
      await unlockFragmentsForStage(memory);
      await saveReflection({
        id: id("reflection"),
        memoryId: memory.id,
        fragmentStage: sortedFragments(memory.id).filter((fragment) => fragment.isUnlocked).length,
        text: "写真を見るかどうかをもう一度選ぶ",
        couldNotRemember: false,
        createdAt: realNowIso(),
        localDate: localDateKey(),
        reflectionType: "もう一度選ぶ"
      });
      state.busy = false;
      await refresh();
    } catch (error) {
      reportError("fragment-resume", error, "もう一度選ぶ画面を開けませんでした。少し待ってから、もう一度お試しください。");
      state.busy = false;
      render();
    }
  }

  async function handleFeeling(form) {
    if (!state.activeMemoryId || state.busy) return;
    const formData = new FormData(form);
    const emotions = formData.getAll("emotions").map(String).filter(Boolean);
    const text = String(formData.get("text") || "").trim();
    if (!emotions.length && !text) return;
    state.busy = true;
    try {
      await saveReflection({
        id: id("reflection"),
        memoryId: state.activeMemoryId,
        fragmentStage: sortedFragments(state.activeMemoryId).filter((fragment) => fragment.isUnlocked).length,
        text,
        emotions,
        couldNotRemember: false,
        createdAt: realNowIso(),
        localDate: localDateKey(),
        reflectionType: "写真を見た後の気持ち"
      });
      state.busy = false;
      await refresh();
    } catch (error) {
      reportError("feeling-save", error, "気持ちを保存できませんでした。もう一度お試しください。");
      state.busy = false;
      render();
    }
  }
  async function handleMeaning(form) {
    const text = String(new FormData(form).get("text") || "").trim();
    if (!state.activeMemoryId || !text || state.busy) return;
    state.busy = true;
    try {
      await saveReflection({
        id: id("reflection"),
        memoryId: state.activeMemoryId,
        fragmentStage: sortedFragments(state.activeMemoryId).filter((fragment) => fragment.isUnlocked).length,
        text,
        couldNotRemember: false,
        createdAt: realNowIso(),
        localDate: localDateKey(),
        reflectionType: "追加した記録"
      });
      state.busy = false;
      await refresh();
    } catch (error) {
      reportError("meaning-save", error, "記録を追加できませんでした。もう一度お試しください。");
      state.busy = false;
      render();
    }
  }

  app.addEventListener("click", async (event) => {
    const routeButton = event.target.closest("[data-route]");
    if (routeButton) {
      setRoute(routeButton.dataset.route);
      return;
    }
    const openButton = event.target.closest("[data-open-memory], [data-route-memory]");
    if (openButton) {
      state.activeMemoryId = openButton.dataset.openMemory || openButton.dataset.routeMemory;
      state.transientOriginalMemoryId = "";
      const memory = state.memories.find((item) => item.id === state.activeMemoryId);
      if (memory?.status === "viewed_original" && isAvailable(memory)) {
        await markOriginalViewed(memory);
      }
      state.route = "memory";
      state.error = "";
      await refresh();
      resetViewPosition();
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "start-camera") {
      await startCamera();
      return;
    }
    if (action === "open-library") {
      triggerFileInput("#libraryInput");
      return;
    }
    if (action === "capture-camera-photo") {
      await captureCameraPhoto();
      return;
    }
    if (action === "stop-camera") {
      stopCamera();
      render();
      return;
    }
    if (action === "logout") {
      await logout();
      return;
    }
    if (action === "google-oauth") {
      await startGoogleOAuth();
      return;
    }
    if (action === "delete-account") {
      await deleteAccount();
      return;
    }
    if (action === "retake") {
      stopCamera();
      state.selectedFile = null;
      if (state.selectedPreviewUrl) URL.revokeObjectURL(state.selectedPreviewUrl);
      state.selectedPreviewUrl = "";
      render();
      return;
    }
    if (action === "show-form") {
      setRoute("form");
      return;
    }
    if (action === "resume-fragments") {
      await resumeFragments();
      return;
    }
    const choice = event.target.closest("[data-choice]")?.dataset.choice;
    if (choice) await handleChoice(choice);
  });

  app.addEventListener("change", (event) => {
    if (event.target.matches("#cameraInput, #libraryInput")) {
      handleFile(event.target.files?.[0]).catch((error) => {
        reportError("image-load", error, "写真を読み込めませんでした。別の写真を選んで、もう一度お試しください。");
        render();
      });
    }
  });

  app.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.target.id === "memoryForm") await handleMemorySubmit(event.target);
    if (event.target.id === "reflectionForm") await handleReflection(event.target, event.submitter);
    if (event.target.id === "feelingForm") await handleFeeling(event.target);
    if (event.target.id === "meaningForm") await handleMeaning(event.target);
  });

  app.innerHTML = `<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><p>保存したデータを読み込んでいます。</p></div>`;
  initializeSupabaseAuth()
    .then(refresh)
    .catch((error) => {
      reportError("startup", error, "保存したデータを読み込めませんでした。ページを読み込み直して、もう一度お試しください。");
      render();
    });
})();







































