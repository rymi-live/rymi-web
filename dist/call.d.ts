import { RymiCallEvents, RymiCallOptions, RymiCallStatus, RymiTokenConnectionConfig } from './types';

type EventKey = keyof RymiCallEvents;
type CredentialsResolver = () => Promise<RymiTokenConnectionConfig>;
/**
 * Represents a single voice call with a Rymi AI agent.
 *
 * Do not construct directly — use `Rymi.createCall()`.
 */
export declare class RymiCall {
    private room;
    private listeners;
    private _status;
    private localAudioTrack;
    private isConnecting;
    private remoteEndReason;
    private suppressDisconnectEvent;
    private _visibilityHandler;
    private transcriptHistory;
    private liveTranscript;
    private thinkingHistory;
    private diagnosticHistory;
    private connectDiagnostics;
    private resolveCredentials;
    private options;
    /** @internal */
    constructor(resolveCredentials: CredentialsResolver, options?: RymiCallOptions);
    /** Current call status. */
    get status(): RymiCallStatus;
    /** Mute the user's microphone. */
    mute(): void;
    /** Unmute the user's microphone. */
    unmute(): void;
    /** Returns true if the user's mic is muted. */
    get isMuted(): boolean;
    /**
     * Call this from a user-gesture handler (click/tap) if the browser blocked
     * audio playback. Listen for the `audioPlayback` event with `blocked: true`
     * to know when to prompt the user.
     */
    resumeAudio(): Promise<void>;
    /** True if the browser currently allows agent audio to play. */
    get canPlayAudio(): boolean;
    /** Connect the prepared call. Attach event listeners before calling this. */
    connect(): Promise<this>;
    /** End the call. */
    end(): Promise<void>;
    /** Subscribe to call events. */
    on<K extends EventKey>(event: K, callback: RymiCallEvents[K]): this;
    /** Unsubscribe from a call event. */
    off<K extends EventKey>(event: K, callback: RymiCallEvents[K]): this;
    /** @internal Connects to the LiveKit room and publishes the user's microphone. */
    _connect(): Promise<void>;
    private _setupRoomListeners;
    private _mapConnectError;
    private _diagnosticStageForConnectError;
    private _cleanupRoom;
    private _cleanupIfEnded;
    private _rememberTranscript;
    private _rememberThinking;
    private _emitDiagnostic;
    private _setStatus;
    private _markEnded;
    private _emit;
}
export {};
//# sourceMappingURL=call.d.ts.map