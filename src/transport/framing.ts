import CRC32 from 'crc-32';

/**
 * Transport framing for data-over-audio.
 *
 * Quiet.js handles its own internal framing at the PHY layer (e.g., 20-25 byte
 * frames). When we call transmitter.transmit(buffer), it internally slices the
 * buffer into PHY frames. On the receiver side, onReceive fires once per PHY
 * frame with the decoded payload.
 *
 * Our transport layer wraps the entire message in a simple envelope:
 *   [1 byte type] [4 bytes total length] [4 bytes CRC32] [N bytes payload]
 *
 * For file transfers, we prefix the payload with file metadata.
 * For chat, the payload IS the text message.
 *
 * Since quiet-js delivers data frame-by-frame (each ~20 bytes), we accumulate
 * received frames into a reassembly buffer until we have the complete message.
 */

export const FRAME_TYPE_FILE = 0x01;
export const FRAME_TYPE_CHAT = 0x02;

const ENVELOPE_HEADER_SIZE = 9; // 1 type + 4 length + 4 crc

export interface FileMetadata {
    fileName: string;
    fileType: string;
}

/**
 * Create a complete envelope buffer for a chat message.
 * Format: [type=0x02][totalLen:u32][crc32:i32][utf8 text]
 */
export function createChatEnvelope(text: string): ArrayBuffer {
    const textBytes = new TextEncoder().encode(text);
    const totalLen = ENVELOPE_HEADER_SIZE + textBytes.length;
    const buffer = new ArrayBuffer(totalLen);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    view.setUint8(0, FRAME_TYPE_CHAT);
    view.setUint32(1, totalLen, true); // little-endian
    // CRC32 over the payload (text)
    const crc = CRC32.buf(textBytes);
    view.setInt32(5, crc, true);
    bytes.set(textBytes, ENVELOPE_HEADER_SIZE);

    return buffer;
}

/**
 * Create a complete envelope buffer for a file transfer.
 * Format: [type=0x01][totalLen:u32][crc32:i32][metaLen:u16][JSON meta][file bytes]
 */
export function createFileEnvelope(file: File, fileData: ArrayBuffer): ArrayBuffer {
    const meta: FileMetadata = {
        fileName: file.name,
        fileType: file.type || 'application/octet-stream',
    };
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
    const fileBytes = new Uint8Array(fileData);

    const payloadLen = 2 + metaBytes.length + fileBytes.length; // 2 for metaLen
    const totalLen = ENVELOPE_HEADER_SIZE + payloadLen;
    const buffer = new ArrayBuffer(totalLen);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    view.setUint8(0, FRAME_TYPE_FILE);
    view.setUint32(1, totalLen, true);

    // CRC32 over the entire payload (meta length + meta + file data)
    const payloadSlice = new Uint8Array(payloadLen);
    const payloadView = new DataView(payloadSlice.buffer);
    payloadView.setUint16(0, metaBytes.length, true);
    payloadSlice.set(metaBytes, 2);
    payloadSlice.set(fileBytes, 2 + metaBytes.length);

    const crc = CRC32.buf(payloadSlice);
    view.setInt32(5, crc, true);

    bytes.set(payloadSlice, ENVELOPE_HEADER_SIZE);

    return buffer;
}

/**
 * Decoded envelope result.
 */
export type DecodedEnvelope =
    | { type: 'chat'; text: string }
    | { type: 'file'; fileName: string; fileType: string; fileData: ArrayBuffer };

/**
 * Decode a complete envelope buffer.
 * Throws if CRC check fails.
 */
export function decodeEnvelope(buffer: ArrayBuffer): DecodedEnvelope {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const type = view.getUint8(0);
    const totalLen = view.getUint32(1, true);
    const expectedCrc = view.getInt32(5, true);

    if (buffer.byteLength < totalLen) {
        throw new Error(`Incomplete envelope: expected ${totalLen} bytes, got ${buffer.byteLength}`);
    }

    const payload = bytes.slice(ENVELOPE_HEADER_SIZE, totalLen);
    const actualCrc = CRC32.buf(payload);

    if (actualCrc !== expectedCrc) {
        throw new Error(`CRC32 mismatch: expected ${expectedCrc}, got ${actualCrc}`);
    }

    if (type === FRAME_TYPE_CHAT) {
        const text = new TextDecoder().decode(payload);
        return { type: 'chat', text };
    }

    if (type === FRAME_TYPE_FILE) {
        const payloadView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const metaLen = payloadView.getUint16(0, true);
        const metaBytes = payload.slice(2, 2 + metaLen);
        const meta: FileMetadata = JSON.parse(new TextDecoder().decode(metaBytes));
        const fileData = payload.slice(2 + metaLen).buffer;

        return {
            type: 'file',
            fileName: meta.fileName,
            fileType: meta.fileType,
            fileData,
        };
    }

    throw new Error(`Unknown frame type: ${type}`);
}

/**
 * Reassembly buffer for accumulating received quiet-js frames.
 * Quiet.js delivers small chunks (~20 bytes each); we accumulate them
 * until we have a complete envelope, then decode it.
 */
export class ReassemblyBuffer {
    private chunks: Uint8Array[] = [];
    private totalBytes = 0;

    /**
     * Add a received chunk. Returns a decoded envelope if we now have
     * a complete message, or null if more data is needed.
     */
    addChunk(chunk: ArrayBuffer): DecodedEnvelope | null {
        const bytes = new Uint8Array(chunk);
        this.chunks.push(bytes);
        this.totalBytes += bytes.length;

        // Need at least the header to know the total length
        if (this.totalBytes < ENVELOPE_HEADER_SIZE) {
            return null;
        }

        // Merge chunks to read the header
        const merged = this.merge();
        const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
        const totalLen = view.getUint32(1, true);

        if (this.totalBytes < totalLen) {
            return null; // Need more data
        }

        // We have enough data — decode it
        const result = decodeEnvelope(merged.buffer as ArrayBuffer);
        this.reset();
        return result;
    }

    private merge(): Uint8Array {
        const merged = new Uint8Array(this.totalBytes);
        let offset = 0;
        for (const chunk of this.chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }
        return merged;
    }

    reset() {
        this.chunks = [];
        this.totalBytes = 0;
    }

    get bytesReceived(): number {
        return this.totalBytes;
    }

    /**
     * Get expected total length from the header, or 0 if header not yet received.
     */
    get expectedLength(): number {
        if (this.totalBytes < ENVELOPE_HEADER_SIZE) return 0;
        const merged = this.merge();
        const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
        return view.getUint32(1, true);
    }
}
