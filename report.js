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

const report = JSON.parse(sessionStorage.getItem("meetingReport") || "null");
if (!report) {
  window.location.replace("/");
} else {
  renderReport(report);
}

document.getElementById("restart").addEventListener("click", () => {
  sessionStorage.removeItem("meetingConfig");
  sessionStorage.removeItem("meetingReport");
  window.location.href = "/";
});

document.getElementById("export-report").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${report.title.replace(/\s+/g, "_")}-report.json`;
  a.click();
  URL.revokeObjectURL(url);
});

function renderReport(report) {
  document.getElementById("report-generated-at").textContent =
    `생성 시각: ${new Date(report.generatedAt).toLocaleString("ko-KR")}`;
  document.getElementById("report-score").textContent = `${report.score} / 100`;
  document.getElementById("report-feedback").textContent =
    `${report.feedback} (균형 지수: ${report.balanceScore})`;

  document.getElementById("report-speakers").innerHTML = report.speakers
    .map((s) => {
      const color = getSpeakerColor(s.speakerId);
      const sEmoji = s.avgSentiment > 0.25 ? "😊" : s.avgSentiment < -0.25 ? "😠" : "😐";
      const sLabel = s.avgSentiment > 0.25 ? "긍정" : s.avgSentiment < -0.25 ? "부정" : "중립";
      const sentimentClass = s.avgSentiment > 0.25 ? "positive" : s.avgSentiment < -0.25 ? "negative" : "neutral";
      return `<li>
        <span class="report-speaker-name" style="color:${color}">${escapeHtml(s.name)}</span> · 지분 ${s.talkRatio}% · 발언 ${s.talkTimeSec}초 · ${s.turnCount}회
        <span class="sentiment-tag sentiment-${sentimentClass}">${sEmoji} ${sLabel}</span>
      </li>`;
    })
    .join("");

  const silentNames = report.warnings
    .filter((w) => w.type === "silence")
    .map((w) => report.speakers.find((s) => s.speakerId === w.speakerId)?.name)
    .filter(Boolean);

  document.getElementById("report-events").innerHTML = [
    `<li>침묵 참여자: ${silentNames.length ? silentNames.map(escapeHtml).join(", ") : "없음"}</li>`,
    ...report.events.slice(0, 10).map((e) => `<li>${escapeHtml(e.message)}</li>`),
  ].join("");
}

function getSpeakerColor(speakerId) {
  if (!speakerId || !speakerId.startsWith("speaker_")) return "#94a3b8";
  const index = Number(speakerId.replace("speaker_", "")) - 1;
  return SPEAKER_COLORS[((Number.isNaN(index) ? 0 : index) + SPEAKER_COLORS.length) % SPEAKER_COLORS.length];
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
