const TARGET_SAMPLE_RATE = 16000;

function uuid() {
  return `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) return buffer;

  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);

  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
      accum += buffer[i];
      count += 1;
    }

    result[offsetResult] = accum / Math.max(1, count);
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function to16BitPCM(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}

function extractSpeakerMetadata(alt) {
  const speakers = (alt?.words ?? [])
    .map((word) => Number(word?.speaker))
    .filter((n) => Number.isFinite(n));

  if (!speakers.length) {
    return { speakerId: null, confidence: 0, wordCount: 0 };
  }

  const counts = new Map();
  speakers.forEach((s) => counts.set(s, (counts.get(s) ?? 0) + 1));
  const [dominant, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];

  return {
    speakerId: dominant === undefined ? null : `speaker_${dominant + 1}`,
    confidence: dominantCount ? dominantCount / speakers.length : 0,
    wordCount: speakers.length,
  };
}

function extractSentiment(alt) {
  const sentiments = (alt?.words ?? [])
    .map((w) => w?.sentiment_score)
    .filter((s) => typeof s === "number" && Number.isFinite(s));

  if (!sentiments.length) return { sentiment: "neutral", score: 0 };

  const avg = sentiments.reduce((sum, s) => sum + s, 0) / sentiments.length;

  let label = "neutral";
  if (avg > 0.25) label = "positive";
  else if (avg < -0.25) label = "negative";

  return { sentiment: label, score: Math.round(avg * 100) / 100 };
}

function parseDeepgramResult(payload) {
  if (payload?.type !== "Results") return null;

  const alt = payload?.channel?.alternatives?.[0];
  const text = alt?.transcript?.trim();
  if (!text) return null;

  const words = alt.words ?? [];
  const firstWord = words[0];
  const lastWord = words[words.length - 1];

  const startSec = firstWord?.start ?? payload.start ?? 0;
  const endSec = lastWord?.end ?? payload.duration ?? startSec;

  const isFinal = Boolean(payload.is_final);
  const speakerMeta = isFinal ? extractSpeakerMetadata(alt) : { speakerId: null, confidence: 0, wordCount: 0 };
  const { sentiment, score: sentimentScore } = isFinal ? extractSentiment(alt) : { sentiment: null, score: 0 };
  return {
    id: uuid(),
    speaker_id: speakerMeta.speakerId,
    speaker_confidence: speakerMeta.confidence,
    speaker_word_count: speakerMeta.wordCount,
    transcript: text,
    start_time: Math.round(startSec * 1000),
    end_time: Math.round(endSec * 1000),
    duration: Math.max(100, Math.round((endSec - startSec) * 1000)),
    created_at: Date.now(),
    is_final: isFinal,
    sentiment,
    sentimentScore,
  };
}

export function createDeepgramRealtimeClient({
  inputMode = "microphone",
  audioElement = null,
  getAuthCredential,
  onUtterance,
  onStatus,
  onError,
  onDiagnostics,
}) {
  let ws = null;
  let mediaStream = null;
  let audioContext = null;
  let processor = null;
  let source = null;
  let sink = null;
  let keepAliveTimer = null;
  let diagnosticsTimer = null;
  let isPaused = false;
  let audioChunkCount = 0;
  let deepgramMessageCount = 0;
  let lastRms = 0;
  let lastDeepgramMessageAt = null;

  async function connect() {
    if (!window.isSecureContext) {
      throw new Error("오디오 접근을 위해 localhost 또는 HTTPS 환경이 필요합니다.");
    }

    mediaStream = await requestAudioStream(inputMode, onStatus);

    const credential = await getAuthCredential();
    if (!credential?.value) throw new Error("Deepgram 인증 정보 발급 실패");

    const params = new URLSearchParams({
      model: "nova-3",
      language: "ko",
      diarize: "true",
      utterances: "true",
      punctuate: "true",
      smart_format: "true",
      interim_results: "true",
      endpointing: "800",
      utterance_end_ms: "2000",
      vad_events: "true",
      sentiment: "true",
      encoding: "linear16",
      sample_rate: String(TARGET_SAMPLE_RATE),
      channels: "1",
    });
    if (credential.type === "token") params.set("token", credential.value);

    onStatus("Deepgram WebSocket 연결 중...");
    const wsUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    ws =
      credential.type === "api_key"
        ? new WebSocket(wsUrl, ["token", credential.value])
        : new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Deepgram WebSocket 연결 시간 초과")), 10000);

      ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Deepgram WebSocket 연결 실패"));
      };
    });

    ws.onmessage = async (message) => {
      try {
        deepgramMessageCount += 1;
        lastDeepgramMessageAt = Date.now();
        let raw = message.data;
        if (raw instanceof Blob) raw = await raw.text();
        if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
        if (typeof raw !== "string") return;

        const payload = JSON.parse(raw);
        const utterance = parseDeepgramResult(payload);
        if (utterance) onUtterance(utterance);
      } catch {
        onStatus("Deepgram 메시지 처리 중 파싱 오류");
      }
    };

    ws.onclose = () => {
      onStatus("Deepgram 연결 종료");
    };

    ws.onerror = () => {
      onStatus("Deepgram 스트림 오류 발생");
      if (onError) onError(new Error("Deepgram 스트림 오류"));
    };

    audioContext = new AudioContext();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
      onStatus("오디오 컨텍스트 활성화 완료");
    }
    source = audioContext.createMediaStreamSource(mediaStream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    sink = audioContext.createGain();
    sink.gain.value = 0;

    processor.onaudioprocess = (event) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (isPaused) return;

      const float32 = event.inputBuffer.getChannelData(0);
      const rms = computeRms(float32);
      lastRms = Number.isFinite(rms) ? rms : 0;
      const downsampled = downsampleBuffer(float32, audioContext.sampleRate, TARGET_SAMPLE_RATE);
      const pcm = to16BitPCM(downsampled);
      ws.send(pcm);
      audioChunkCount += 1;
    };

    source.connect(processor);
    processor.connect(sink);
    sink.connect(audioContext.destination);

    keepAliveTimer = window.setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, 10000);

    diagnosticsTimer = window.setInterval(() => {
      if (!onDiagnostics) return;
      onDiagnostics({
        inputMode,
        audioChunkCount,
        deepgramMessageCount,
        lastRms,
        lastDeepgramMessageAt,
      });
    }, 1000);

    onStatus("Deepgram 실시간 스트림 연결됨");
  }

  async function requestAudioStream(mode, reportStatus) {
    if (mode === "audio_element") {
      if (!audioElement) {
        throw new Error("테스트 음성 플레이어가 준비되지 않았습니다.");
      }

      if (!audioElement.src) {
        throw new Error("업로드된 테스트 음성 파일이 없습니다.");
      }

      if (audioElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await new Promise((resolve, reject) => {
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onError = () => {
            cleanup();
            reject(new Error("업로드 음성 파일 로드에 실패했습니다."));
          };
          const cleanup = () => {
            audioElement.removeEventListener("canplay", onReady);
            audioElement.removeEventListener("error", onError);
          };
          audioElement.addEventListener("canplay", onReady, { once: true });
          audioElement.addEventListener("error", onError, { once: true });
        });
      }

      const captureFn =
        typeof audioElement.captureStream === "function"
          ? audioElement.captureStream.bind(audioElement)
          : typeof audioElement.mozCaptureStream === "function"
            ? audioElement.mozCaptureStream.bind(audioElement)
            : null;

      if (!captureFn) {
        throw new Error("이 브라우저는 오디오 요소 캡처(captureStream)를 지원하지 않습니다.");
      }

      reportStatus("테스트 모드: 업로드 음성 소스 연결 완료. 재생 버튼을 눌러 분석하세요.");
      return captureFn();
    }

    reportStatus("마이크 권한 요청 중...");
    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }

  function disconnect() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (diagnosticsTimer) {
      clearInterval(diagnosticsTimer);
      diagnosticsTimer = null;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "Finalize" }));
      ws.send(JSON.stringify({ type: "CloseStream" }));
    }

    try {
      processor?.disconnect();
      source?.disconnect();
      sink?.disconnect();
    } catch {
      // noop
    }

    mediaStream?.getTracks().forEach((track) => track.stop());
    audioContext?.close();
    ws?.close();

    ws = null;
    mediaStream = null;
    audioContext = null;
    processor = null;
    source = null;
    sink = null;

    onStatus("스트림 연결 종료");
  }

  function pause() {
    isPaused = true;
  }

  function resume() {
    isPaused = false;
  }

  return { connect, disconnect, pause, resume };
}

function computeRms(float32) {
  if (!float32 || !float32.length) return 0;
  let sumSquares = 0;
  for (let i = 0; i < float32.length; i += 1) {
    const sample = float32[i];
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / float32.length);
}
