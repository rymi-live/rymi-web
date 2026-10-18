/**
 * The one live-transcript projection. Every case in the shared corpus runs
 * through it; the wire-mode and persisted-row rules that the Studio panel and
 * landing demo used to implement separately are pinned here once.
 */
import { describe, expect, it } from 'vitest';
import {
    EMPTY_TRANSCRIPT,
    SPEAKING_AGENT_ID,
    applyPersistedRow,
    applyPolledRow,
    applyTranscriptPacket,
    markAgentSpeaking,
    parseTranscriptPacket,
    reduceEntries,
    type TranscriptEntry,
} from './liveTranscript';
import { PARITY_CASES, PERSISTED_CASES, type WirePacket } from '../../../test/fixtures/liveTranscriptCorpus';

const fold = (packets: WirePacket[], initial: TranscriptEntry[] = []) =>
    packets.reduce((acc, p) => reduceEntries(acc, p), initial);

describe('corpus', () => {
    for (const c of PARITY_CASES) {
        it(c.name, () => expect(fold(c.packets)).toEqual(c.expected));
    }
    for (const c of PERSISTED_CASES) {
        it(`persisted: ${c.name}`, () => {
            const before = { ...EMPTY_TRANSCRIPT, entries: c.live };
            const after = applyPersistedRow(before, c.entry);
            // 'unchanged' pins referential identity: the no-swap guarantee.
            if (c.expected === 'unchanged') expect(after).toBe(before);
            else expect(after.entries).toEqual(c.expected);
        });
    }
});

describe('wire mode', () => {
    const sentence = { type: 'transcript_sentence', sentenceKey: 'a1#0', text: 'Hello there.', revealedChars: 12, final: true } as const;
    const agentFinal = { type: 'transcript', role: 'agent', text: 'Hello there.', final: true, turnKey: 'a1#0' } as const;

    it('an agent transcript after a sentence is a duplicate and is dropped', () => {
        const t = applyTranscriptPacket(applyTranscriptPacket(EMPTY_TRANSCRIPT, sentence), agentFinal);
        expect(t.entries).toHaveLength(1);
        expect(t.karaoke).toBe(true);
    });

    it('realtime (no sentences) renders the agent transcript', () => {
        const t = applyTranscriptPacket(EMPTY_TRANSCRIPT, agentFinal);
        expect(t.entries).toEqual([{ id: 'turn-a1#0', role: 'agent', text: 'Hello there.', pending: false }]);
    });
});

describe('parseTranscriptPacket', () => {
    it('defaults a missing final to true and a missing turnKey to null', () => {
        expect(parseTranscriptPacket({ type: 'transcript', role: 'user', text: 'hi' }))
            .toEqual({ type: 'transcript', role: 'user', text: 'hi', final: true, turnKey: null });
    });
    it('reads a sentence packet', () => {
        expect(parseTranscriptPacket({ type: 'transcript_sentence', sentenceKey: 'k', text: 'Hi.', revealedChars: 2, final: false }))
            .toEqual({ type: 'transcript_sentence', sentenceKey: 'k', text: 'Hi.', revealedChars: 2, final: false });
    });
    it('ignores other packet types and blank text', () => {
        expect(parseTranscriptPacket({ type: 'thinking', text: 'x' })).toBeNull();
        expect(parseTranscriptPacket({ type: 'transcript', role: 'user', text: '   ' })).toBeNull();
    });
});

describe('speaking placeholder', () => {
    it('is added once and retired by real text', () => {
        let t = markAgentSpeaking(markAgentSpeaking(EMPTY_TRANSCRIPT));
        expect(t.entries.map((e) => e.id)).toEqual([SPEAKING_AGENT_ID]);
        t = applyTranscriptPacket(t, { type: 'transcript', role: 'agent', text: 'Hi', final: true, turnKey: 'a1' });
        expect(t.entries.map((e) => e.id)).toEqual(['turn-a1']);
    });
});

describe('polled rows (phone calls)', () => {
    it('grows one bubble per sequence', () => {
        let t = applyPolledRow(EMPTY_TRANSCRIPT, { role: 'user', text: 'Mon', sequence: 4 });
        t = applyPolledRow(t, { role: 'user', text: 'Monday 6 PM', sequence: 4 });
        expect(t.entries).toEqual([{ id: 'seq-4', role: 'user', text: 'Monday 6 PM' }]);
    });
});
