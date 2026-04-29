import { describe, it, expect, vi } from 'vitest';
import { SenderSM } from './ui/sender-sm';
import { ReassemblyManager, deframe, createCompactAckStartFrame, createCompactAckFrame } from './transport/framing';
import { FskDecoder, DATA_CHANNEL, ACK_CHANNEL, encodeFrameToAudio, getSymbolSamples } from './dsp/fsk-modem';

let globalSenderAckCallback: ((data: ArrayBuffer) => void) | null = null;
let globalSimulateSenderSend: ((data: ArrayBuffer) => Promise<void>) | null = null;

vi.mock('./dsp/fsk-modem', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        TransmitterSession: class {
            init() { return Promise.resolve(); }
            async send(data: ArrayBuffer) {
                if (globalSimulateSenderSend) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    await globalSimulateSenderSend(data);
                }
            }
            destroy() {}
        },
        startListening: async (cb: (data: ArrayBuffer) => void, channel: any) => {
            globalSenderAckCallback = cb;
            return { stop: vi.fn() };
        }
    };
});

describe('End-to-end simulated file transfer', () => {
    it('transmits and receives a file', async () => {
        const fileContent = 'Hello end-to-end testing!';
        const fileBuffer = new TextEncoder().encode(fileContent).buffer;

        const g = globalThis as any;
        const MockFile = g['File'];
        const file = new MockFile([fileBuffer], 'hello.txt', { type: 'text/plain' });
        file.slice = function(start: number, end: number) {
            const buf = fileBuffer.slice(start, end);
            const blob = new Blob([buf]);
            (blob as any).arrayBuffer = () => Promise.resolve(buf);
            return blob;
        };
        Object.defineProperty(file, 'size', { value: fileBuffer.byteLength });

        const SAMPLE_RATE = 48000;
        const symbolSamples = getSymbolSamples(SAMPLE_RATE);

        let receivedFrames: ArrayBuffer[] = [];

        const receiverDecoder = new FskDecoder({
            sampleRate: SAMPLE_RATE,
            channel: DATA_CHANNEL,
            onData: (data) => {
                receivedFrames.push(data);
            }
        });

        const reassemblyManager = new ReassemblyManager();
        let finalFile: File | null = null;

        const senderDecoder = new FskDecoder({
            sampleRate: SAMPLE_RATE,
            channel: ACK_CHANNEL,
            onData: (data) => {
                if (globalSenderAckCallback) {
                    globalSenderAckCallback(data);
                }
            }
        });

        globalSimulateSenderSend = async (frame: ArrayBuffer) => {
            const pcm = encodeFrameToAudio(frame, symbolSamples, SAMPLE_RATE, DATA_CHANNEL);
            for (let off = 0; off < pcm.length; off += 128) {
                receiverDecoder.pushSamples(pcm.subarray(off, off + 128));
            }

            // In actual behavior, the receiver parses it, enqueues an ACK, and sends the ACK.
            // Since we're doing this synchronously within a mocked send, it resolves the ACK BEFORE `waitForAck` is even called!

            while (receivedFrames.length > 0) {
                const rFrame = receivedFrames.shift()!;
                const { header, payload } = deframe(rFrame);

                let ackFrame: ArrayBuffer | null = null;
                if (header.type === 'file-start') {
                    reassemblyManager.getReassembler(header);
                    ackFrame = createCompactAckStartFrame(header.fileId);
                } else if (header.type === 'file-data') {
                    finalFile = reassemblyManager.processFrame(header, payload) || null;
                    ackFrame = createCompactAckFrame(header.fileId, header.frameIndex!);
                }

                if (ackFrame) {
                    // Send ACK asynchronously so `await session.send` resolves, and `waitForAck` gets called BEFORE the ACK arrives!
                    setTimeout(() => {
                        const ackPcm = encodeFrameToAudio(ackFrame!, symbolSamples, SAMPLE_RATE, ACK_CHANNEL);
                        for (let off = 0; off < ackPcm.length; off += 128) {
                            senderDecoder.pushSamples(ackPcm.subarray(off, off + 128));
                        }
                    }, 50);
                }
            }
        };

        const senderSM = new SenderSM(
            file,
            (state, msg) => { },
            (prog, tot) => { }
        );

        senderSM.start();

        await new Promise(resolve => setTimeout(resolve, 3000));

        expect(finalFile).not.toBeNull();
        const text = await (finalFile as any).text ? await (finalFile as any).text() : await finalFile!.arrayBuffer().then(b => new TextDecoder().decode(b));
        expect(text).toBe(fileContent);
    });
});
