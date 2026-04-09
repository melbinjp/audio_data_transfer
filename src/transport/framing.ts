import CRC32 from 'crc-32';

/**
 * The size of the payload for each data frame, in bytes.
 * 512 bytes balances frame overhead against Quiet.js's internal PHY frame size
 * (~20-25 bytes), keeping reassembly manageable while not over-fragmenting data.
 */
const PAYLOAD_SIZE = 512;

/**
 * Defines the different types of frames used in the protocol.
 * - `file-start`: Initiates a file transfer, containing metadata about the file.
 * - `file-data`: Carries a chunk of the file's data.
 * - `ack`: Acknowledges the successful receipt of a `file-data` frame.
 * - `ack-start`: Acknowledges the successful receipt of a `file-start` frame.
 */
export type FrameType = 'file-start' | 'file-data' | 'ack' | 'ack-start';

/**
 * Represents the header of a single frame.
 */
export interface FrameHeader {
    /** The type of the frame. */
    type: FrameType;
    /** A unique identifier for the file transfer session. */
    fileId: string;
    /** The name of the file being transferred (only in `file-start` frames). */
    fileName?: string;
    /** The MIME type of the file (only in `file-start` frames). */
    fileType?: string;
    /** The total number of data frames for the file (only in `file-start` and `file-data` frames). */
    totalFrames?: number;
    /** The index of the current data frame (for `file-data` and `ack` frames). */
    frameIndex?: number;
    /** The CRC32 checksum of the payload (only for `file-data` frames). */
    crc32?: number;
}

/**
 * Creates a frame by combining a header and an optional payload into a single ArrayBuffer.
 * The frame format is `[header_length (1 byte)] [json_header] [payload]`.
 * @param header The frame header object.
 * @param payload An optional payload as an ArrayBuffer.
 * @returns The combined frame as an ArrayBuffer.
 */
function createFrame(header: FrameHeader, payload?: ArrayBuffer): ArrayBuffer {
    const headerString = JSON.stringify(header);
    const headerBuffer = new TextEncoder().encode(headerString);
    if (headerBuffer.length > 255) {
        throw new Error(`Header is too large (${headerBuffer.length} bytes) for a 1-byte length prefix (max 255 bytes)`);
    }

    const payloadLength = payload ? payload.byteLength : 0;
    const frame = new ArrayBuffer(1 + headerBuffer.length + payloadLength);
    const frameView = new Uint8Array(frame);

    frameView[0] = headerBuffer.length;
    frameView.set(headerBuffer, 1);
    if (payload) {
        frameView.set(new Uint8Array(payload), 1 + headerBuffer.length);
    }

    return frame;
}

/**
 * Creates a `file-start` frame to initiate a file transfer.
 * @param file The file to be transferred.
 * @param fileId A unique ID for this transfer session.
 * @returns An ArrayBuffer representing the `file-start` frame.
 */
export function createFileStartFrame(file: File, fileId: string): ArrayBuffer {
    const totalFrames = Math.ceil(file.size / PAYLOAD_SIZE);
    const header: FrameHeader = {
        type: 'file-start',
        fileId,
        fileName: file.name,
        fileType: file.type,
        totalFrames,
    };
    return createFrame(header);
}

/**
 * Creates an `ack` frame to acknowledge a received data frame.
 * @param fileId The ID of the file transfer session.
 * @param frameIndex The index of the frame being acknowledged.
 * @returns An ArrayBuffer representing the `ack` frame.
 */
export function createAckFrame(fileId: string, frameIndex: number): ArrayBuffer {
    const header: FrameHeader = {
        type: 'ack',
        fileId,
        frameIndex,
    };
    return createFrame(header);
}

/**
 * Creates an `ack-start` frame to acknowledge the `file-start` frame.
 * @param fileId The ID of the file transfer session.
 * @returns An ArrayBuffer representing the `ack-start` frame.
 */
export function createAckStartFrame(fileId: string): ArrayBuffer {
    const header: FrameHeader = {
        type: 'ack-start',
        fileId,
    };
    return createFrame(header);
}

/**
 * Chunks a file buffer into an array of `file-data` frames.
 * @param fileBuffer The file content as an ArrayBuffer.
 * @param fileId The ID for this transfer session.
 * @returns An array of `file-data` frames.
 */
export function createFileDataFrames(fileBuffer: ArrayBuffer, fileId: string): ArrayBuffer[] {
    const totalFrames = Math.ceil(fileBuffer.byteLength / PAYLOAD_SIZE);
    const frames: ArrayBuffer[] = [];

    for (let i = 0; i < totalFrames; i++) {
        const start = i * PAYLOAD_SIZE;
        const end = start + PAYLOAD_SIZE;
        const payload = fileBuffer.slice(start, end);

        const header: FrameHeader = {
            type: 'file-data',
            fileId,
            frameIndex: i,
            totalFrames,
            crc32: CRC32.buf(new Uint8Array(payload)),
        };

        frames.push(createFrame(header, payload));
    }

    return frames;
}


/**
 * Parses a raw frame ArrayBuffer into its header and payload.
 * Verifies the payload's integrity using the CRC32 checksum from the header.
 * @param frame The raw frame to deframe.
 * @returns An object containing the parsed header and the payload.
 */
export function deframe(frame: ArrayBuffer): { header: FrameHeader; payload: ArrayBuffer } {
    const frameView = new Uint8Array(frame);
    const headerLength = frameView[0];
    const headerBuffer = frame.slice(1, 1 + headerLength);
    const payload = frame.slice(1 + headerLength);

    const headerString = new TextDecoder().decode(headerBuffer);
    const header: FrameHeader = JSON.parse(headerString);

    if (header.crc32 !== undefined) {
        const payloadCrc = CRC32.buf(new Uint8Array(payload));
        if (payloadCrc !== header.crc32) {
            throw new Error('CRC32 mismatch');
        }
    }

    return { header, payload };
}


const REASSEMBLY_TIMEOUT = 30000; // 30 seconds

/**
 * Manages the reassembly of chunks for a single file transfer.
 */
class FileReassembler {
    private chunks: (ArrayBuffer | undefined)[];
    private receivedChunks = 0;
    public lastUpdated: number;

    constructor(
        public readonly fileId: string,
        public readonly fileName: string,
        public readonly fileType: string,
        private readonly totalFrames: number
    ) {
        this.chunks = new Array(totalFrames);
        this.lastUpdated = Date.now();
    }

    /**
     * Adds a chunk to the reassembly buffer.
     * @param frameIndex The index of the chunk.
     * @param payload The chunk's data.
     */
    addChunk(frameIndex: number, payload: ArrayBuffer) {
        if (!this.chunks[frameIndex]) {
            this.chunks[frameIndex] = payload;
            this.receivedChunks++;
        }
        this.lastUpdated = Date.now();
    }

    /**
     * Checks if all chunks for the file have been received.
     * @returns True if the file is complete, false otherwise.
     */
    isComplete(): boolean {
        return this.receivedChunks === this.totalFrames;
    }

    /**
     * Reconstructs the file from the received chunks.
     * @returns The reassembled File object.
     * @throws If the file is not yet complete.
     */
    getFile(): File {
        if (!this.isComplete()) {
            throw new Error('File is not complete');
        }
        const fileBlob = new Blob(this.chunks as BlobPart[], { type: this.fileType });
        return new File([fileBlob], this.fileName, { type: this.fileType });
    }
}

/**
 * Manages multiple concurrent file reassembly processes.
 * Handles the creation and cleanup of `FileReassembler` instances.
 */
export class ReassemblyManager {
    private reassemblers = new Map<string, FileReassembler>();
    private cleanupInterval: number;

    constructor() {
        this.cleanupInterval = setInterval(() => this.cleanup(), REASSEMBLY_TIMEOUT) as unknown as number;
    }

    /**
     * Retrieves or creates a `FileReassembler` for a given transfer.
     * @param header The header of the received frame.
     * @returns The corresponding `FileReassembler`, or null if one cannot be created.
     */
    public getReassembler(header: FrameHeader): FileReassembler | null {
        if (header.type === 'file-start' && header.fileId && header.fileName && header.fileType && header.totalFrames !== undefined) {
            if (!this.reassemblers.has(header.fileId)) {
                const reassembler = new FileReassembler(
                    header.fileId,
                    header.fileName,
                    header.fileType,
                    header.totalFrames
                );
                this.reassemblers.set(header.fileId, reassembler);
            }
            return this.reassemblers.get(header.fileId)!;
        } else if (header.type === 'file-data' && header.fileId) {
            return this.reassemblers.get(header.fileId) || null;
        }
        return null;
    }

    /**
     * Processes an incoming frame, adding its payload to the correct reassembler.
     * @param header The header of the received frame.
     * @param payload The payload of the received frame.
     * @returns The reassembled `File` if the transfer is complete, otherwise `null`.
     */
    public processFrame(header: FrameHeader, payload: ArrayBuffer): File | null {
        const reassembler = this.getReassembler(header);
        if (!reassembler || header.frameIndex === undefined) {
            return null;
        }

        reassembler.addChunk(header.frameIndex, payload);

        if (reassembler.isComplete()) {
            const file = reassembler.getFile();
            this.reassemblers.delete(reassembler.fileId);
            return file;
        }

        return null;
    }

    /**
     * Periodically cleans up stale `FileReassembler` instances to prevent memory leaks.
     */
    private cleanup() {
        const now = Date.now();
        for (const [fileId, reassembler] of this.reassemblers.entries()) {
            if (now - reassembler.lastUpdated >= REASSEMBLY_TIMEOUT) {
                console.log(`Timing out reassembly for fileId: ${fileId}`);
                this.reassemblers.delete(fileId);
            }
        }
    }

    /**
     * Stops the cleanup interval and clears all active reassemblers.
     */
    public destroy() {
        clearInterval(this.cleanupInterval);
        this.reassemblers.clear();
    }
}
