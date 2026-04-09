import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initializeReceiver } from './receiver';
import { createFileStartFrame, createFileDataFrames, deframe } from '../transport/framing';
import { sendData, startListening } from '../dsp/quiet-modem';

// Mock the dsp module so no real audio/Quiet.js is needed
vi.mock('../dsp/quiet-modem');
vi.mock('./spectrogram');

describe('Receiver UI', () => {
    let onFrameCallback: (frame: ArrayBuffer) => Promise<void>;

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
            onFrameCallback = cb as (frame: ArrayBuffer) => Promise<void>;
            return { analyser: {} as AnalyserNode };
        });
        vi.mocked(sendData).mockResolvedValue(undefined);
        URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should send ack-start when receiving a file-start frame', async () => {
        initializeReceiver();
        const receiveButton = document.getElementById('receive-button') as HTMLButtonElement;
        receiveButton.click();

        // Wait for startListening to resolve and register the callback
        await new Promise<void>(resolve => setTimeout(resolve, 0));

        const file = new File(['test'], 'test.txt', { type: 'text/plain' });
        const startFrame = createFileStartFrame(file, 'test-file-id');

        await onFrameCallback(startFrame);

        expect(sendData).toHaveBeenCalledOnce();
        const sentFrame = vi.mocked(sendData).mock.calls[0][0];
        const { header } = deframe(sentFrame);
        expect(header.type).toBe('ack-start');
    });

    it('should send ack per data frame and show download link when complete', async () => {
        initializeReceiver();
        const receiveButton = document.getElementById('receive-button') as HTMLButtonElement;
        receiveButton.click();

        await new Promise<void>(resolve => setTimeout(resolve, 0));

        const fileId = 'test-file-id';
        const fileContent = 'hello world';
        const file = new File([fileContent], 'test.txt', { type: 'text/plain' });

        // 1. Send file-start — receiver should ACK with ack-start
        const startFrame = createFileStartFrame(file, fileId);
        await onFrameCallback(startFrame);
        expect(sendData).toHaveBeenCalledOnce();
        const { header: ackStartHeader } = deframe(vi.mocked(sendData).mock.calls[0][0]);
        expect(ackStartHeader.type).toBe('ack-start');

        // 2. Send data frames — receiver should ACK each one
        const fileBuffer = await file.arrayBuffer();
        const dataFrames = createFileDataFrames(fileBuffer, fileId);

        for (let i = 0; i < dataFrames.length; i++) {
            vi.mocked(sendData).mockClear();
            await onFrameCallback(dataFrames[i]);
            expect(sendData).toHaveBeenCalledOnce();
            const { header: ackHeader } = deframe(vi.mocked(sendData).mock.calls[0][0]);
            expect(ackHeader.type).toBe('ack');
            expect(ackHeader.frameIndex).toBe(i);
        }

        // 3. Verify download link appears after all frames received
        const downloadLink = document.getElementById('download-link') as HTMLAnchorElement;
        expect(downloadLink.style.display).toBe('block');
        expect(downloadLink.download).toBe('test.txt');
    });
});
