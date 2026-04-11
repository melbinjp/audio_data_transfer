import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initializeReceiver } from './receiver';
import { createFileStartFrame, createFileDataFrames } from '../transport/framing';
import { startListening, TransmitterSession } from '../dsp/fsk-modem';

// Mock the dsp module so no real audio/AudioWorklet is needed
vi.mock('../dsp/fsk-modem');
vi.mock('./spectrogram');

describe('Receiver UI', () => {
    let onFrameCallback: (frame: ArrayBuffer) => void;

    beforeEach(() => {
        // Set up a minimal DOM for the receiver
        document.body.innerHTML = `
            <button id="receive-button"></button>
            <span id="receiver-status"></span>
            <a id="download-link"></a>
            <progress id="receive-progress"></progress>
            <canvas id="spectrogram-canvas"></canvas>
        `;

        vi.mocked(startListening).mockImplementation(async (cb) => {
            onFrameCallback = cb as (frame: ArrayBuffer) => void;
            return { analyser: {} as AnalyserNode, stop: vi.fn(), setRxMuted: vi.fn() };
        });

        // TransmitterSession is used by the receiver to send ACKs.
        // Mock it so that init() and send() return resolved Promises.
        vi.mocked(TransmitterSession).mockImplementation(() => ({
            init: vi.fn().mockResolvedValue(undefined),
            send: vi.fn().mockResolvedValue(undefined),
            destroy: vi.fn(),
        }) as unknown as TransmitterSession);

        URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should update status when receiving a file-start frame', async () => {
        initializeReceiver();
        const receiveButton = document.getElementById('receive-button') as HTMLButtonElement;
        receiveButton.click();

        // Wait for startListening to resolve and register the callback
        await new Promise<void>(resolve => setTimeout(resolve, 0));

        const file = new File(['test'], 'test.txt', { type: 'text/plain' });
        const startFrame = createFileStartFrame(file, 'test-file-id');

        onFrameCallback(startFrame);

        const statusEl = document.getElementById('receiver-status') as HTMLSpanElement;
        expect(statusEl.textContent).toBe('Receiving file: test.txt');
    });

    it('should show download link when all frames received', async () => {
        initializeReceiver();
        const receiveButton = document.getElementById('receive-button') as HTMLButtonElement;
        receiveButton.click();

        await new Promise<void>(resolve => setTimeout(resolve, 0));

        const fileId = 'test-file-id';
        const fileContent = 'hello world';
        const file = new File([fileContent], 'test.txt', { type: 'text/plain' });

        // 1. Deliver file-start frame
        const startFrame = createFileStartFrame(file, fileId);
        onFrameCallback(startFrame);

        // 2. Deliver all data frames
        const fileBuffer = await file.arrayBuffer();
        const dataFrames = createFileDataFrames(fileBuffer, fileId);

        for (const frame of dataFrames) {
            onFrameCallback(frame);
        }

        // 3. Verify download link appears after all frames received
        const downloadLink = document.getElementById('download-link') as HTMLAnchorElement;
        expect(downloadLink.style.display).toBe('block');
        expect(downloadLink.download).toBe('test.txt');
    });
});
