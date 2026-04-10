import { sendData, startListening } from '../dsp/quiet-modem';
import { createFileDataFrames, createFileStartFrame, deframe, FrameHeader } from '../transport/framing';

const RETRY_LIMIT = 10;
const ACK_TIMEOUT = 10000; // 10 seconds

/**
 * Defines the possible states of the sender state machine.
 */
export type SenderState = 'idle' | 'waiting-for-ack-start' | 'sending' | 'waiting-for-ack-data' | 'complete' | 'error';

/**
 * Manages the state and logic for sending a file, including the handshake,
 * data transmission, and ACK handling with retries.
 */
export class SenderSM {
    private state: SenderState = 'idle';
    /** The unique ID for the current file transfer. Made public for testing. */
    public fileId = '';
    private frames: ArrayBuffer[] = [];
    private currentFrameIndex = 0;
    private retryCount = 0;
    private ackTimeout: ReturnType<typeof setTimeout> | null = null;

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
        this.file.arrayBuffer().then(async fileBuffer => {
            this.frames = createFileDataFrames(fileBuffer, this.fileId);
            this.onProgress(0, this.frames.length);
            // Wait for the ACK listener to be fully initialised (microphone
            // permission granted, Quiet receiver created) before transmitting
            // the first frame.  Without this await, the first ACK could arrive
            // before the listener is ready and would be silently missed.
            await this.startAckListener();
            this.sendStartFrame();
        }).catch(err => {
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

    private async sendFrame(frame: ArrayBuffer) {
        try {
            await sendData(frame);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState('error', `Transmission error: ${msg}`);
        }
    }

    private startAckListener(): Promise<void> {
        return startListening(frame => {
            try {
                const { header } = deframe(frame);
                if (header.fileId !== this.fileId) return; // Ignore frames for other transfers

                if (this.ackTimeout) {
                    clearTimeout(this.ackTimeout);
                    this.ackTimeout = null;
                }

                if (this.state === 'waiting-for-ack-start' && header.type === 'ack-start') {
                    this.handleAckStart();
                } else if (this.state === 'waiting-for-ack-data' && header.type === 'ack') {
                    this.handleAckData(header);
                }
            } catch (_err) {
                // Ignore frames that can't be deframed (may be noise)
            }
        }).then(() => {
            console.log('Sender ACK listener ready.');
        }).catch(err => {
            const msg = err instanceof Error ? err.message : String(err);
            this.setState('error', `Listener error: ${msg}`);
            throw err;
        });
    }

    private handleAckStart() {
        this.setState('sending', 'Handshake complete. Sending data...');
        this.currentFrameIndex = 0;
        this.retryCount = 0;
        this.sendNextDataFrame();
    }

    private handleAckData(header: FrameHeader) {
        if (header.frameIndex === this.currentFrameIndex) {
            this.currentFrameIndex++;
            this.retryCount = 0;
            this.onProgress(this.currentFrameIndex, this.frames.length);
            if (this.currentFrameIndex < this.frames.length) {
                this.sendNextDataFrame();
            } else {
                this.setState('complete', 'File sending complete.');
            }
        }
    }

    private async sendStartFrame() {
        const startFrame = createFileStartFrame(this.file, this.fileId);
        this.setState('sending', 'Sending handshake frame...');
        // Await the full playback of the frame so the ACK timeout only begins
        // once the receiver has actually heard the entire transmission.
        await this.sendFrame(startFrame);
        this.setState('waiting-for-ack-start', 'Waiting for handshake ACK...');
        this.ackTimeout = setTimeout(() => this.onAckTimeout('start'), ACK_TIMEOUT);
    }

    private async sendNextDataFrame() {
        this.setState('sending', `Sending frame ${this.currentFrameIndex + 1}/${this.frames.length}...`);
        // Await full playback before starting the ACK timer.
        await this.sendFrame(this.frames[this.currentFrameIndex]);
        this.setState('waiting-for-ack-data', `Waiting for ACK on frame ${this.currentFrameIndex + 1}...`);
        this.ackTimeout = setTimeout(() => this.onAckTimeout('data'), ACK_TIMEOUT);
    }

    private onAckTimeout(phase: 'start' | 'data') {
        this.ackTimeout = null;
        this.retryCount++;
        if (this.retryCount > RETRY_LIMIT) {
            this.setState('error', 'Transfer failed: Too many retries.');
            return;
        }

        this.setState('sending', `Timeout, retrying... (${this.retryCount}/${RETRY_LIMIT})`);
        if (phase === 'start') {
            this.sendStartFrame();
        } else {
            this.sendNextDataFrame();
        }
    }
}
