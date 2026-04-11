import { startListening, primeAudio, TransmitterSession, ACK_CHANNEL } from '../dsp/fsk-modem';
import { ACK_RING_DOWN_MS } from '../dsp/modem-config';
import { deframe, ReassemblyManager, createCompactAckFrame, createCompactAckStartFrame } from '../transport/framing';
import { Spectrogram } from './spectrogram';

/**
 * Initializes the receiver UI, wiring up the receive button and handling
 * the logic for receiving frames, reassembling the file, and sending ACKs.
 *
 * Reliability improvements implemented here:
 *
 * 1A. **Reuse single ACK TransmitterSession** — one AudioContext is created
 *     for the entire receive session and reused for every ACK.  This eliminates
 *     the per-ACK AudioContext creation cost (50–200 ms on mobile) and the
 *     speaker warm-up transient that previously bled into the microphone.
 *
 * 1B. **Async dedup ACK queue** — incoming frames queue their ACKs rather than
 *     silently dropping them when a previous ACK is still in flight.  Duplicate
 *     ACKs (same key) are deduplicated so the queue never grows unboundedly.
 *
 * 1C. **RX mute during ACK TX + ring-down** — the RX state machine is muted
 *     while the ACK plays and for ACK_RING_DOWN_MS afterward.  This prevents
 *     the receiver's own speaker output from being fed back into the Goertzel
 *     detector and corrupting preamble lock on the next incoming data frame.
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
    // Persistent ACK TransmitterSession for the current receive session.
    // Held at outer scope so it can be torn down when the user clicks Receive
    // again before the previous session completes.
    let ackTxSession: TransmitterSession | null = null;

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

        // Tear down any previous listener and ACK session before starting new ones.
        stopListener?.();
        stopListener = null;
        ackTxSession?.destroy();
        ackTxSession = null;
        spectrogram?.stop();
        spectrogram = null;
        reassemblyManager?.destroy();
        reassemblyManager = new ReassemblyManager();

        // ── ACK queue ────────────────────────────────────────────────────────
        // Each entry carries the raw ACK frame and a dedup key (e.g. "data:5").
        // ACKs are processed one at a time.  While an ACK is transmitting, the
        // RX state machine is muted to prevent acoustic self-interference (1C).
        // After transmission, a ring-down pause (ACK_RING_DOWN_MS) lets the
        // speaker settle before the RX is unmuted (1C).
        type AckEntry = { frame: ArrayBuffer; key: string };
        const ackQueue: AckEntry[] = [];
        let isProcessingAck = false;
        // Set by the Promise.all below once startListening resolves.
        let setRxMuted: ((muted: boolean) => void) | null = null;

        // Keep a stable reference to THIS session's ACK transmitter so that
        // processAckQueue cannot accidentally use a session from a later click.
        const currentAckSession = new TransmitterSession(ACK_CHANNEL);
        ackTxSession = currentAckSession;

        async function processAckQueue(): Promise<void> {
            if (isProcessingAck) return;
            isProcessingAck = true;
            while (ackQueue.length > 0) {
                const { frame } = ackQueue.shift()!;
                // Mute RX before transmitting: prevents self-interference (1C).
                setRxMuted?.(true);
                try {
                    await currentAckSession.send(frame);
                } catch (err) {
                    console.error('Receiver: ACK transmission error:', err);
                    // Re-enable RX even on failure so the session is not stuck
                    // muted forever; then abort the queue.
                    setRxMuted?.(false);
                    break;
                }
                // Speaker ring-down: keep RX muted for a short period after the
                // last PCM sample plays so that reverb tails are not decoded as
                // preamble symbols for the next incoming frame (1C).
                await new Promise<void>(r => setTimeout(r, ACK_RING_DOWN_MS));
                setRxMuted?.(false);
            }
            isProcessingAck = false;
        }

        /**
         * Enqueues an ACK frame for transmission.
         * @param ackFrame  The raw compact ACK frame bytes.
         * @param key       Dedup key: `"start:<fileId>"` or `"data:<frameIndex>"`.
         *                  If the same key is already queued, the call is ignored.
         */
        function enqueueAck(ackFrame: ArrayBuffer, key: string): void {
            if (ackQueue.some(a => a.key === key)) return;
            ackQueue.push({ frame: ackFrame, key });
            processAckQueue().catch(err => console.error('Receiver: ACK queue error:', err));
        }

        try {
            // Initialise the ACK TransmitterSession concurrently with
            // startListening so neither blocks the other.  By the time the
            // first data frame can possibly arrive both are ready.
            const [listenerResult] = await Promise.all([
                startListening((frame) => {
                    try {
                        const { header, payload } = deframe(frame);

                        switch (header.type) {
                            case 'file-start': {
                                reassemblyManager!.getReassembler(header);
                                statusEl.textContent = `Receiving file: ${header.fileName}`;
                                enqueueAck(
                                    createCompactAckStartFrame(header.fileId),
                                    `start:${header.fileId}`,
                                );
                                break;
                            }
                            case 'file-data': {
                                statusEl.textContent = `Receiving frame ${header.frameIndex! + 1}/${header.totalFrames}`;
                                receiveProgress.max = header.totalFrames!;
                                receiveProgress.value = header.frameIndex! + 1;

                                const file = reassemblyManager!.processFrame(header, payload);
                                enqueueAck(
                                    createCompactAckFrame(header.fileId, header.frameIndex!),
                                    `data:${header.frameIndex}`,
                                );

                                if (file) {
                                    statusEl.textContent = `File "${file.name}" received!`;
                                    const url = URL.createObjectURL(file);
                                    downloadLink.href = url;
                                    downloadLink.download = file.name;
                                    downloadLink.textContent = `Download ${file.name}`;
                                    downloadLink.style.display = 'block';
                                    receiveButton.disabled = false;
                                    spectrogram?.stop();
                                    spectrogram = null;
                                    reassemblyManager?.destroy();
                                    reassemblyManager = null;
                                    // Stop receiving new frames now that the
                                    // transfer is complete.
                                    stopListener?.();
                                    stopListener = null;
                                    // Schedule ACK session cleanup after a delay
                                    // that gives the in-flight ACK time to finish.
                                    // Capture the session reference so a subsequent
                                    // click that creates a new session is not affected.
                                    const sessionToClose = ackTxSession;
                                    ackTxSession = null;
                                    window.setTimeout(() => sessionToClose?.destroy(), 3000);
                                }
                                break;
                            }
                        }
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        console.error('Frame error:', err);
                        statusEl.textContent = `Error: ${msg}. Waiting for next frame...`;
                    }
                }),
                currentAckSession.init(),
            ]);

            const { analyser, stop, setRxMuted: muter } = listenerResult;
            setRxMuted = muter;
            stopListener = stop;
            spectrogram = new Spectrogram(spectrogramCanvas, analyser);
            spectrogram.start();

        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('Error starting listener:', err);
            statusEl.textContent = `Error: ${msg}`;
            receiveButton.disabled = false;
            currentAckSession.destroy();
            ackTxSession = null;
            reassemblyManager?.destroy();
            reassemblyManager = null;
        }
    });
}
