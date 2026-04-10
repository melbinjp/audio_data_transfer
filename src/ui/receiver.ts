import { sendData, startListening, primeAudio, ACK_MODEM_PROFILE } from '../dsp/quiet-modem';
import { createAckFrame, createAckStartFrame, deframe, ReassemblyManager } from '../transport/framing';
import { Spectrogram } from './spectrogram';

/**
 * Initializes the receiver UI, wiring up the receive button and handling
 * the logic for receiving frames, sending ACKs, and reassembling the file.
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
        // handler before any await so that quiet.js can resume its AudioContext.
        primeAudio();
        console.log('Starting to listen...');
        receiveButton.disabled = true;
        statusEl.textContent = 'Listening...';
        downloadLink.style.display = 'none';
        receiveProgress.value = 0;

        // Tear down any previous listener before creating a new one to prevent
        // accumulation of ScriptProcessorNodes (Emscripten DSP) on the main thread.
        stopListener?.();
        stopListener = null;
        if (spectrogram) {
            spectrogram.stop();
        }
        if (reassemblyManager) {
            reassemblyManager.destroy();
        }
        reassemblyManager = new ReassemblyManager();

        try {
            const { analyser, stop } = await startListening(async (frame) => {
                try {
                    const { header, payload } = deframe(frame);

                    switch (header.type) {
                        case 'file-start': {
                            reassemblyManager!.getReassembler(header);
                            statusEl.textContent = `Receiving file: ${header.fileName}`;
                            await sendData(createAckStartFrame(header.fileId), ACK_MODEM_PROFILE);
                            break;
                        }
                        case 'file-data': {
                            statusEl.textContent = `Receiving frame ${header.frameIndex! + 1}/${header.totalFrames}`;
                            receiveProgress.max = header.totalFrames!;
                            receiveProgress.value = header.frameIndex! + 1;

                            await sendData(createAckFrame(header.fileId, header.frameIndex!), ACK_MODEM_PROFILE);

                            const file = reassemblyManager!.processFrame(header, payload);
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
                                // Release the receiver ScriptProcessorNode now that the
                                // transfer is complete so it stops consuming main-thread CPU.
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
