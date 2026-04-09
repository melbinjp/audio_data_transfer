// Mock URL.createObjectURL which is not implemented in jsdom
if (!URL.createObjectURL) {
    URL.createObjectURL = () => 'blob:mock';
}
const g = globalThis as Record<string, unknown>;

if (!g['File']) {
    (g['File'] as unknown) = class MockFile {
        private parts: BlobPart[];
        public name: string;
        private options: BlobPropertyBag;
        constructor(parts: BlobPart[], name: string, options: BlobPropertyBag) {
            this.parts = parts;
            this.name = name;
            this.options = options;
        }
        async arrayBuffer(): Promise<ArrayBuffer> {
            const blob = new Blob(this.parts, this.options);
            return blob.arrayBuffer();
        }
    };
} else {
    const FileClass = g['File'] as typeof File;
    if (!FileClass.prototype.arrayBuffer) {
        FileClass.prototype.arrayBuffer = function (): Promise<ArrayBuffer> {
            return new Promise((resolve) => {
                const fr = new FileReader();
                fr.onload = () => resolve(fr.result as ArrayBuffer);
                fr.readAsArrayBuffer(this);
            });
        };
    }
}
