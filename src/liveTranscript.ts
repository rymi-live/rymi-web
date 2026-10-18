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

export type TranscriptPacket =
    | { type: 'transcript'; role: TranscriptRole; text: string; final: boolean; turnKey: string | null }
    | { type: 'transcript_sentence'; sentenceKey: string; text: string; revealedChars: number; final: boolean };

export interface LiveTranscript {
    entries: TranscriptEntry[];
    /**
     * True once this call produced a karaoke sentence. The two agent wire modes are
     * exclusive: on the sentence wire an agent `transcript` duplicates text the
     * sentences already drew; on a realtime stack it is the only agent text.
     */
    karaoke: boolean;
}

export const EMPTY_TRANSCRIPT: LiveTranscript = { entries: [], karaoke: false };

/** Placeholder row shown while agent audio plays before its text arrives. */
export const SPEAKING_AGENT_ID = 'speaking-agent';

export function parseTranscriptPacket(msg: unknown): TranscriptPacket | null {
    if (!msg || typeof msg !== 'object') return null;
    const m = msg as Record<string, unknown>;
    if (typeof m.text !== 'string' || !m.text.trim()) return null;
    if (m.type === 'transcript') {
        return {
            type: 'transcript',
            role: m.role === 'user' ? 'user' : 'agent',
            text: m.text,
            // Relays that omit the flag mean final (roomHandler.ts LiveKit transcription wire).
            final: m.final !== false,
            turnKey: typeof m.turnKey === 'string' && m.turnKey ? m.turnKey : null,
        };
    }
    if (m.type === 'transcript_sentence' && typeof m.sentenceKey === 'string') {
        return {
            type: 'transcript_sentence',
            sentenceKey: m.sentenceKey,
            text: m.text,
            revealedChars: typeof m.revealedChars === 'number' ? m.revealedChars : m.text.length,
            final: m.final === true,
        };
    }
    return null;
}

/** Pure projection of one packet onto rows (no wire-mode rule). */
export function reduceEntries(entries: TranscriptEntry[], packet: TranscriptPacket): TranscriptEntry[] {
    const base = entries.filter((e) => e.id !== SPEAKING_AGENT_ID);

    if (packet.type === 'transcript_sentence') {
        const id = `sent-${packet.sentenceKey}`;
        const existing = base.find((e) => e.id === id);
        const revealedChars = packet.final ? packet.text.length : packet.revealedChars;
        if (existing) {
            if (existing.pending === false && !packet.final) return base;
            return base.map((e) =>
                e.id === id ? { ...e, text: packet.text, revealedChars, pending: !packet.final } : e,
            );
        }
        return [...base, { id, role: 'agent', text: packet.text, revealedChars, pending: !packet.final }];
    }

    const { role, text, final, turnKey } = packet;
    if (turnKey) {
        const turnId = `turn-${turnKey}`;
        const existing = base.find((e) => e.id === turnId);
        if (!final) {
            if (existing && existing.pending !== true) return base;
            if (existing) return base.map((e) => (e.id === turnId ? { ...e, text, pending: true } : e));
            return [...base, { id: turnId, role, text, pending: true }];
        }
        const cleaned = base.filter((e) => e.id !== `pending-${role}`);
        if (cleaned.some((e) => e.id === turnId)) {
            return cleaned.map((e) => (e.id === turnId ? { ...e, text, pending: false } : e));
        }
        return [...cleaned, { id: turnId, role, text, pending: false }];
    }

    const pendingId = `pending-${role}`;
    if (!final) {
        if (base.some((e) => e.id === pendingId)) return base.map((e) => (e.id === pendingId ? { ...e, text } : e));
        return [...base, { id: pendingId, role, text, pending: true }];
    }
    const pendingIdx = base.findIndex((e) => e.id === pendingId);
    if (pendingIdx !== -1) {
        return base.map((e, i) => (i === pendingIdx ? { id: `final-${role}-${base.length}`, role, text, pending: false } : e));
    }
    return [...base, { id: `final-${role}-${base.length}`, role, text, pending: false }];
}

export function applyTranscriptPacket(t: LiveTranscript, packet: TranscriptPacket): LiveTranscript {
    if (packet.type === 'transcript_sentence') {
        return { entries: reduceEntries(t.entries, packet), karaoke: true };
    }
    if (packet.role === 'agent' && t.karaoke) return t;
    return { ...t, entries: reduceEntries(t.entries, packet) };
}

export function markAgentSpeaking(t: LiveTranscript): LiveTranscript {
    if (t.entries.some((e) => e.id === SPEAKING_AGENT_ID || (e.role === 'agent' && e.pending))) return t;
    return { ...t, entries: [...t.entries, { id: SPEAKING_AGENT_ID, role: 'agent', text: '', pending: true }] };
}

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
const stripWhitespace = (value: string) => value.replace(/\s+/g, '');
const joinText = (entries: TranscriptEntry[]) => normalize(entries.map((e) => e.text.trim()).join(' '));

/** A database transcript row backfilling a browser call (Studio's DB monitor). */
export function applyPersistedRow(
    t: LiveTranscript,
    row: { role: TranscriptRole; text: string; sequence: number },
): LiveTranscript {
    const prev = t.entries;
    const text = normalize(row.text);
    if (!text) return t;
    const id = `persisted-${row.sequence}`;
    if (prev.some((p) => p.id === id)) {
        return { ...t, entries: prev.map((p) => (p.id === id ? { ...p, role: row.role, text, pending: false } : p)) };
    }
    // Live karaoke bubbles are final: never collapse them into the persisted paragraph.
    if (row.role === 'agent') {
        const live = stripWhitespace(prev.filter((p) => p.id.startsWith('sent-')).map((p) => p.text).join(''));
        if (live && live.includes(stripWhitespace(text))) return t;
    }
    if (prev.some((p) => p.role === row.role && normalize(p.text) === text)) return t;

    let best: { start: number; end: number } | null = null;
    for (let start = 0; start < prev.length; start += 1) {
        if (prev[start].role !== row.role) continue;
        for (let end = start; end < prev.length && prev[end].role === row.role; end += 1) {
            const combined = joinText(prev.slice(start, end + 1));
            if (!combined) continue;
            if (text === combined || text.startsWith(`${combined} `) || combined.startsWith(`${text} `)) {
                if (!best || end - start > best.end - best.start) best = { start, end };
            }
        }
    }
    const persisted: TranscriptEntry = { id, role: row.role, text, pending: false };
    if (best) return { ...t, entries: [...prev.slice(0, best.start), persisted, ...prev.slice(best.end + 1)] };
    return { ...t, entries: [...prev, persisted] };
}

/** A polled transcript row on a phone call: one bubble per sequence, grown in place. */
export function applyPolledRow(
    t: LiveTranscript,
    row: { role: TranscriptRole; text: string; sequence: number },
): LiveTranscript {
    if (!row.text.trim()) return t;
    const id = `seq-${row.sequence}`;
    const entries = t.entries.some((e) => e.id === id)
        ? t.entries.map((e) => (e.id === id ? { ...e, text: row.text } : e))
        : [...t.entries, { id, role: row.role, text: row.text }];
    return { ...t, entries };
}
