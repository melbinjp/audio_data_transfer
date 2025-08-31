import { startListening } from '../dsp/quiet-modem';
import { deframe, reassembleFile } from '../transport/framing';
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

    try {
      const { analyser } = await startListening((frame) => {
        try {
          const { header, payload } = deframe(frame);

          if (header.type === 'file' && header.fileName) {
            statusEl.textContent = `Receiving frame ${header.frameIndex! + 1}/${header.totalFrames} of ${header.fileName}`;
            receiveProgress.max = header.totalFrames!;
            receiveProgress.value = header.frameIndex! + 1;

            const file = reassembleFile(header, payload);
            if (file) {
              statusEl.textContent = `File "${file.name}" received!`;
              const url = URL.createObjectURL(file);
              downloadLink.href = url;
              downloadLink.download = file.name;
              downloadLink.textContent = `Download ${file.name}`;
              downloadLink.style.display = 'block';
              receiveButton.disabled = false; // Or stop listening
              if (spectrogram) {
                spectrogram.stop();
              }
            }
          } else if (header.type === 'chat' && header.text) {
            displayChatMessage(header.text);
          }
        } catch (error) {
          console.error('Frame error:', error);
          statusEl.textContent = `Error: ${error.message}. Waiting for next frame...`;
        }
      });

      spectrogram = new Spectrogram(spectrogramCanvas, analyser);
      spectrogram.start();

    } catch (error) {
      console.error('Error starting listener:', error);
      statusEl.textContent = `Error: ${error.message}`;
      receiveButton.disabled = false;
    }
  });
}
