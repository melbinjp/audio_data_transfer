import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
    createFileDataFrames,
    deframe,
    ReassemblyManager,
    FrameHeader,
    createFileStartFrame,
    createAckFrame,
    createAckStartFrame
} from './framing';
import CRC32 from 'crc-32';

describe('framing', () => {
    let testFile: File;
    let fileBuffer: ArrayBuffer;

    beforeAll(async () => {
        const fileContent = 'Hello, this is a test file for the data over audio project.';
        fileBuffer = new TextEncoder().encode(fileContent).buffer;
        testFile = new File([fileBuffer], 'test.txt', { type: 'text/plain' });
    });

    it('should create file data frames with correct headers', async () => {
        const frames = createFileDataFrames(fileBuffer, 'test-file-id');

        expect(frames.length).toBe(1); // The test file is small
        const frame = frames[0];
        const frameView = new Uint8Array(frame);

        // Bytes 0-1 are the 2-byte big-endian total-content-length prefix.
        // Byte 2 is the header length.
        const headerLength = frameView[2];
        const headerBuffer = frame.slice(3, 3 + headerLength);
        const payload = frame.slice(3 + headerLength);

        const headerString = new TextDecoder().decode(headerBuffer);
        const header: FrameHeader = JSON.parse(headerString);

        expect(header.frameIndex).toBe(0);
        expect(header.totalFrames).toBe(1);
        expect(header.crc32).toBe(CRC32.buf(new Uint8Array(payload)));
        expect(payload.byteLength).toBe(fileBuffer.byteLength);
    });

    it('should deframe a valid file-data frame', async () => {
        const frames = createFileDataFrames(fileBuffer, 'test-file-id');
        const frame = frames[0];

        const { header, payload } = deframe(frame);

        expect(header.type).toBe('file-data');
        expect(header.fileId).toBe('test-file-id');
        expect(payload.byteLength).toBe(fileBuffer.byteLength);
        expect(new Uint8Array(payload)).toEqual(new Uint8Array(fileBuffer));
    });

    it('should create a file-start frame', () => {
        const frame = createFileStartFrame(testFile, 'test-file-id');
        const { header, payload } = deframe(frame);

        expect(header.type).toBe('file-start');
        expect(header.fileId).toBe('test-file-id');
        expect(header.fileName).toBe('test.txt');
        expect(header.fileType).toBe('text/plain');
        expect(header.totalFrames).toBe(1);
        expect(payload.byteLength).toBe(0);
    });

    it('should create an ack frame', () => {
        const frame = createAckFrame('test-file-id', 5);
        const { header, payload } = deframe(frame);

        expect(header.type).toBe('ack');
        expect(header.fileId).toBe('test-file-id');
        expect(header.frameIndex).toBe(5);
        expect(payload.byteLength).toBe(0);
    });

    it('should create an ack-start frame', () => {
        const frame = createAckStartFrame('test-file-id');
        const { header, payload } = deframe(frame);

        expect(header.type).toBe('ack-start');
        expect(header.fileId).toBe('test-file-id');
        expect(payload.byteLength).toBe(0);
    });

    it('should throw an error for a frame with a CRC mismatch', async () => {
        const frames = createFileDataFrames(fileBuffer, 'test-file-id');
        const frame = frames[0];

        // Tamper with the payload
        const tamperedFrame = new Uint8Array(frame.slice(0)); // Create a copy
        // Bytes 0-1 are the length prefix, byte 2 is header_length.
        const headerLength = tamperedFrame[2];
        const payloadStartIndex = 3 + headerLength;
        tamperedFrame[payloadStartIndex]++; // Change the first byte of the payload

        expect(() => deframe(tamperedFrame.buffer)).toThrow('CRC32 mismatch');
    });

    it('should throw for a frame that is too short', () => {
        const shortFrame = new Uint8Array([0, 1, 5]).buffer;
        expect(() => deframe(shortFrame)).toThrow('Frame too short');
    });

    it('should throw for a frame with zero header length', () => {
        // content-length = 1 (just the header-length byte), headerLength = 0
        const frame = new Uint8Array([0, 1, 0, 0, 0]).buffer;
        expect(() => deframe(frame)).toThrow('header length is zero');
    });

    it('should throw for a frame with header length exceeding frame size', () => {
        // content-length = 3, headerLength = 255 (way beyond actual frame)
        const frame = new Uint8Array([0, 3, 255, 0x7B, 0x7D]).buffer;
        expect(() => deframe(frame)).toThrow('header length 255 exceeds frame size');
    });

    it('should throw for a frame with corrupted JSON header', () => {
        // Build a structurally valid frame but with garbage header bytes
        const garbageHeader = new Uint8Array([0xFF, 0xFE, 0xFD]);
        const contentLength = 1 + garbageHeader.length; // headerLen byte + header
        const frame = new Uint8Array(2 + contentLength);
        frame[0] = (contentLength >> 8) & 0xFF;
        frame[1] = contentLength & 0xFF;
        frame[2] = garbageHeader.length;
        frame.set(garbageHeader, 3);

        expect(() => deframe(frame.buffer)).toThrow('header is not valid JSON');
    });

    it('should throw for a frame with content-length mismatch', () => {
        // Create a valid frame then change the content-length prefix
        const frames = createFileDataFrames(fileBuffer, 'test-file-id');
        const tamperedFrame = new Uint8Array(frames[0].slice(0));
        // Set content-length to 0x00 0x01 (way too small for the actual frame)
        tamperedFrame[0] = 0;
        tamperedFrame[1] = 1;
        expect(() => deframe(tamperedFrame.buffer)).toThrow('content-length prefix');
    });

    describe('ReassemblyManager', () => {
        let manager: ReassemblyManager;

        beforeEach(() => {
            manager = new ReassemblyManager();
        });

        afterEach(() => {
            manager.destroy();
        });

        it('should reassemble a file from multiple frames', async () => {
            const longFileContent = 'a'.repeat(1000);
            const longFileBuffer = new TextEncoder().encode(longFileContent).buffer;
            const fileId = 'long-file-id';
            const frames = createFileDataFrames(longFileBuffer, fileId);
            let resultFile: File | null = null;

            // Start the process with a file-start frame
            const startFrame = createFileStartFrame(new File([longFileContent], 'long.txt', {type: 'text/plain'}), fileId);
            const { header: startHeader } = deframe(startFrame);
            manager.getReassembler(startHeader);


            for (const frame of frames) {
                const { header, payload } = deframe(frame);
                resultFile = manager.processFrame(header, payload);
            }

            expect(resultFile).not.toBeNull();
            expect(resultFile!.name).toBe('long.txt');
            const resultBuffer = await resultFile!.arrayBuffer();
            expect(resultBuffer.byteLength).toBe(1000);
        });

        it('should not reassemble an incomplete file', async () => {
            const longFileContent = 'a'.repeat(1000);
            const longFileBuffer = new TextEncoder().encode(longFileContent).buffer;
            const fileId = 'long-file-id';
            const frames = createFileDataFrames(longFileBuffer, fileId);
            let resultFile: File | null = null;

            const startFrame = createFileStartFrame(new File([longFileContent], 'long.txt', {type: 'text/plain'}), fileId);
            const { header: startHeader } = deframe(startFrame);
            manager.getReassembler(startHeader);

            // Skip the last frame
            for (let i = 0; i < frames.length - 1; i++) {
                const { header, payload } = deframe(frames[i]);
                resultFile = manager.processFrame(header, payload);
            }

            expect(resultFile).toBeNull();
        });
    });
});
