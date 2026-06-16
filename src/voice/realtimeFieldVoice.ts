type RealtimeVoiceEvent =
  | { type: 'status'; status: string }
  | { type: 'user_transcript'; text: string; final: boolean }
  | { type: 'assistant_text'; text: string }
  | { type: 'audio_chunk'; base64: string; mimeType: string }
  | { type: 'error'; message: string };

type RealtimeVoiceContext = {
  messages: { role: 'user' | 'assistant'; content: string }[];
  doctrine: string;
  jobContext: string;
  voiceId: string;
};

type RealtimeFieldVoiceOptions = {
  wsUrl: string;
  mobileApiToken: string;
  getContext: () => RealtimeVoiceContext;
  onEvent: (event: RealtimeVoiceEvent) => void;
};

const SAMPLE_RATE = 16000;
const CHANNELS = 1;

function float32ToPcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function toFloat32Array(data: unknown): Float32Array {
  if (data instanceof Float32Array) return data;
  if (Array.isArray(data)) return Float32Array.from(data);
  return new Float32Array();
}

export function createRealtimeFieldVoice(options: RealtimeFieldVoiceOptions) {
  let socket: WebSocket | null = null;
  let recorder: any = null;
  let audioStudio: any = null;
  let active = false;

  const emit = (event: RealtimeVoiceEvent) => options.onEvent(event);

  const sendJson = (payload: Record<string, unknown>) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  };

  const connect = () =>
    new Promise<void>((resolve, reject) => {
      socket = new WebSocket(options.wsUrl);
      socket.binaryType = 'arraybuffer';

      socket.onopen = () => {
        sendJson({
          type: 'hello',
          token: options.mobileApiToken,
          sampleRate: SAMPLE_RATE,
          channels: CHANNELS,
          context: options.getContext(),
        });
        emit({ type: 'status', status: 'Realtime connected' });
        resolve();
      };

      socket.onerror = () => {
        reject(new Error('Realtime voice socket failed'));
      };

      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as RealtimeVoiceEvent;
          emit(event);
        } catch {
          emit({ type: 'error', message: 'Unreadable realtime voice event' });
        }
      };

      socket.onclose = () => {
        if (active) emit({ type: 'status', status: 'Realtime disconnected' });
      };
    });

  const start = async () => {
    if (active) return;
    if (!options.wsUrl) throw new Error('Realtime voice gateway URL is missing');

    active = true;
    emit({ type: 'status', status: 'Starting realtime voice' });

    const module = await import('@siteed/audio-studio');
    audioStudio = module.AudioStudioModule;
    if (!audioStudio?.startRecording) {
      active = false;
      throw new Error('Native audio streaming is unavailable in this build');
    }

    await connect();

    recorder = await audioStudio.startRecording({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      encoding: 'pcm_32bit',
      streamFormat: 'float32',
      interval: 100,
      bufferDurationSeconds: 0.1,
      keepAwake: true,
      output: { primary: { enabled: false } },
      enableProcessing: true,
      keepFullAnalysis: false,
      segmentDurationMs: 100,
      features: { rms: true, zcr: true },
      onAudioStream: async (event: { data: unknown }) => {
        if (!active || !socket || socket.readyState !== WebSocket.OPEN) return;
        const samples = toFloat32Array(event.data);
        if (!samples.length) return;
        socket.send(float32ToPcm16(samples));
      },
    });

    emit({ type: 'status', status: 'Realtime listening' });
  };

  const updateContext = () => {
    sendJson({ type: 'context', context: options.getContext() });
  };

  const stop = async () => {
    active = false;
    try {
      if (audioStudio?.stopRecording) await audioStudio.stopRecording();
      else if (recorder?.stopRecording) await recorder.stopRecording();
    } catch {}
    try {
      socket?.close();
    } catch {}
    socket = null;
    recorder = null;
    emit({ type: 'status', status: 'Realtime stopped' });
  };

  return {
    start,
    stop,
    updateContext,
  };
}
