// LÕI GIẢ LẬP phía JavaScript: chạy sketch.wasm, lập lịch các task (asyncify), màn hình, âm thanh, lưu trữ.
// Không phụ thuộc giao diện -> dùng được cả trong app (WebView) lẫn Node (để test tự động).

const INF = Infinity;

export class SimCore {
  constructor(opt = {}) {
    this.opt = opt;
    this.onSerial = opt.onSerial || (() => {});
    this.store = opt.store || new MemStore();
    this.audio = opt.audio || new VirtualAudio(() => this.now());
    this.t0 = 0;
    this.pausedAt = 0;
    this.tasks = new Map();
    this.order = [];
    this.rr = 0;
    this.cur = null;
    this.unwinding = false;
    this.rewinding = false;
    this.wantRestart = false;
    this.crashed = null;
    this.dec = new TextDecoder();
    this.held = new Map();               // chân đang bị giữ (nút BOOT...) -> giữ nguyên khi RESET
  }

  now() { return (this.pausedAt || performance.now()) - this.t0; }
  pause() { if (!this.pausedAt) this.pausedAt = performance.now(); }
  resume() { if (this.pausedAt) { this.t0 += performance.now() - this.pausedAt; this.pausedAt = 0; } }

  async load(bytes) {
    this.bytes = bytes;
    this.module = await WebAssembly.compile(bytes);
    await this._instantiate();
  }

  async _instantiate() {
    this.tasks.clear(); this.order = []; this.rr = 0; this.cur = null;
    this.unwinding = this.rewinding = false; this.crashed = null;
    const self = this;
    const env = {
      sim_now_ms: () => self.now(),
      sim_block: (wake) => self._block(wake),
      sim_wake: (id) => { const t = self.tasks.get(id); if (t && !t.done) t.wake = 0; },
      sim_task_new: (id, spTop, adata, asize, namePtr) => {
        const t = { id, spTop, adata, asize, name: self._cstr(namePtr), wake: 0, started: false, done: false, sp: 0 };
        self.tasks.set(id, t);
        self.order.push(t);
      },
      sim_task_end: (id) => { const t = self.tasks.get(id); if (t) t.done = true; },
      sim_serial_out: (p, n) => self.onSerial(self.dec.decode(self.u8.subarray(p, p + n))),
      sim_audio_push: (p, frames, rate) => self.audio.push(new Int16Array(self.mem.buffer, p, frames * 2), frames, rate),
      sim_store_get: (kp, buf, max) => {
        const v = self.store.get(self._cstr(kp));
        if (!v) return -1;
        self.u8.set(v.subarray(0, Math.min(max, v.length)), buf);
        return v.length;
      },
      sim_store_set: (kp, buf, n) => self.store.set(self._cstr(kp), self.u8.slice(buf, buf + n)),
      sim_store_del: (kp) => {
        const k = self._cstr(kp);
        if (k.endsWith('\x01')) self.store.del(k.slice(0, -1));
        else self.store.delPrefix(k);
      },
      sim_restart: () => { self.wantRestart = true; },
    };
    // Mạng: app Android cắm "net" vào (TCP/UDP thật); không có thì coi như mạng trống
    const net = this.opt.net || null;
    const str = (p) => self._cstr(p);
    const bytes = (p, n) => self.u8.slice(p, p + n);
    Object.assign(env, {
      sim_net_ip: () => net ? net.ip() >>> 0 : 0,
      sim_net_connect: (h, port) => net ? net.connect(str(h), port) : -1,
      sim_net_listen: (port) => net ? net.listen(port) : -1,
      sim_net_accept: (l) => net ? net.accept(l) : -1,
      sim_net_state: (h) => net ? net.state(h) : -1,
      sim_net_send: (h, p, n) => net ? net.send(h, bytes(p, n)) : -1,
      sim_net_recv: (h, p, n) => {
        if (!net) return -1;
        const b = net.recv(h, n);
        if (b == null) return -1;
        self.u8.set(b, p);
        return b.length;
      },
      sim_net_avail: (h) => net ? net.avail(h) : 0,
      sim_net_close: (h) => { if (net) net.close(h); },
      sim_net_peer: (h, portPtr) => {
        const r = net ? net.peer(h) : [0, 0];
        if (portPtr) self.dv.setInt32(portPtr, r[1], true);
        return r[0] >>> 0;
      },
      sim_udp_open: (port) => net ? net.udpOpen(port) : -1,
      sim_udp_send: (h, host, port, p, n) => net ? net.udpSend(h, str(host), port, bytes(p, n)) : -1,
      sim_udp_recv: (h, p, n, ipPtr, portPtr) => {
        if (!net) return 0;
        const r = net.udpRecv(h, n);
        if (!r) return 0;
        self.u8.set(r.data, p);
        self.dv.setUint32(ipPtr, r.ip >>> 0, true);
        self.dv.setInt32(portPtr, r.port, true);
        return r.data.length;
      },
      sim_dns: (h) => net ? net.dns(str(h)) >>> 0 : 0,
    });
    const wasi = this._wasi();
    const inst = await WebAssembly.instantiate(this.module, { env, wasi_snapshot_preview1: wasi });
    this.ex = inst.exports;
    this.mem = this.ex.memory;
    this.sp = this.ex.__stack_pointer;
    if (this.ex._initialize) this.ex._initialize();
    this.mainSp = this.sp.value;
    this.isrStack = this.ex.sim_malloc(65536) + 65536 - 16;
    this.t0 = performance.now(); this.pausedAt = 0;
    for (const [p, v] of this.held) this.ex.sim_set_pin(p, v);
    this.ex.sim_start();
    this.fbW = this.ex.sim_fb_w();
    this.fbH = this.ex.sim_fb_h();
    this.blPin = this.ex.sim_bl_pin();
    this.bootPin = this.ex.sim_boot_pin();
  }

  get u8() { return new Uint8Array(this.mem.buffer); }
  get dv() { return new DataView(this.mem.buffer); }
  _cstr(p) { if (!p) return ''; const u = this.u8; let e = p; while (u[e]) e++; return this.dec.decode(u.subarray(p, e)); }

  _wasi() {
    const self = this;
    const ENOSYS = 52;
    const base = {
      fd_write(fd, iovs, iovsLen, nwritten) {
        const dv = self.dv; let total = 0; let s = '';
        for (let i = 0; i < iovsLen; i++) {
          const p = dv.getUint32(iovs + i * 8, true), n = dv.getUint32(iovs + i * 8 + 4, true);
          s += self.dec.decode(self.u8.subarray(p, p + n)); total += n;
        }
        if (fd === 1 || fd === 2) self.onSerial(s);
        dv.setUint32(nwritten, total, true);
        return 0;
      },
      fd_close: () => 0,
      fd_seek: () => 0,
      fd_fdstat_get: () => 0,
      random_get(p, n) { crypto.getRandomValues(self.u8.subarray(p, p + n)); return 0; },
      clock_time_get(id, prec, out) {
        const ns = BigInt(Math.round((id === 0 ? Date.now() : self.now()) * 1e6));
        self.dv.setBigUint64(out, ns, true); return 0;
      },
      clock_res_get(id, out) { self.dv.setBigUint64(out, 1000n, true); return 0; },
      environ_sizes_get(c, s) { self.dv.setUint32(c, 0, true); self.dv.setUint32(s, 0, true); return 0; },
      environ_get: () => 0,
      args_sizes_get(c, s) { self.dv.setUint32(c, 0, true); self.dv.setUint32(s, 0, true); return 0; },
      args_get: () => 0,
      proc_exit(code) { throw new Error('Chương trình thoát, mã ' + code); },
      sched_yield: () => 0,
    };
    return new Proxy(base, { get: (o, k) => o[k] || (() => ENOSYS) });
  }

  // ---- asyncify: task nhường CPU ----
  _block(wake) {
    if (this.rewinding) {                  // đang khôi phục task -> chạy tiếp từ đây
      this.ex.asyncify_stop_rewind();
      this.rewinding = false;
      return;
    }
    const t = this.cur;
    if (!t) return;                        // gọi ngoài task: bỏ qua
    t.wake = wake;
    t.sp = this.sp.value;
    const dv = this.dv;
    dv.setUint32(t.adata, t.adata + 8, true);
    dv.setUint32(t.adata + 4, t.adata + t.asize, true);
    this.ex.asyncify_start_unwind(t.adata);
    this.unwinding = true;
  }

  _run(t) {
    this.cur = t;
    this.ex.sim_slice_begin(t.id);
    if (t.started) {
      this.sp.value = t.sp;
      this.ex.asyncify_start_rewind(t.adata);
      this.rewinding = true;
    } else {
      t.started = true;
      this.sp.value = t.spTop || this.mainSp;
    }
    try {
      this.ex.sim_task_run(t.id);
    } catch (e) {
      this.unwinding = this.rewinding = false;
      try { this.ex.asyncify_stop_unwind(); } catch (_) {}
      this.cur = null;
      this.crashed = `Task "${t.name}" bị lỗi: ${e.message}`;
      this.onSerial(`\n*** ${this.crashed} ***\n`);
      t.done = true;
      return;
    }
    if (this.unwinding) {
      this.ex.asyncify_stop_unwind();
      this.unwinding = false;
    } else {
      t.done = true;                       // hàm task đã kết thúc
    }
    this.ex.sim_slice_end();
    this.cur = null;
  }

  // Chạy các task tới lượt trong tối đa budget ms. Trả về thời điểm task gần nhất cần dậy.
  step(budget = 12) {
    if (this.crashed) return INF;
    const start = performance.now();
    for (;;) {
      const now = this.now();
      let ran = false;
      const n = this.order.length;
      for (let k = 0; k < n; k++) {
        const t = this.order[(this.rr + k) % n];
        if (t.done || t.wake > now) continue;
        this.rr = (this.rr + k + 1) % n;
        this._run(t);
        ran = true;
        break;
      }
      if (this.wantRestart || this.crashed) break;
      if (!ran || performance.now() - start > budget) break;
    }
    this.order = this.order.filter(t => !t.done);
    if (this.wantRestart) { this.wantRestart = false; this._instantiate(); return 0; }
    let next = INF;
    for (const t of this.order) next = Math.min(next, t.wake);
    return next;
  }

  _outside(fn) {                           // gọi vào wasm khi không ở trong task (ngắt, chạm...)
    const old = this.sp.value;
    this.sp.value = this.isrStack;
    try { return fn(); } finally { this.sp.value = old; }
  }

  // ---- màn hình ----
  frame() { return this.ex.sim_fb_frame(); }
  flags() { return this.ex.sim_fb_flags(); }
  fb() { return new Uint16Array(this.mem.buffer, this.ex.sim_fb(), this.fbW * this.fbH); }
  backlight() {                            // 0..1
    const p = this.blPin;
    if (p < 0) return 1;
    const pwm = this.ex.sim_pin_pwm(p);
    if (pwm >= 0) return pwm / 1000;
    const mode = this.ex.sim_pin_mode(p);
    if ((mode & 0x02) === 0) return 1;     // chưa cấu hình chân -> coi như sáng
    return this.ex.sim_pin_level(p) ? 1 : 0;
  }

  // ---- đầu vào ----
  touch(down, x, y) { this.ex.sim_touch(down ? 1 : 0, Math.round(x), Math.round(y)); }
  setPin(pin, v) { this.held.set(pin, v); this._outside(() => this.ex.sim_set_pin(pin, v)); }
  setAdc(pin, mv) { this.ex.sim_set_adc(pin, mv); }
  serialIn(text) {
    const b = new TextEncoder().encode(text).subarray(0, 1024);
    this.u8.set(b, this.ex.sim_serial_stage());
    this.ex.sim_serial_in(b.length);
  }
}

// Lưu trữ trong bộ nhớ (Node / test). App dùng LocalStore.
export class MemStore {
  constructor() { this.m = new Map(); }
  get(k) { return this.m.get(k); }
  set(k, v) { this.m.set(k, v); }
  del(k) { this.m.delete(k); }
  delPrefix(p) { for (const k of [...this.m.keys()]) if (k.startsWith(p)) this.m.delete(k); }
}

// Lưu vào localStorage của app -> giữ lại sau khi tắt app (giống flash NVS)
export class LocalStore {
  constructor(prefix) { this.p = 'nvs:' + prefix + ':'; }
  get(k) {
    const s = localStorage.getItem(this.p + k);
    if (s == null) return null;
    const b = atob(s), u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  set(k, v) { let s = ''; for (const c of v) s += String.fromCharCode(c); localStorage.setItem(this.p + k, btoa(s)); }
  del(k) { localStorage.removeItem(this.p + k); }
  delPrefix(pre) {
    const full = this.p + pre, ks = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(full)) ks.push(k); }
    ks.forEach(k => localStorage.removeItem(k));
  }
  clearAll() { this.delPrefix(''); }
}

// Âm thanh "ảo": giữ nhịp như DMA thật (mỗi lần nhận tối đa ~120 ms), có thể nối ra loa thật
export class VirtualAudio {
  constructor(now) { this.now = now; this.until = 0; this.sink = null; }
  push(lr, frames, rate) {
    const t = this.now();
    if (this.until < t) this.until = t;
    const room = Math.floor((this.until - t < 120 ? 120 - (this.until - t) : 0) * rate / 1000);
    const n = Math.min(frames, room);
    if (n <= 0) return 0;
    if (this.sink) this.sink(lr.subarray(0, n * 2), n, rate);
    this.until += n * 1000 / rate;
    return n;
  }
}
