import {
    Room,
    RoomEvent,
    Track,
    RemoteTrack,
    RemoteTrackPublication,
    RemoteParticipant,
    DataPacket_Kind,
    LocalTrack,
} from 'livekit-client';
import type {
    RymiCallDiagnosticEvent,
    RymiCallDiagnosticStage,
    RymiCallDiagnosticStatus,
    RymiCallEvents,
    RymiCallOptions,
    RymiCallStatus,
    RymiThinkingEvent,
    RymiTokenConnectionConfig,
    RymiTranscriptEvent,
} from './types';
import { EMPTY_TRANSCRIPT, applyTranscriptPacket, parseTranscriptPacket, type LiveTranscript } from './liveTranscript';

type EventKey = keyof RymiCallEvents;
type CredentialsResolver = () => Promise<RymiTokenConnectionConfig>;

type ConnectDiagnostics = {
    signalConnected: boolean;
    roomConnected: boolean;
    localAudioPublished: boolean;
    mediaDeviceError: string | null;
    connectionState: string | null;
    subscriptionFailures: string[];
};

function isPcConnectionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /could not establish pc connection/i.test(message);
}

function formatCallErrorMessage(message: string): string {
    if (/could not establish pc connection|webrtc media path|ice connection failed/i.test(message)) {
        return 'WebRTC connection failed. Check your firewall or network settings.';
    }
    if (/permission|notallowederror|microphone/i.test(message)) {
        return 'Microphone access denied. Please allow microphone permissions.';
    }
    if (/insufficient_quota|quota exceeded|429/i.test(message)) {
        return "The agent's voice provider is over quota. Check TTS provider billing.";
    }
    if (/unauthorized|401|403|invalid.*token|expired.*token/i.test(message)) {
        return 'Session token is invalid or expired. Refresh the page and try again.';
    }
    if (/timed? ?out|timeout/i.test(message)) {
        return 'The call timed out waiting for the agent. Try again.';
    }
    if (/autoplay|audio.*blocked|user gesture|NotAllowedError.*play/i.test(message)) {
        return 'Browser blocked audio playback. Tap the page to enable audio.';
    }
    return message;
}

function createCallError(message: string): Error {
    const error = new Error(formatCallErrorMessage(message));
    (error as Error & { rawMessage?: string }).rawMessage = message;
    return error;
}

function getAcousticTrackSettings(track: LocalTrack | null): Record<string, unknown> | undefined {
    const mediaStreamTrack = (track as any)?.mediaStreamTrack;
    if (!mediaStreamTrack || typeof mediaStreamTrack.getSettings !== 'function') return undefined;

    const settings = mediaStreamTrack.getSettings() as MediaTrackSettings & Record<string, unknown>;
    const details: Record<string, unknown> = {};
    for (const key of [
        'echoCancellation',
        'noiseSuppression',
        'autoGainControl',
        'voiceIsolation',
        'sampleRate',
        'channelCount',
        'latency',
    ]) {
        if (settings[key] !== undefined) details[key] = settings[key];
    }
    return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * Represents a single voice call with a Rymi AI agent.
 *
 * Do not construct directly — use `Rymi.createCall()`.
 */
export class RymiCall {
    private room: Room;
    private listeners = new Map<EventKey, Set<(...args: any[]) => void>>();
    private _status: RymiCallStatus = 'idle';
    private localAudioTrack: LocalTrack | null = null;
    private isConnecting = false;
    private remoteEndReason: string | null = null;
    private suppressDisconnectEvent = false;
    private _visibilityHandler: (() => void) | null = null;
    private transcriptHistory: RymiTranscriptEvent[] = [];
    private liveTranscript: LiveTranscript = EMPTY_TRANSCRIPT;
    private thinkingHistory: RymiThinkingEvent[] = [];
    private diagnosticHistory: RymiCallDiagnosticEvent[] = [];
    private connectDiagnostics: ConnectDiagnostics = {
        signalConnected: false,
        roomConnected: false,
        localAudioPublished: false,
        mediaDeviceError: null,
        connectionState: null,
        subscriptionFailures: []
    };

    private resolveCredentials: CredentialsResolver;
    private options: RymiCallOptions;

    /** @internal */
    constructor(
        resolveCredentials: CredentialsResolver,
        options: RymiCallOptions = {}
    ) {
        this.resolveCredentials = resolveCredentials;
        this.options = options;
        this.room = new Room({
            audioCaptureDefaults: {
                deviceId: { ideal: 'default' },
                // Keep echo cancellation (agent TTS plays through the caller's
                // speakers and would otherwise feed back into the mic) and AGC
                // (lifts quiet input toward a usable level for STT).
                echoCancellation: true,
                autoGainControl: true,
                // voiceIsolation and noiseSuppression are both enabled: on Windows + open speakers, browser
                // AEC alone doesn't fully cancel the agent's TTS bleeding into the
                // mic (macOS hardware AEC does), causing self-echo or STT filler.
                // Browsers ignore unsupported hints, so capture diagnostics below
                // log what was actually applied by the media stack.
                voiceIsolation: true,
                noiseSuppression: true,
            }
        });
        this._setupRoomListeners();
    }

    // ─── Public API ───

    /** Current call status. */
    get status(): RymiCallStatus {
        return this._status;
    }

    /** Mute the user's microphone. */
    mute(): void {
        try {
            if (this.localAudioTrack) {
                this.localAudioTrack.mute();
            }
        } catch (err) {
            console.warn('[Rymi] Failed to mute track:', err);
        }
    }

    /** Unmute the user's microphone. */
    unmute(): void {
        try {
            if (this.localAudioTrack) {
                this.localAudioTrack.unmute();
            }
        } catch (err) {
            console.warn('[Rymi] Failed to unmute track:', err);
        }
    }

    /** Returns true if the user's mic is muted. */
    get isMuted(): boolean {
        return this.localAudioTrack?.isMuted ?? false;
    }

    /**
     * Call this from a user-gesture handler (click/tap) if the browser blocked
     * audio playback. Listen for the `audioPlayback` event with `blocked: true`
     * to know when to prompt the user.
     */
    async resumeAudio(): Promise<void> {
        try {
            await this.room.startAudio();
            // Also re-play any attached agent audio elements that may be paused
            if (typeof document !== 'undefined') {
                document.querySelectorAll<HTMLAudioElement>('audio[data-rymi-audio]').forEach((el) => {
                    if (el.paused) el.play().catch(() => {});
                });
            }
        } catch (err) {
            console.warn('[Rymi] resumeAudio() failed:', err);
        }
    }

    /** True if the browser currently allows agent audio to play. */
    get canPlayAudio(): boolean {
        return this.room.canPlaybackAudio;
    }

    /** Connect the prepared call. Attach event listeners before calling this. */
    async connect(): Promise<this> {
        await this._connect();
        return this;
    }

    /** End the call. */
    async end(): Promise<void> {
        if (this._status === 'ended') return;

        const preserveErrorState = this._status === 'error';
        if (!preserveErrorState) {
            this._setStatus('ended');
        }

        await this._cleanupRoom();

        if (!preserveErrorState) {
            this._emit('ended', { reason: 'user_hangup' });
        }
    }

    /** Subscribe to call events. */
    on<K extends EventKey>(event: K, callback: RymiCallEvents[K]): this {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event)!.add(callback as any);

        // One-shot `Rymi.connect()` callers may subscribe after connection completes.
        if (event === 'started' && this._status === 'connected') {
            queueMicrotask(() => {
                (callback as RymiCallEvents['started'])();
            });
        }

        if (event === 'status') {
            const currentStatus = this._status;
            queueMicrotask(() => {
                (callback as RymiCallEvents['status'])(currentStatus);
            });
        }

        if (event === 'audioPlayback' && this._status === 'connected') {
            queueMicrotask(() => {
                (callback as RymiCallEvents['audioPlayback'])({ blocked: !this.room.canPlaybackAudio });
            });
        }

        if (event === 'transcript' && this.transcriptHistory.length > 0) {
            queueMicrotask(() => {
                for (const entry of this.transcriptHistory) {
                    (callback as RymiCallEvents['transcript'])(entry);
                }
            });
        }

        if (event === 'transcriptChange' && this.liveTranscript.entries.length > 0) {
            queueMicrotask(() => {
                (callback as RymiCallEvents['transcriptChange'])(this.liveTranscript);
            });
        }

        if (event === 'thinking' && this.thinkingHistory.length > 0) {
            queueMicrotask(() => {
                for (const entry of this.thinkingHistory) {
                    (callback as RymiCallEvents['thinking'])(entry);
                }
            });
        }

        if (event === 'diagnostic' && this.diagnosticHistory.length > 0) {
            queueMicrotask(() => {
                for (const entry of this.diagnosticHistory) {
                    (callback as RymiCallEvents['diagnostic'])(entry);
                }
            });
        }

        return this;
    }

    /** Unsubscribe from a call event. */
    off<K extends EventKey>(event: K, callback: RymiCallEvents[K]): this {
        this.listeners.get(event)?.delete(callback as any);
        return this;
    }

    // ─── Internal ───

    /** @internal Connects to the LiveKit room and publishes the user's microphone. */
    async _connect(): Promise<void> {
        if (this.isConnecting) {
            throw new Error('Call connection already in progress.');
        }
        if (this._status === 'connected') return;
        if (this._status === 'ended') {
            throw new Error('Cannot connect an ended call.');
        }

        this.isConnecting = true;
        this._setStatus('connecting');
        this.connectDiagnostics = {
            signalConnected: false,
            roomConnected: false,
            localAudioPublished: false,
            mediaDeviceError: null,
            connectionState: null,
            subscriptionFailures: []
        };

        try {
            this._emitDiagnostic('token', 'started', 'Preparing call access.');
            const { url, token } = await this.resolveCredentials();
            this._emitDiagnostic('token', 'ok', 'Call access ready.');
            if (await this._cleanupIfEnded()) return;

            this._emitDiagnostic('signaling', 'started', 'Connecting to voice session.');
            await this.room.connect(url, token);
            this._emitDiagnostic('signaling', 'ok', 'Voice session signaling connected.');
            if (await this._cleanupIfEnded()) return;

            // startAudio() needs a user-gesture context. It may fail silently if
            // the gesture was lost during awaits — in which case AudioPlaybackStatusChanged
            // will fire with blocked=true and the UI should call resumeAudio() from a click.
            try {
                this._emitDiagnostic('audio_playback', 'started', 'Starting browser audio playback.');
                await this.room.startAudio();
                this._emitDiagnostic('audio_playback', 'ok', 'Browser audio playback is ready.');
            } catch (audioErr) {
                this._emitDiagnostic('audio_playback', 'blocked', 'Browser blocked audio playback. User gesture required.');
                console.warn('[Rymi] startAudio() blocked (autoplay policy):', audioErr);
            }

            // Audio capture constraints are already set via Room.audioCaptureDefaults —
            // no need to repeat them here.
            this._emitDiagnostic('microphone', 'started', 'Starting microphone capture.');
            const micPublication = await this.room.localParticipant.setMicrophoneEnabled(true);
            this.localAudioTrack = micPublication?.audioTrack ?? null;
            this._emitDiagnostic(
                'microphone',
                'ok',
                'Microphone capture is ready.',
                getAcousticTrackSettings(this.localAudioTrack),
            );
            if (await this._cleanupIfEnded()) return;

            if (this.options.autoMic === false && this.localAudioTrack) {
                void this.localAudioTrack.mute();
            }

            this._setStatus('connected');
            this._emit('started');
            this._emitDiagnostic('agent_ready', 'ok', 'Call is ready.');

            // Emit initial audio playback state so the UI can show an "unmute" prompt
            // if autoplay was blocked (AudioPlaybackStatusChanged only fires on change).
            if (!this.room.canPlaybackAudio) {
                this._emit('audioPlayback', { blocked: true });
            }

            // Re-enable audio context if the tab was backgrounded and re-focused
            // (browsers can suspend the AudioContext while the tab is hidden).
            this._visibilityHandler = () => {
                if (document.visibilityState === 'visible' && this._status === 'connected') {
                    this.room.startAudio().catch(() => {});
                }
            };
            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', this._visibilityHandler);
            }
        } catch (err) {
            const mappedError = this._mapConnectError(err);
            this._emitDiagnostic(this._diagnosticStageForConnectError(mappedError), 'failed', mappedError.message);
            this._setStatus('error');
            this._emit('error', mappedError);

            this.suppressDisconnectEvent = true;
            try {
                await this.room.disconnect();
            } catch (disconnectErr) {
                console.warn('[Rymi] Error during failed connect cleanup:', disconnectErr);
            }

            throw mappedError;
        } finally {
            this.isConnecting = false;
        }
    }

    private _setupRoomListeners(): void {
        // Agent audio arrives as a remote track — auto-subscribe and attach to DOM
        this.room.on(
            RoomEvent.TrackSubscribed,
            (track: RemoteTrack, _pub: RemoteTrackPublication, _participant: RemoteParticipant) => {
                if (track.kind === Track.Kind.Audio) {
                    const el = track.attach();
                    el.setAttribute('data-rymi-audio', 'agent');
                    if (typeof document !== 'undefined') {
                        document.body.appendChild(el);
                    }
                    // Browsers may block autoplay if AudioContext wasn't resumed via a
                    // user gesture. Catch and warn rather than silently failing.
                    el.play().catch((playErr: unknown) => {
                        console.warn('[Rymi] Agent audio play() blocked — user gesture may be required:', playErr);
                    });
                }
            }
        );

        // Clean up attached audio elements on unsubscribe
        this.room.on(
            RoomEvent.TrackUnsubscribed,
            (track: RemoteTrack) => {
                if (track.kind === Track.Kind.Audio) {
                    track.detach().forEach((el) => el.remove());
                }
            }
        );

        // Browser autoplay policy: fires when agent audio is blocked or unblocked
        this.room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
            const canPlay = this.room.canPlaybackAudio;
            this._emit('audioPlayback', { blocked: !canPlay });
        });

        this.room.on(RoomEvent.SignalConnected, () => {
            this.connectDiagnostics.signalConnected = true;
        });

        this.room.on(RoomEvent.Connected, () => {
            this.connectDiagnostics.roomConnected = true;
        });

        this.room.on(RoomEvent.ConnectionStateChanged, (state: unknown) => {
            this.connectDiagnostics.connectionState = typeof state === 'string' ? state : String(state);
        });

        this.room.on(RoomEvent.LocalTrackPublished, (publication: any) => {
            if (publication?.kind === Track.Kind.Audio || publication?.track?.kind === Track.Kind.Audio) {
                this.connectDiagnostics.localAudioPublished = true;
            }
        });

        this.room.on(RoomEvent.TrackSubscriptionFailed, (trackSid: string) => {
            this.connectDiagnostics.subscriptionFailures.push(trackSid);
        });

        this.room.on(RoomEvent.MediaDevicesError, (error: Error) => {
            this.connectDiagnostics.mediaDeviceError = error?.message || 'Failed to access microphone.';
        });

        // Data channel messages (transcripts, thinking/status updates from gateway)
        this.room.on(RoomEvent.DataReceived, (payload: Uint8Array, _participant?: RemoteParticipant, _kind?: DataPacket_Kind) => {
            try {
                const text = new TextDecoder().decode(payload);
                const msg = JSON.parse(text);

                const packet = parseTranscriptPacket(msg);
                if (packet) {
                    const next = applyTranscriptPacket(this.liveTranscript, packet);
                    if (next !== this.liveTranscript) {
                        this.liveTranscript = next;
                        this._emit('transcriptChange', next);
                    }
                    if (packet.type === 'transcript') {
                        const event: RymiTranscriptEvent = {
                            role: packet.role,
                            text: packet.text,
                            final: packet.final,
                            ...(packet.turnKey ? { turnKey: packet.turnKey } : {}),
                        };
                        this._rememberTranscript(event);
                        this._emit('transcript', event);
                        return;
                    }
                    const sentence = {
                        role: 'agent',
                        turnKey: typeof msg.turnKey === 'string' ? msg.turnKey : '',
                        sentenceKey: packet.sentenceKey,
                        text: packet.text,
                        revealedChars: packet.revealedChars,
                        final: packet.final,
                    } as const;
                    this._emit('sentence', sentence);
                    if (sentence.final) {
                        const event: RymiTranscriptEvent = { role: 'agent', text: sentence.text, final: true, turnKey: sentence.sentenceKey };
                        this._rememberTranscript(event);
                        this._emit('transcript', event);
                    }
                    return;
                }

                if (msg.type === 'thinking' || msg.type === 'status') {
                    const text = typeof msg.text === 'string' ? msg.text : '';
                    if (!text.trim()) return;
                    const event: RymiThinkingEvent = { text };
                    this._rememberThinking(event);
                    this._emit('thinking', event);
                } else if (msg.type === 'call_error') {
                    const message = typeof msg.message === 'string' && msg.message.trim()
                        ? msg.message
                        : 'The call failed.';
                    this.remoteEndReason = typeof msg.code === 'string' && msg.code.trim()
                        ? msg.code
                        : 'agent_error';
                    this._setStatus('error');
                    this._emit('error', createCallError(message));
                } else if (msg.type === 'call_ended') {
                    const reason = typeof msg.reason === 'string' && msg.reason.trim()
                        ? msg.reason
                        : 'agent_hangup';
                    this._markEnded(reason);
                    void this._cleanupRoom();
                }
            } catch {
                // Non-JSON data, ignore
            }
        });

        // Disconnection
        this.room.on(RoomEvent.Disconnected, () => {
            if (this.suppressDisconnectEvent) {
                this.suppressDisconnectEvent = false;
                return;
            }

            this._markEnded(this.remoteEndReason || 'agent_hangup');
        });

        this.room.on(RoomEvent.Reconnecting, () => {
            this._setStatus('connecting');
        });

        this.room.on(RoomEvent.Reconnected, () => {
            this._setStatus('connected');
        });
    }

    private _mapConnectError(error: unknown): Error {
        if (this.connectDiagnostics.mediaDeviceError) {
            return new Error(`Microphone access failed: ${this.connectDiagnostics.mediaDeviceError}`);
        }

        if (isPcConnectionError(error)) {
            const detail = this.connectDiagnostics.signalConnected || this.connectDiagnostics.roomConnected
                ? 'LiveKit signaling connected, but the browser could not establish the WebRTC media path.'
                : 'The browser could not establish the WebRTC media path.';
            return new Error(
                `${detail} Check LiveKit TCP/UDP/TURN reachability and any VPN or firewall between the browser and LiveKit.`
            );
        }

        const message = error instanceof Error ? error.message : String(error);
        return createCallError(message);
    }

    private _diagnosticStageForConnectError(error: Error): RymiCallDiagnosticStage {
        if (this.connectDiagnostics.mediaDeviceError || /microphone/i.test(error.message)) {
            return 'microphone';
        }
        if (/audio|autoplay|playback/i.test(error.message)) {
            return 'audio_playback';
        }
        if (isPcConnectionError(error) || /webrtc|media path|ice/i.test(error.message)) {
            return 'media';
        }
        return this.connectDiagnostics.signalConnected ? 'media' : 'signaling';
    }

    private async _cleanupRoom(): Promise<void> {
        if (this._visibilityHandler) {
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', this._visibilityHandler);
            }
            this._visibilityHandler = null;
        }

        try {
            await this.room.disconnect();
        } catch (err) {
            console.warn('[Rymi] Error during disconnect:', err);
        }

        if (typeof document !== 'undefined') {
            document.querySelectorAll('audio[data-rymi-audio]').forEach((el) => el.remove());
        }
    }

    private async _cleanupIfEnded(): Promise<boolean> {
        if (this._status !== 'ended') return false;
        await this._cleanupRoom();
        return true;
    }

    private _rememberTranscript(event: RymiTranscriptEvent): void {
        // History is replayed to late subscribers, so keep only committed turns:
        // interims are ephemeral, and a superseding final replaces its earlier
        // fragment in place rather than stacking a duplicate.
        if (event.final === false) return;
        if (event.turnKey) {
            const idx = this.transcriptHistory.findIndex((e) => e.turnKey === event.turnKey);
            if (idx !== -1) {
                this.transcriptHistory[idx] = event;
                return;
            }
        }
        this.transcriptHistory.push(event);
        if (this.transcriptHistory.length > 100) {
            this.transcriptHistory.splice(0, this.transcriptHistory.length - 100);
        }
    }

    private _rememberThinking(event: RymiThinkingEvent): void {
        this.thinkingHistory.push(event);
        if (this.thinkingHistory.length > 50) {
            this.thinkingHistory.splice(0, this.thinkingHistory.length - 50);
        }
    }

    private _emitDiagnostic(
        stage: RymiCallDiagnosticStage,
        status: RymiCallDiagnosticStatus,
        message?: string,
        details?: Record<string, unknown>
    ): void {
        const event: RymiCallDiagnosticEvent = {
            stage,
            status,
            message,
            ...(details ? { details } : {}),
            timestamp: Date.now()
        };
        this.diagnosticHistory.push(event);
        if (this.diagnosticHistory.length > 50) {
            this.diagnosticHistory.splice(0, this.diagnosticHistory.length - 50);
        }
        this._emit('diagnostic', event);
    }

    private _setStatus(status: RymiCallStatus): void {
        this._status = status;
        this._emit('status', status);
    }

    private _markEnded(reason: string): void {
        if (this._status === 'ended' || this._status === 'error') return;
        this._setStatus('ended');
        this._emit('ended', { reason });
        this.remoteEndReason = null;
    }

    private _emit(event: EventKey, ...args: any[]): void {
        const handlers = this.listeners.get(event);
        if (handlers) {
            for (const fn of handlers) {
                try {
                    (fn as any)(...args);
                } catch (err) {
                    console.error(`[Rymi] Error in ${event} handler:`, err);
                }
            }
        }
    }
}
