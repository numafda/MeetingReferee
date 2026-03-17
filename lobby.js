const testModeEl = document.getElementById("test-mode");
const testAudioWrapEl = document.getElementById("test-audio-wrap");
const testAudioFileEl = document.getElementById("test-audio-file");
const DB_NAME = "meetingreferee-db";
const DB_VERSION = 1;
const TEST_SOURCE_STORE = "testSources";

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

async function saveTestAudioFile(file) {
  const db = await openDb();
  const id = `test-audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    type: "audio_file",
    file,
    name: file.name,
    size: file.size,
    mimeType: file.type || "audio/*",
    createdAt: Date.now(),
  };

  await new Promise((resolve, reject) => {
    const tx = db.transaction(TEST_SOURCE_STORE, "readwrite");
    tx.objectStore(TEST_SOURCE_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("indexedDB write failed"));
    tx.onabort = () => reject(tx.error || new Error("indexedDB write aborted"));
  });

  db.close();
  return { id, name: file.name, size: file.size, mimeType: file.type || "audio/*" };
}

function toggleTestModeInput() {
  const isTestMode = testModeEl.checked;
  testAudioWrapEl.classList.toggle("hidden", !isTestMode);
  testAudioFileEl.required = isTestMode;
}

testModeEl.addEventListener("change", toggleTestModeInput);
toggleTestModeInput();

document.getElementById("start-meeting").addEventListener("click", async () => {
  const title = document.getElementById("meeting-title").value.trim() || "이름 없는 회의";
  const raw = document.getElementById("meeting-participants").value;
  const participantCount = Math.min(Math.max(parseInt(raw, 10) || 2, 2), 20);
  const testMode = testModeEl.checked;
  const testAudioFile = testAudioFileEl.files?.[0] ?? null;

  if (participantCount < 2) {
    alert("참여자 수는 최소 2명이어야 합니다.");
    return;
  }

  if (testMode && !testAudioFile) {
    alert("테스트 모드에서는 음성 파일을 업로드해주세요.");
    testAudioFileEl.focus();
    return;
  }

  let testSource = null;
  if (testMode && testAudioFile) {
    try {
      testSource = await saveTestAudioFile(testAudioFile);
    } catch {
      alert("테스트 음성 파일 저장에 실패했습니다. 다시 시도해주세요.");
      return;
    }
  }

  sessionStorage.setItem(
    "meetingConfig",
    JSON.stringify({ title, participantCount, testMode, testSourceId: testSource?.id || null }),
  );
  window.location.href = "/dashboard.html";
});
