import { startListening } from '../dsp/quiet-modem';
import { ReassemblyBuffer } from '../transport/framing';
import { Spectrogram } from './spectrogram';
import { displayChatMessage } from './chat';

export function initializeReceiver() {
  const receiveButton = document.getElementById('receive-button') as HTMLButtonElement;
  const statusEl = document.getElementById('receiver-status') as HTMLSpanElement;
  const downloadLink = document.getElementById('download-link') as HTMLAnchorElement;
  const receiveProgress = document.getElementById('receive-progress') as HTMLProgressElement;
  const spectrogramCanvas = document.getElementById('spectrogram-canvas') as HTMLCanvasElement;

  let spectrogram: Spectrogram | null = null;

  receiveButton.addEventListener('click', async () => {
    console.log('Starting to listen...');
    receiveButton.disabled = true;
    statusEl.textContent = 'Listening...';
    downloadLink.style.display = 'none';
    receiveProgress.value = 0;

    if (spectrogram) {
      spectrogram.stop();
    }

    const reassembly = new ReassemblyBuffer();

    try {
      const { analyser } = await startListening((chunk) => {
        try {
          const result = reassembly.addChunk(chunk);

          // Show progress if we know the expected length
          const expected = reassembly.expectedLength;
          if (expected > 0) {
            receiveProgress.max = expected;
            receiveProgress.value = reassembly.bytesReceived;
            statusEl.textContent = `Receiving: ${reassembly.bytesReceived}/${expected} bytes...`;
          }

          if (result === null) {
            return; // More data needed
          }

          if (result.type === 'file') {
            statusEl.textContent = `File "${result.fileName}" received!`;
            receiveProgress.value = receiveProgress.max;
            const blob = new Blob([result.fileData], { type: result.fileType });
            const url = URL.createObjectURL(blob);
            downloadLink.href = url;
            downloadLink.download = result.fileName;
            downloadLink.textContent = `Download ${result.fileName}`;
            downloadLink.style.display = 'block';
          } else if (result.type === 'chat') {
            displayChatMessage(result.text);
            statusEl.textContent = 'Listening...';
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error('Frame error:', error);
          statusEl.textContent = `Error: ${msg}. Waiting for next transmission...`;
          reassembly.reset();
        }
      });

      spectrogram = new Spectrogram(spectrogramCanvas, analyser);
      spectrogram.start();

    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Error starting listener:', error);
      statusEl.textContent = `Error: ${msg}`;
      receiveButton.disabled = false;
    }
  });
}
