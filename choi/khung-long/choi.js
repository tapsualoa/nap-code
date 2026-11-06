// Chơi thử bộ Game Khủng Long trên web: chạy đúng code của mạch (biên dịch ra game.wasm) bằng lõi giả lập.
import { SimCore, LocalStore } from './sim-core.js';

const $ = (s) => document.querySelector(s);
const man = $('#man'), ctx = man.getContext('2d');
const store = new LocalStore('khung-long');
// Số hiệu chỉnh cảm ứng sẵn (màn giả lập luôn chuẩn) -> không phải chạm 3 dấu cộng lần đầu
if (!store.get('qualive/cal')) store.set('qualive/cal', Uint8Array.from(atob('CSzw/bp2zX4/H0kQP1K7fr/nXBi7sxJvQw=='), (c) => c.charCodeAt(0)));

// ---- âm thanh: nhận mẫu 16-bit stereo từ game, đổi tần số rồi phát ----
class Loa {
  constructor() { this.ctx = null; this.on = localStorage.getItem('kl:am') !== '0'; }
  mo() {
    if (!this.on) return;
    if (!this.ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      this.ctx = new C({ latencyHint: 'interactive' });
      this.rate = this.ctx.sampleRate; this.size = this.rate;
      this.L = new Float32Array(this.size); this.R = new Float32Array(this.size);
      this.w = this.r = 0; this.frac = 0; this.pL = this.pR = 0;
      const node = this.ctx.createScriptProcessor(1024, 0, 2);
      node.onaudioprocess = (e) => {
        const a = e.outputBuffer.getChannelData(0), b = e.outputBuffer.getChannelData(1);
        for (let i = 0; i < a.length; i++) {
          if (this.r !== this.w) { a[i] = this.L[this.r]; b[i] = this.R[this.r]; this.r = (this.r + 1) % this.size; } else a[i] = b[i] = 0;
        }
      };
      node.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') this.ctx.resume();
    capNhatNut();
  }
  push(lr, n, rate) {
    if (!this.ctx || !this.on || this.ctx.state !== 'running') return;
    const step = rate / this.rate;
    let pos = this.frac;
    while (pos < n) {
      const i = Math.floor(pos), f = pos - i;
      const l0 = i > 0 ? lr[(i - 1) * 2] : this.pL, r0 = i > 0 ? lr[(i - 1) * 2 + 1] : this.pR;
      const nx = (this.w + 1) % this.size;
      if (nx === this.r) break;
      this.L[this.w] = (l0 + (lr[i * 2] - l0) * f) / 32768;
      this.R[this.w] = (r0 + (lr[i * 2 + 1] - r0) * f) / 32768;
      this.w = nx; pos += step;
    }
    this.frac = pos - n;
    this.pL = lr[(n - 1) * 2]; this.pR = lr[(n - 1) * 2 + 1];
  }
}
const loa = new Loa();
const capNhatNut = () => { $('#amThanh').textContent = loa.on ? '🔊' : '🔇'; };
$('#amThanh').onclick = () => {
  loa.on = !loa.on; localStorage.setItem('kl:am', loa.on ? '1' : '0');
  if (loa.on) loa.mo(); else if (loa.ctx) loa.ctx.suspend();
  capNhatNut();
};
capNhatNut();

// ---- chạy game ----
const sim = new SimCore({ store });
sim.audio.sink = (lr, n, rate) => loa.push(lr, n, rate);
await sim.load(new Uint8Array(await (await fetch('game.wasm')).arrayBuffer()));
const W = sim.fbW, H = sim.fbH;                     // bộ nhớ màn dọc 240x320, mạch xoay ngang -> 320x240
const img = ctx.createImageData(320, 240), px = new Uint32Array(img.data.buffer);
let khungCu = -1;

function bom() {
  let next = Infinity;
  try { next = sim.step(10); } catch (e) { console.error(e); }
  setTimeout(bom, Math.max(0, Math.min(16, next - sim.now())));
}
function ve() {
  requestAnimationFrame(ve);
  const f = sim.frame(), fl = sim.flags();
  if (f === khungCu) return;
  khungCu = f;
  const fb = sim.fb(), inv = fl & 1, swap = fl & 2, k = fl & 4 ? 0 : sim.backlight();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = fb[y * W + x];
    if (inv) v = ~v & 0xFFFF;
    let R = (v >> 8) & 0xF8, G = (v >> 3) & 0xFC, B = (v << 3) & 0xF8;
    if (swap) { const t = R; R = B; B = t; }
    R = (R | R >> 5) * k; G = (G | G >> 6) * k; B = (B | B >> 5) * k;
    px[(W - 1 - x) * 320 + y] = 0xFF000000 | (B << 16) | (G << 8) | R;   // X = y, Y = W-1-x
  }
  ctx.putImageData(img, 0, 0);
}

// ---- chạm màn (chuột / ngón tay) ----
const diem = (ev) => {
  const rc = man.getBoundingClientRect();
  const X = Math.min(319, Math.max(0, (ev.clientX - rc.left) * 320 / rc.width));
  const Y = Math.min(239, Math.max(0, (ev.clientY - rc.top) * 240 / rc.height));
  return [W - 1 - Y, X];
};
let id = null, tXuong = 0;
man.addEventListener('pointerdown', (ev) => {
  loa.mo();
  if (id !== null) return;
  id = ev.pointerId; man.setPointerCapture(id); tXuong = performance.now();
  sim.touch(true, ...diem(ev));
});
man.addEventListener('pointermove', (ev) => { if (ev.pointerId === id) sim.touch(true, ...diem(ev)); });
const tha = (ev) => {                                  // chạm giữ ít nhất 80 ms: game đọc cảm ứng mỗi 15 ms, bấm chuột nhanh quá sẽ bị lọt
  if (ev.pointerId !== id) return;
  const d = diem(ev);
  id = null;
  setTimeout(() => { if (id === null) sim.touch(false, ...d); }, Math.max(0, 80 - (performance.now() - tXuong)));
};
man.addEventListener('pointerup', tha);
man.addEventListener('pointercancel', tha);

// ---- nút BOOT (phím cách trên máy tính) ----
const boot = $('#boot');
const bootXuong = (ev) => { ev && ev.preventDefault(); loa.mo(); boot.classList.add('down'); sim.setPin(sim.bootPin, 0); };
const bootLen = () => { boot.classList.remove('down'); sim.setPin(sim.bootPin, 1); };
boot.addEventListener('pointerdown', bootXuong);
boot.addEventListener('pointerup', bootLen);
boot.addEventListener('pointerleave', bootLen);
addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat) bootXuong(e); });
addEventListener('keyup', (e) => { if (e.code === 'Space') bootLen(); });

// ---- toàn màn hình, tạm dừng khi ẩn tab ----
$('#toanMan').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else { await document.documentElement.requestFullscreen(); try { await screen.orientation.lock('landscape'); } catch {} }
  } catch { document.body.classList.toggle('full'); }
};
document.addEventListener('visibilitychange', () => { if (document.hidden) sim.pause(); else sim.resume(); });

$('#batDau button').onclick = () => { loa.mo(); $('#batDau').remove(); };
bom();
ve();
