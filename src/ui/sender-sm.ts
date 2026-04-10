import { sendData } from '../dsp/quiet-modem';
import { createFileDataFrames, createFileStartFrame } from '../transport/framing';

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
        const frames = createFileDataFrames(fileBuffer, this.fileId);
        this.onProgress(0, frames.length);

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

        // Send every data frame in order.  await ensures each frame's audio
        // has fully played out before the next one begins, preventing the
        // quiet.js transmit queue from growing unboundedly.
        for (let i = 0; i < frames.length; i++) {
            this.setState('sending', `Sending frame ${i + 1}/${frames.length}...`);
            try {
                await sendData(frames[i]);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.setState('error', `Transmission error: ${msg}`);
                return;
            }
            this.onProgress(i + 1, frames.length);
        }

        this.setState('complete', 'File sent successfully.');
    }
}
