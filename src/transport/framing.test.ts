import { describe, it, expect } from 'vitest';
import {
    createChatEnvelope,
    createFileEnvelope,
    decodeEnvelope,
    ReassemblyBuffer,
    FRAME_TYPE_CHAT,
    FRAME_TYPE_FILE,
} from './framing';

describe('framing', () => {
    describe('createChatEnvelope / decodeEnvelope', () => {
        it('should round-trip a chat message', () => {
            const text = 'Hello, World!';
            const envelope = createChatEnvelope(text);
            const result = decodeEnvelope(envelope);

            expect(result.type).toBe('chat');
            if (result.type === 'chat') {
                expect(result.text).toBe(text);
            }
        });

        it('should round-trip a chat message with unicode', () => {
            const text = '🎵 Audio transfer 日本語テスト';
            const envelope = createChatEnvelope(text);
            const result = decodeEnvelope(envelope);

            expect(result.type).toBe('chat');
            if (result.type === 'chat') {
                expect(result.text).toBe(text);
            }
        });

        it('should have correct envelope header bytes', () => {
            const text = 'Test';
            const envelope = createChatEnvelope(text);
            const view = new DataView(envelope);

            expect(view.getUint8(0)).toBe(FRAME_TYPE_CHAT);
            // total length = 9 (header) + 4 (utf8 "Test") = 13
            expect(view.getUint32(1, true)).toBe(13);
        });
    });

    describe('createFileEnvelope / decodeEnvelope', () => {
        it('should round-trip a file', () => {
            const content = 'Hello, this is a test file for the data over audio project.';
            const fileData = new TextEncoder().encode(content).buffer;
            const file = new File([fileData], 'test.txt', { type: 'text/plain' });

            const envelope = createFileEnvelope(file, fileData);
            const result = decodeEnvelope(envelope);

            expect(result.type).toBe('file');
            if (result.type === 'file') {
                expect(result.fileName).toBe('test.txt');
                expect(result.fileType).toBe('text/plain');
                const decoded = new TextDecoder().decode(result.fileData);
                expect(decoded).toBe(content);
            }
        });

        it('should have correct envelope header bytes', () => {
            const fileData = new Uint8Array([1, 2, 3, 4]).buffer;
            const file = new File([fileData], 'data.bin', { type: 'application/octet-stream' });

            const envelope = createFileEnvelope(file, fileData);
            const view = new DataView(envelope);

            expect(view.getUint8(0)).toBe(FRAME_TYPE_FILE);
            // total length should be > 9 (header) + metadata + 4 (file bytes)
            expect(view.getUint32(1, true)).toBeGreaterThan(13);
        });
    });

    describe('CRC validation', () => {
        it('should throw on corrupted envelope', () => {
            const envelope = createChatEnvelope('Test');
            const corrupted = new Uint8Array(envelope);
            corrupted[corrupted.length - 1] ^= 0xFF; // Flip last byte

            expect(() => decodeEnvelope(corrupted.buffer)).toThrow('CRC32 mismatch');
        });
    });

    describe('ReassemblyBuffer', () => {
        it('should reassemble a chat envelope from small chunks', () => {
            const text = 'Hello from audio!';
            const envelope = createChatEnvelope(text);
            const buffer = new ReassemblyBuffer();

            // Simulate 5-byte chunks (smaller than quiet-js's typical 20-byte frames)
            const bytes = new Uint8Array(envelope);
            const chunkSize = 5;
            let result = null;

            for (let i = 0; i < bytes.length; i += chunkSize) {
                const chunk = bytes.slice(i, i + chunkSize).buffer;
                result = buffer.addChunk(chunk);
                if (result !== null) break;
            }

            expect(result).not.toBeNull();
            expect(result!.type).toBe('chat');
            if (result!.type === 'chat') {
                expect(result!.text).toBe(text);
            }
        });

        it('should reassemble a file envelope from chunks', () => {
            const content = 'File content here';
            const fileData = new TextEncoder().encode(content).buffer;
            const file = new File([fileData], 'small.txt', { type: 'text/plain' });

            const envelope = createFileEnvelope(file, fileData);
            const buffer = new ReassemblyBuffer();

            // Simulate 10-byte chunks
            const bytes = new Uint8Array(envelope);
            const chunkSize = 10;
            let result = null;

            for (let i = 0; i < bytes.length; i += chunkSize) {
                const chunk = bytes.slice(i, i + chunkSize).buffer;
                result = buffer.addChunk(chunk);
                if (result !== null) break;
            }

            expect(result).not.toBeNull();
            expect(result!.type).toBe('file');
            if (result!.type === 'file') {
                expect(result!.fileName).toBe('small.txt');
                const decoded = new TextDecoder().decode(result!.fileData);
                expect(decoded).toBe(content);
            }
        });

        it('should return null when data is incomplete', () => {
            const envelope = createChatEnvelope('Hello');
            const buffer = new ReassemblyBuffer();

            // Only send first 3 bytes (less than header)
            const bytes = new Uint8Array(envelope);
            const result = buffer.addChunk(bytes.slice(0, 3).buffer);

            expect(result).toBeNull();
        });

        it('should track bytesReceived', () => {
            const buffer = new ReassemblyBuffer();
            buffer.addChunk(new Uint8Array([1, 2, 3]).buffer);
            expect(buffer.bytesReceived).toBe(3);
            buffer.addChunk(new Uint8Array([4, 5]).buffer);
            expect(buffer.bytesReceived).toBe(5);
        });
    });
});
