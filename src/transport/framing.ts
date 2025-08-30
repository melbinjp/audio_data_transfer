import CRC32 from 'crc-32';

const PAYLOAD_SIZE = 512; // bytes
const HEADER_SIZE = 256; // bytes

export type FrameType = 'file' | 'chat';

export interface FrameHeader {
    type: FrameType;
    // For file frames
    fileId?: string;
    fileName?: string;
    fileType?: string;
    frameIndex?: number;
    totalFrames?: number;
    // For chat frames
    text?: string;
    // Common
    crc32?: number; // Optional for chat messages to save space
}

export async function chunkFile(file: File): Promise<ArrayBuffer[]> {
    const fileBuffer = await file.arrayBuffer();
    const totalFrames = Math.ceil(fileBuffer.byteLength / PAYLOAD_SIZE);
    const fileId = `${file.name}-${Date.now()}`;
    const frames: ArrayBuffer[] = [];

    for (let i = 0; i < totalFrames; i++) {
        const start = i * PAYLOAD_SIZE;
        const end = start + PAYLOAD_SIZE;
        const payload = fileBuffer.slice(start, end);

        const header: FrameHeader = {
            type: 'file',
            fileId,
            fileName: file.name,
            fileType: file.type,
            frameIndex: i,
            totalFrames,
            crc32: CRC32.buf(new Uint8Array(payload)),
        };

        const headerString = JSON.stringify(header);
        const headerBuffer = new TextEncoder().encode(headerString);
        if (headerBuffer.length > HEADER_SIZE) {
            throw new Error('Header is too large!');
        }

        const frame = new ArrayBuffer(HEADER_SIZE + payload.byteLength);
        new Uint8Array(frame, 0, HEADER_SIZE).set(headerBuffer);
        new Uint8Array(frame, HEADER_SIZE).set(new Uint8Array(payload));
        frames.push(frame);
    }

    return frames;
}

export function deframe(frame: ArrayBuffer): { header: FrameHeader; payload: ArrayBuffer } {
    const headerBuffer = frame.slice(0, HEADER_SIZE);
    const payload = frame.slice(HEADER_SIZE);

    const headerString = new TextDecoder().decode(headerBuffer).replace(/\0/g, '');
    const header: FrameHeader = JSON.parse(headerString);

    if (header.crc32) {
        const payloadCrc = CRC32.buf(new Uint8Array(payload));
        if (payloadCrc !== header.crc32) {
            throw new Error('CRC32 mismatch');
        }
    }

    return { header, payload };
}

export function createChatFrame(text: string): ArrayBuffer {
    const header: FrameHeader = {
        type: 'chat',
        text: text,
    };

    const headerString = JSON.stringify(header);
    const headerBuffer = new TextEncoder().encode(headerString);
    if (headerBuffer.length > HEADER_SIZE) {
        throw new Error('Header is too large!');
    }

    // Chat frames have no payload, the text is in the header.
    const frame = new ArrayBuffer(HEADER_SIZE);
    new Uint8Array(frame, 0, HEADER_SIZE).set(headerBuffer);
    return frame;
}

export const receivedChunks = new Map<string, ArrayBuffer[]>();

export function reassembleFile(header: FrameHeader, payload: ArrayBuffer): File | null {
    if (!receivedChunks.has(header.fileId)) {
        receivedChunks.set(header.fileId, Array.from({ length: header.totalFrames }));
    }

    const chunks = receivedChunks.get(header.fileId)!;
    chunks[header.frameIndex] = payload;

    // Check if all chunks have been received
    if (chunks.every(chunk => chunk !== undefined)) {
        const fileBlob = new Blob(chunks, { type: header.fileType });
        const file = new File([fileBlob], header.fileName, { type: header.fileType });
        receivedChunks.delete(header.fileId); // Clean up
        return file;
    }

    return null;
}
