import { SenderSM } from './sender-sm';
import { primeAudio } from '../dsp/fsk-modem';

/**
 * Initializes the sender UI, wiring up the file picker and send button
 * to the `SenderSM` state machine.
 */
export function initializeSender() {
    const sendButton = document.getElementById('send-button') as HTMLButtonElement;
    const filePicker = document.getElementById('file-picker') as HTMLInputElement;
    const sendProgress = document.getElementById('send-progress') as HTMLProgressElement;
    const statusEl = document.getElementById('sender-status') as HTMLSpanElement;
    let selectedFile: File | null = null;

    filePicker.addEventListener('change', () => {
        selectedFile = filePicker.files ? filePicker.files[0] : null;
        sendButton.disabled = !selectedFile;
        if (selectedFile) {
            statusEl.textContent = `Ready to send ${selectedFile.name}.`;
        } else {
            statusEl.textContent = 'Idle';
        }
        sendProgress.value = 0;
    });

    sendButton.addEventListener('click', () => {
        if (!selectedFile) return;
        // Unlock the Web Audio API from within this synchronous user-gesture
        // handler so that AudioContext.resume() calls in subsequent async code
        // (inside quiet.js) are allowed by Chrome's autoplay policy.
        primeAudio();
        sendButton.disabled = true;

        const sm = new SenderSM(
            selectedFile,
            (state, message) => {
                statusEl.textContent = message;
                if (state === 'complete' || state === 'error') {
                    sendButton.disabled = false;
                }
            },
            (progress, total) => {
                sendProgress.max = total;
                sendProgress.value = progress;
            }
        );
        sm.start();
    });
}
