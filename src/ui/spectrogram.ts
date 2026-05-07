export class Spectrogram {
    private canvas: HTMLCanvasElement;
    private analyser: AnalyserNode;
    private canvasCtx: CanvasRenderingContext2D;
    private animationFrameId: number | null = null;

    constructor(canvas: HTMLCanvasElement, analyser: AnalyserNode) {
        this.canvas = canvas;
        this.analyser = analyser;
        this.canvasCtx = canvas.getContext('2d')!;
        this.analyser.fftSize = 2048;
    }

    public start() {
        if (this.animationFrameId) {
            this.stop();
        }
        this.draw();
    }

    public stop() {
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }

    private draw = () => {
        this.animationFrameId = requestAnimationFrame(this.draw);

        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        this.analyser.getByteFrequencyData(dataArray);

        this.canvasCtx.fillStyle = 'rgb(240, 240, 240)';
        this.canvasCtx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        const barWidth = (this.canvas.width / bufferLength) * 2.5;
        let barHeight;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
            barHeight = dataArray[i];

            this.canvasCtx.fillStyle = `rgb(50, ${barHeight + 100}, 50)`;
            this.canvasCtx.fillRect(x, this.canvas.height - barHeight / 2, barWidth, barHeight / 2);

            x += barWidth + 1;
        }
    };
}
