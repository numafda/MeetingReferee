import { createDeepgramRealtimeClient } from "./deepgramAdapter.js";

const DEMO_TIME_SCALE = 10;
const DOMINANCE_RATIO = 0.4;
const DOMINANCE_WINDOW_MS = (5 * 60 * 1000) / DEMO_TIME_SCALE;
const SILENCE_WINDOW_MS = (10 * 60 * 1000) / DEMO_TIME_SCALE;
const MAX_FEED_ITEMS = 40;
const ACTIVE_SPEAKER_HOLD_MS = 2200;
const DEEPGRAM_TOKEN_ENDPOINT = "/api/deepgram/token";
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
};

const el = {
  dashboardTitle: document.getElementById("dashboard-title"),
  status: document.getElementById("connection-status"),
  speakerStats: document.getElementById("speaker-stats"),
  utteranceFeed: document.getElementById("utterance-feed"),
  eventFeed: document.getElementById("event-feed"),
  ratioFeed: document.getElementById("ratio-feed"),
  balanceScore: document.getElementById("balance-score"),
  sentimentSummary: document.getElementById("sentiment-summary"),

  activeSpeakerBadge: document.getElementById("active-speaker-badge"),
  liveTranscript: document.getElementById("live-transcript"),
  elapsed: document.getElementById("meeting-elapsed"),
  pauseBtn: document.getElementById("pause-meeting"),
  dotLive: document.querySelector(".dot-live"),
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

async function startMeeting({ title, participantCount }) {
  const participants = parseParticipants(participantCount);

  state.meeting = {
    id: String(Date.now()),
    title,
    participants,
    startAt: Date.now(),
  };
  state.speakerStats = createSpeakerStats(participants);

  el.dashboardTitle.textContent = `${title} - 실시간 모니터링`;
  renderAll();
  startElapsedTimer();

  const realtimeClient = createDeepgramRealtimeClient({
    getAuthCredential: fetchDeepgramAuthCredential,
    onUtterance: handleUtterance,
    onStatus: setStatus,
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
    renderEvents();
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
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
    state.activeSpeakerId = null;
    state.liveTranscript = "";
    el.pauseBtn.textContent = "재개";
    el.pauseBtn.classList.add("is-paused");
    el.dotLive.classList.add("is-paused");
    setStatus("일시정지됨 – 마이크 및 분석이 중단됩니다.");
    renderActiveSpeaker();
    renderLiveTranscript();
  } else {
    state.stream?.resume();
    startElapsedTimer();
    el.pauseBtn.textContent = "일시정지";
    el.pauseBtn.classList.remove("is-paused");
    el.dotLive.classList.remove("is-paused");
    setStatus("Deepgram 실시간 분석 재개");
  }
}

// ─── 회의 종료 ────────────────────────────────────────────────────────────────

function endMeeting() {
  state.stream?.disconnect();
  clearTimers();
  state.activeSpeakerId = null;

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
  renderEvents();
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

function renderUtterances() {
  el.utteranceFeed.innerHTML = state.utterances
    .map((u) => {
      const speakerName = state.speakerStats.get(u.speaker_id)?.name ?? "미확정 화자";
      const color = getSpeakerColor(u.speaker_id);
      const sEmoji = u.sentiment === "positive" ? "😊" : u.sentiment === "negative" ? "😠" : "😐";
      return `<li><strong style="color:${color}">${escapeHtml(speakerName)}</strong> · ${(u.duration / 1000).toFixed(1)}초 <span class="sentiment-tag sentiment-${u.sentiment ?? "neutral"}">${sEmoji}</span><br/>${escapeHtml(u.transcript)}</li>`;
    })
    .join("");
}

function renderEvents() {
  el.eventFeed.innerHTML = state.events
    .map((e) => {
      const cls = e.kind === "alert" ? "alert" : e.kind === "interrupt" ? "interrupt" : "warn";
      const label = e.kind === "alert" ? "독점" : e.kind === "interrupt" ? "끼어들기" : "주의";
      return `<li><span class="tag ${cls}">${label}</span>${escapeHtml(e.message)}</li>`;
    })
    .join("");
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
