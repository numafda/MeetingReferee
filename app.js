import { createDeepgramRealtimeClient } from "./deepgramAdapter.js";

const DEMO_TIME_SCALE = 10;
const DOMINANCE_RATIO = 0.4;
const DOMINANCE_WINDOW_MS = (5 * 60 * 1000) / DEMO_TIME_SCALE;
const SILENCE_WINDOW_MS = (10 * 60 * 1000) / DEMO_TIME_SCALE;
const MAX_FEED_ITEMS = 40;
const ACTIVE_SPEAKER_HOLD_MS = 2200;
const DEEPGRAM_TOKEN_ENDPOINT = "/api/deepgram/token";

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

const state = {
  meeting: null,
  speakerStats: new Map(),
  utterances: [],
  events: [],
  warnings: [],
  stream: null,
  latestReport: null,
  activeSpeakerId: null,
  meetingElapsedSec: 0,
  elapsedTimer: null,
  activeSpeakerTimer: null,
  liveTranscript: "",
  streamMode: "none",
  topicCounts: new Map(),
};

const el = {
  lobby: document.getElementById("lobby-view"),
  dashboard: document.getElementById("dashboard-view"),
  report: document.getElementById("report-view"),
  titleInput: document.getElementById("meeting-title"),
  participantInput: document.getElementById("meeting-participants"),
  dashboardTitle: document.getElementById("dashboard-title"),
  status: document.getElementById("connection-status"),
  speakerStats: document.getElementById("speaker-stats"),
  utteranceFeed: document.getElementById("utterance-feed"),
  eventFeed: document.getElementById("event-feed"),
  ratioFeed: document.getElementById("ratio-feed"),
  balanceScore: document.getElementById("balance-score"),
  sentimentSummary: document.getElementById("sentiment-summary"),
  topicCloud: document.getElementById("topic-cloud"),
  activeSpeakerBadge: document.getElementById("active-speaker-badge"),
  liveTranscript: document.getElementById("live-transcript"),
  elapsed: document.getElementById("meeting-elapsed"),
  reportGeneratedAt: document.getElementById("report-generated-at"),
  reportScore: document.getElementById("report-score"),
  reportFeedback: document.getElementById("report-feedback"),
  reportSpeakers: document.getElementById("report-speakers"),
  reportTopics: document.getElementById("report-topics"),
  reportEvents: document.getElementById("report-events"),
};

document.getElementById("start-meeting").addEventListener("click", () => {
  startMeeting().catch((error) => {
    setStatus(`회의 시작 실패: ${error.message}`);
  });
});
document.getElementById("end-meeting").addEventListener("click", endMeeting);
document.getElementById("restart").addEventListener("click", resetToLobby);
document.getElementById("export-report").addEventListener("click", exportReport);

function parseParticipants(raw) {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
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
      },
    ])
  );
}

async function startMeeting() {
  const title = el.titleInput.value.trim() || "이름 없는 회의";
  const participants = parseParticipants(el.participantInput.value);
  if (participants.length < 2) {
    alert("참여자를 최소 2명 입력해 주세요.");
    return;
  }

  clearTimers();
  state.stream?.disconnect();

  state.meeting = {
    id: String(Date.now()),
    title,
    participants,
    startAt: Date.now(),
  };
  state.speakerStats = createSpeakerStats(participants);
  state.utterances = [];
  state.events = [];
  state.warnings = [];
  state.latestReport = null;
  state.activeSpeakerId = null;
  state.liveTranscript = "";
  state.meetingElapsedSec = 0;
  state.streamMode = "none";
  state.topicCounts = new Map();

  el.dashboardTitle.textContent = `${title} - 실시간 모니터링`;
  transitionView("dashboard");
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

function setStatus(msg) {
  const modeLabel = state.streamMode === "deepgram" ? "REALTIME" : "INIT";
  el.status.textContent = `[${modeLabel}] ${msg} (${new Date().toLocaleTimeString("ko-KR")})`;
}

function startElapsedTimer() {
  state.elapsedTimer = window.setInterval(() => {
    state.meetingElapsedSec += 1;
    renderElapsed();
    detectSilence();
    renderEvents();
    renderSpeakerStats();
  }, 1000);
}

function handleUtterance(utterance) {
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
  state.utterances.unshift(utterance);
  if (state.utterances.length > MAX_FEED_ITEMS) state.utterances.length = MAX_FEED_ITEMS;

  if (!hasKnownSpeaker) {
    state.liveTranscript = "";
    renderAll();
    return;
  }

  const stat = state.speakerStats.get(speakerId);
  if (!stat) return;

  stat.talkTimeMs += utterance.duration;
  stat.turnCount += 1;
  stat.lastSpokeAt = utterance.created_at;

  if (utterance.sentiment) {
    stat.sentimentCounts[utterance.sentiment] = (stat.sentimentCounts[utterance.sentiment] ?? 0) + 1;
    stat.sentimentScoreSum += utterance.sentimentScore ?? 0;
  }

  for (const t of utterance.topics ?? []) {
    state.topicCounts.set(t.topic, (state.topicCounts.get(t.topic) ?? 0) + 1);
  }

  const allTalkTime = [...state.speakerStats.values()].reduce((sum, s) => sum + s.talkTimeMs, 0);
  state.speakerStats.forEach((s) => {
    s.talkRatio = allTalkTime ? s.talkTimeMs / allTalkTime : 0;
  });

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

  detectDominance();
  detectSilence();
  detectInefficientPattern(utterance);
  renderAll();
}

function pushEvent(kind, message) {
  const item = {
    id: `${Date.now()}-${Math.random()}`,
    kind,
    message,
    at: Date.now(),
  };
  state.events.unshift(item);
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

function renderAll() {
  renderElapsed();
  renderActiveSpeaker();
  renderLiveTranscript();
  renderSpeakerStats();
  renderRatioFeed();
  renderBalanceScore();
  renderSentimentSummary();
  renderTopicCloud();
  renderUtterances();
  renderEvents();
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

function renderTopicCloud() {
  if (!state.topicCounts.size) {
    el.topicCloud.innerHTML = `<p class="muted-copy">토픽 수집 중...</p>`;
    return;
  }

  const sorted = [...state.topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const maxCount = sorted[0]?.[1] ?? 1;

  el.topicCloud.innerHTML = sorted
    .map(([topic, count]) => {
      const size = Math.max(12, Math.min(22, 12 + (count / maxCount) * 10));
      const opacity = Math.max(0.5, count / maxCount);
      return `<span class="topic-tag" style="font-size:${size}px;opacity:${opacity}">${escapeHtml(topic)} <sup>${count}</sup></span>`;
    })
    .join("");
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
  const rows = [...state.speakerStats.values()]
    .sort((a, b) => b.talkRatio - a.talkRatio)
    .map((s) => {
      const color = getSpeakerColor(s.speakerId);
      const hasWarning = state.warnings.some((w) => w.speakerId === s.speakerId);
      const isActive = state.activeSpeakerId === s.speakerId;

      const avgScore = s.turnCount ? (s.sentimentScoreSum / s.turnCount) : 0;
      const sentimentEmoji = avgScore > 0.25 ? "😊" : avgScore < -0.25 ? "😠" : "😐";
      const sentimentLabel = avgScore > 0.25 ? "긍정" : avgScore < -0.25 ? "부정" : "중립";

      return `<article class="speaker-card ${hasWarning ? "is-warning" : ""} ${isActive ? "is-active" : ""}" style="border-color:${
        isActive ? color : ""
      }">
        <p class="speaker-name"><span class="speaker-dot" style="background:${color}"></span>${escapeHtml(s.name)}</p>
        <p class="speaker-meta">지분 ${Math.round(s.talkRatio * 100)}% · 턴 ${s.turnCount}회</p>
        <p class="speaker-meta">총 발언 ${(s.talkTimeMs / 1000).toFixed(1)}초</p>
        <p class="speaker-sentiment">${sentimentEmoji} ${sentimentLabel} (${avgScore >= 0 ? "+" : ""}${avgScore.toFixed(2)})</p>
      </article>`;
    })
    .join("");

  el.speakerStats.innerHTML = rows;
}

function renderRatioFeed() {
  const rows = [...state.speakerStats.values()]
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

  el.ratioFeed.innerHTML = rows;
}

function renderBalanceScore() {
  const score = getBalanceScore();
  el.balanceScore.textContent = String(score);
  el.balanceScore.classList.remove("good", "mid", "low");
  if (score >= 70) el.balanceScore.classList.add("good");
  else if (score >= 40) el.balanceScore.classList.add("mid");
  else el.balanceScore.classList.add("low");
}

function renderUtterances() {
  el.utteranceFeed.innerHTML = state.utterances
    .map((u) => {
      const speakerId = u.speaker_id;
      const speakerName = state.speakerStats.get(speakerId)?.name ?? "미확정 화자";
      const color = getSpeakerColor(speakerId);
      const sEmoji = u.sentiment === "positive" ? "😊" : u.sentiment === "negative" ? "😠" : "😐";
      return `<li><strong style="color:${color}">${escapeHtml(speakerName)}</strong> · ${(u.duration / 1000).toFixed(
        1
      )}초 <span class="sentiment-tag sentiment-${u.sentiment ?? "neutral"}">${sEmoji}</span><br/>${escapeHtml(u.transcript)}</li>`;
    })
    .join("");
}

function renderEvents() {
  el.eventFeed.innerHTML = state.events
    .map((e) => {
      const cls = e.kind === "alert" ? "alert" : "warn";
      const label = e.kind === "alert" ? "독점" : "주의";
      return `<li><span class="tag ${cls}">${label}</span>${escapeHtml(e.message)}</li>`;
    })
    .join("");
}

function endMeeting() {
  state.stream?.disconnect();
  clearTimers();
  state.activeSpeakerId = null;

  const report = buildReport();
  renderReport(report);
  transitionView("report");
}

function buildReport() {
  const speakers = [...state.speakerStats.values()].sort((a, b) => b.talkRatio - a.talkRatio);
  const dominantCount = state.warnings.filter((w) => w.type === "dominance").length;
  const silenceCount = state.warnings.filter((w) => w.type === "silence").length;
  const inefficientCount = state.events.filter((e) => e.kind === "warn").length;

  let score = 100;
  score -= dominantCount * 15;
  score -= silenceCount * 10;
  score -= Math.min(inefficientCount * 3, 20);
  score = Math.max(score, 0);

  let feedback = "발언 균형이 양호합니다.";
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
      sentimentCounts: { ...s.sentimentCounts },
      avgSentiment: s.turnCount ? Math.round((s.sentimentScoreSum / s.turnCount) * 100) / 100 : 0,
    })),
    warnings: state.warnings,
    events: state.events,
    topics: [...state.topicCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([topic, count]) => ({ topic, count })),
  };
}

function renderReport(report) {
  state.latestReport = report;
  el.reportGeneratedAt.textContent = `생성 시각: ${new Date(report.generatedAt).toLocaleString("ko-KR")}`;
  el.reportScore.textContent = `${report.score} / 100`;
  el.reportFeedback.textContent = `${report.feedback} (균형 지수: ${report.balanceScore})`;

  el.reportSpeakers.innerHTML = report.speakers
    .map((s) => {
      const color = getSpeakerColor(s.speakerId);
      const sEmoji = s.avgSentiment > 0.25 ? "😊" : s.avgSentiment < -0.25 ? "😠" : "😐";
      const sLabel = s.avgSentiment > 0.25 ? "긍정" : s.avgSentiment < -0.25 ? "부정" : "중립";
      return `<li>
        <span class="report-speaker-name" style="color:${color}">${escapeHtml(s.name)}</span> · 지분 ${
        s.talkRatio
      }% · 발언 ${s.talkTimeSec}초 · ${s.turnCount}회
        <span class="sentiment-tag sentiment-${s.avgSentiment > 0.25 ? "positive" : s.avgSentiment < -0.25 ? "negative" : "neutral"}">${sEmoji} ${sLabel}</span>
      </li>`;
    })
    .join("");

  if (report.topics?.length) {
    const maxCount = report.topics[0]?.count ?? 1;
    el.reportTopics.innerHTML = report.topics
      .map((t) => {
        const size = Math.max(12, Math.min(22, 12 + (t.count / maxCount) * 10));
        return `<span class="topic-tag" style="font-size:${size}px">${escapeHtml(t.topic)} <sup>${t.count}</sup></span>`;
      })
      .join("");
  } else {
    el.reportTopics.innerHTML = `<p class="muted-copy">감지된 토픽이 없습니다.</p>`;
  }

  const silentNames = report.warnings
    .filter((w) => w.type === "silence")
    .map((w) => state.speakerStats.get(w.speakerId)?.name)
    .filter(Boolean);

  el.reportEvents.innerHTML = [
    `<li>침묵 참여자: ${silentNames.length ? silentNames.map((n) => escapeHtml(n)).join(", ") : "없음"}</li>`,
    ...report.events.slice(0, 10).map((e) => `<li>${escapeHtml(e.message)}</li>`),
  ].join("");
}

function exportReport() {
  if (!state.latestReport) return;

  const blob = new Blob([JSON.stringify(state.latestReport, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.meeting.title.replace(/\s+/g, "_")}-report.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function transitionView(target) {
  [el.lobby, el.dashboard, el.report].forEach((view) => {
    view.classList.add("hidden");
    view.classList.remove("active");
  });

  const current = target === "dashboard" ? el.dashboard : target === "report" ? el.report : el.lobby;
  current.classList.remove("hidden");
  current.classList.add("active");
}

function resetToLobby() {
  state.stream?.disconnect();
  clearTimers();

  state.meeting = null;
  state.speakerStats = new Map();
  state.utterances = [];
  state.events = [];
  state.warnings = [];
  state.latestReport = null;
  state.activeSpeakerId = null;
  state.liveTranscript = "";
  state.meetingElapsedSec = 0;
  state.streamMode = "none";
  state.topicCounts = new Map();

  transitionView("lobby");
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
