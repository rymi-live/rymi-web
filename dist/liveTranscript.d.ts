/**
 * The live transcript, for every browser surface: the Studio test panel, the
 * landing demo and @rymi/react. One parser for the wire packets the gateway relays
 * publish (apps/gateway transcriptRelay.ts, apps/gateway-pipecat transcript_relay.py)
 * and one projection onto rendered rows. Nothing else in the browser may
 * interpret transcript packets.
 */
export type TranscriptRole = 'agent' | 'user';
export interface TranscriptEntry {
    id: string;
    role: TranscriptRole;
    text: string;
    /** True while this row is still being refined (interim STT, or a sentence still revealing). */
    pending?: boolean;
    /** Agent karaoke: characters revealed so far. */
    revealedChars?: number;
}
export type TranscriptPacket = {
    type: 'transcript';
    role: TranscriptRole;
    text: string;
    final: boolean;
    turnKey: string | null;
} | {
    type: 'transcript_sentence';
    sentenceKey: string;
    text: string;
    revealedChars: number;
    final: boolean;
};
export interface LiveTranscript {
    entries: TranscriptEntry[];
    /**
     * True once this call produced a karaoke sentence. The two agent wire modes are
     * exclusive: on the sentence wire an agent `transcript` duplicates text the
     * sentences already drew; on a realtime stack it is the only agent text.
     */
    karaoke: boolean;
}
export declare const EMPTY_TRANSCRIPT: LiveTranscript;
/** Placeholder row shown while agent audio plays before its text arrives. */
export declare const SPEAKING_AGENT_ID = "speaking-agent";
export declare function parseTranscriptPacket(msg: unknown): TranscriptPacket | null;
/** Pure projection of one packet onto rows (no wire-mode rule). */
export declare function reduceEntries(entries: TranscriptEntry[], packet: TranscriptPacket): TranscriptEntry[];
export declare function applyTranscriptPacket(t: LiveTranscript, packet: TranscriptPacket): LiveTranscript;
export declare function markAgentSpeaking(t: LiveTranscript): LiveTranscript;
/** A database transcript row backfilling a browser call (Studio's DB monitor). */
export declare function applyPersistedRow(t: LiveTranscript, row: {
    role: TranscriptRole;
    text: string;
    sequence: number;
}): LiveTranscript;
/** A polled transcript row on a phone call: one bubble per sequence, grown in place. */
export declare function applyPolledRow(t: LiveTranscript, row: {
    role: TranscriptRole;
    text: string;
    sequence: number;
}): LiveTranscript;
//# sourceMappingURL=liveTranscript.d.ts.map