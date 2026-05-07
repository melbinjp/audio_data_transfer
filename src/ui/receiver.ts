import { startListening, primeAudio, TransmitterSession, DATA_CHANNEL, ACK_CHANNEL } from '../dsp/fsk-modem';
import { ACK_RING_DOWN_MS } from '../dsp/modem-config';
import {
    deframe,
    ReassemblyManager,
    createCompactAckFrame,
    createCompactAckStartFrame,
    createCompactProbeAckFrame,
} from '../transport/framing';
import { Spectrogram } from './spectrogram';
import { ACOUSTIC_SETTINGS, SignalQualityMeter } from './acoustic-settings';
import { hasLocalSelfTestPassed } from './self-test';

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

    function stopCurrentSession(message = 'Stopped.'): void {
        stopListener?.();
        stopListener = null;
        ackTxSession?.destroy();
        ackTxSession = null;
        spectrogram?.stop();
        spectrogram = null;
        reassemblyManager?.destroy();
        reassemblyManager = null;
        receiveButton.disabled = false;
        receiveButton.textContent = 'Start Listening';
        statusEl.textContent = message;
    }

    receiveButton.addEventListener('click', async () => {
        if (stopListener) {
            stopCurrentSession();
            return;
        }
        if (!hasLocalSelfTestPassed()) {
            statusEl.textContent = 'Run Test This Device first.';
            return;
        }

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
        stopCurrentSession('Listening...');
        receiveButton.disabled = true;
        reassemblyManager = new ReassemblyManager();
        const acousticSettings = ACOUSTIC_SETTINGS;
        const inboundQualityMeter = new SignalQualityMeter();

        // ── ACK queue ────────────────────────────────────────────────────────
        // Each entry carries the raw ACK frame and a dedup key (e.g. "data:5").
        // ACKs are processed one at a time.  While an ACK is transmitting, the
        // RX state machine is muted to prevent acoustic self-interference (1C).
        // After transmission, a ring-down pause (ACK_RING_DOWN_MS) lets the
        // speaker settle before the RX is unmuted (1C).
        type AckEntry = { frame: ArrayBuffer; key: string };
        const ackQueue: AckEntry[] = [];
        let isProcessingAck = false;
        let activeAckKey: string | null = null;
        // Set by the Promise.all below once startListening resolves.
        let setRxMuted: ((muted: boolean) => void) | null = null;

        // Keep a stable reference to THIS session's ACK transmitter so that
        // processAckQueue cannot accidentally use a session from a later click.
        const currentAckSession = new TransmitterSession(ACK_CHANNEL, acousticSettings.receiver.ackTransmitter);
        ackTxSession = currentAckSession;

        async function processAckQueue(): Promise<void> {
            if (isProcessingAck) return;
            isProcessingAck = true;
            while (ackQueue.length > 0) {
                const { frame, key } = ackQueue.shift()!;
                activeAckKey = key;
                // Mute RX before transmitting: prevents self-interference (1C).
                setRxMuted?.(true);
                try {
                    if (acousticSettings.receiver.ackTurnaroundMs > 0) {
                        await new Promise<void>(r => setTimeout(r, acousticSettings.receiver.ackTurnaroundMs));
                    }
                    for (let i = 0; i < acousticSettings.receiver.ackRepeatCount; i++) {
                        await currentAckSession.send(frame);
                        if (i < acousticSettings.receiver.ackRepeatCount - 1) {
                            await new Promise<void>(r => setTimeout(r, acousticSettings.receiver.ackRepeatGapMs));
                        }
                    }
                } catch (err) {
                    console.error('Receiver: ACK transmission error:', err);
                    // Re-enable RX even on failure so the session is not stuck
                    // muted forever; then abort the queue.
                    setRxMuted?.(false);
                    activeAckKey = null;
                    break;
                }
                // Speaker ring-down: keep RX muted for a short period after the
                // last PCM sample plays so that reverb tails are not decoded as
                // preamble symbols for the next incoming frame (1C).
                await new Promise<void>(r => setTimeout(r, ACK_RING_DOWN_MS));
                setRxMuted?.(false);
                activeAckKey = null;
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
            if (activeAckKey === key) return;
            if (ackQueue.some(a => a.key === key)) return;
            ackQueue.push({ frame: ackFrame, key });
            processAckQueue().catch(err => console.error('Receiver: ACK queue error:', err));
        }

        function finishReceivedFile(file: File): void {
            statusEl.textContent = `File "${file.name}" received!`;
            const url = URL.createObjectURL(file);
            downloadLink.href = url;
            downloadLink.download = file.name;
            downloadLink.textContent = `Download ${file.name}`;
            downloadLink.style.display = 'block';
            receiveProgress.max = Math.max(1, receiveProgress.max || 1);
            receiveProgress.value = receiveProgress.max;
            receiveButton.disabled = false;
            receiveButton.textContent = 'Start Receiving';
            spectrogram?.stop();
            spectrogram = null;
            reassemblyManager?.destroy();
            reassemblyManager = null;
            // Stop receiving new frames now that the transfer is complete.
            stopListener?.();
            stopListener = null;
            // Schedule ACK session cleanup after a delay that gives the in-flight
            // ACK time to finish. Capture the session reference so a subsequent
            // click that creates a new session is not affected.
            const sessionToClose = ackTxSession;
            ackTxSession = null;
            window.setTimeout(() => sessionToClose?.destroy(), 3000);
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
                            case 'probe': {
                                const quality = inboundQualityMeter.summarize();
                                enqueueAck(
                                    createCompactProbeAckFrame(header.fileId, quality.score),
                                    `probe:${header.fileId}`,
                                );
                                statusEl.textContent = `Calibration heard at ${quality.score}/100. Sending confirmation...`;
                                inboundQualityMeter.reset();
                                break;
                            }
                            case 'file-start': {
                                if (!reassemblyManager) {
                                    break;
                                }
                                const reassembler = reassemblyManager.getReassembler(header);
                                if (!reassembler) {
                                    statusEl.textContent = 'Error: invalid file metadata. Waiting for next frame...';
                                    break;
                                }
                                statusEl.textContent = `Receiving file: ${header.fileName}`;
                                enqueueAck(
                                    createCompactAckStartFrame(header.fileId),
                                    `start:${header.fileId}`,
                                );
                                statusEl.textContent = `Receiving file: ${header.fileName}. Sending ACK...`;
                                if (header.totalFrames === 0) {
                                    finishReceivedFile(new File([], header.fileName ?? 'received-file', {
                                        type: header.fileType ?? '',
                                    }));
                                }
                                break;
                            }
                            case 'file-data': {
                                if (!reassemblyManager || !reassemblyManager.canProcessFrame(header)) {
                                    statusEl.textContent = 'Waiting for file metadata before accepting data frames...';
                                    break;
                                }
                                const totalFrames =
                                    Number.isInteger(header.totalFrames) && header.totalFrames! > 0
                                        ? header.totalFrames!
                                        : receiveProgress.max || 1;
                                statusEl.textContent = `Receiving frame ${header.frameIndex! + 1}/${totalFrames}`;
                                receiveProgress.max = totalFrames;
                                receiveProgress.value = header.frameIndex! + 1;

                                const file = reassemblyManager!.processFrame(header, payload);
                                enqueueAck(
                                    createCompactAckFrame(header.fileId, header.frameIndex!),
                                    `data:${header.frameIndex}`,
                                );
                                statusEl.textContent = `Receiving frame ${header.frameIndex! + 1}/${totalFrames}. Sending ACK...`;

                                if (file) {
                                    finishReceivedFile(file);
                                }
                                break;
                            }
                        }
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        console.error('Frame error:', err);
                        statusEl.textContent = `Error: ${msg}. Waiting for next frame...`;
                    }
                }, DATA_CHANNEL, {
                    ...acousticSettings.receiver.listen,
                    onSignal: signal => inboundQualityMeter.add(signal),
                }),
                currentAckSession.init(),
            ]);

            const { analyser, stop, setRxMuted: muter } = listenerResult;
            setRxMuted = muter;
            stopListener = stop;
            spectrogram = new Spectrogram(spectrogramCanvas, analyser);
            spectrogram.start();
            receiveButton.disabled = false;
            receiveButton.textContent = 'Stop Listening';
            statusEl.textContent = 'Listening...';

        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('Error starting listener:', err);
            statusEl.textContent = `Error: ${msg}`;
            receiveButton.disabled = false;
            receiveButton.textContent = 'Start Listening';
            currentAckSession.destroy();
            ackTxSession = null;
            reassemblyManager?.destroy();
            reassemblyManager = null;
        }
    });
}
