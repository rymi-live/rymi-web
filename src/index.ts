/**
 * @rymi/web — Headless Browser SDK for Rymi Voice AI
 *
 * Usage:
 *   import { Rymi } from '@rymi/web';
 *
 *   const call = Rymi.createCall({ publishableKey: 'sb_publishable_...' });
 *
 *   call.on('started',    ()      => console.log('Connected'));
 *   call.on('transcript', (text)  => console.log('AI said:', text));
 *   call.on('ended',      ()      => console.log('Call ended'));
 *
 *   await call.connect();
 *
 *   call.mute();
 *   call.unmute();
 *   call.end();
 */

import { Rymi } from './rymi';

if (typeof window !== 'undefined') {
    (window as any).Rymi = Rymi;
}

export { Rymi };
export { RymiCall } from './call';
export type {
    RymiCallDiagnosticEvent,
    RymiCallDiagnosticStage,
    RymiCallDiagnosticStatus,
    RymiCallEvents,
    RymiCallOptions,
    RymiCallStatus,
    RymiConnectionConfig,
    RymiThinkingEvent,
    RymiTokenConnectionConfig,
    RymiTranscriptEvent,
    RymiSentenceEvent,
} from './types';

export default Rymi;

export {
    EMPTY_TRANSCRIPT,
    SPEAKING_AGENT_ID,
    applyPersistedRow,
    applyPolledRow,
    applyTranscriptPacket,
    markAgentSpeaking,
    parseTranscriptPacket,
} from './liveTranscript';
export type { LiveTranscript, TranscriptEntry, TranscriptPacket, TranscriptRole } from './liveTranscript';
