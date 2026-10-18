import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  startAudio: vi.fn(),
  disconnect: vi.fn(),
  setMicrophoneEnabled: vi.fn(),
  roomOptions: [] as any[]
}));

vi.mock('livekit-client', () => {
  class MockRoom {
    private listeners = new Map<string, Set<(...args: any[]) => void>>();
    canPlaybackAudio = true;

    localParticipant = {
      setMicrophoneEnabled: (...args: any[]) => mocks.setMicrophoneEnabled(...args)
    };

    constructor(options: any) {
      mocks.roomOptions.push(options);
    }

    on(event: string, callback: (...args: any[]) => void) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(callback);
      return this;
    }

    emit(event: string, ...args: any[]) {
      for (const callback of this.listeners.get(event) ?? []) {
        callback(...args);
      }
    }

    connect(...args: any[]) {
      return mocks.connect.apply(this, args);
    }

    startAudio(...args: any[]) {
      return mocks.startAudio(...args);
    }

    disconnect(...args: any[]) {
      return mocks.disconnect(...args);
    }
  }

  return {
    Room: MockRoom,
    RoomEvent: {
      TrackSubscribed: 'trackSubscribed',
      TrackUnsubscribed: 'trackUnsubscribed',
      AudioPlaybackStatusChanged: 'audioPlaybackStatusChanged',
      SignalConnected: 'signalConnected',
      Connected: 'connected',
      ConnectionStateChanged: 'connectionStateChanged',
      LocalTrackPublished: 'localTrackPublished',
      TrackSubscriptionFailed: 'trackSubscriptionFailed',
      MediaDevicesError: 'mediaDevicesError',
      DataReceived: 'dataReceived',
      Disconnected: 'disconnected',
      Reconnecting: 'reconnecting',
      Reconnected: 'reconnected'
    },
    Track: {
      Kind: {
        Audio: 'audio'
      }
    },
    DataPacket_Kind: {}
  };
});

import { RymiCall } from './call';
import { Rymi } from './rymi';

function createTestCall() {
  return new RymiCall(async () => ({
    url: 'wss://example.invalid',
    token: 'token'
  }));
}

describe('RymiCall connect diagnostics', () => {
  beforeEach(() => {
    mocks.connect.mockReset();
    mocks.startAudio.mockReset();
    mocks.disconnect.mockReset();
    mocks.setMicrophoneEnabled.mockReset();
    mocks.roomOptions.length = 0;

    mocks.startAudio.mockResolvedValue(undefined);
    mocks.disconnect.mockResolvedValue(undefined);
    mocks.setMicrophoneEnabled.mockResolvedValue({ audioTrack: null });
  });

  it('requests browser noise suppression on the microphone track', () => {
    createTestCall();

    expect(mocks.roomOptions[0]?.audioCaptureDefaults).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: true
    });
  });

  it('emits applied microphone capture settings for acoustic debugging', async () => {
    mocks.connect.mockResolvedValue(undefined);
    mocks.setMicrophoneEnabled.mockResolvedValue({
      audioTrack: {
        mediaStreamTrack: {
          getSettings: () => ({
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            voiceIsolation: true,
            sampleRate: 48000,
            channelCount: 1,
            deviceId: 'do-not-log'
          })
        }
      }
    });

    const call = createTestCall();
    const diagnosticSpy = vi.fn();
    call.on('diagnostic', diagnosticSpy);

    await call._connect();

    expect(diagnosticSpy).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'microphone',
      status: 'ok',
      details: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        voiceIsolation: true,
        sampleRate: 48000,
        channelCount: 1
      }
    }));
    expect(diagnosticSpy).not.toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ deviceId: 'do-not-log' })
    }));
  });

  it('maps LiveKit peer connection failures to an actionable error and cleans up the partial room', async () => {
    mocks.connect.mockImplementation(function (this: { emit: (event: string, ...args: any[]) => void }) {
      this.emit('signalConnected');
      throw new Error('could not establish pc connection');
    });

    const call = createTestCall();
    const errorSpy = vi.fn();
    const endedSpy = vi.fn();
    call.on('error', errorSpy);
    call.on('ended', endedSpy);

    await expect(call._connect()).rejects.toThrow(
      'LiveKit signaling connected, but the browser could not establish the WebRTC media path.'
    );

    expect(call.status).toBe('error');
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(endedSpy).not.toHaveBeenCalled();
  });

  it('replays early transcript events to listeners attached after connect', async () => {
    const call = createTestCall();
    const payload = new TextEncoder().encode(JSON.stringify({
      type: 'transcript',
      role: 'agent',
      text: 'Hello from the agent'
    }));

    (call as any).room.emit('dataReceived', payload);

    const transcriptSpy = vi.fn();
    call.on('transcript', transcriptSpy);
    await Promise.resolve();

    expect(transcriptSpy).toHaveBeenCalledWith({
      role: 'agent',
      text: 'Hello from the agent',
      final: true
    });
  });

  it('streams interims with final:false and coalesces superseding finals by turnKey', async () => {
    const call = createTestCall();
    const transcriptSpy = vi.fn();
    call.on('transcript', transcriptSpy);

    const send = (payload: Record<string, unknown>) =>
      (call as any).room.emit('dataReceived', new TextEncoder().encode(JSON.stringify(payload)));

    // Interim → interim → committing final, all for the same growing turn.
    send({ type: 'transcript', role: 'user', text: 'Monday', final: false });
    send({ type: 'transcript', role: 'user', text: 'Monday, 6', final: false });
    send({ type: 'transcript', role: 'user', text: 'Monday, 6 PM.', final: true, turnKey: 'utk-A' });

    expect(transcriptSpy).toHaveBeenNthCalledWith(1, { role: 'user', text: 'Monday', final: false });
    expect(transcriptSpy).toHaveBeenNthCalledWith(2, { role: 'user', text: 'Monday, 6', final: false });
    expect(transcriptSpy).toHaveBeenNthCalledWith(3, {
      role: 'user', text: 'Monday, 6 PM.', final: true, turnKey: 'utk-A'
    });

    // A late subscriber replays committed history only: no interim fragments,
    // and the superseding final replaced its earlier turn row in place.
    send({ type: 'transcript', role: 'user', text: 'Monday, 6 PM. Actually 7.', final: true, turnKey: 'utk-A' });
    const lateSpy = vi.fn();
    call.on('transcript', lateSpy);
    await Promise.resolve();

    expect(lateSpy).toHaveBeenCalledTimes(1);
    expect(lateSpy).toHaveBeenCalledWith({
      role: 'user', text: 'Monday, 6 PM. Actually 7.', final: true, turnKey: 'utk-A'
    });
  });

  it('replays blocked audio state to listeners attached after connect', async () => {
    mocks.connect.mockResolvedValue(undefined);

    const call = createTestCall();
    (call as any).room.canPlaybackAudio = false;

    await call._connect();

    const audioPlaybackSpy = vi.fn();
    call.on('audioPlayback', audioPlaybackSpy);
    await Promise.resolve();

    expect(audioPlaybackSpy).toHaveBeenCalledWith({ blocked: true });
  });

  it('attaches and starts a subscribed agent audio track once', async () => {
    const call = createTestCall();
    const play = vi.fn().mockResolvedValue(undefined);
    const attach = vi.fn(() => ({
      setAttribute: vi.fn(),
      play
    }));

    (call as any).room.emit('trackSubscribed', { kind: 'audio', attach }, {}, {});

    expect(attach).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('replays connection diagnostics to listeners attached after connect', async () => {
    mocks.connect.mockResolvedValue(undefined);

    const call = createTestCall();

    await call._connect();

    const diagnosticSpy = vi.fn();
    call.on('diagnostic', diagnosticSpy);
    await Promise.resolve();

    expect(diagnosticSpy).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'signaling',
      status: 'started',
      message: 'Connecting to voice session.'
    }));
    expect(diagnosticSpy).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'agent_ready',
      status: 'ok',
      message: 'Call is ready.'
    }));
  });

  it('connects a prepared call with explicit token credentials through the public SDK contract', async () => {
    mocks.connect.mockResolvedValue(undefined);
    const diagnosticSpy = vi.fn();
    const statusSpy = vi.fn();

    const call = Rymi.createCall({
      url: 'wss://example.invalid',
      token: 'token',
      autoMic: false
    });
    call.on('diagnostic', diagnosticSpy);
    call.on('status', statusSpy);
    await call.connect();
    await Promise.resolve();

    expect(call).toBeInstanceOf(RymiCall);
    expect(mocks.connect).toHaveBeenCalledWith('wss://example.invalid', 'token');
    expect(statusSpy).toHaveBeenCalledWith('idle');
    expect(statusSpy).toHaveBeenCalledWith('connecting');
    expect(statusSpy).toHaveBeenCalledWith('connected');
    expect(diagnosticSpy).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'token',
      status: 'started',
      message: 'Preparing call access.'
    }));
    expect(diagnosticSpy).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'signaling',
      status: 'started',
      message: 'Connecting to voice session.'
    }));
    expect(diagnosticSpy).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'agent_ready',
      status: 'ok',
      message: 'Call is ready.'
    }));

    await call.end();
  });

  it('does not convert an errored call into an ended call during cleanup', async () => {
    const call = createTestCall();
    const endedSpy = vi.fn();
    call.on('ended', endedSpy);

    const payload = new TextEncoder().encode(JSON.stringify({
      type: 'call_error',
      message: 'TTS provider quota exceeded'
    }));
    (call as any).room.emit('dataReceived', payload);

    await call.end();

    expect(call.status).toBe('error');
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(endedSpy).not.toHaveBeenCalled();
  });

  it('ends immediately when the gateway sends a call_ended packet', async () => {
    const call = createTestCall();
    const statusSpy = vi.fn();
    const endedSpy = vi.fn();
    call.on('status', statusSpy);
    call.on('ended', endedSpy);

    const payload = new TextEncoder().encode(JSON.stringify({
      type: 'call_ended',
      reason: 'end_call_tool'
    }));
    (call as any).room.emit('dataReceived', payload);

    await Promise.resolve();

    expect(call.status).toBe('ended');
    expect(statusSpy).toHaveBeenCalledWith('ended');
    expect(endedSpy).toHaveBeenCalledWith({ reason: 'end_call_tool' });
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('RymiCall sentence events', () => {
  beforeEach(() => {
    mocks.connect.mockReset();
    mocks.startAudio.mockReset();
    mocks.disconnect.mockReset();
    mocks.setMicrophoneEnabled.mockReset();
    mocks.roomOptions.length = 0;
    mocks.startAudio.mockResolvedValue(undefined);
    mocks.disconnect.mockResolvedValue(undefined);
    mocks.setMicrophoneEnabled.mockResolvedValue({ audioTrack: null });
  });

  const send = (call: any, payload: Record<string, unknown>) =>
    call.room.emit('dataReceived', new TextEncoder().encode(JSON.stringify(payload)));

  const makeCallHarness = () => {
    const call = createTestCall();
    const fireData = (payload: Record<string, unknown>) => {
      (call as any).room.emit('dataReceived', new TextEncoder().encode(JSON.stringify(payload)));
    };
    return { call, fireData };
  };

  it('emits a sentence event for a transcript_sentence packet', () => {
    const { call, fireData } = makeCallHarness();
    const seen: any[] = [];
    call.on('sentence', (e) => seen.push(e));
    fireData({
        type: 'transcript_sentence', role: 'agent', turnKey: 'a1',
        sentenceKey: 'a1#0', text: 'Hello there.', revealedChars: 6, final: false,
    });
    expect(seen).toEqual([{
        role: 'agent', turnKey: 'a1', sentenceKey: 'a1#0',
        text: 'Hello there.', revealedChars: 6, final: false,
    }]);
  });

  it('emits sentence event when a transcript_sentence packet arrives', () => {
    const call = createTestCall();
    const sentenceSpy = vi.fn();
    (call as any).on('sentence', sentenceSpy);

    send(call, {
      type: 'transcript_sentence',
      role: 'agent',
      turnKey: 'a1',
      sentenceKey: 'a1#0',
      text: 'Hello there.',
      revealedChars: 6,
      final: false,
    });

    expect(sentenceSpy).toHaveBeenCalledWith({
      role: 'agent',
      turnKey: 'a1',
      sentenceKey: 'a1#0',
      text: 'Hello there.',
      revealedChars: 6,
      final: false,
    });
  });

  it('emits the projected transcript on every transcript packet', () => {
    const { call, fireData } = makeCallHarness();
    const seen: any[] = [];
    call.on('transcriptChange', (t) => seen.push(t));
    fireData({ type: 'transcript_sentence', role: 'agent', turnKey: 'a1', sentenceKey: 'a1#0', text: 'Hello there.', revealedChars: 5, final: false });
    fireData({ type: 'transcript', role: 'agent', text: 'Hello there.', final: true, turnKey: 'a1#0' });
    expect(seen).toHaveLength(1); // the agent transcript duplicates the sentence and changes nothing
    expect(seen[0].entries).toEqual([{ id: 'sent-a1#0', role: 'agent', text: 'Hello there.', revealedChars: 5, pending: true }]);
  });

  it('drops transcript_sentence packets with empty text', () => {
    const call = createTestCall();
    const sentenceSpy = vi.fn();
    (call as any).on('sentence', sentenceSpy);

    send(call, {
      type: 'transcript_sentence',
      role: 'agent',
      turnKey: 'a1',
      sentenceKey: 'a1#0',
      text: '',
      revealedChars: 0,
      final: false,
    });

    expect(sentenceSpy).not.toHaveBeenCalled();
  });

  it('emits sentence events for both partial and final packets', () => {
    const call = createTestCall();
    const sentences: any[] = [];
    (call as any).on('sentence', (e: any) => sentences.push(e));

    send(call, { type: 'transcript_sentence', role: 'agent', turnKey: 'a1', sentenceKey: 'a1#0', text: 'Hi.', revealedChars: 2, final: false });
    send(call, { type: 'transcript_sentence', role: 'agent', turnKey: 'a1', sentenceKey: 'a1#0', text: 'Hi.', revealedChars: 3, final: true });

    expect(sentences).toHaveLength(2);
    expect(sentences[0].final).toBe(false);
    expect(sentences[1].final).toBe(true);
    expect(sentences[1].revealedChars).toBe(3);
  });

  it('also emits a final agent transcript for final sentence packets', () => {
    const call = createTestCall();
    const transcriptSpy = vi.fn();
    (call as any).on('transcript', transcriptSpy);

    send(call, {
      type: 'transcript_sentence',
      role: 'agent',
      turnKey: 'a1',
      sentenceKey: 'a1#0',
      text: 'Hi.',
      revealedChars: 3,
      final: true,
    });

    expect(transcriptSpy).toHaveBeenCalledWith({
      role: 'agent',
      text: 'Hi.',
      final: true,
      turnKey: 'a1#0',
    });
  });
});
