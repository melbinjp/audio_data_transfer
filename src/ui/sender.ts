import { sendData } from '../dsp/quiet-modem';
import { chunkFile } from '../transport/framing';

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

    sendButton.addEventListener('click', async () => {
        if (!selectedFile) {
            return;
        }

        sendButton.disabled = true;
        statusEl.textContent = `Chunking file...`;

        const frames = await chunkFile(selectedFile);
        sendProgress.max = frames.length;
        sendProgress.value = 0;

        for (let i = 0; i < frames.length; i++) {
            statusEl.textContent = `Sending frame ${i + 1}/${frames.length}...`;
            sendProgress.value = i + 1;
            const transmitter = await sendData(frames[i]);
            // Wait for onFinish to be called, which indicates the sound has been played.
            // This is a bit of a hack since onFinish doesn't return a promise.
            // A better way would be to calculate the duration of the sound and sleep for that long.
            // quiet.js transmitter does not expose the duration, so we will sleep for a fixed time.
            const estimatedDuration = frames[i].byteLength * 8 / 44100 * 1000 * 2; // Heuristic
            await sleep(estimatedDuration + 200); // Add a buffer
            transmitter.destroy();
        }

        statusEl.textContent = 'File sending complete.';
        sendButton.disabled = false;
    });
}
