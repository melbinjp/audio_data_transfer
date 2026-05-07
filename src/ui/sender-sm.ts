import { TransmitterSession, startListening, DATA_CHANNEL, ACK_CHANNEL } from '../dsp/fsk-modem';
import {
    PAYLOAD_SIZE,
    createFileDataFrameFromPayload,
    createFileStartFrame,
    getAckToken,
    parseCompactAck,
} from '../transport/framing';
import type { AcousticProfile } from './acoustic-profile';

/**
 * Defines the possible states of the sender state machine.
 */
export type SenderState = 'idle' | 'sending' | 'complete' | 'error';

/** How long the sender waits for an ACK before retrying a frame (ms). */
const ACK_TIMEOUT_MS = 10000;
/** Maximum number of transmission attempts per frame before aborting. */
const MAX_RETRIES = 5;
/** Maximum number of transmission attempts for handshake before aborting. Use -1 for infinite retries. */
const MAX_HANDSHAKE_RETRIES = -1;
/** Base delay before the first retry (ms). */
const RETRY_BASE_DELAY_MS = 500;
/** Guard period inserted after a successful ACK before the next frame is sent (ms). */
const POST_ACK_GUARD_MS = 300;
/** Sentinel value for waitForAck meaning "accept any frameIndex". */
const ANY_FRAME_INDEX = -1;

/**
 * Sends a file as audio frames using a stop-and-wait ARQ protocol.
 */
export class SenderSM {
    /** The unique ID for the current file transfer. Made public for testing. */
    public fileId = '';

    constructor(
        private readonly file: File,
        private readonly onStateChange: (state: SenderState, message: string) => void,
        private readonly onProgress: (progress: number, total: number) => void,
        private readonly acousticProfile?: AcousticProfile,
    ) {}

    public start() {
        this.fileId = crypto.randomUUID();
        this.setState('sending', 'Preparing to send...');
        this.sendAll().catch(err => {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState('error', `Transmission error: ${msg}`);
        });
    }

    private setState(newState: SenderState, message?: string) {
        if (message) {
            this.onStateChange(newState, message);
        }
    }

    private async sendAll() {
        const totalFrames = Math.ceil(this.file.size / PAYLOAD_SIZE);
        const progressTotal = Math.max(1, totalFrames);
        this.onProgress(0, progressTotal);

        const senderTuning = this.acousticProfile?.sender;
        const ackTimeoutMs = senderTuning?.ackTimeoutMs ?? ACK_TIMEOUT_MS;
        const retryBaseDelayMs = senderTuning?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
        const maxRetries = senderTuning?.maxRetries ?? MAX_RETRIES;
        const maxHandshakeRetries = senderTuning?.maxHandshakeRetries ?? MAX_HANDSHAKE_RETRIES;
        const postAckGuardMs = senderTuning?.postAckGuardMs ?? POST_ACK_GUARD_MS;

        const session = new TransmitterSession(DATA_CHANNEL, senderTuning?.transmitter);
        try {
            await session.init();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState('error', `Failed to initialize transmitter: ${msg}`);
            return;
        }

        let stopAckListener: (() => void) | null = null;
        type AckWaiter = {
            type: string;
            frameIndex: number;
            resolve: (received: boolean) => void;
            timer: ReturnType<typeof setTimeout>;
        };
        let pendingWaiter: AckWaiter | null = null;

        try {
            const ackToken = getAckToken(this.fileId);
            const { stop } = await startListening((rawFrame) => {
                try {
                    const ack = parseCompactAck(rawFrame);
                    if (!ack || ack.token !== ackToken || !pendingWaiter) return;
                    const w = pendingWaiter;
                    const frameMatches =
                        w.frameIndex === ANY_FRAME_INDEX ||
                        ack.frameIndex === w.frameIndex;
                    if (ack.type === w.type && frameMatches) {
                        clearTimeout(w.timer);
                        pendingWaiter = null;
                        w.resolve(true);
                    }
                } catch {
                    // Ignore malformed or noise-induced frames.
                }
            }, ACK_CHANNEL, senderTuning?.ackListen);
            stopAckListener = stop;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState('error', `Failed to start ACK listener: ${msg}`);
            session.destroy();
            return;
        }

        const waitForAck = (ackType: string, frameIndex: number): Promise<boolean> =>
            new Promise((resolve) => {
                const timer = setTimeout(() => {
                    if (pendingWaiter?.resolve === resolve) pendingWaiter = null;
                    resolve(false);
                }, ackTimeoutMs);
                pendingWaiter = { type: ackType, frameIndex, resolve, timer };
            });

        try {
            let ackStartReceived = false;
            for (
                let attempt = 0;
                (maxHandshakeRetries === -1 || attempt < maxHandshakeRetries) && !ackStartReceived;
                attempt++
            ) {
                if (attempt > 0) {
                    await new Promise<void>(r =>
                        setTimeout(r, Math.min(5000, retryBaseDelayMs * (1 << (attempt - 1)))),
                    );
                }
                this.setState(
                    'sending',
                    attempt === 0
                        ? 'Sending handshake frame...'
                        : `Retrying handshake (attempt ${attempt + 1}${maxHandshakeRetries === -1 ? '' : '/' + maxHandshakeRetries})...`,
                );
                const startFrame = createFileStartFrame(this.file, this.fileId);
                await session.send(startFrame);
                this.setState('sending', 'Waiting for receiver ACK...');
                ackStartReceived = await waitForAck('ack-start', ANY_FRAME_INDEX);
            }
            if (!ackStartReceived) {
                this.setState('error', 'No acknowledgment from receiver. Is the receiver listening?');
                return;
            }
            if (totalFrames > 0) {
                await new Promise<void>(r => setTimeout(r, postAckGuardMs));
            }

            for (let i = 0; i < totalFrames; i++) {
                let ackReceived = false;
                for (let attempt = 0; attempt < maxRetries && !ackReceived; attempt++) {
                    if (attempt > 0) {
                        await new Promise<void>(r =>
                            setTimeout(r, Math.min(5000, retryBaseDelayMs * (1 << (attempt - 1)))),
                        );
                    }
                    this.setState(
                        'sending',
                        attempt === 0
                            ? `Sending frame ${i + 1}/${totalFrames}...`
                            : `Retrying frame ${i + 1}/${totalFrames} (attempt ${attempt + 1}/${maxRetries})...`,
                    );
                    const start = i * PAYLOAD_SIZE;
                    const chunkBuffer = await this.file.slice(start, start + PAYLOAD_SIZE).arrayBuffer();
                    const frame = createFileDataFrameFromPayload(chunkBuffer, this.fileId, i, totalFrames);
                    await session.send(frame);
                    this.setState('sending', `Waiting for ACK for frame ${i + 1}/${totalFrames}...`);
                    ackReceived = await waitForAck('ack', i);
                }
                if (!ackReceived) {
                    this.setState(
                        'error',
                        `Frame ${i + 1}/${totalFrames} was not acknowledged after ${maxRetries} attempts. Transfer failed.`,
                    );
                    return;
                }
                this.onProgress(i + 1, progressTotal);
                if (i < totalFrames - 1) {
                    await new Promise<void>(r => setTimeout(r, postAckGuardMs));
                }
            }

            this.onProgress(progressTotal, progressTotal);
            this.setState('complete', 'File sent successfully.');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState('error', `Transmission error: ${msg}`);
        } finally {
            session.destroy();
            stopAckListener?.();
        }
    }
}
