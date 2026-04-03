import { createDeepgramRealtimeClient } from "./deepgramAdapter.js";

const DEMO_TIME_SCALE = 10;
const DOMINANCE_RATIO = 0.4;
const DOMINANCE_WINDOW_MS = (5 * 60 * 1000) / DEMO_TIME_SCALE;
const SILENCE_WINDOW_MS = (10 * 60 * 1000) / DEMO_TIME_SCALE;
const MAX_FEED_ITEMS = 40;
const ACTIVE_SPEAKER_HOLD_MS = 2200;
const DEEPGRAM_TOKEN_ENDPOINT = "/api/deepgram/token";
const DEEPGRAM_PRERECORDED_ENDPOINT = "/api/deepgram/prerecorded";
const SHORT_UTTERANCE_MS = 900;
const SHORT_UTTERANCE_WORDS = 2;
const LOW_SPEAKER_CONFIDENCE = 0.6;
const UNKNOWN_ADOPTION_GAP_MS = 1200;
const SPEAKER_SWITCH_CONFIRM_WINDOW_MS = 1500;
const SPEAKER_HISTORY_SIZE = 6;
const UNKNOWN_REVIEW_DELAY_MS = 4000;
const UNKNOWN_LINK_GAP_MS = 1800;
const UNKNOWN_NEW_SPEAKER_DELAY_MS = 9000;
const UNKNOWN_NEW_SPEAKER_MIN_DURATION_MS = 1400;
const UNKNOWN_NEW_SPEAKER_MIN_WORDS = 3;
const DB_NAME = "meetingreferee-db";
const DB_VERSION = 1;
const TEST_SOURCE_STORE = "testSources";

const NOTIFICATION_TITLES = {
  alert: "🚨 독점 경고",
  warn: "⚠️ 주의",
  interrupt: "🗣️ 끼어들기",
};

const SPEAKER_COLORS = [
  "#60a5fa",
  "#34d399",
  "#f59e0b",
  "#f472b6",
  "#a78bfa",
  "#22d3ee",
  "#fb7185",
  "#4ade80",
  "#fbbf24",
  "#818cf8",
];

const INTERRUPTION_OVERLAP_MS = 200;

const state = {
  meeting: null,
  speakerStats: new Map(),
  utterances: [],
  events: [],
  warnings: [],
  stream: null,
  activeSpeakerId: null,
  meetingElapsedSec: 0,
  elapsedTimer: null,
  activeSpeakerTimer: null,
  liveTranscript: "",
  streamMode: "none",
  topicCounts: new Map(),
  isPaused: false,
  lastFinalUtterance: null,
  lastObservedFinalUtterance: null,
  recentFinalUtterances: [],
  testMode: false,
  testSourceId: null,
  testAudioBlob: null,
  testAudioUrl: "",
  testAudioName: "",
  diagnostics: {
    inputMode: "-",
    audioChunkCount: 0,
    deepgramMessageCount: 0,
    lastRms: 0,
    lastDeepgramMessageAt: null,
  },
};

const el = {
  dashboardTitle: document.getElementById("dashboard-title"),
  status: document.getElementById("connection-status"),
  speakerStats: document.getElementById("speaker-stats"),
  utteranceFeed: document.getElementById("utterance-feed"),
  ratioFeed: document.getElementById("ratio-feed"),
  balanceScore: document.getElementById("balance-score"),
  sentimentSummary: document.getElementById("sentiment-summary"),

  activeSpeakerBadge: document.getElementById("active-speaker-badge"),
  liveTranscript: document.getElementById("live-transcript"),
  elapsed: document.getElementById("meeting-elapsed"),
  pauseBtn: document.getElementById("pause-meeting"),
  dotLive: document.querySelector(".dot-live"),
  testSourcePanel: document.getElementById("test-source-panel"),
  testAudioPlayer: document.getElementById("test-audio-player"),
  testAudioMeta: document.getElementById("test-audio-meta"),
  diagnosticPanel: document.getElementById("diagnostic-panel"),
  diagInputMode: document.getElementById("diag-input-mode"),
  diagAudioLevel: document.getElementById("diag-audio-level"),
  diagAudioFlow: document.getElementById("diag-audio-flow"),
  diagDeepgramFlow: document.getElementById("diag-deepgram-flow"),
};

document.getElementById("end-meeting").addEventListener("click", endMeeting);
document.getElementById("pause-meeting").addEventListener("click", togglePause);

// ─── 초기화 ───────────────────────────────────────────────────────────────────

const config = JSON.parse(sessionStorage.getItem("meetingConfig") || "null");
if (!config) {
  window.location.replace("/");
} else {
  startMeeting(config).catch((error) => {
    setStatus(`회의 시작 실패: ${error.message}`);
  });
}

// ─── 회의 시작 ────────────────────────────────────────────────────────────────

function parseParticipants(count) {
  return Array.from({ length: count }, (_, i) => `참여자 ${i + 1}`);
}

function createSpeakerStats(participants) {
  return new Map(
    participants.map((name, idx) => [
      `speaker_${idx + 1}`,
      {
        speakerId: `speaker_${idx + 1}`,
        name,
        talkTimeMs: 0,
        talkRatio: 0,
        turnCount: 0,
        lastSpokeAt: null,
        dominanceSince: null,
        sentimentCounts: { positive: 0, neutral: 0, negative: 0 },
        sentimentScoreSum: 0,
        interruptionCount: 0,
      },
    ])
  );
}

function buildSpeakerName(speakerId) {
  const index = Number(String(speakerId).replace("speaker_", ""));
  return Number.isFinite(index) && index > 0 ? `Participant ${index}` : "Participant";
}

function ensureSpeakerRegistered(speakerId) {
  if (!speakerId || !speakerId.startsWith("speaker_")) return false;
  if (state.speakerStats.has(speakerId)) return true;

  state.speakerStats.set(speakerId, {
    speakerId,
    name: buildSpeakerName(speakerId),
    talkTimeMs: 0,
    talkRatio: 0,
    turnCount: 0,
    lastSpokeAt: null,
    dominanceSince: null,
    sentimentCounts: { positive: 0, neutral: 0, negative: 0 },
    sentimentScoreSum: 0,
    interruptionCount: 0,
  });

  if (state.meeting && !state.meeting.participants.includes(speakerId)) {
    state.meeting.participants.push(buildSpeakerName(speakerId));
  }

  return true;
}

function getNextSpeakerId() {
  const maxIndex = [...state.speakerStats.keys()]
    .map((speakerId) => Number(String(speakerId).replace("speaker_", "")))
    .filter((index) => Number.isFinite(index))
    .reduce((max, index) => Math.max(max, index), 0);

  return `speaker_${maxIndex + 1}`;
}

async function startMeeting({ title, participantCount, testMode = false, testSourceId = null }) {
  if ("Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission();
  }

  const participants = parseParticipants(participantCount);

  state.meeting = {
    id: String(Date.now()),
    title,
    participants,
    startAt: Date.now(),
  };
  state.testMode = Boolean(testMode);
  state.testSourceId = String(testSourceId || "");
  state.speakerStats = createSpeakerStats(participants);

  if (state.testMode) {
    await loadTestAudioSource(state.testSourceId);
  }

  setupTestSourcePanel();
  el.dashboardTitle.textContent = `${title} - 실시간 모니터링`;
  renderAll();
  startElapsedTimer();

  if (state.testMode) {
    updateDiagnostics({
      inputMode: "prerecorded_file",
      audioChunkCount: 0,
      deepgramMessageCount: 0,
      lastRms: 0,
      lastDeepgramMessageAt: null,
    });
    await analyzeTestAudioWithPrerecorded();
    return;
  }

  const realtimeClient = createDeepgramRealtimeClient({
    inputMode: "microphone",
    audioElement: null,
    getAuthCredential: fetchDeepgramAuthCredential,
    onUtterance: handleUtterance,
    onStatus: setStatus,
    onDiagnostics: updateDiagnostics,
    onError: (error) => {
      setStatus(`Deepgram 오류: ${error.message}`);
    },
  });

  try {
    state.stream = realtimeClient;
    await state.stream.connect();
    state.streamMode = "deepgram";
    setStatus("Deepgram 실시간 분석 모드 활성화");
  } catch (error) {
    setStatus(`Deepgram 연동 실패: ${error.message}`);
    state.stream?.disconnect();
    state.stream = null;
  }
}

async function fetchDeepgramAuthCredential() {
  const res = await fetch(DEEPGRAM_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ttl_seconds: 300 }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.message || payload?.detail?.error || `HTTP ${res.status}`;
    throw new Error(`토큰 발급 실패 (${detail})`);
  }

  if (!payload.access_token) {
    throw new Error("토큰 응답 형식이 올바르지 않습니다.");
  }

  if (payload.auth_type === "api_key") {
    setStatus("임시 토큰 권한 부족: 브라우저 API key 인증으로 연결합니다.");
    return { type: "api_key", value: payload.access_token };
  }

  return { type: "token", value: payload.access_token };
}

// ─── 타이머 ───────────────────────────────────────────────────────────────────

function startElapsedTimer() {
  state.elapsedTimer = window.setInterval(() => {
    state.meetingElapsedSec += 1;
    reviewUnknownUtterances();
    renderElapsed();
    detectSilence();
    renderSpeakerStats();
  }, 1000);
}

function clearTimers() {
  if (state.elapsedTimer) {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }
  if (state.activeSpeakerTimer) {
    clearTimeout(state.activeSpeakerTimer);
    state.activeSpeakerTimer = null;
  }
}

// ─── 발화 처리 ────────────────────────────────────────────────────────────────

function handleUtterance(utterance) {
  if (utterance.is_final) {
    stabilizeFinalUtterance(utterance);
    state.lastObservedFinalUtterance = utterance;
  }

  if (utterance.speaker_id) {
    ensureSpeakerRegistered(utterance.speaker_id);
  }

  const speakerId = utterance.speaker_id;
  const hasKnownSpeaker = Boolean(speakerId && state.speakerStats.has(speakerId));

  if (!utterance.is_final) {
    state.activeSpeakerId = hasKnownSpeaker ? speakerId : null;
    state.liveTranscript = hasKnownSpeaker ? utterance.transcript : `[화자 미확정] ${utterance.transcript}`;
    renderActiveSpeaker();
    renderLiveTranscript();
    renderSpeakerStats();
    return;
  }

  utterance.speaker_id = hasKnownSpeaker ? speakerId : "unknown";
  utterance.speaker_resolution_status = utterance.speaker_id === "unknown" ? "pending" : "resolved";
  utterance.speaker_resolution_due_at =
    utterance.speaker_id === "unknown" ? utterance.created_at + UNKNOWN_REVIEW_DELAY_MS : null;
  state.utterances.unshift(utterance);
  if (state.utterances.length > MAX_FEED_ITEMS) state.utterances.length = MAX_FEED_ITEMS;

  if (!hasKnownSpeaker) {
    state.liveTranscript = "";
    renderAll();
    return;
  }

  state.activeSpeakerId = speakerId;
  state.liveTranscript = "";
  if (state.activeSpeakerTimer) clearTimeout(state.activeSpeakerTimer);
  state.activeSpeakerTimer = window.setTimeout(() => {
    state.activeSpeakerId = null;
    state.liveTranscript = "";
    renderSpeakerStats();
    renderActiveSpeaker();
    renderLiveTranscript();
  }, ACTIVE_SPEAKER_HOLD_MS);

  state.lastFinalUtterance = utterance;
  state.recentFinalUtterances.unshift(utterance);
  if (state.recentFinalUtterances.length > SPEAKER_HISTORY_SIZE) {
    state.recentFinalUtterances.length = SPEAKER_HISTORY_SIZE;
  }

  rebuildDerivedState();
  detectSilence();
  renderAll();
}

function stabilizeFinalUtterance(utterance) {
  const previous = state.lastObservedFinalUtterance;
  const originalSpeakerId = utterance.speaker_id;
  const confidence = utterance.speaker_confidence ?? 0;
  const wordCount = utterance.speaker_word_count ?? countTranscriptWords(utterance.transcript);
  const isShortUtterance = utterance.duration <= SHORT_UTTERANCE_MS || wordCount <= SHORT_UTTERANCE_WORDS;
  const isLowConfidence = confidence <= 0 || confidence < LOW_SPEAKER_CONFIDENCE;
  const gapFromPrevious = previous ? utterance.start_time - previous.end_time : Number.POSITIVE_INFINITY;

  utterance.original_speaker_id = originalSpeakerId;

  if (originalSpeakerId) {
    ensureSpeakerRegistered(originalSpeakerId);
  }

  if (!previous || !state.speakerStats.has(previous.speaker_id)) {
    return;
  }

  if (!originalSpeakerId) {
    if (isShortUtterance && gapFromPrevious <= UNKNOWN_ADOPTION_GAP_MS) {
      utterance.speaker_id = previous.speaker_id;
      utterance.speaker_stabilized = true;
      utterance.speaker_stabilization_reason = "adopt_previous_for_unknown";
    }
    return;
  }

  if (!state.speakerStats.has(originalSpeakerId)) {
    return;
  }

  if (originalSpeakerId === previous.speaker_id) {
    return;
  }

  const consensusSpeakerId = getRecentSpeakerConsensus();
  const shouldHoldPreviousSpeaker =
    gapFromPrevious <= SPEAKER_SWITCH_CONFIRM_WINDOW_MS &&
    (isLowConfidence || (isShortUtterance && consensusSpeakerId && consensusSpeakerId === previous.speaker_id));

  if (shouldHoldPreviousSpeaker) {
    utterance.speaker_id = previous.speaker_id;
    utterance.speaker_stabilized = true;
    utterance.speaker_stabilization_reason = "hold_previous_speaker";
  }
}

function getRecentSpeakerConsensus() {
  const recentKnownSpeakers = state.recentFinalUtterances
    .map((utterance) => utterance.original_speaker_id || utterance.speaker_id)
    .filter((speakerId) => state.speakerStats.has(speakerId))
    .slice(0, 3);

  if (recentKnownSpeakers.length < 2) return null;
  if (new Set(recentKnownSpeakers).size !== 1) return null;
  return recentKnownSpeakers[0];
}

function countTranscriptWords(transcript) {
  return String(transcript)
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function reviewUnknownUtterances() {
  const now = Date.now();
  let hasChanges = false;

  state.utterances.forEach((utterance) => {
    if (!utterance.is_final) return;
    if (utterance.speaker_id !== "unknown") return;
    if (utterance.speaker_resolution_status === "resolved") return;
    if ((utterance.speaker_resolution_due_at ?? 0) > now) return;

    const resolvedSpeakerId = resolveUnknownUtterance(utterance, now);
    if (!resolvedSpeakerId) return;

    utterance.speaker_id = resolvedSpeakerId;
    utterance.speaker_resolution_status = "resolved";
    utterance.speaker_resolved_at = now;
    utterance.speaker_stabilized = true;
    utterance.speaker_stabilization_reason = "deferred_unknown_resolution";
    hasChanges = true;
  });

  if (hasChanges) {
    rebuildDerivedState();
  }
}

function resolveUnknownUtterance(targetUtterance, now) {
  const previous = findAdjacentKnownUtterance(targetUtterance, "previous");
  const next = findAdjacentKnownUtterance(targetUtterance, "next");

  if (previous && next && previous.speaker_id === next.speaker_id) {
    const prevGap = targetUtterance.start_time - previous.end_time;
    const nextGap = next.start_time - targetUtterance.end_time;
    if (prevGap <= UNKNOWN_LINK_GAP_MS && nextGap <= UNKNOWN_LINK_GAP_MS) {
      return previous.speaker_id;
    }
  }

  const wordCount = targetUtterance.speaker_word_count ?? countTranscriptWords(targetUtterance.transcript);
  const isShortUtterance = targetUtterance.duration <= SHORT_UTTERANCE_MS || wordCount <= SHORT_UTTERANCE_WORDS;

  if (previous && isShortUtterance) {
    const prevGap = targetUtterance.start_time - previous.end_time;
    if (prevGap <= UNKNOWN_LINK_GAP_MS) {
      return previous.speaker_id;
    }
  }

  if (next && isShortUtterance) {
    const nextGap = next.start_time - targetUtterance.end_time;
    if (nextGap <= UNKNOWN_LINK_GAP_MS) {
      return next.speaker_id;
    }
  }

  const longEnoughForNewSpeaker =
    now - targetUtterance.created_at >= UNKNOWN_NEW_SPEAKER_DELAY_MS &&
    targetUtterance.duration >= UNKNOWN_NEW_SPEAKER_MIN_DURATION_MS &&
    wordCount >= UNKNOWN_NEW_SPEAKER_MIN_WORDS &&
    shouldCreateSpeakerFromUnknown(targetUtterance);

  if (longEnoughForNewSpeaker) {
    const newSpeakerId = getNextSpeakerId();
    ensureSpeakerRegistered(newSpeakerId);
    return newSpeakerId;
  }

  return null;
}

function findAdjacentKnownUtterance(targetUtterance, direction) {
  const knownUtterances = state.utterances.filter(
    (utterance) =>
      utterance !== targetUtterance &&
      utterance.is_final &&
      utterance.speaker_id &&
      utterance.speaker_id !== "unknown" &&
      state.speakerStats.has(utterance.speaker_id),
  );

  if (direction === "previous") {
    return knownUtterances
      .filter((utterance) => utterance.end_time <= targetUtterance.start_time)
      .sort((a, b) => b.end_time - a.end_time)[0] ?? null;
  }

  return knownUtterances
    .filter((utterance) => utterance.start_time >= targetUtterance.end_time)
    .sort((a, b) => a.start_time - b.start_time)[0] ?? null;
}

function shouldCreateSpeakerFromUnknown(targetUtterance) {
  const nearbyKnownSpeakers = state.utterances
    .filter(
      (utterance) =>
        utterance !== targetUtterance &&
        utterance.is_final &&
        utterance.speaker_id &&
        utterance.speaker_id !== "unknown" &&
        state.speakerStats.has(utterance.speaker_id),
    )
    .filter((utterance) => Math.abs(utterance.created_at - targetUtterance.created_at) <= UNKNOWN_NEW_SPEAKER_DELAY_MS)
    .map((utterance) => utterance.speaker_id);

  return new Set(nearbyKnownSpeakers).size >= 2;
}

function rebuildDerivedState() {
  resetSpeakerStats();
  state.events = [];
  state.warnings = [];
  state.lastFinalUtterance = null;

  const finalUtterances = [...state.utterances]
    .filter((utterance) => utterance.is_final && utterance.speaker_id && utterance.speaker_id !== "unknown")
    .sort((a, b) => a.created_at - b.created_at);

  finalUtterances.forEach((utterance) => {
    applyUtteranceStatsOnly(utterance);
    detectInterruption(utterance);
    state.lastFinalUtterance = utterance;
    detectInefficientPattern(utterance);
    detectDominance();
  });
}

function resetSpeakerStats() {
  state.speakerStats.forEach((stat) => {
    stat.talkTimeMs = 0;
    stat.talkRatio = 0;
    stat.turnCount = 0;
    stat.lastSpokeAt = null;
    stat.dominanceSince = null;
    stat.sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
    stat.sentimentScoreSum = 0;
    stat.interruptionCount = 0;
  });
}

function applyUtteranceStatsOnly(utterance) {
  ensureSpeakerRegistered(utterance.speaker_id);

  const stat = state.speakerStats.get(utterance.speaker_id);
  if (!stat) return;

  stat.talkTimeMs += utterance.duration;
  stat.turnCount += 1;
  stat.lastSpokeAt = stat.lastSpokeAt ? Math.max(stat.lastSpokeAt, utterance.created_at) : utterance.created_at;

  if (utterance.sentiment) {
    stat.sentimentCounts[utterance.sentiment] = (stat.sentimentCounts[utterance.sentiment] ?? 0) + 1;
    stat.sentimentScoreSum += utterance.sentimentScore ?? 0;
  }

  recomputeTalkRatios();
}

function recomputeTalkRatios() {
  const allTalkTime = [...state.speakerStats.values()].reduce((sum, s) => sum + s.talkTimeMs, 0);
  state.speakerStats.forEach((s) => {
    s.talkRatio = allTalkTime ? s.talkTimeMs / allTalkTime : 0;
  });
}

// ─── 패턴 감지 ────────────────────────────────────────────────────────────────

function pushEvent(kind, message) {
  state.events.unshift({ id: `${Date.now()}-${Math.random()}`, kind, message, at: Date.now() });
  if (state.events.length > MAX_FEED_ITEMS) state.events.length = MAX_FEED_ITEMS;
  sendNotification(kind, message);
}

function sendNotification(kind, message) {
  const title = NOTIFICATION_TITLES[kind] || "회의 알림";

  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
    new Notification(title, { body: message, tag: kind + "-" + Date.now() });
  } else {
    showToast(kind, title, message);
  }
}

function showToast(kind, title, message) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.innerHTML = `<strong>${title}</strong><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add("toast-exit"); }, 4000);
  setTimeout(() => { toast.remove(); }, 4500);
}

function detectDominance() {
  const now = Date.now();
  state.speakerStats.forEach((s) => {
    if (s.talkRatio > DOMINANCE_RATIO) {
      if (!s.dominanceSince) s.dominanceSince = now;
      if (now - s.dominanceSince > DOMINANCE_WINDOW_MS) {
        const already = state.warnings.some((w) => w.type === "dominance" && w.speakerId === s.speakerId);
        if (!already) {
          state.warnings.push({ type: "dominance", speakerId: s.speakerId });
          pushEvent("alert", `발언 독점 경고: ${s.name} (${Math.round(s.talkRatio * 100)}%)`);
        }
      }
    } else {
      s.dominanceSince = null;
    }
  });
}

function detectSilence() {
  if (!state.meeting) return;
  const now = Date.now();
  state.speakerStats.forEach((s) => {
    const silentMs = s.lastSpokeAt ? now - s.lastSpokeAt : now - state.meeting.startAt;
    if (silentMs > SILENCE_WINDOW_MS) {
      const already = state.warnings.some((w) => w.type === "silence" && w.speakerId === s.speakerId);
      if (!already) {
        state.warnings.push({ type: "silence", speakerId: s.speakerId });
        pushEvent("warn", `침묵 참여자 감지: ${s.name}`);
      }
    }
  });
}

function detectInefficientPattern(lastUtterance) {
  const speaker = state.speakerStats.get(lastUtterance.speaker_id);
  if (!speaker) return;

  if (lastUtterance.duration > 25000 / DEMO_TIME_SCALE) {
    pushEvent("warn", `장문 독백 감지: ${speaker.name}`);
  }

  const recent = state.utterances
    .filter((u) => u.speaker_id === lastUtterance.speaker_id)
    .slice(0, 4)
    .map((u) => u.transcript);
  if (recent.length >= 3 && new Set(recent).size <= 2) {
    pushEvent("warn", `반복 발언 패턴: ${speaker.name}`);
  }

  if (/[!?]{2,}/.test(lastUtterance.transcript)) {
    pushEvent("warn", `감정 고조 징후: ${speaker.name}`);
  }
}

function detectInterruption(utterance) {
  const prev = state.lastFinalUtterance;
  if (!prev) return;
  if (prev.speaker_id === utterance.speaker_id) return;
  if (prev.speaker_id === "unknown" || utterance.speaker_id === "unknown") return;

  const overlap = prev.end_time - utterance.start_time;
  if (overlap < INTERRUPTION_OVERLAP_MS) return;

  const interrupter = state.speakerStats.get(utterance.speaker_id);
  const interrupted = state.speakerStats.get(prev.speaker_id);
  if (!interrupter || !interrupted) return;

  interrupter.interruptionCount += 1;
  pushEvent(
    "interrupt",
    `끼어들기 감지: ${interrupter.name}이(가) ${interrupted.name}의 발언 중 끼어듦 (겹침 ${(overlap / 1000).toFixed(1)}초)`,
  );
}

// ─── 일시정지 / 재개 ──────────────────────────────────────────────────────────

function togglePause() {
  state.isPaused = !state.isPaused;

  if (state.isPaused) {
    state.stream?.pause();
    if (state.testMode && !el.testAudioPlayer.paused) {
      el.testAudioPlayer.pause();
    }
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
    state.activeSpeakerId = null;
    state.liveTranscript = "";
    el.pauseBtn.textContent = "재개";
    el.pauseBtn.classList.add("is-paused");
    el.dotLive.classList.add("is-paused");
    setStatus("일시정지됨 – 오디오 입력 및 분석이 중단됩니다.");
    renderActiveSpeaker();
    renderLiveTranscript();
  } else {
    state.stream?.resume();
    if (state.testMode && el.testAudioPlayer.paused) {
      el.testAudioPlayer.play().catch(() => {});
    }
    startElapsedTimer();
    el.pauseBtn.textContent = "일시정지";
    el.pauseBtn.classList.remove("is-paused");
    el.dotLive.classList.remove("is-paused");
    if (state.testMode) {
      setStatus("테스트 모드 재개");
    } else {
      setStatus("Deepgram 실시간 분석 재개");
    }
  }
}

// ─── 회의 종료 ────────────────────────────────────────────────────────────────

function endMeeting() {
  state.stream?.disconnect();
  clearTimers();
  state.activeSpeakerId = null;
  if (state.testAudioUrl) {
    URL.revokeObjectURL(state.testAudioUrl);
    state.testAudioUrl = "";
  }

  const report = buildReport();
  sessionStorage.setItem("meetingReport", JSON.stringify(report));
  window.location.href = "/report.html";
}

function buildReport() {
  const speakers = [...state.speakerStats.values()].sort((a, b) => b.talkRatio - a.talkRatio);
  const dominantCount = state.warnings.filter((w) => w.type === "dominance").length;
  const silenceCount = state.warnings.filter((w) => w.type === "silence").length;
  const inefficientCount = state.events.filter((e) => e.kind === "warn").length;
  const interruptionCount = state.events.filter((e) => e.kind === "interrupt").length;

  let score = 100;
  score -= dominantCount * 15;
  score -= silenceCount * 10;
  score -= Math.min(inefficientCount * 3, 20);
  score -= Math.min(interruptionCount * 2, 15);
  score = Math.max(score, 0);

  let feedback = "발언 균형이 양호합니다.";
  if (interruptionCount >= 5) feedback = "끼어들기가 빈번하여 발언 규칙 합의를 권장합니다.";
  if (dominantCount > 0) feedback = "특정 인원의 발언 지분이 높아 균형 개선이 필요합니다.";
  if (silenceCount > 1) feedback = "다수 침묵 참여자가 감지되어 참여 유도 질문을 권장합니다.";

  return {
    meetingId: state.meeting.id,
    title: state.meeting.title,
    generatedAt: Date.now(),
    score,
    balanceScore: getBalanceScore(),
    feedback,
    speakers: speakers.map((s) => ({
      speakerId: s.speakerId,
      name: s.name,
      talkTimeSec: Number((s.talkTimeMs / 1000).toFixed(1)),
      talkRatio: Math.round(s.talkRatio * 100),
      turnCount: s.turnCount,
      interruptionCount: s.interruptionCount,
      sentimentCounts: { ...s.sentimentCounts },
      avgSentiment: s.turnCount ? Math.round((s.sentimentScoreSum / s.turnCount) * 100) / 100 : 0,
    })),
    warnings: state.warnings,
    events: state.events,
    transcript: [...state.utterances]
      .reverse()
      .filter((u) => u.is_final && u.speaker_id !== "unknown")
      .map((u) => {
        const speaker = state.speakerStats.get(u.speaker_id);
        return `${speaker?.name || u.speaker_id}: ${u.transcript}`;
      })
      .join("\n"),
  };
}

// ─── 렌더링 ───────────────────────────────────────────────────────────────────

function setStatus(msg) {
  const modeLabel = state.streamMode === "deepgram" ? "REALTIME" : "INIT";
  el.status.textContent = `[${modeLabel}] ${msg} (${new Date().toLocaleTimeString("ko-KR")})`;
}

function renderAll() {
  renderElapsed();
  renderActiveSpeaker();
  renderLiveTranscript();
  renderSpeakerStats();
  renderRatioFeed();
  renderBalanceScore();
  renderSentimentSummary();
  renderUtterances();
}

function renderElapsed() {
  el.elapsed.textContent = formatElapsed(state.meetingElapsedSec);
}

function renderActiveSpeaker() {
  if (!state.activeSpeakerId) {
    el.activeSpeakerBadge.textContent = "활성 화자: 대기 중";
    el.activeSpeakerBadge.classList.remove("is-active");
    el.activeSpeakerBadge.style.borderColor = "";
    return;
  }

  const stat = state.speakerStats.get(state.activeSpeakerId);
  const color = getSpeakerColor(state.activeSpeakerId);
  el.activeSpeakerBadge.textContent = `활성 화자: ${stat?.name ?? "알 수 없음"}`;
  el.activeSpeakerBadge.classList.add("is-active");
  el.activeSpeakerBadge.style.borderColor = color;
}

function renderLiveTranscript() {
  el.liveTranscript.textContent = state.liveTranscript
    ? `실시간 자막: ${state.liveTranscript}`
    : "실시간 자막: 대기 중...";
}

function renderSpeakerStats() {
  el.speakerStats.innerHTML = [...state.speakerStats.values()]
    .sort((a, b) => b.talkRatio - a.talkRatio)
    .map((s) => {
      const color = getSpeakerColor(s.speakerId);
      const hasWarning = state.warnings.some((w) => w.speakerId === s.speakerId);
      const isActive = state.activeSpeakerId === s.speakerId;
      const avgScore = s.turnCount ? s.sentimentScoreSum / s.turnCount : 0;
      const sentimentEmoji = avgScore > 0.25 ? "😊" : avgScore < -0.25 ? "😠" : "😐";
      const sentimentLabel = avgScore > 0.25 ? "긍정" : avgScore < -0.25 ? "부정" : "중립";

      return `<article class="speaker-card ${hasWarning ? "is-warning" : ""} ${isActive ? "is-active" : ""}" style="border-color:${isActive ? color : ""}">
        <p class="speaker-name"><span class="speaker-dot" style="background:${color}"></span>${escapeHtml(s.name)}</p>
        <p class="speaker-meta">지분 ${Math.round(s.talkRatio * 100)}% · 턴 ${s.turnCount}회</p>
        <p class="speaker-meta">총 발언 ${(s.talkTimeMs / 1000).toFixed(1)}초${s.interruptionCount ? ` · 끼어들기 ${s.interruptionCount}회` : ""}</p>
        <p class="speaker-sentiment">${sentimentEmoji} ${sentimentLabel} (${avgScore >= 0 ? "+" : ""}${avgScore.toFixed(2)})</p>
      </article>`;
    })
    .join("");
}

function renderRatioFeed() {
  el.ratioFeed.innerHTML = [...state.speakerStats.values()]
    .sort((a, b) => b.talkRatio - a.talkRatio)
    .map((s) => {
      const color = getSpeakerColor(s.speakerId);
      const ratio = Math.round(s.talkRatio * 100);
      return `<div class="ratio-item">
        <div class="ratio-head">
          <span class="ratio-label" style="color:${color}">${escapeHtml(s.name)}</span>
          <span>${ratio}%</span>
        </div>
        <div class="ratio-track"><div class="ratio-fill" style="width:${ratio}%;background:${color}"></div></div>
        <div class="ratio-meta">${s.turnCount}회 · ${(s.talkTimeMs / 1000).toFixed(1)}초</div>
      </div>`;
    })
    .join("");
}

function renderBalanceScore() {
  const score = getBalanceScore();
  el.balanceScore.textContent = String(score);
  el.balanceScore.classList.remove("good", "mid", "low");
  if (score >= 70) el.balanceScore.classList.add("good");
  else if (score >= 40) el.balanceScore.classList.add("mid");
  else el.balanceScore.classList.add("low");
}

function renderSentimentSummary() {
  const speakers = [...state.speakerStats.values()].filter((s) => s.turnCount > 0);
  if (!speakers.length) {
    el.sentimentSummary.innerHTML = `<p class="muted-copy">발화 데이터 수집 중...</p>`;
    return;
  }

  el.sentimentSummary.innerHTML = speakers
    .map((s) => {
      const color = getSpeakerColor(s.speakerId);
      const avg = s.sentimentScoreSum / s.turnCount;
      const emoji = avg > 0.25 ? "😊" : avg < -0.25 ? "😠" : "😐";
      const { positive, neutral, negative } = s.sentimentCounts;
      const total = positive + neutral + negative || 1;
      const pPct = Math.round((positive / total) * 100);
      const neuPct = Math.round((neutral / total) * 100);
      const nPct = Math.round((negative / total) * 100);

      return `<div class="sentiment-item">
        <div class="sentiment-head">
          <span style="color:${color};font-weight:700">${escapeHtml(s.name)}</span>
          <span>${emoji} ${avg.toFixed(2)}</span>
        </div>
        <div class="sentiment-bar">
          <div class="sentiment-fill positive" style="width:${pPct}%"></div>
          <div class="sentiment-fill neutral" style="width:${neuPct}%"></div>
          <div class="sentiment-fill negative" style="width:${nPct}%"></div>
        </div>
        <div class="sentiment-labels">
          <span class="s-positive">긍정 ${pPct}%</span>
          <span class="s-neutral">중립 ${neuPct}%</span>
          <span class="s-negative">부정 ${nPct}%</span>
        </div>
      </div>`;
    })
    .join("");
}

function groupUtterancesBySpeaker(utterances) {
  const groups = [];
  for (const u of utterances) {
    const last = groups[groups.length - 1];
    if (last && last.speaker_id === u.speaker_id) {
      last.items.push(u);
      last.totalDuration += u.duration;
    } else {
      groups.push({ speaker_id: u.speaker_id, items: [u], totalDuration: u.duration });
    }
  }
  return groups;
}

function renderUtterances() {
  const groups = groupUtterancesBySpeaker([...state.utterances].reverse());
  el.utteranceFeed.innerHTML = groups
    .map((g) => {
      const speakerName = state.speakerStats.get(g.speaker_id)?.name ?? "미확정 화자";
      const color = getSpeakerColor(g.speaker_id);
      const lines = g.items
        .map((u) => {
          const sEmoji = u.sentiment === "positive" ? "😊" : u.sentiment === "negative" ? "😠" : "😐";
          return `<p class="bubble-line"><span class="sentiment-tag sentiment-${u.sentiment ?? "neutral"}">${sEmoji}</span>${escapeHtml(u.transcript)}</p>`;
        })
        .join("");
      return `<li class="bubble"><div class="bubble-header"><strong style="color:${color}">${escapeHtml(speakerName)}</strong> · ${(g.totalDuration / 1000).toFixed(1)}초 · ${g.items.length}건</div>${lines}</li>`;
    })
    .join("");
  el.utteranceFeed.scrollTop = el.utteranceFeed.scrollHeight;
}


function setupTestSourcePanel() {
  if (!state.testMode) {
    el.testSourcePanel.classList.add("hidden");
    el.diagnosticPanel.classList.add("hidden");
    el.testAudioPlayer.src = "";
    el.testAudioMeta.textContent = "";
    return;
  }

  el.testSourcePanel.classList.remove("hidden");
  el.diagnosticPanel.classList.remove("hidden");
  el.testAudioPlayer.src = state.testAudioUrl;
  el.testAudioMeta.textContent = `파일: ${state.testAudioName || "알 수 없음"}`;
}

function updateDiagnostics(data) {
  state.diagnostics = {
    inputMode: data.inputMode ?? "-",
    audioChunkCount: Number(data.audioChunkCount ?? 0),
    deepgramMessageCount: Number(data.deepgramMessageCount ?? 0),
    lastRms: Number(data.lastRms ?? 0),
    lastDeepgramMessageAt: data.lastDeepgramMessageAt ?? null,
  };
  renderDiagnostics();
}

function renderDiagnostics() {
  const d = state.diagnostics;
  const modeText = d.inputMode === "prerecorded_file" ? "업로드 파일 사전 분석" : d.inputMode;
  el.diagInputMode.textContent = `입력 모드: ${modeText}`;
  el.diagAudioLevel.textContent = `오디오 레벨(RMS): ${d.lastRms.toFixed(4)}`;
  el.diagAudioFlow.textContent = `오디오 전송 청크: ${d.audioChunkCount}`;
  const lastAt = d.lastDeepgramMessageAt
    ? new Date(d.lastDeepgramMessageAt).toLocaleTimeString("ko-KR")
    : "-";
  el.diagDeepgramFlow.textContent = `Deepgram 메시지: ${d.deepgramMessageCount} (마지막 ${lastAt})`;
}

async function analyzeTestAudioWithPrerecorded() {
  if (!state.testAudioBlob) {
    throw new Error("테스트 음성 파일이 로드되지 않았습니다.");
  }

  setStatus("업로드 음성 파일을 Deepgram 사전 분석 중...");
  const res = await fetch(DEEPGRAM_PRERECORDED_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": state.testAudioBlob.type || "application/octet-stream" },
    body: state.testAudioBlob,
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.detail?.err_msg || payload?.detail?.error || payload?.message || `HTTP ${res.status}`;
    throw new Error(`파일 분석 실패 (${detail})`);
  }

  const utterances = extractUtterancesFromPrerecorded(payload);
  if (!utterances.length) {
    setStatus("분석 완료: 발화를 추출하지 못했습니다. 파일 음량/언어/내용을 확인하세요.");
    return;
  }

  state.utterances = [];
  state.events = [];
  state.warnings = [];
  state.lastFinalUtterance = null;
  state.lastObservedFinalUtterance = null;
  state.recentFinalUtterances = [];
  resetSpeakerStats();

  utterances.forEach((utterance) => handleUtterance(utterance));

  updateDiagnostics({
    inputMode: "prerecorded_file",
    audioChunkCount: utterances.length,
    deepgramMessageCount: utterances.length,
    lastRms: 0,
    lastDeepgramMessageAt: Date.now(),
  });

  setStatus(`사전 분석 완료: 발화 ${utterances.length}건`);
}

function extractUtterancesFromPrerecorded(payload) {
  const result = payload?.results ?? payload;
  const utterancesFromResult = result?.utterances;
  if (Array.isArray(utterancesFromResult) && utterancesFromResult.length) {
    return utterancesFromResult
      .map(normalizePrerecordedUtterance)
      .filter(Boolean)
      .sort((a, b) => a.start_time - b.start_time)
      .map((utterance, idx) => ({ ...utterance, created_at: Date.now() + idx }));
  }

  const words = result?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  if (!words.length) return [];

  const grouped = [];
  let current = null;
  for (const word of words) {
    const speakerNum = Number(word?.speaker);
    if (!Number.isFinite(speakerNum)) continue;

    const token = word?.punctuated_word || word?.word || "";
    if (!token) continue;

    const startSec = Number(word?.start ?? 0);
    const endSec = Number(word?.end ?? startSec);
    if (!current) {
      current = {
        speaker: speakerNum,
        start: startSec,
        end: endSec,
        words: [token],
        sentimentScores: [],
      };
      if (typeof word?.sentiment_score === "number") current.sentimentScores.push(word.sentiment_score);
      continue;
    }

    const isSameSpeaker = current.speaker === speakerNum;
    const gap = Math.max(0, startSec - current.end);
    if (isSameSpeaker && gap <= 1.2) {
      current.end = Math.max(current.end, endSec);
      current.words.push(token);
      if (typeof word?.sentiment_score === "number") current.sentimentScores.push(word.sentiment_score);
    } else {
      grouped.push(current);
      current = {
        speaker: speakerNum,
        start: startSec,
        end: endSec,
        words: [token],
        sentimentScores: typeof word?.sentiment_score === "number" ? [word.sentiment_score] : [],
      };
    }
  }
  if (current) grouped.push(current);

  return grouped.map((group, idx) => {
    const avg = group.sentimentScores.length
      ? group.sentimentScores.reduce((sum, score) => sum + score, 0) / group.sentimentScores.length
      : 0;
    return {
      id: `pre-${Date.now()}-${idx}`,
      speaker_id: `speaker_${group.speaker + 1}`,
      speaker_confidence: 1,
      speaker_word_count: group.words.length,
      transcript: group.words.join(" "),
      start_time: Math.round(group.start * 1000),
      end_time: Math.round(group.end * 1000),
      duration: Math.max(100, Math.round((group.end - group.start) * 1000)),
      created_at: Date.now() + idx,
      is_final: true,
      sentiment: avg > 0.25 ? "positive" : avg < -0.25 ? "negative" : "neutral",
      sentimentScore: Math.round(avg * 100) / 100,
    };
  });
}

function normalizePrerecordedUtterance(input) {
  const transcript = String(input?.transcript || "").trim();
  if (!transcript) return null;

  const speakerNum = Number(input?.speaker ?? input?.words?.[0]?.speaker);
  const startSec = Number(input?.start ?? 0);
  const endSec = Number(input?.end ?? startSec);
  const words = Array.isArray(input?.words) ? input.words : [];
  const sentimentScores = words
    .map((word) => word?.sentiment_score)
    .filter((score) => typeof score === "number" && Number.isFinite(score));

  const avg = sentimentScores.length
    ? sentimentScores.reduce((sum, score) => sum + score, 0) / sentimentScores.length
    : 0;

  return {
    id: `pre-${Math.random().toString(36).slice(2, 10)}`,
    speaker_id: Number.isFinite(speakerNum) ? `speaker_${speakerNum + 1}` : "unknown",
    speaker_confidence: Number(input?.confidence ?? 1),
    speaker_word_count: words.length || countTranscriptWords(transcript),
    transcript,
    start_time: Math.round(startSec * 1000),
    end_time: Math.round(endSec * 1000),
    duration: Math.max(100, Math.round((endSec - startSec) * 1000)),
    created_at: Date.now(),
    is_final: true,
    sentiment: avg > 0.25 ? "positive" : avg < -0.25 ? "negative" : "neutral",
    sentimentScore: Math.round(avg * 100) / 100,
  };
}

async function loadTestAudioSource(testSourceId) {
  if (!testSourceId) {
    throw new Error("테스트 음성 파일 참조 정보가 없습니다.");
  }

  const record = await readTestSource(testSourceId);
  if (!record?.file) {
    throw new Error("테스트 음성 파일을 찾을 수 없습니다. 첫 화면에서 다시 업로드해주세요.");
  }

  state.testAudioBlob = record.file;
  state.testAudioName = record.name || "업로드 음성";
  state.testAudioUrl = URL.createObjectURL(record.file);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TEST_SOURCE_STORE)) {
        db.createObjectStore(TEST_SOURCE_STORE, { keyPath: "id" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
  });
}

async function readTestSource(id) {
  const db = await openDb();

  const record = await new Promise((resolve, reject) => {
    const tx = db.transaction(TEST_SOURCE_STORE, "readonly");
    const req = tx.objectStore(TEST_SOURCE_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error("indexedDB read failed"));
  });

  db.close();
  return record;
}

// ─── 유틸리티 ─────────────────────────────────────────────────────────────────

function getBalanceScore() {
  const values = [...state.speakerStats.values()].map((s) => s.talkTimeMs);
  const total = values.reduce((sum, v) => sum + v, 0);
  if (!values.length || total === 0) return 100;

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  let sumDiff = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      sumDiff += Math.abs(sorted[i] - sorted[j]);
    }
  }

  const gini = sumDiff / (2 * n * total);
  return Math.max(0, Math.round((1 - gini) * 100));
}

function getSpeakerColor(speakerId) {
  if (!speakerId || !speakerId.startsWith("speaker_")) return "#94a3b8";
  const index = Number(speakerId.replace("speaker_", "")) - 1;
  return SPEAKER_COLORS[((Number.isNaN(index) ? 0 : index) + SPEAKER_COLORS.length) % SPEAKER_COLORS.length];
}

function formatElapsed(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
