import { TransmitterSession, startListening, ACK_CHANNEL } from '../dsp/fsk-modem';
import { PAYLOAD_SIZE, createFileDataFrameFromPayload, createFileStartFrame, deframe } from '../transport/framing';

/**
 * Defines the possible states of the sender state machine.
 */
export type SenderState = 'idle' | 'sending' | 'complete' | 'error';

/** How long the sender waits for an ACK before retrying a frame (ms). */
const ACK_TIMEOUT_MS = 10000;
/** Maximum number of transmission attempts per frame before aborting. */
const MAX_RETRIES = 3;

/**
 * Sends a file as audio frames using a stop-and-wait ARQ protocol.
 *
 * Each frame (the handshake and every data chunk) is retransmitted up to
 * MAX_RETRIES times if the expected ACK is not received within ACK_TIMEOUT_MS.
 * This guarantees reliable delivery even when individual acoustic frames are
 * corrupted or missed by the receiver.
 *
 * Key design decisions that prevent out-of-memory crashes and transmission
 * timeouts:
 *
 * 1. **Lazy chunk reading** — `File.arrayBuffer()` is never called on the
 *    entire file.  Instead, each 4 KB chunk is read with `File.slice().arrayBuffer()`
 *    immediately before it is transmitted and discarded afterwards.  Peak RAM
 *    usage is therefore O(1 frame) rather than O(file size).
 *
 * 2. **Single `TransmitterSession`** — one AudioContext and one
 *    AudioBufferSourceNode is created for the whole transfer and reused across
 *    all frames.  Creating/destroying a node per frame was causing unnecessary
 *    DSP churn on the main thread.
 *
 * 3. **Safe concurrent TX + RX** — the new 4-FSK modem uses
 *    AudioBufferSourceNode (TX) and AudioWorkletNode (RX), both of which run
 *    on the audio rendering thread.  Unlike the deprecated ScriptProcessorNode,
 *    they do not block the main thread and can coexist without crashes.  This
 *    makes it safe to keep an ACK listener running throughout the transfer.
 */
export class SenderSM {
    private state: SenderState = 'idle';
    /** The unique ID for the current file transfer. Made public for testing. */
    public fileId = '';

    /**
     * @param file The file to be sent.
     * @param onStateChange A callback that is invoked when the state changes.
     * @param onProgress A callback that is invoked to report sending progress.
     */
    constructor(
        private readonly file: File,
        private readonly onStateChange: (state: SenderState, message: string) => void,
        private readonly onProgress: (progress: number, total: number) => void
    ) {}

    /**
     * Starts the file transfer process.
     */
    public start() {
        this.fileId = crypto.randomUUID();
        this.setState('sending', 'Preparing to send...');
        this.sendAll().catch(err => {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState('error', `Transmission error: ${msg}`);
        });
    }

    private setState(newState: SenderState, message?: string) {
        this.state = newState;
        if (message) {
            this.onStateChange(newState, message);
        }
    }

    private async sendAll() {
        // Compute the total frame count from file metadata — no need to read
        // the file contents up front, which would cause an OOM for large files.
        const totalFrames = Math.ceil(this.file.size / PAYLOAD_SIZE);
        this.onProgress(0, totalFrames);

        const session = new TransmitterSession();
        try {
            await session.init();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState('error', `Failed to initialize transmitter: ${msg}`);
            return;
        }

        // Start a persistent ACK listener for the duration of the transfer.
        // AudioBufferSourceNode (TX) and AudioWorkletNode (RX) run on the audio
        // rendering thread and safely coexist, so no main-thread starvation occurs.
        let stopAckListener: (() => void) | null = null;
        type AckWaiter = {
            type: string;
            frameIndex: number;
            resolve: (received: boolean) => void;
            timer: ReturnType<typeof setTimeout>;
        };
        let pendingWaiter: AckWaiter | null = null;

        try {
            // ACK listener is tuned to the ACK_CHANNEL (2200–3400 Hz).  Because
            // this band does not overlap the data channel (400–1600 Hz), the
            // sender's own outgoing transmissions will never be mistaken for
            // incoming ACKs by the Goertzel detector.
            const { stop } = await startListening((rawFrame) => {
                try {
                    const { header } = deframe(rawFrame);
                    if (header.fileId !== this.fileId || !pendingWaiter) return;
                    const w = pendingWaiter;
                    const frameMatches = w.frameIndex === ANY_FRAME_INDEX || header.frameIndex === w.frameIndex;
                    if (header.type === w.type && frameMatches) {
                        clearTimeout(w.timer);
                        pendingWaiter = null;
                        w.resolve(true);
                    }
                } catch {
                    // Ignore malformed or noise-induced frames.
                }
            }, ACK_CHANNEL);
            stopAckListener = stop;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState('error', `Failed to start ACK listener: ${msg}`);
            session.destroy();
            return;
        }

/** Sentinel value for waitForAck meaning "accept any frameIndex". */
const ANY_FRAME_INDEX = -1;

        /**
         * Returns a Promise that resolves to `true` when the expected ACK
         * arrives, or `false` if ACK_TIMEOUT_MS elapses first.
         * @param ackType       Expected frame type ('ack-start' or 'ack').
         * @param frameIndex    Expected frameIndex, or ANY_FRAME_INDEX to match any value.
         */
        const waitForAck = (ackType: string, frameIndex: number): Promise<boolean> =>
            new Promise((resolve) => {
                const timer = setTimeout(() => {
                    if (pendingWaiter?.resolve === resolve) pendingWaiter = null;
                    resolve(false);
                }, ACK_TIMEOUT_MS);
                pendingWaiter = { type: ackType, frameIndex, resolve, timer };
            });

        try {
            // ── Handshake ──────────────────────────────────────────────────────
            let ackStartReceived = false;
            for (let attempt = 0; attempt < MAX_RETRIES && !ackStartReceived; attempt++) {
                this.setState(
                    'sending',
                    attempt === 0
                        ? 'Sending handshake frame...'
                        : `Retrying handshake (attempt ${attempt + 1}/${MAX_RETRIES})...`,
                );
                const startFrame = createFileStartFrame(this.file, this.fileId);
                await session.send(startFrame);
                ackStartReceived = await waitForAck('ack-start', ANY_FRAME_INDEX);
            }
            if (!ackStartReceived) {
                this.setState('error', 'No acknowledgment from receiver. Is the receiver listening?');
                return;
            }

            // ── Data frames ────────────────────────────────────────────────────
            // Each chunk is read lazily with File.slice() so that only ~4 KB is
            // held in memory at a time, regardless of the total file size.
            for (let i = 0; i < totalFrames; i++) {
                let ackReceived = false;
                for (let attempt = 0; attempt < MAX_RETRIES && !ackReceived; attempt++) {
                    this.setState(
                        'sending',
                        attempt === 0
                            ? `Sending frame ${i + 1}/${totalFrames}...`
                            : `Retrying frame ${i + 1}/${totalFrames} (attempt ${attempt + 1}/${MAX_RETRIES})...`,
                    );
                    const start = i * PAYLOAD_SIZE;
                    const chunkBuffer = await this.file.slice(start, start + PAYLOAD_SIZE).arrayBuffer();
                    const frame = createFileDataFrameFromPayload(chunkBuffer, this.fileId, i, totalFrames);
                    await session.send(frame);
                    ackReceived = await waitForAck('ack', i);
                }
                if (!ackReceived) {
                    this.setState(
                        'error',
                        `Frame ${i + 1}/${totalFrames} was not acknowledged after ${MAX_RETRIES} attempts. Transfer failed.`,
                    );
                    return;
                }
                this.onProgress(i + 1, totalFrames);
            }

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
