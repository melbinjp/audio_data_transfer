import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { chunkFile, deframe, reassembleFile, FrameHeader, receivedChunks } from './framing';
import CRC32 from 'crc-32';

// Polyfill for File.arrayBuffer in jsdom
if (!File.prototype.arrayBuffer) {
    File.prototype.arrayBuffer = function() {
        return new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = () => {
                resolve(fr.result as ArrayBuffer);
            };
            fr.readAsArrayBuffer(this);
        });
    };
}

describe('framing', () => {
    let testFile: File;
    let fileBuffer: ArrayBuffer;

    beforeAll(async () => {
        const fileContent = 'Hello, this is a test file for the data over audio project.';
        fileBuffer = new TextEncoder().encode(fileContent).buffer;
        testFile = new File([fileBuffer], 'test.txt', { type: 'text/plain' });
    });

    afterEach(() => {
        receivedChunks.clear();
    });

    it('should chunk a file into frames with correct headers', async () => {
        const frames = await chunkFile(testFile);

        expect(frames.length).toBe(1); // The test file is small
        const frame = frames[0];

        const headerBuffer = frame.slice(0, 256);
        const payload = frame.slice(256);
        const headerString = new TextDecoder().decode(headerBuffer).replace(/\0/g, '');
        const header: FrameHeader = JSON.parse(headerString);

        expect(header.fileName).toBe('test.txt');
        expect(header.fileType).toBe('text/plain');
        expect(header.frameIndex).toBe(0);
        expect(header.totalFrames).toBe(1);
        expect(header.crc32).toBe(CRC32.buf(new Uint8Array(payload)));
        expect(payload.byteLength).toBe(fileBuffer.byteLength);
    });

    it('should deframe a valid frame', async () => {
        const frames = await chunkFile(testFile);
        const frame = frames[0];

        const { header, payload } = deframe(frame);

        expect(header.fileName).toBe('test.txt');
        expect(payload.byteLength).toBe(fileBuffer.byteLength);
        expect(new Uint8Array(payload)).toEqual(new Uint8Array(fileBuffer));
    });

    it('should throw an error for a frame with a CRC mismatch', async () => {
        const frames = await chunkFile(testFile);
        const frame = frames[0];

        // Tamper with the payload
        const tamperedFrame = new Uint8Array(frame);
        tamperedFrame[300]++; // Change a byte in the payload

        expect(() => deframe(tamperedFrame.buffer)).toThrow('CRC32 mismatch');
    });

    it('should reassemble a file from frames', async () => {
        const frames = await chunkFile(testFile);
        let resultFile: File | null = null;

        for (const frame of frames) {
            const { header, payload } = deframe(frame);
            resultFile = reassembleFile(header, payload);
        }

        expect(resultFile).not.toBeNull();
        expect(resultFile!.name).toBe(testFile.name);
        expect(resultFile!.type).toBe(testFile.type);

        const resultBuffer = await resultFile!.arrayBuffer();
        expect(new Uint8Array(resultBuffer)).toEqual(new Uint8Array(fileBuffer));
    });

    it('should not reassemble an incomplete file', async () => {
        const longFileContent = 'a'.repeat(1000);
        const longFile = new File([longFileContent], 'long.txt', { type: 'text/plain' });
        const frames = await chunkFile(longFile);

        let resultFile: File | null = null;
        // Skip the last frame
        for (let i = 0; i < frames.length - 1; i++) {
            const { header, payload } = deframe(frames[i]);
            resultFile = reassembleFile(header, payload);
        }

        expect(resultFile).toBeNull();
    });
});
