import { SenderSM } from './sender-sm';
import { primeAudio } from '../dsp/fsk-modem';
import { ACOUSTIC_SETTINGS } from './acoustic-settings';
import { runDefaultLocalSelfTest } from './self-test';

/**
 * Initializes the sender UI, wiring up the file picker and send button
 * to the `SenderSM` state machine.
 */
export function initializeSender() {
    const sendButton = document.getElementById('send-button') as HTMLButtonElement;
    const selfTestButton = document.getElementById('self-test-button') as HTMLButtonElement;
    const filePicker = document.getElementById('file-picker') as HTMLInputElement;
    const sendProgress = document.getElementById('send-progress') as HTMLProgressElement;
    const statusEl = document.getElementById('sender-status') as HTMLSpanElement;
    const selfTestStatusEl = document.getElementById('self-test-status') as HTMLSpanElement;
    let selectedFile: File | null = null;
    let selfTestReady = false;

    const updateSendButton = () => {
        sendButton.disabled = !selectedFile || !selfTestReady;
    };

    filePicker.addEventListener('change', () => {
        selectedFile = filePicker.files ? filePicker.files[0] : null;
        if (selectedFile) {
            statusEl.textContent = `Ready to send ${selectedFile.name}.`;
        } else {
            statusEl.textContent = 'Idle';
        }
        sendProgress.value = 0;
        updateSendButton();
    });

    selfTestButton.addEventListener('click', async () => {
        primeAudio();
        selfTestReady = false;
        updateSendButton();
        selfTestButton.disabled = true;
        selfTestStatusEl.textContent = 'Testing...';
        statusEl.textContent = 'Testing this device speaker and microphone...';

        const result = await runDefaultLocalSelfTest((message) => {
            selfTestStatusEl.textContent = message;
        });

        selfTestReady = result.ok;
        selfTestStatusEl.textContent = result.ok
            ? `Ready (data ${result.dataTone.score}/100, ACK ${result.ackTone.score}/100)`
            : `Weak (data ${result.dataTone.score}/100, ACK ${result.ackTone.score}/100)`;
        statusEl.textContent = result.ok
            ? 'This device speaker and microphone are verified.'
            : 'Self-test failed. Increase volume, reduce distance to mic, and try again.';
        selfTestButton.disabled = false;
        updateSendButton();
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
            },
            ACOUSTIC_SETTINGS,
        );
        sm.start();
    });
}
