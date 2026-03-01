import { sendData } from '../dsp/quiet-modem';
import { createFileEnvelope } from '../transport/framing';

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
            statusEl.textContent = `Ready to send ${selectedFile.name} (${(selectedFile.size / 1024).toFixed(1)} KB).`;
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
        statusEl.textContent = `Preparing file...`;
        sendProgress.value = 0;

        try {
            const fileData = await selectedFile.arrayBuffer();
            statusEl.textContent = `Encoding ${selectedFile.name} (${(fileData.byteLength / 1024).toFixed(1)} KB)...`;

            // Create a single envelope containing the entire file + metadata
            const envelope = createFileEnvelope(selectedFile, fileData);

            statusEl.textContent = `Transmitting ${selectedFile.name} via audio...`;
            sendProgress.max = 100;
            sendProgress.value = 50; // Indeterminate-ish progress

            // sendData returns a Promise that resolves when onFinish fires
            await sendData(envelope);

            sendProgress.value = 100;
            statusEl.textContent = `File "${selectedFile.name}" sent successfully.`;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            statusEl.textContent = `Error: ${msg}`;
            console.error('Send error:', error);
        } finally {
            sendButton.disabled = false;
        }
    });
}
