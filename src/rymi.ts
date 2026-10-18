import { RymiCall } from './call';
import type {
    RymiConnectionConfig,
    RymiPublishableConfig,
    RymiTokenConnectionConfig
} from './types';

function isTokenConfig(config: RymiConnectionConfig): config is RymiTokenConnectionConfig {
    return 'url' in config && 'token' in config;
}

function isPublishableConfig(config: RymiConnectionConfig): config is RymiPublishableConfig {
    return 'publishableKey' in config;
}

export class Rymi {
    private static activeCall: RymiCall | null = null;
    private static isConnecting = false;

    /**
     * Create a prepared browser voice call.
     *
     * Attach event listeners before calling `call.connect()` so no lifecycle,
     * diagnostic, transcript, or audio-playback event can be missed.
     */
    static createCall(config: RymiConnectionConfig): RymiCall {
        if (!config || typeof config !== 'object') {
            throw new Error('Rymi.createCall requires a connection config.');
        }

        if (isTokenConfig(config)) {
            if (!config.url || !config.token) {
                throw new Error('Rymi token connection requires both url and token.');
            }
            return new RymiCall(async () => ({
                url: config.url,
                token: config.token
            }), config);
        }

        if (isPublishableConfig(config)) {
            if (!config.publishableKey) {
                throw new Error('Rymi publishable-key connection requires publishableKey.');
            }
            return new RymiCall(() => this.resolvePublishableCredentials(config), config);
        }

        throw new Error('Rymi connection config must include either { url, token } or { publishableKey }.');
    }

    /**
     * Convenience one-shot connection. Prefer `createCall()` when the UI needs
     * diagnostics or event handlers during the connection handshake.
     */
    static async connect(config: RymiConnectionConfig): Promise<RymiCall> {
        if (this.isConnecting) {
            throw new Error('Connection already in progress.');
        }

        if (this.activeCall) {
            try {
                await this.activeCall.end();
            } catch (e) {
                console.warn('[Rymi] Error cleaning up previous call:', e);
            }
        }

        this.isConnecting = true;
        try {
            const call = this.createCall(config);
            this.activeCall = call;
            call.on('ended', () => {
                if (this.activeCall === call) this.activeCall = null;
            });
            call.on('error', () => {
                if (this.activeCall === call) this.activeCall = null;
            });
            await call.connect();
            return call;
        } catch (err) {
            this.activeCall = null;
            throw err;
        } finally {
            this.isConnecting = false;
        }
    }

    private static async resolvePublishableCredentials(config: RymiPublishableConfig): Promise<RymiTokenConnectionConfig> {
        const apiUrl = config.apiUrl || 'https://api.rymi.live';

        const req = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/calls`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.publishableKey}`
            },
            body: JSON.stringify({
                participants: [{ transport: 'webrtc', identity: config.identity || 'browser' }],
                metadata: config.metadata
            })
        });

        if (!req.ok) {
            const errJson = await req.json().catch(() => ({}));
            throw new Error(`Rymi API Error: ${errJson.error || req.statusText}`);
        }

        const res = await req.json();
        const webParticipant = Array.isArray(res.participants)
            ? res.participants.find((participant: any) => participant.transport === 'webrtc' && participant.access?.url && participant.access?.token)
            : null;

        if (!webParticipant?.access?.url || !webParticipant?.access?.token) {
            throw new Error('Rymi API Error: Missing WebRTC access credentials');
        }

        return {
            url: webParticipant.access.url,
            token: webParticipant.access.token
        };
    }
}
