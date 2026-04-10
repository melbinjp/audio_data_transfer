import { TransmitterSession } from '../dsp/quiet-modem';
import { PAYLOAD_SIZE, createFileDataFrameFromPayload, createFileStartFrame } from '../transport/framing';

/**
 * Defines the possible states of the sender state machine.
 */
export type SenderState = 'idle' | 'sending' | 'complete' | 'error';

/**
 * Sends a file as audio frames sequentially without requiring ACKs.
 *
 * Key design decisions that prevent out-of-memory crashes and transmission
 * timeouts:
 *
 * 1. **Lazy chunk reading** — `File.arrayBuffer()` is never called on the
 *    entire file.  Instead, each 4 KB chunk is read with `File.slice().arrayBuffer()`
 *    immediately before it is transmitted and discarded afterwards.  Peak RAM
 *    usage is therefore O(1 frame) rather than O(file size).
 *
 * 2. **Single `TransmitterSession`** — one `Quiet.transmitter` (and one
 *    `ScriptProcessorNode`) is created for the whole transfer and reused across
 *    all frames.  Creating/destroying a node per frame was causing unnecessary
 *    DSP churn on the main thread.
 *
 * 3. **No concurrent ACK receiver** — removing the bidirectional ACK protocol
 *    means only one `ScriptProcessorNode` is active at any time.  Running two
 *    concurrent nodes (transmitter + ACK receiver) previously starved the
 *    browser's audio thread.
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

        try {
            // Transmit the handshake frame first so the receiver can prepare its
            // reassembly buffer before any data frames arrive.
            const startFrame = createFileStartFrame(this.file, this.fileId);
            this.setState('sending', 'Sending handshake frame...');
            await session.send(startFrame);

            // Send every data frame in order.  Each chunk is read lazily with
            // File.slice() so that only ~4 KB is held in memory at a time,
            // regardless of the total file size.  Awaiting session.send() ensures
            // each frame's audio has fully played out before the next one begins,
            // preventing the quiet.js transmit queue from growing unboundedly.
            for (let i = 0; i < totalFrames; i++) {
                this.setState('sending', `Sending frame ${i + 1}/${totalFrames}...`);
                const start = i * PAYLOAD_SIZE;
                const end = start + PAYLOAD_SIZE;
                const chunkBuffer = await this.file.slice(start, end).arrayBuffer();
                const frame = createFileDataFrameFromPayload(chunkBuffer, this.fileId, i, totalFrames);
                await session.send(frame);
                this.onProgress(i + 1, totalFrames);
            }

            this.setState('complete', 'File sent successfully.');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState('error', `Transmission error: ${msg}`);
        } finally {
            session.destroy();
        }
    }
}
