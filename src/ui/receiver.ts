import { startListening, primeAudio, TransmitterSession } from '../dsp/fsk-modem';
import { deframe, ReassemblyManager, createAckFrame, createAckStartFrame } from '../transport/framing';
import { Spectrogram } from './spectrogram';

/**
 * Initializes the receiver UI, wiring up the receive button and handling
 * the logic for receiving frames, reassembling the file, and sending ACKs.
 *
 * The new 4-FSK modem uses AudioBufferSourceNode (TX) and AudioWorkletNode
 * (RX) which run on the audio rendering thread and safely coexist.  This
 * allows the receiver to send ACKs while simultaneously listening for the
 * next data frame, which was not possible with the deprecated ScriptProcessorNode
 * approach that previously caused browser crashes.
 */
export function initializeReceiver() {
    const receiveButton = document.getElementById('receive-button') as HTMLButtonElement;
    const statusEl = document.getElementById('receiver-status') as HTMLSpanElement;
    const downloadLink = document.getElementById('download-link') as HTMLAnchorElement;
    const receiveProgress = document.getElementById('receive-progress') as HTMLProgressElement;
    const spectrogramCanvas = document.getElementById('spectrogram-canvas') as HTMLCanvasElement;

    let spectrogram: Spectrogram | null = null;
    let reassemblyManager: ReassemblyManager | null = null;
    let stopListener: (() => void) | null = null;

    receiveButton.addEventListener('click', async () => {
        // Unlock the Web Audio API from within this synchronous user-gesture
        // handler before any await so that AudioContext.resume() calls in
        // subsequent async code are allowed by Chrome's autoplay policy.
        primeAudio();
        console.log('Starting to listen...');
        receiveButton.disabled = true;
        statusEl.textContent = 'Listening...';
        downloadLink.style.display = 'none';
        receiveProgress.value = 0;

        // Tear down any previous listener before creating a new one to prevent
        // accumulation of AudioWorkletNodes on the audio rendering thread.
        stopListener?.();
        stopListener = null;
        if (spectrogram) {
            spectrogram.stop();
        }
        if (reassemblyManager) {
            reassemblyManager.destroy();
        }
        reassemblyManager = new ReassemblyManager();

        // Per-session ACK sender.  A busy flag serialises ACK transmissions so
        // that only one TransmitterSession is active at a time.  Frames arriving
        // while an ACK is in flight are still processed — the sender will retry
        // if the ACK is not received within its timeout window.
        let isSendingAck = false;
        function sendAck(ackFrame: ArrayBuffer): void {
            if (isSendingAck) {
                console.warn('Receiver: ACK skipped — previous ACK still transmitting');
                return;
            }
            isSendingAck = true;
            (async () => {
                const ackSession = new TransmitterSession();
                try {
                    await ackSession.init();
                    await ackSession.send(ackFrame);
                    ackSession.destroy();
                } catch (err) {
                    console.error('Receiver: ACK transmission error:', err);
                    ackSession.destroy();
                } finally {
                    isSendingAck = false;
                }
            })();
        }

        try {
            const { analyser, stop } = await startListening((frame) => {
                try {
                    const { header, payload } = deframe(frame);

                    switch (header.type) {
                        case 'file-start': {
                            reassemblyManager!.getReassembler(header);
                            statusEl.textContent = `Receiving file: ${header.fileName}`;
                            sendAck(createAckStartFrame(header.fileId));
                            break;
                        }
                        case 'file-data': {
                            statusEl.textContent = `Receiving frame ${header.frameIndex! + 1}/${header.totalFrames}`;
                            receiveProgress.max = header.totalFrames!;
                            receiveProgress.value = header.frameIndex! + 1;

                            const file = reassemblyManager!.processFrame(header, payload);
                            sendAck(createAckFrame(header.fileId, header.frameIndex!));

                            if (file) {
                                statusEl.textContent = `File "${file.name}" received!`;
                                const url = URL.createObjectURL(file);
                                downloadLink.href = url;
                                downloadLink.download = file.name;
                                downloadLink.textContent = `Download ${file.name}`;
                                downloadLink.style.display = 'block';
                                receiveButton.disabled = false;
                                if (spectrogram) {
                                    spectrogram.stop();
                                    spectrogram = null;
                                }
                                reassemblyManager?.destroy();
                                reassemblyManager = null;
                                // Release the receiver AudioWorkletNode now that the
                                // transfer is complete so it stops consuming audio thread CPU.
                                stopListener?.();
                                stopListener = null;
                            }
                            break;
                        }
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error('Frame error:', err);
                    statusEl.textContent = `Error: ${msg}. Waiting for next frame...`;
                }
            });

            stopListener = stop;
            spectrogram = new Spectrogram(spectrogramCanvas, analyser);
            spectrogram.start();

        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('Error starting listener:', err);
            statusEl.textContent = `Error: ${msg}`;
            receiveButton.disabled = false;
            if (reassemblyManager) {
                reassemblyManager.destroy();
                reassemblyManager = null;
            }
        }
    });
}
