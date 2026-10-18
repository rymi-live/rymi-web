/**
 * Event map for RymiCall.
 */
export interface RymiCallEvents {
    /** Fired when the microphone is connected and the call is live. */
    started: () => void;
    /** Fired when the AI (or user) speaks — provides a text transcript. */
    transcript: (data: RymiTranscriptEvent) => void;
    /** The live transcript, projected and ready to render. Fired after every transcript packet. */
    transcriptChange: (transcript: import('./liveTranscript').LiveTranscript) => void;
    /** Fired when the AI is "thinking" (processing user input). */
    thinking: (data?: RymiThinkingEvent) => void;
    /**
    /** Fired as the agent speaks each sentence (word-by-word reveal). */
    sentence: (data: RymiSentenceEvent) => void;
    /** Fired when the call ends (user or agent hangup). */
    ended: (data: { reason: string }) => void;
    /** Fired on any error. */
    error: (error: Error) => void;
    /** Fired when the call status changes. */
    status: (status: RymiCallStatus) => void;
    /**
     * Fired when browser autoplay policy blocks/unblocks agent audio.
     * When `blocked: true`, the UI MUST show a button that calls
     * `call.resumeAudio()` from a user gesture to unblock playback.
     */
    audioPlayback: (data: { blocked: boolean }) => void;
    /** Fired for connection lifecycle diagnostics suitable for UI progress displays. */
    diagnostic: (data: RymiCallDiagnosticEvent) => void;
}

export type RymiCallStatus = 'idle' | 'connecting' | 'connected' | 'ended' | 'error';

export type RymiCallDiagnosticStage =
    | 'token'
    | 'signaling'
    | 'media'
    | 'microphone'
    | 'agent_ready'
    | 'audio_playback';

export type RymiCallDiagnosticStatus = 'started' | 'ok' | 'failed' | 'blocked';

export interface RymiCallDiagnosticEvent {
    stage: RymiCallDiagnosticStage;
    status: RymiCallDiagnosticStatus;
    message?: string;
    details?: Record<string, unknown>;
    timestamp: number;
}

export interface RymiTranscriptEvent {
    role: 'agent' | 'user';
    text: string;
    /**
     * False while this is an interim STT result still being refined; true (or
     * omitted, for back-compat) once the turn is committed. Consumers should
     * render interims as a single in-place bubble and replace it on the final.
     */
    final?: boolean;
    /**
     * Stable key for a caller turn that grows across superseding fragments
     * ("Monday" → "Monday, 6 PM"). Use it to update one bubble in place instead
     * of appending a duplicate. Absent on agent turns and interims.
     */
    turnKey?: string;
}

export interface RymiThinkingEvent {
    text?: string;
}

export interface RymiSentenceEvent {
    role: 'agent';
    turnKey: string;
    sentenceKey: string;
    /** Full sentence text. */
    text: string;
    /** Chars revealed so far (word-snapped karaoke cursor). */
    revealedChars: number;
    /** True when this sentence is committed (pinned, fully revealed). */
    final: boolean;
}

export interface RymiCallOptions {
    /** Set to false to start muted (default: true). */
    autoMic?: boolean;
}

export interface RymiTokenConnectionConfig extends RymiCallOptions {
    /** LiveKit WebSocket URL returned by the Rymi API. */
    url: string;
    /** Participant-scoped LiveKit token returned by the Rymi API. */
    token: string;
}

export interface RymiPublishableConfig extends RymiCallOptions {
    /** The frontend publishable SDK key (starts with sb_publishable_; legacy rymi_pk_ keys are still accepted). */
    publishableKey: string;
    /** Defaults to https://api.rymi.live */
    apiUrl?: string;
    /** Optional browser participant identity. Defaults to browser. */
    identity?: string;
    /** Optional call metadata forwarded to the backend when creating the session. */
    metadata?: Record<string, unknown>;
}

export type RymiConnectionConfig = RymiTokenConnectionConfig | RymiPublishableConfig;
