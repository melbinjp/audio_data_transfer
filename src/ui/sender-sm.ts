import { sendData } from '../dsp/quiet-modem';
import { createFileDataFrame, createFileStartFrame, getTotalFrames } from '../transport/framing';

/**
 * Defines the possible states of the sender state machine.
 */
export type SenderState = 'idle' | 'sending' | 'complete' | 'error';

/**
 * Sends a file as audio frames sequentially without requiring ACKs.
 *
 * Removing the bidirectional ACK protocol means the sender no longer needs
 * to run a microphone receiver (ScriptProcessorNode) concurrently with the
 * transmitter (another ScriptProcessorNode).  Having two ScriptProcessorNodes
 * simultaneously was the primary cause of the main-thread freeze and the
 * out-of-memory crash: quiet.js runs Emscripten DSP synchronously inside each
 * node's onaudioprocess callback, and two concurrent nodes starved the browser.
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
        this.file.arrayBuffer().then(fileBuffer => this.sendAll(fileBuffer)).catch(err => {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState('error', `Failed to read file: ${msg}`);
        });
    }

    private setState(newState: SenderState, message?: string) {
        this.state = newState;
        if (message) {
            this.onStateChange(newState, message);
        }
    }

    private async sendAll(fileBuffer: ArrayBuffer) {
        const totalFrames = getTotalFrames(fileBuffer);
        this.onProgress(0, totalFrames);

        // Transmit the handshake frame first so the receiver can prepare its
        // reassembly buffer before any data frames arrive.
        const startFrame = createFileStartFrame(this.file, this.fileId);
        this.setState('sending', 'Sending handshake frame...');
        try {
            await sendData(startFrame);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState('error', `Transmission error: ${msg}`);
            return;
        }

        // Send every data frame in order.  Frames are created one at a time so
        // that only the current frame is held in memory alongside fileBuffer,
        // rather than pre-allocating the full set (which would double peak RAM
        // usage and cause out-of-memory crashes for large files).
        // await ensures each frame's audio has fully played out before the next
        // one begins, preventing the quiet.js transmit queue from growing unboundedly.
        for (let i = 0; i < totalFrames; i++) {
            this.setState('sending', `Sending frame ${i + 1}/${totalFrames}...`);
            const frame = createFileDataFrame(fileBuffer, this.fileId, i, totalFrames);
            try {
                await sendData(frame);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.setState('error', `Transmission error: ${msg}`);
                return;
            }
            this.onProgress(i + 1, totalFrames);
        }

        this.setState('complete', 'File sent successfully.');
    }
}
