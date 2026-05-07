import { SenderSM } from './sender-sm';
import { primeAudio } from '../dsp/fsk-modem';
import { getSelectedAcousticProfile } from './acoustic-profile';
import { runAcousticLinkCheck } from './link-check';

/**
 * Initializes the sender UI, wiring up the file picker and send button
 * to the `SenderSM` state machine.
 */
export function initializeSender() {
    const sendButton = document.getElementById('send-button') as HTMLButtonElement;
    const linkCheckButton = document.getElementById('link-check-button') as HTMLButtonElement;
    const filePicker = document.getElementById('file-picker') as HTMLInputElement;
    const sendProgress = document.getElementById('send-progress') as HTMLProgressElement;
    const statusEl = document.getElementById('sender-status') as HTMLSpanElement;
    const linkStatusEl = document.getElementById('link-status') as HTMLSpanElement;
    let selectedFile: File | null = null;
    let linkReady = false;

    const updateSendButton = () => {
        sendButton.disabled = !selectedFile || !linkReady;
    };

    const resetLink = () => {
        linkReady = false;
        linkStatusEl.textContent = 'Not checked';
        updateSendButton();
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

    document.getElementById('acoustic-profile')?.addEventListener('change', resetLink);

    linkCheckButton.addEventListener('click', async () => {
        primeAudio();
        linkReady = false;
        updateSendButton();
        linkCheckButton.disabled = true;
        linkStatusEl.textContent = 'Checking...';
        statusEl.textContent = 'Checking acoustic link...';

        const ok = await runAcousticLinkCheck(getSelectedAcousticProfile(), (message) => {
            linkStatusEl.textContent = message;
        });

        linkReady = ok;
        linkStatusEl.textContent = ok ? 'Ready' : 'Not ready';
        statusEl.textContent = ok
            ? 'Link ready. Choose a file and send.'
            : 'Link check failed. Start receiver, increase volume, and try again.';
        linkCheckButton.disabled = false;
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
            getSelectedAcousticProfile(),
        );
        sm.start();
    });
}
