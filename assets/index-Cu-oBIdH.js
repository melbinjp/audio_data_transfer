(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const s of document.querySelectorAll('link[rel="modulepreload"]'))t(s);new MutationObserver(s=>{for(const o of s)if(o.type==="childList")for(const c of o.addedNodes)c.tagName==="LINK"&&c.rel==="modulepreload"&&t(c)}).observe(document,{childList:!0,subtree:!0});function n(s){const o={};return s.integrity&&(o.integrity=s.integrity),s.referrerPolicy&&(o.referrerPolicy=s.referrerPolicy),s.crossOrigin==="use-credentials"?o.credentials="include":s.crossOrigin==="anonymous"?o.credentials="omit":o.credentials="same-origin",o}function t(s){if(s.ep)return;s.ep=!0;const o=n(s);fetch(s.href,o)}})();const Y=5,M=[2,4,6,8],D=1,N=16,K=10,q=171,W=8,X=.005,H=.4;function B(a){return Math.round(Y*a/1e3)}function V(a,e,n){const s=M[a]*n/e,o=new Float32Array(e),c=2*Math.PI*s/n;for(let f=0;f<e;f++)o[f]=Math.sin(c*f);return o}function L(a){return[a>>6&3,a>>4&3,a>>2&3,a&3]}function G(a,e,n){const t=new Uint8Array(a),s=M.map((m,l)=>V(l,e,n));let o=0;for(const m of t)o^=m;const c=N+4+t.length*4+4+W,f=new Float32Array(c*e);let h=0;const g=m=>{f.set(s[m],h),h+=e};for(let m=0;m<N;m++)g(D);for(const m of L(q))g(m);for(const m of t)for(const l of L(m))g(l);for(const m of L(o))g(m);return f}function J(){return`
class FskRxProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var opts = (options && options.processorOptions) || {};
    this._N    = opts.symbolSamples    || 240;
    this._kv   = opts.kValues          || [2, 4, 6, 8];
    this._silT = opts.silenceThreshold || 0.005;
    this._buf  = new Float32Array(0);
    this._run  = true;
    var self = this;
    this.port.onmessage = function(e) { if (e.data === 'stop') self._run = false; };
  }

  /**
   * Goertzel algorithm: efficiently computes energy at frequency
   * f = k * sampleRate / N  without a full FFT.
   * Returns a power estimate (arbitrary units, proportional to amplitude²).
   */
  _goertzel(buf, k) {
    var N = buf.length;
    var coeff = 2.0 * Math.cos((2.0 * Math.PI * k) / N);
    var q1 = 0.0, q2 = 0.0;
    for (var i = 0; i < N; i++) {
      var q0 = buf[i] + coeff * q1 - q2;
      q2 = q1;
      q1 = q0;
    }
    return q1 * q1 + q2 * q2 - coeff * q1 * q2;
  }

  process(inputs) {
    if (!this._run) return false;
    var ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;

    /* Append new samples to accumulation buffer. */
    var merged = new Float32Array(this._buf.length + ch.length);
    merged.set(this._buf);
    merged.set(ch, this._buf.length);
    this._buf = merged;

    /* Process complete symbol windows. */
    while (this._buf.length >= this._N) {
      var sym = this._buf.subarray(0, this._N);

      /* RMS — silence gate. */
      var sumSq = 0.0;
      for (var i = 0; i < sym.length; i++) sumSq += sym[i] * sym[i];
      var rms = Math.sqrt(sumSq / sym.length);

      if (rms < this._silT) {
        this.port.postMessage({ type: 'symbol', toneIndex: -1, rms: rms, dominance: 0 });
      } else {
        /* Goertzel energy for each of the four tones. */
        var energies = [];
        for (var j = 0; j < this._kv.length; j++) {
          energies.push(this._goertzel(sym, this._kv[j]));
        }
        var total = 0.0;
        for (var j = 0; j < energies.length; j++) total += energies[j];
        var maxE = -1.0, best = 0;
        for (var j = 0; j < energies.length; j++) {
          if (energies[j] > maxE) { maxE = energies[j]; best = j; }
        }
        var dom = total > 0.0 ? maxE / total : 0.0;
        this.port.postMessage({ type: 'symbol', toneIndex: best, rms: rms, dominance: dom });
      }

      /* Advance buffer by one symbol. */
      this._buf = this._buf.slice(this._N);
    }

    return true;
  }
}

registerProcessor('fsk-rx-processor', FskRxProcessor);
`}const Z=500;function $(){try{const a=new AudioContext;a.resume().catch(()=>{}),setTimeout(()=>a.close().catch(()=>{}),Z)}catch(a){console.warn("primeAudio: could not create AudioContext:",a)}}class Q{ctx=null;isDestroyed=!1;async init(){try{this.ctx=new AudioContext,await this.ctx.resume()}catch(e){this.ctx=null;const n=e instanceof Error?e.message:String(e);throw new Error(`TransmitterSession: failed to create or resume AudioContext — ${n}. Ensure primeAudio() was called synchronously in the click handler.`)}}send(e){return new Promise((n,t)=>{if(this.isDestroyed||!this.ctx){t(new Error("TransmitterSession has been destroyed or not initialised"));return}const s=this.ctx,o=B(s.sampleRate);let c;try{c=G(e,o,s.sampleRate)}catch(g){t(g instanceof Error?g:new Error(String(g)));return}const f=s.createBuffer(1,c.length,s.sampleRate);f.copyToChannel(c,0);const h=s.createBufferSource();h.buffer=f,h.connect(s.destination),h.onended=()=>n(),h.start()})}destroy(){this.isDestroyed||(this.isDestroyed=!0,this.ctx?.close().catch(()=>{}),this.ctx=null)}}async function ee(a){const e=new AudioContext;if(await e.resume(),!e.audioWorklet)throw e.close().catch(()=>{}),new Error("AudioWorklet is not supported in this browser. Please use Chrome 66+, Firefox 76+, or Safari 14.1+.");const n=await navigator.mediaDevices.getUserMedia({audio:!0,video:!1}).catch(v=>{e.close().catch(()=>{});const E=v instanceof Error?v.message:String(v);throw new Error(`startListening: microphone access failed — ${E}. Check browser permissions and ensure a microphone is connected.`)}),t=e.createMediaStreamSource(n),s=e.createAnalyser();s.fftSize=2048,t.connect(s);const o=new Blob([J()],{type:"application/javascript"}),c=URL.createObjectURL(o);await e.audioWorklet.addModule(c),URL.revokeObjectURL(c);const f=B(e.sampleRate),h=new AudioWorkletNode(e,"fsk-rx-processor",{processorOptions:{symbolSamples:f,kValues:Array.from(M),silenceThreshold:X}});t.connect(h);let g="IDLE",m=0,l=[],b=[],w=0;function x(){g="IDLE",m=0,l=[],b=[],w=0}function I(){const v=l[0]<<6|l[1]<<4|l[2]<<2|l[3];return l=[],v&255}return h.port.onmessage=v=>{const E=v.data;if(E.type!=="symbol")return;const{toneIndex:F,dominance:_}=E,C=F>=0&&_>=H;switch(g){case"IDLE":C&&F===D?(m++,m>=K&&(g="SYNC",l=[])):m=0;break;case"SYNC":if(!C){x();break}if(l.push(F),l.length===4){const S=I();S===q?(g="DATA",b=[],w=0):(console.warn(`FSK RX: sync mismatch (got 0x${S.toString(16).toUpperCase()})`),x())}break;case"DATA":if(!C){console.warn("FSK RX: noise during data symbols — discarding frame"),x();break}if(l.push(F),l.length===4){const S=I();b.push(S),b.length===2&&w===0&&(w=2+(b[0]<<8|b[1])),w>0&&b.length===w&&(g="CHECKSUM",l=[])}break;case"CHECKSUM":if(!C){console.warn("FSK RX: noise during checksum symbol — discarding frame"),x();break}if(l.push(F),l.length===4){const S=I();let A=0;for(const r of b)A^=r;if(S===(A&255)){const r=new Uint8Array(b).buffer;try{a(r)}catch(y){console.error("FSK RX: onData callback threw:",y)}}else console.warn(`FSK RX: checksum mismatch (expected 0x${(A&255).toString(16).toUpperCase()}, got 0x${S.toString(16).toUpperCase()})`);x()}break}},{analyser:s,stop:()=>{h.port.postMessage("stop"),h.disconnect(),t.disconnect(),n.getTracks().forEach(v=>v.stop()),e.close().catch(()=>{})}}}function te(a){return a&&a.__esModule&&Object.prototype.hasOwnProperty.call(a,"default")?a.default:a}var R={};/*! crc32.js (C) 2014-present SheetJS -- http://sheetjs.com */var P;function se(){return P||(P=1,(function(a){(function(e){e(typeof DO_NOT_EXPORT_CRC>"u"?a:{})})(function(e){e.version="1.2.2";function n(){for(var r=0,y=new Array(256),i=0;i!=256;++i)r=i,r=r&1?-306674912^r>>>1:r>>>1,r=r&1?-306674912^r>>>1:r>>>1,r=r&1?-306674912^r>>>1:r>>>1,r=r&1?-306674912^r>>>1:r>>>1,r=r&1?-306674912^r>>>1:r>>>1,r=r&1?-306674912^r>>>1:r>>>1,r=r&1?-306674912^r>>>1:r>>>1,r=r&1?-306674912^r>>>1:r>>>1,y[i]=r;return typeof Int32Array<"u"?new Int32Array(y):y}var t=n();function s(r){var y=0,i=0,u=0,d=typeof Int32Array<"u"?new Int32Array(4096):new Array(4096);for(u=0;u!=256;++u)d[u]=r[u];for(u=0;u!=256;++u)for(i=r[u],y=256+u;y<4096;y+=256)i=d[y]=i>>>8^r[i&255];var p=[];for(u=1;u!=16;++u)p[u-1]=typeof Int32Array<"u"?d.subarray(u*256,u*256+256):d.slice(u*256,u*256+256);return p}var o=s(t),c=o[0],f=o[1],h=o[2],g=o[3],m=o[4],l=o[5],b=o[6],w=o[7],x=o[8],I=o[9],O=o[10],v=o[11],E=o[12],F=o[13],_=o[14];function C(r,y){for(var i=y^-1,u=0,d=r.length;u<d;)i=i>>>8^t[(i^r.charCodeAt(u++))&255];return~i}function S(r,y){for(var i=y^-1,u=r.length-15,d=0;d<u;)i=_[r[d++]^i&255]^F[r[d++]^i>>8&255]^E[r[d++]^i>>16&255]^v[r[d++]^i>>>24]^O[r[d++]]^I[r[d++]]^x[r[d++]]^w[r[d++]]^b[r[d++]]^l[r[d++]]^m[r[d++]]^g[r[d++]]^h[r[d++]]^f[r[d++]]^c[r[d++]]^t[r[d++]];for(u+=15;d<u;)i=i>>>8^t[(i^r[d++])&255];return~i}function A(r,y){for(var i=y^-1,u=0,d=r.length,p=0,k=0;u<d;)p=r.charCodeAt(u++),p<128?i=i>>>8^t[(i^p)&255]:p<2048?(i=i>>>8^t[(i^(192|p>>6&31))&255],i=i>>>8^t[(i^(128|p&63))&255]):p>=55296&&p<57344?(p=(p&1023)+64,k=r.charCodeAt(u++)&1023,i=i>>>8^t[(i^(240|p>>8&7))&255],i=i>>>8^t[(i^(128|p>>2&63))&255],i=i>>>8^t[(i^(128|k>>6&15|(p&3)<<4))&255],i=i>>>8^t[(i^(128|k&63))&255]):(i=i>>>8^t[(i^(224|p>>12&15))&255],i=i>>>8^t[(i^(128|p>>6&63))&255],i=i>>>8^t[(i^(128|p&63))&255]);return~i}e.table=t,e.bstr=C,e.buf=S,e.str=A})})(R)),R}var re=se();const j=te(re),T=256;function z(a,e){const n=JSON.stringify(a),t=new TextEncoder().encode(n);if(t.length>255)throw new Error(`Header is too large (${t.length} bytes) for a 1-byte length prefix (max 255 bytes)`);const s=e?e.byteLength:0,o=1+t.length+s,c=new ArrayBuffer(2+o),f=new Uint8Array(c);return f[0]=o>>8&255,f[1]=o&255,f[2]=t.length,f.set(t,3),e&&f.set(new Uint8Array(e),3+t.length),c}function ne(a,e){const n=Math.ceil(a.size/T),t={type:"file-start",fileId:e,fileName:a.name,fileType:a.type,totalFrames:n};return z(t)}function oe(a,e,n,t){const s={type:"file-data",fileId:e,frameIndex:n,totalFrames:t,crc32:j.buf(new Uint8Array(a))};return z(s,a)}function ie(a){const n=new Uint8Array(a)[2],t=a.slice(3,3+n),s=a.slice(3+n),o=new TextDecoder().decode(t),c=JSON.parse(o);if(c.crc32!==void 0&&j.buf(new Uint8Array(s))!==c.crc32)throw new Error("CRC32 mismatch");return{header:c,payload:s}}const U=3e4;class ae{constructor(e,n,t,s){this.fileId=e,this.fileName=n,this.fileType=t,this.totalFrames=s,this.chunks=new Array(s),this.lastUpdated=Date.now()}chunks;receivedChunks=0;lastUpdated;addChunk(e,n){this.chunks[e]||(this.chunks[e]=n,this.receivedChunks++),this.lastUpdated=Date.now()}isComplete(){return this.receivedChunks===this.totalFrames}getFile(){if(!this.isComplete())throw new Error("File is not complete");const e=new Blob(this.chunks,{type:this.fileType});return new File([e],this.fileName,{type:this.fileType})}}class ce{reassemblers=new Map;cleanupInterval;constructor(){this.cleanupInterval=setInterval(()=>this.cleanup(),U)}getReassembler(e){if(e.type==="file-start"&&e.fileId&&e.fileName&&e.fileType&&e.totalFrames!==void 0){if(!this.reassemblers.has(e.fileId)){const n=new ae(e.fileId,e.fileName,e.fileType,e.totalFrames);this.reassemblers.set(e.fileId,n)}return this.reassemblers.get(e.fileId)}else if(e.type==="file-data"&&e.fileId)return this.reassemblers.get(e.fileId)||null;return null}processFrame(e,n){const t=this.getReassembler(e);if(!t||e.frameIndex===void 0)return null;if(t.addChunk(e.frameIndex,n),t.isComplete()){const s=t.getFile();return this.reassemblers.delete(t.fileId),s}return null}cleanup(){const e=Date.now();for(const[n,t]of this.reassemblers.entries())e-t.lastUpdated>=U&&(console.log(`Timing out reassembly for fileId: ${n}`),this.reassemblers.delete(n))}destroy(){clearInterval(this.cleanupInterval),this.reassemblers.clear()}}class le{constructor(e,n,t){this.file=e,this.onStateChange=n,this.onProgress=t}state="idle";fileId="";start(){this.fileId=crypto.randomUUID(),this.setState("sending","Preparing to send..."),this.sendAll().catch(e=>{const n=e instanceof Error?e.message:String(e);this.setState("error",`Transmission error: ${n}`)})}setState(e,n){this.state=e,n&&this.onStateChange(e,n)}async sendAll(){const e=Math.ceil(this.file.size/T);this.onProgress(0,e);const n=new Q;try{await n.init()}catch(t){const s=t instanceof Error?t.message:String(t);this.setState("error",`Failed to initialize transmitter: ${s}`);return}try{const t=ne(this.file,this.fileId);this.setState("sending","Sending handshake frame..."),await n.send(t);for(let s=0;s<e;s++){this.setState("sending",`Sending frame ${s+1}/${e}...`);const o=s*T,c=o+T,f=await this.file.slice(o,c).arrayBuffer(),h=oe(f,this.fileId,s,e);await n.send(h),this.onProgress(s+1,e)}this.setState("complete","File sent successfully.")}catch(t){const s=t instanceof Error?t.message:String(t);this.setState("error",`Transmission error: ${s}`)}finally{n.destroy()}}}function fe(){const a=document.getElementById("send-button"),e=document.getElementById("file-picker"),n=document.getElementById("send-progress"),t=document.getElementById("sender-status");let s=null;e.addEventListener("change",()=>{s=e.files?e.files[0]:null,a.disabled=!s,s?t.textContent=`Ready to send ${s.name}.`:t.textContent="Idle",n.value=0}),a.addEventListener("click",()=>{if(!s)return;$(),a.disabled=!0,new le(s,(c,f)=>{t.textContent=f,(c==="complete"||c==="error")&&(a.disabled=!1)},(c,f)=>{n.max=f,n.value=c}).start()})}class ue{canvas;analyser;canvasCtx;animationFrameId=null;constructor(e,n){this.canvas=e,this.analyser=n,this.canvasCtx=e.getContext("2d"),this.analyser.fftSize=2048}start(){this.animationFrameId&&this.stop(),this.draw()}stop(){this.animationFrameId&&(cancelAnimationFrame(this.animationFrameId),this.animationFrameId=null)}draw=()=>{this.animationFrameId=requestAnimationFrame(this.draw);const e=this.analyser.frequencyBinCount,n=new Uint8Array(e);this.analyser.getByteFrequencyData(n),this.canvasCtx.fillStyle="rgb(240, 240, 240)",this.canvasCtx.fillRect(0,0,this.canvas.width,this.canvas.height);const t=this.canvas.width/e*2.5;let s,o=0;for(let c=0;c<e;c++)s=n[c],this.canvasCtx.fillStyle=`rgb(50, ${s+100}, 50)`,this.canvasCtx.fillRect(o,this.canvas.height-s/2,t,s/2),o+=t+1}}function de(){const a=document.getElementById("receive-button"),e=document.getElementById("receiver-status"),n=document.getElementById("download-link"),t=document.getElementById("receive-progress"),s=document.getElementById("spectrogram-canvas");let o=null,c=null,f=null;a.addEventListener("click",async()=>{$(),console.log("Starting to listen..."),a.disabled=!0,e.textContent="Listening...",n.style.display="none",t.value=0,f?.(),f=null,o&&o.stop(),c&&c.destroy(),c=new ce;try{const{analyser:h,stop:g}=await ee(m=>{try{const{header:l,payload:b}=ie(m);switch(l.type){case"file-start":{c.getReassembler(l),e.textContent=`Receiving file: ${l.fileName}`;break}case"file-data":{e.textContent=`Receiving frame ${l.frameIndex+1}/${l.totalFrames}`,t.max=l.totalFrames,t.value=l.frameIndex+1;const w=c.processFrame(l,b);if(w){e.textContent=`File "${w.name}" received!`;const x=URL.createObjectURL(w);n.href=x,n.download=w.name,n.textContent=`Download ${w.name}`,n.style.display="block",a.disabled=!1,o&&(o.stop(),o=null),c?.destroy(),c=null,f?.(),f=null}break}}}catch(l){const b=l instanceof Error?l.message:String(l);console.error("Frame error:",l),e.textContent=`Error: ${b}. Waiting for next frame...`}});f=g,o=new ue(s,h),o.start()}catch(h){const g=h instanceof Error?h.message:String(h);console.error("Error starting listener:",h),e.textContent=`Error: ${g}`,a.disabled=!1,c&&(c.destroy(),c=null)}})}console.log("Data Over Audio app is running!");document.addEventListener("DOMContentLoaded",()=>{fe(),de()});
