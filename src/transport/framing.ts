import CRC32 from 'crc-32';

/**
 * The size of the payload for each data frame, in bytes.
 * Larger payloads mean fewer frames and fewer round-trips, which reduces
 * memory pressure and the number of audio-buffer callbacks on the main thread.
 * quiet.js internally slices each transmit() call into 20-byte acoustic PHY
 * frames with FEC, so any application-level payload size works — however
 * values much above ~64 KB risk hitting Emscripten's encoder queue limit, and
 * very small values (< 20) produce excessive framing overhead.  4096 bytes
 * balances memory efficiency with frame-count reduction (~64× fewer frames
 * compared to the previous 64-byte size).
 */
const PAYLOAD_SIZE = 4096;

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
 * The frame format is `[total_content_length (2 bytes, big-endian)] [header_length (1 byte)] [json_header] [payload]`.
 * The 2-byte length prefix allows a stream buffer to know exactly how many bytes
 * make up one complete application frame, which is necessary because quiet.js
 * delivers data via `onReceive` in small PHY-layer chunks (not one full frame at a time).
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
    // content = [header_len (1)] [header] [payload]
    const contentLength = 1 + headerBuffer.length + payloadLength;
    // frame = [total_content_length (2)] [content]
    const frame = new ArrayBuffer(2 + contentLength);
    const frameView = new Uint8Array(frame);

    frameView[0] = (contentLength >> 8) & 0xff;
    frameView[1] = contentLength & 0xff;
    frameView[2] = headerBuffer.length;
    frameView.set(headerBuffer, 3);
    if (payload) {
        frameView.set(new Uint8Array(payload), 3 + headerBuffer.length);
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
 * Creates a single `file-data` frame for the given chunk index.
 * Prefer this over {@link createFileDataFrames} when iterating over a large
 * file: it avoids holding the entire set of pre-built frames in memory
 * simultaneously (which would double peak memory usage).
 *
 * @param fileBuffer The full file content as an ArrayBuffer.
 * @param fileId The ID for this transfer session.
 * @param frameIndex The zero-based index of the frame to create.
 * @param totalFrames The total number of data frames for this file.
 * @returns An ArrayBuffer representing the single `file-data` frame.
 */
export function createFileDataFrame(
    fileBuffer: ArrayBuffer,
    fileId: string,
    frameIndex: number,
    totalFrames: number,
): ArrayBuffer {
    const start = frameIndex * PAYLOAD_SIZE;
    const end = start + PAYLOAD_SIZE;
    const payload = fileBuffer.slice(start, end);

    const header: FrameHeader = {
        type: 'file-data',
        fileId,
        frameIndex,
        totalFrames,
        crc32: CRC32.buf(new Uint8Array(payload)),
    };

    return createFrame(header, payload);
}

/**
 * Returns the total number of `file-data` frames required for a given buffer.
 * @param fileBuffer The file content as an ArrayBuffer.
 */
export function getTotalFrames(fileBuffer: ArrayBuffer): number {
    return Math.ceil(fileBuffer.byteLength / PAYLOAD_SIZE);
}

/**
 * Chunks a file buffer into an array of `file-data` frames.
 * @param fileBuffer The file content as an ArrayBuffer.
 * @param fileId The ID for this transfer session.
 * @returns An array of `file-data` frames.
 */
export function createFileDataFrames(fileBuffer: ArrayBuffer, fileId: string): ArrayBuffer[] {
    const totalFrames = getTotalFrames(fileBuffer);
    const frames: ArrayBuffer[] = [];

    for (let i = 0; i < totalFrames; i++) {
        frames.push(createFileDataFrame(fileBuffer, fileId, i, totalFrames));
    }

    return frames;
}


/**
 * Parses a raw frame ArrayBuffer into its header and payload.
 * Expects the full frame format produced by `createFrame`:
 * `[total_content_length (2 bytes, big-endian)] [header_length (1 byte)] [json_header] [payload]`.
 * Verifies the payload's integrity using the CRC32 checksum from the header.
 * @param frame The raw frame to deframe.
 * @returns An object containing the parsed header and the payload.
 */
export function deframe(frame: ArrayBuffer): { header: FrameHeader; payload: ArrayBuffer } {
    const frameView = new Uint8Array(frame);
    // Skip the 2-byte total-content-length prefix; start reading content at offset 2.
    const headerLength = frameView[2];
    const headerBuffer = frame.slice(3, 3 + headerLength);
    const payload = frame.slice(3 + headerLength);

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
