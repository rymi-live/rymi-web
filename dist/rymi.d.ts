import { RymiCall } from './call';
import { RymiConnectionConfig } from './types';

export declare class Rymi {
    private static activeCall;
    private static isConnecting;
    /**
     * Create a prepared browser voice call.
     *
     * Attach event listeners before calling `call.connect()` so no lifecycle,
     * diagnostic, transcript, or audio-playback event can be missed.
     */
    static createCall(config: RymiConnectionConfig): RymiCall;
    /**
     * Convenience one-shot connection. Prefer `createCall()` when the UI needs
     * diagnostics or event handlers during the connection handshake.
     */
    static connect(config: RymiConnectionConfig): Promise<RymiCall>;
    private static resolvePublishableCredentials;
}
//# sourceMappingURL=rymi.d.ts.map