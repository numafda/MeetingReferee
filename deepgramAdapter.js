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

function extractSpeakerId(alt) {
  const speakers = (alt?.words ?? [])
    .map((word) => Number(word?.speaker))
    .filter((n) => Number.isFinite(n));

  if (!speakers.length) return null;

  const counts = new Map();
  speakers.forEach((s) => counts.set(s, (counts.get(s) ?? 0) + 1));
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return dominant === undefined ? null : `speaker_${dominant + 1}`;
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

  return {
    id: uuid(),
    speaker_id: isFinal ? extractSpeakerId(alt) : null,
    transcript: text,
    start_time: Math.round(startSec * 1000),
    end_time: Math.round(endSec * 1000),
    duration: Math.max(100, Math.round((endSec - startSec) * 1000)),
    created_at: Date.now(),
    is_final: isFinal,
  };
}

export function createDeepgramRealtimeClient({ getAuthCredential, onUtterance, onStatus, onError }) {
  let ws = null;
  let mediaStream = null;
  let audioContext = null;
  let processor = null;
  let source = null;
  let sink = null;
  let keepAliveTimer = null;

  async function connect() {
    if (!window.isSecureContext) {
      throw new Error("마이크 접근을 위해 localhost 또는 HTTPS 환경이 필요합니다.");
    }

    onStatus("마이크 권한 요청 중...");
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

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

      const float32 = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleBuffer(float32, audioContext.sampleRate, TARGET_SAMPLE_RATE);
      const pcm = to16BitPCM(downsampled);
      ws.send(pcm);
    };

    source.connect(processor);
    processor.connect(sink);
    sink.connect(audioContext.destination);

    keepAliveTimer = window.setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, 10000);

    onStatus("Deepgram 실시간 스트림 연결됨");
  }

  function disconnect() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
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

  return { connect, disconnect };
}
