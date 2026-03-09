document.getElementById("start-meeting").addEventListener("click", () => {
  const title = document.getElementById("meeting-title").value.trim() || "이름 없는 회의";
  const raw = document.getElementById("meeting-participants").value;
  const participantCount = Math.min(Math.max(parseInt(raw, 10) || 2, 2), 20);

  if (participantCount < 2) {
    alert("참여자 수는 최소 2명이어야 합니다.");
    return;
  }

  sessionStorage.setItem("meetingConfig", JSON.stringify({ title, participantCount }));
  window.location.href = "/dashboard.html";
});
