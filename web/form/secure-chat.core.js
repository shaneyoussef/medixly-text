/* ════════════════════════════════════════════════════════════════════
   SecureChat — view layer only. All I/O goes through `transport`.
   ════════════════════════════════════════════════════════════════════ */

const ICONS = 'https://unpkg.com/lucide-static@0.454.0/icons/';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;   // textContent: never innerHTML
  return n;
}
function icon(name, small) {
  const i = el('i', 'mx-icon' + (small ? ' mx-icon--sm' : ''));
  i.style.setProperty('--icon', `url(${ICONS}${name}.svg)`);
  return i;
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'm' + Date.now() + Math.random().toString(16).slice(2));
const fmtTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const dayKey  = ts => new Date(ts).toDateString();

function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) -
                           new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7)   return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

const COUNTRY = {
  Canada: { platform: 'Hushmail for Healthcare', law: 'PIPEDA' },
  USA:    { platform: 'Paubox', law: 'HIPAA' }
};

/* ── Shop ──────────────────────────────────────────────────────────── */
// Matches MAX_QTY in api/shop.ts, which rejects anything above it.
const MAX_QTY = 12;

/** Money for display. Shopify returns amounts as decimal strings. */
const money = (amount, currency = 'CAD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency })
    .format(typeof amount === 'string' ? parseFloat(amount) : amount);

/**
 * Ten digits, which is what `requests.patient_phone` stores. A leading country
 * code is dropped rather than rejected — people write their own number as
 * "+1 416 555 0100" and being told that's invalid is the form's fault, not
 * theirs. Returns null if it can't be read as a North American number.
 */
function tenDigits(value) {
  const d = String(value ?? '').replace(/\D/g, '');
  if (d.length === 10) return d;
  if (d.length === 11 && d[0] === '1') return d.slice(1);
  return null;
}

/* ── Attachments ───────────────────────────────────────────────────── */
const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;                       // 10 MB per file
const ALLOWED   = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf'];
const MAX_EDGE  = 2048;                                   // downscale target, longest edge

const isImage = t => !!t && t.startsWith('image/');
const fmtSize = b => b < 1024 * 1024
  ? `${Math.max(1, Math.round(b / 1024))} KB`
  : `${(b / 1024 / 1024).toFixed(1)} MB`;

/**
 * Phone cameras produce 4–12 MB frames; a legible prescription label needs far
 * less. Downscale to MAX_EDGE and re-encode as JPEG. Formats the browser can't
 * decode (HEIC on some platforms) fall through untouched and upload as-is.
 */
async function shrinkImage(file) {
  if (!isImage(file.type) || file.size < 600 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;                                          // undecodable — send the original
  }
}

/* ── Voice notes ───────────────────────────────────────────────────── */
const MAX_SECONDS = 180;
const WAVE_BARS   = 40;

// Chrome and Firefox record Opus in WebM; Safari only offers MP4/AAC.
const VOICE_MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  .find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && VOICE_MIME);

const isVoice = f => !!f && (f.kind === 'voice' || (f.type || '').startsWith('audio/'));
const fmtDur = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Squashes a recording's level samples down to a fixed number of display bars. */
function resample(peaks, n = WAVE_BARS) {
  if (!peaks.length) return new Array(n).fill(0.15);
  const out = [];
  const per = peaks.length / n;
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * per);
    const slice = peaks.slice(from, Math.max(Math.floor((i + 1) * per), from + 1));
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length || 0);
  }
  const max = Math.max(...out, 0.01);
  return out.map(v => Math.max(0.08, v / max));           // normalise, keep a visible floor
}

class SecureChat {
  /**
   * @param {HTMLElement} root
   * @param {object} opts
   *   pharmacyName, presence, country ('Canada' | 'USA'), history[]
   *   transport: { send(msg) -> Promise<{status,ts}>, subscribe(fn), upload(file) }
   *   onBack(), onCall()
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.messages = [];
    this.pending = [];          // staged attachments
    this.typing = false;
    this.stick = true;          // pinned to the newest message
    this.seen = new Set();      // ids already animated in
    this.forms = new Map();     // form cards, cached so typed answers survive re-renders
    this.$ = sel => root.querySelector(`[data-${sel}]`);
    this.mount();
  }

  mount() {
    const o = this.opts;
    if (o.pharmacyName) {
      this.$('name').textContent = o.pharmacyName;
      this.$('avatar').textContent = o.pharmacyName.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
      this.$('log').setAttribute('aria-label', `Conversation with ${o.pharmacyName}`);
    }
    if (o.presence) this.setPresence(o.presence);

    const c = COUNTRY[o.country] || COUNTRY.Canada;
    this.$('trust').textContent =
      `Your information is transmitted securely via ${c.platform} — ${c.law} compliant`;

    const input = this.$('input'), send = this.$('send'), log = this.$('log');

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      this.syncSend();
    });
    // Physical keyboards send on Enter; touch keyboards insert a newline.
    this.softKeyboard = window.matchMedia('(pointer:coarse)').matches;
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !this.softKeyboard) { e.preventDefault(); this.send(); }
    });
    send.addEventListener('click', () => this.send());

    // Attach sheet
    this.$('attach').addEventListener('click', () => this.openSheet());
    this.$('sheet-cancel').addEventListener('click', () => this.closeSheet());
    this.$('scrim').addEventListener('click', e => { if (e.target === this.$('scrim')) this.closeSheet(); });
    this.$('sheet').addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); this.closeSheet(); }
      if (e.key === 'Tab') this.trapTab(e);
    });
    this.root.querySelectorAll('[data-pick]').forEach(btn => {
      btn.addEventListener('click', () => {
        const which = btn.dataset.pick;
        this.closeSheet({ restoreFocus: false });
        this.$(which).click();
      });
    });
    ['camera', 'photos', 'docs'].forEach(which => {
      this.$(which).addEventListener('change', e => {
        this.stage([...e.target.files]);
        e.target.value = '';                    // re-selecting the same file still fires
      });
    });

    // Desktop conveniences: drop a file anywhere, or paste a screenshot.
    this.root.addEventListener('dragover', e => { e.preventDefault(); });
    this.root.addEventListener('drop', e => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) this.stage([...e.dataTransfer.files]);
    });
    input.addEventListener('paste', e => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); this.stage(files); }
    });

    // Voice notes
    this.$('mic').addEventListener('click', () => this.startRecording());
    this.$('rec-stop').addEventListener('click', () => this.stopRecording());
    this.$('rec-cancel').addEventListener('click', () => this.stopRecording({ discard: true }));
    if (!canRecord) this.$('mic').hidden = true;

    // Image viewer
    this.$('viewer-close').addEventListener('click', () => this.closeViewer());
    this.$('viewer').addEventListener('click', e => { if (e.target === this.$('viewer')) this.closeViewer(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !this.$('viewer').hidden) this.closeViewer();
    });

    log.addEventListener('scroll', () => {
      this.stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      this.$('jump').hidden = this.stick;
    });
    this.$('jump').addEventListener('click', () => { this.stick = true; this.$('jump').hidden = true; this.scrollDown(); });

    this.$('back').addEventListener('click', () => this.opts.onBack?.());
    this.$('call').addEventListener('click', () => this.opts.onCall?.());

    if (o.history) this.load(o.history);
    this.renderServices();
    this.syncSend();
    o.transport?.subscribe?.(m => this.receive(m));
  }

  /* ── Public API ──────────────────────────────────────────────── */

  load(messages) {
    this.messages = messages.map(m => ({ id: m.id || uid(), status: 'read', ...m }));
    this.messages.forEach(m => this.seen.add(m.id));   // history doesn't animate
    this.render();
    requestAnimationFrame(() => this.scrollDown('auto'));
  }

  /** Adds an inbound message from the pharmacy. */
  receive({ text, ts = Date.now(), files }) {
    this.setTyping(false);
    const m = { id: uid(), from: 'them', text, ts, files };
    this.messages.push(m);
    this.render();
    this.$('announce').textContent = `New message from ${this.$('name').textContent}: ${text}`;
  }

  setTyping(on) { if (this.typing !== on) { this.typing = on; this.render(); } }

  setPresence(text, state = 'online') {
    this.$('presence').textContent = text;
    this.$('presence-dot').classList.toggle('mx-dot--away', state !== 'online');
  }

  /**
   * Stores the signed-in profile and rebuilds any form card still open, so a
   * card drawn before sign-in can pick the profile up. Submitted cards are
   * receipts and are left alone. Consent is never carried across — it belongs
   * to one submission and needs its own timestamp.
   */
  setProfile(profile) {
    this.profile = profile;
    for (const m of this.messages) {
      if (m.kind === 'form' && !m.submitted) { this.seedIdentity(m); this.forms.delete(m.id); }
    }
    this.render();
  }

  /**
   * Fills a form's identity answers from the signed-in patient's record, so they
   * don't retype what the pharmacy already holds. Only ever fills a blank — a
   * value the patient typed, or deliberately cleared, is theirs.
   *
   * Identity only. Consent and any clinical answer are never seeded: consent
   * belongs to one submission and needs its own timestamp.
   */
  seedIdentity(m) {
    const p = this.profile;
    if (!p || p.guest) return;
    const known = { fullName: p.name, phone: p.phone, dob: p.dob };
    for (const [key, value] of Object.entries(known)) {
      if (value && m.values[key] == null) m.values[key] = value;
    }
  }

  setStatus(id, status, ts) {
    const m = this.messages.find(x => x.id === id);
    if (!m) return;
    m.status = status;
    if (ts) m.ts = ts;
    this.render();
  }

  /* ── Sheet and viewer ────────────────────────────────────────── */

  openSheet() {
    this.lastFocus = document.activeElement;
    this.$('scrim').hidden = false;
    this.$('attach').setAttribute('aria-expanded', 'true');
    this.root.querySelector('[data-pick]').focus();
  }

  closeSheet({ restoreFocus = true } = {}) {
    this.$('scrim').hidden = true;
    this.$('attach').setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.lastFocus?.focus();
  }

  trapTab(e) {
    const focusable = [...this.$('sheet').querySelectorAll('button')];
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  openViewer(src, alt) {
    const img = this.$('viewer-img');
    img.src = src;
    img.alt = alt || 'Attachment';
    this.$('viewer').hidden = false;
    this.$('viewer-close').focus();
  }
  closeViewer() { this.$('viewer').hidden = true; this.$('viewer-img').src = ''; }

  /* ── Staging ─────────────────────────────────────────────────── */

  fail(message) {
    const box = this.$('error');
    box.textContent = message;
    box.hidden = false;
    this.$('announce').textContent = message;
  }
  clearError() { this.$('error').hidden = true; }

  async stage(files) {
    this.clearError();
    for (const file of files) {
      if (this.pending.length >= MAX_FILES) {
        this.fail(`You can attach up to ${MAX_FILES} files at a time. Send these first, then add the rest.`);
        break;
      }
      if (!ALLOWED.includes(file.type)) {
        this.fail('Please attach a photo or a PDF.');
        continue;
      }
      if (file.size > MAX_BYTES) {
        this.fail(`${file.name} is ${fmtSize(file.size)}. Please attach a file under ${fmtSize(MAX_BYTES)}.`);
        continue;
      }
      const ready = await shrinkImage(file);
      this.pending.push({
        id: uid(),
        file: ready,
        name: file.name,                                  // keep the name the patient recognises
        size: ready.size,
        type: ready.type,
        previewUrl: isImage(ready.type) ? URL.createObjectURL(ready) : null
      });
      this.renderChips();
      this.syncSend();
    }
  }

  unstage(id) {
    const i = this.pending.findIndex(p => p.id === id);
    if (i < 0) return;
    if (this.pending[i].previewUrl) URL.revokeObjectURL(this.pending[i].previewUrl);
    this.pending.splice(i, 1);
    this.clearError();
    this.renderChips();
    this.syncSend();
  }

  syncSend() {
    const hasContent = !!this.$('input').value.trim() || this.pending.length > 0;
    const showMic = canRecord && !hasContent;
    this.$('mic').hidden = !showMic;
    this.$('send').hidden = showMic;
    this.$('send').disabled = !hasContent;
  }

  /* ── Recording ───────────────────────────────────────────────── */

  async startRecording() {
    if (this.recorder) return;
    this.clearError();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Denied, dismissed, or no input device — all land here.
      this.fail('We couldn\u2019t reach your microphone. Allow microphone access in your browser settings, then try again.');
      return;
    }

    this.peaks = [];
    this.chunks = [];
    this.startedAt = Date.now();
    this.stream = stream;
    this.recorder = new MediaRecorder(stream, { mimeType: VOICE_MIME });
    this.recorder.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.onstop = () => this.finishRecording();
    this.recorder.start();

    // Level metering drives both the live bars and the saved waveform.
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    this.audioCtx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);

    this.$('row').hidden = true;
    this.$('quick').hidden = true;
    this.$('rec').hidden = false;
    this.$('rec-stop').focus();
    this.$('announce').textContent = 'Recording a voice note.';

    this.sampler = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
      this.peaks.push(Math.sqrt(sum / buf.length));

      const secs = (Date.now() - this.startedAt) / 1000;
      this.$('timer').textContent = fmtDur(secs);
      this.renderLevels();
      if (secs >= MAX_SECONDS) this.stopRecording();
    }, 100);
  }

  stopRecording({ discard = false } = {}) {
    if (!this.recorder) return;
    this.discardRecording = discard;
    clearInterval(this.sampler);
    this.recorder.stop();                       // → finishRecording via onstop
  }

  finishRecording() {
    const seconds = (Date.now() - this.startedAt) / 1000;
    const blob = new Blob(this.chunks, { type: VOICE_MIME });

    // Release the mic so the browser's recording indicator clears.
    this.stream.getTracks().forEach(t => t.stop());
    this.audioCtx?.close();
    this.recorder = this.stream = this.audioCtx = null;

    this.$('rec').hidden = true;
    this.$('row').hidden = false;
    this.$('quick').hidden = this.opts.services === false;
    this.$('levels').replaceChildren();
    this.$('timer').textContent = '0:00';

    if (this.discardRecording || seconds < 1 || !blob.size) {
      this.$('announce').textContent = 'Recording discarded.';
      this.$('input').focus();
      return;
    }

    const ext = VOICE_MIME.includes('mp4') ? 'm4a' : VOICE_MIME.includes('ogg') ? 'ogg' : 'webm';
    this.pending.push({
      id: uid(),
      kind: 'voice',
      file: new File([blob], `voice-note.${ext}`, { type: blob.type }),
      name: 'Voice note',
      size: blob.size,
      type: blob.type,
      duration: seconds,
      peaks: resample(this.peaks),
      previewUrl: URL.createObjectURL(blob)
    });
    this.$('announce').textContent = `Voice note recorded, ${fmtDur(seconds)}. Review it, then send.`;
    this.renderChips();
    this.syncSend();
  }

  renderLevels() {
    const box = this.$('levels');
    const width = box.clientWidth || 1;
    const visible = this.peaks.slice(-Math.floor(width / 4));
    box.replaceChildren(...visible.map(p => {
      const bar = el('i');
      bar.style.height = Math.max(2, Math.min(1, p * 3) * 24) + 'px';
      return bar;
    }));
  }

  /* ── Sending ─────────────────────────────────────────────────── */

  async send() {
    const input = this.$('input');
    const text = input.value.trim();
    if (!text && !this.pending.length) return;

    const staged = this.pending;
    const m = {
      id: uid(), from: 'me', text, ts: Date.now(), status: 'sending',
      files: staged.map(p => ({
        id: p.id, name: p.name, size: p.size, type: p.type,
        kind: p.kind, duration: p.duration, peaks: p.peaks,
        previewUrl: p.previewUrl,      // shown immediately; replaced by url once stored
        progress: 0
      }))
    };
    m._blobs = staged;                 // kept off the wire, needed for retry

    this.messages.push(m);
    input.value = ''; input.style.height = 'auto';
    this.pending = []; this.clearError(); this.renderChips(); this.syncSend();
    this.stick = true; this.render();

    this.deliver(m);
  }

  /** Uploads any attachments, then sends the message. Shared by send and retry. */
  async deliver(m) {
    try {
      for (const att of m.files || []) {
        if (att.url) continue;                                  // already stored
        const staged = m._blobs?.find(p => p.id === att.id);
        if (!staged) continue;
        const res = await this.opts.transport?.upload?.(staged.file, pct => {
          att.progress = pct;
          this.render();
        });
        att.url = res?.url;
        att.progress = 100;
        this.render();
      }

      const payload = {
        id: m.id, text: m.text, ts: m.ts,
        files: (m.files || []).map(({ name, size, type, url, kind, duration, peaks }) =>
          ({ name, size, type, url, kind, duration, peaks }))
      };
      const res = (await this.opts.transport?.send?.(payload)) || {};
      this.setStatus(m.id, res.status || 'sent', res.ts);
    } catch (err) {
      console.error('[SecureChat] send failed', err);
      this.setStatus(m.id, 'failed');
    }
  }

  retry(id) {
    const m = this.messages.find(x => x.id === id);
    if (!m) return;
    this.setStatus(id, 'sending');
    this.deliver(m);
  }

  /* ── Rendering ───────────────────────────────────────────────── */

  metaText(m) {
    if (m.from === 'them') return fmtTime(m.ts);
    return { sending: 'Sending…', failed: 'Not sent — tap to retry' }[m.status]
      || `${{ sent: 'Sent', delivered: 'Delivered', read: 'Read' }[m.status] || 'Sent'} ${fmtTime(m.ts)}`;
  }

  messageEl(m) {
    if (m.kind === 'form') return this.formEl(m);
    if (m.kind === 'products') return this.productsEl(m);
    if (m.kind === 'basket') return this.basketEl(m);

    const wrap = el('div', `mx-msg mx-msg--${m.from === 'me' ? 'me' : 'them'}`);
    if (!this.seen.has(m.id)) { wrap.classList.add('mx-enter'); this.seen.add(m.id); }

    const bubble = el('div', 'mx-bubble');

    const images = (m.files || []).filter(f => isImage(f.type) && !isVoice(f));
    const voices = (m.files || []).filter(isVoice);
    const docs   = (m.files || []).filter(f => !isImage(f.type) && !isVoice(f));

    voices.forEach(f => bubble.append(this.voiceEl(f)));

    if (images.length) {
      const grid = el('div', 'mx-atts');
      images.forEach(f => {
        const img = el('img', 'mx-att-img');
        img.src = f.url || f.previewUrl || '';
        img.alt = f.name;
        img.loading = 'lazy';
        img.addEventListener('click', () => this.openViewer(img.src, f.name));
        grid.append(img);
      });
      bubble.append(grid);
    }

    docs.forEach(f => {
      const row = el('div', 'mx-file');
      row.append(icon('file-text', true), el('span', null, f.name), el('span', 'mx-size', fmtSize(f.size)));
      bubble.append(row);
    });

    if (m.text) bubble.append(el('span', null, m.text));

    if (m.status === 'sending' && (m.files || []).some(f => f.progress != null && f.progress < 100)) {
      const done = m.files.reduce((sum, f) => sum + (f.progress || 0), 0) / m.files.length;
      const bar = el('div', 'mx-prog');
      const fill = el('i');
      fill.style.width = done + '%';
      bar.append(fill);
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', 'Upload progress');
      bar.setAttribute('aria-valuenow', Math.round(done));
      bubble.append(bar);
    }

    wrap.append(bubble);

    if (m.status === 'failed') {
      const b = el('button', 'mx-meta mx-meta--failed', this.metaText(m));
      b.type = 'button';
      b.addEventListener('click', () => this.retry(m.id));
      wrap.append(b);
    } else {
      wrap.append(el('div', 'mx-meta', this.metaText(m)));
    }
    return wrap;
  }

  render() {
    const frag = document.createDocumentFragment();
    let day = null;
    for (const m of this.messages) {
      const k = dayKey(m.ts);
      if (k !== day) {
        day = k;
        const d = el('div', 'mx-day');
        d.append(el('span', null, dayLabel(m.ts)));
        frag.append(d);
      }
      frag.append(this.messageEl(m));
    }
    if (this.typing) {
      const t = el('div', 'mx-typing');
      t.setAttribute('aria-label', 'Typing');
      t.append(el('i'), el('i'), el('i'));
      frag.append(t);
    }
    this.$('stream').replaceChildren(frag);
    if (this.stick) this.scrollDown();
  }

  /** Builds a play/waveform/duration player for one voice attachment. */
  voiceEl(att) {
    const wrap = el('div', 'mx-voice');

    const play = el('button', 'mx-play');
    play.type = 'button';
    play.setAttribute('aria-label', `Play voice note, ${fmtDur(att.duration || 0)}`);
    const glyph = icon('play', true);
    play.append(glyph);

    const wave = el('div', 'mx-wave');
    wave.setAttribute('role', 'slider');
    wave.setAttribute('aria-label', 'Seek');
    const bars = (att.peaks || resample([])).map(p => {
      const b = el('i');
      b.style.height = Math.round(p * 100) + '%';
      return b;
    });
    wave.append(...bars);

    const time = el('span', 'mx-timer', fmtDur(att.duration || 0));
    wrap.append(play, wave, time);

    const paint = ratio => bars.forEach((b, i) => b.classList.toggle('is-played', i / bars.length <= ratio));
    const setGlyph = playing =>
      glyph.style.setProperty('--icon', `url(${ICONS}${playing ? 'pause' : 'play'}.svg)`);

    const src = att.url || att.previewUrl;

    play.addEventListener('click', () => {
      // One player at a time: stop whatever else is going.
      if (this.audio && this.audio.dataset.attId !== att.id) {
        this.audio.pause();
        this.audioReset?.();
      }
      if (!this.audio || this.audio.dataset.attId !== att.id) {
        this.audio = new Audio(src);
        this.audio.dataset.attId = att.id;
        this.audio.addEventListener('timeupdate', () => {
          const d = this.audio.duration || att.duration || 1;
          paint(this.audio.currentTime / d);
          time.textContent = fmtDur(this.audio.currentTime);
        });
        this.audio.addEventListener('ended', () => {
          paint(0); setGlyph(false); time.textContent = fmtDur(att.duration || 0);
        });
        this.audioReset = () => { paint(0); setGlyph(false); time.textContent = fmtDur(att.duration || 0); };
      }
      if (this.audio.paused) { this.audio.play(); setGlyph(true); }
      else { this.audio.pause(); setGlyph(false); }
    });

    wave.addEventListener('click', e => {
      if (!this.audio || this.audio.dataset.attId !== att.id) return;
      const box = wave.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
      this.audio.currentTime = ratio * (this.audio.duration || att.duration || 0);
    });

    return wrap;
  }

  /* ── Service chips ───────────────────────────────────────────── */

  renderServices() {
    if (this.opts.services === false) { this.$('quick').hidden = true; return; }
    this.$('quick').replaceChildren(...SERVICES.map(s => {
      const chip = el('button', 'mx-service');
      chip.type = 'button';
      chip.append(icon(s.icon, true), document.createTextNode(s.label));
      chip.addEventListener('click', () => {
        if (s.form) return this.requestForm(s.form);
        // Browsing the shelf sends no message and involves no model.
        if (s.shop) return this.opts.shop?.search(s.query || '');
        const input = this.$('input');
        input.value = s.prefill;
        input.focus();
        input.dispatchEvent(new Event('input'));      // resize + flip mic to send
      });
      return chip;
    }));
  }

  /* ── Shop ────────────────────────────────────────────────────────
     Products and a basket, rendered as cards in the thread. Everything
     here is display and local basket state; the network lives in
     `opts.shop` (secure-chat.shop.js).

     Neither card is cached. Unlike a form card there is nothing typed to
     lose, and the basket card has to redraw whenever the basket changes,
     so rebuilding on every render is both simpler and correct.

     What must never appear on these cards: why the patient wants the
     product. The basket carries variant ids and quantities, and that is
     what reaches Shopify. See docs/SHOP.md.
     ─────────────────────────────────────────────────────────────── */

  /** Drops a set of search results into the thread. */
  showProducts(query, products) {
    this.messages.push({
      id: uid(), kind: 'products', from: 'them', ts: Date.now(),
      query, products: products || []
    });
    this.stick = true;
    this.render();
  }

  /** variantId → { product, qty }. Insertion-ordered, which is display order. */
  get basket() {
    this._basket = this._basket || new Map();
    return this._basket;
  }

  basketCount() {
    let n = 0;
    for (const line of this.basket.values()) n += line.qty;
    return n;
  }

  basketTotal() {
    let cents = 0;
    for (const { product, qty } of this.basket.values()) {
      cents += Math.round(parseFloat(product.price) * 100) * qty;
    }
    return cents / 100;
  }

  addToBasket(product) {
    const line = this.basket.get(product.variantId);
    if (line) line.qty = Math.min(line.qty + 1, MAX_QTY);
    else this.basket.set(product.variantId, { product, qty: 1 });
    this.announceBasket(`${product.title} added.`);
    this.showBasket();
  }

  setQty(variantId, qty) {
    if (qty <= 0) this.basket.delete(variantId);
    else {
      const line = this.basket.get(variantId);
      if (line) line.qty = Math.min(qty, MAX_QTY);
    }
    this.announceBasket();
    this.render();
  }

  clearBasket() { this.basket.clear(); this.render(); }

  announceBasket(prefix = '') {
    const n = this.basketCount();
    this.$('announce').textContent =
      `${prefix} Basket: ${n} ${n === 1 ? 'item' : 'items'}, ${money(this.basketTotal())}.`.trim();
  }

  /** Shows the basket card, moving the existing one rather than stacking. */
  showBasket() {
    const open = this.messages.find(m => m.kind === 'basket');
    if (open) {
      // Keep it as the newest thing in the thread so it's where they look.
      this.messages.splice(this.messages.indexOf(open), 1);
      open.ts = Date.now();
      this.messages.push(open);
    } else {
      this.messages.push({ id: uid(), kind: 'basket', from: 'them', ts: Date.now() });
    }
    this.stick = true;
    this.render();
  }

  productsEl(m) {
    const wrap = el('div', 'mx-msg mx-msg--form');
    if (!this.seen.has(m.id)) { wrap.classList.add('mx-enter'); this.seen.add(m.id); }
    const card = el('div', 'mx-shop');
    wrap.append(card);

    card.append(el('h3', null, m.query ? `Matches for “${m.query}”` : 'Available to order'));

    if (!m.products.length) {
      card.append(el('p', 'mx-shop__blurb',
        'We don’t have that on the shelf for online orders. A pharmacist can check the back or suggest what we do carry.'));
      return wrap;
    }

    card.append(el('p', 'mx-shop__blurb',
      'Prices include what you’d pay at the counter. A pharmacist checks every order before it goes out.'));
    m.products.forEach(p => card.append(this.productEl(p)));
    return wrap;
  }

  productEl(p) {
    const row = el('div', 'mx-prod');

    const thumb = el('div', 'mx-prod__img');
    if (p.image) {
      const img = el('img');
      img.src = p.image;
      img.alt = p.imageAlt || p.title;
      img.loading = 'lazy';
      thumb.append(img);
    } else {
      thumb.append(icon('package'));
    }

    const body = el('div', 'mx-prod__body');
    body.append(el('span', 'mx-prod__name', p.title));
    const meta = el('div', 'mx-prod__meta');
    meta.append(el('span', 'mx-price', money(p.price, p.currency)));
    if (p.vendor) meta.append(el('span', 'mx-vendor', p.vendor));
    body.append(meta);

    row.append(thumb, body);

    if (p.available === false) {
      row.append(el('span', 'mx-oos', 'Out of stock'));
      return row;
    }

    const add = el('button', 'mx-add');
    add.type = 'button';
    add.setAttribute('aria-label', `Add ${p.title} to your basket`);
    add.append(icon('plus'));
    add.addEventListener('click', () => this.addToBasket(p));
    row.append(add);
    return row;
  }

  basketEl(m) {
    const wrap = el('div', 'mx-msg mx-msg--form');
    if (!this.seen.has(m.id)) { wrap.classList.add('mx-enter'); this.seen.add(m.id); }
    const card = el('div', 'mx-shop');
    wrap.append(card);

    card.append(el('h3', null, 'Your basket'));

    if (!this.basket.size) {
      card.append(el('p', 'mx-empty', 'Nothing in it yet.'));
      return wrap;
    }

    for (const [variantId, line] of this.basket) {
      const row = el('div', 'mx-prod');

      const thumb = el('div', 'mx-prod__img');
      if (line.product.image) {
        const img = el('img');
        img.src = line.product.image;
        img.alt = line.product.imageAlt || line.product.title;
        thumb.append(img);
      } else {
        thumb.append(icon('package'));
      }

      const body = el('div', 'mx-prod__body');
      body.append(el('span', 'mx-prod__name', line.product.title));
      const meta = el('div', 'mx-prod__meta');
      meta.append(el('span', 'mx-price',
        money(parseFloat(line.product.price) * line.qty, line.product.currency)));
      body.append(meta);

      const qty = el('div', 'mx-qty');
      const less = el('button');
      less.type = 'button';
      less.setAttribute('aria-label', `One fewer ${line.product.title}`);
      less.append(icon('minus', true));
      less.addEventListener('click', () => this.setQty(variantId, line.qty - 1));
      const count = el('span', null, String(line.qty));
      count.setAttribute('aria-label', `Quantity ${line.qty}`);
      const more = el('button');
      more.type = 'button';
      more.setAttribute('aria-label', `One more ${line.product.title}`);
      more.append(icon('plus', true));
      more.disabled = line.qty >= MAX_QTY;
      more.addEventListener('click', () => this.setQty(variantId, line.qty + 1));
      qty.append(less, count, more);

      row.append(thumb, body, qty);
      card.append(row);
    }

    const total = el('div', 'mx-total');
    total.append(el('span', null, 'Subtotal'),
                 el('span', 'mx-price', money(this.basketTotal())));
    card.append(total);
    card.append(el('p', 'mx-hint', 'Tax and any delivery charge are added at checkout.'));

    const pay = el('button', 'mx-submit', 'Checkout');
    pay.type = 'button';
    pay.addEventListener('click', async () => {
      pay.disabled = true;
      pay.textContent = 'Opening checkout…';
      try {
        await this.opts.shop?.checkout(
          [...this.basket.values()].map(l => ({ variantId: l.product.variantId, quantity: l.qty }))
        );
      } catch (err) {
        console.error('[SecureChat] checkout failed', err);
        this.fail('We couldn’t open checkout. Check your connection and try again.');
      } finally {
        pay.disabled = false;
        pay.textContent = 'Checkout';
      }
    });
    card.append(pay);
    return wrap;
  }

  /* ── Forms ───────────────────────────────────────────────────── */

  /** Drops a form card into the thread. `chat.requestForm('transfer')` */
  requestForm(formId) {
    if (!FORMS[formId]) return;

    // Already asked and not yet sent — take them back to it rather than stacking another.
    const open = this.messages.find(m => m.kind === 'form' && m.formId === formId && !m.submitted);
    if (open) {
      const card = this.forms.get(open.id);
      card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card?.querySelector('input, select, textarea')?.focus({ preventScroll: true });
      return;
    }

    const card = { id: uid(), kind: 'form', formId, from: 'them', ts: Date.now(),
                   values: {}, step: 0, consent: false, submitted: false };
    this.seedIdentity(card);
    this.messages.push(card);
    this.stick = true;
    this.render();
  }

  /** A form's steps, minus any that don't apply to the answers so far. */
  stepsOf(spec, m) {
    const all = spec.steps || [{ fields: spec.fields }];
    if (!m) return all;
    return all.filter(s => !s.showWhen || s.showWhen(m.values));
  }
  /** A step's fields, which may be a function of the answers so far. */
  fieldsOf(step, m) {
    return typeof step.fields === 'function' ? step.fields(m.values) : step.fields;
  }

  /**
   * Form cards are cached by message id and reused across renders — rebuilding
   * them would wipe half-typed answers whenever a message arrives.
   */
  formEl(m) {
    if (this.forms.has(m.id)) return this.forms.get(m.id);

    const spec = FORMS[m.formId];
    const wrap = el('div', 'mx-msg mx-msg--form mx-enter');
    const card = el('div', 'mx-form');
    wrap.append(card);
    this.forms.set(m.id, wrap);
    this.seen.add(m.id);

    if (m.submitted) { this.paintSubmitted(m); return wrap; }

    card.append(el('h3', null, spec.title), el('p', 'mx-form__blurb', spec.blurb));
    const body = el('div');
    card.append(body);
    this.paintStep(m, body);
    return wrap;
  }

  /** Renders the current step's fields plus its footer. */
  paintStep(m, body) {
    const spec = FORMS[m.formId];
    const steps = this.stepsOf(spec, m);
    m.step = Math.min(m.step, steps.length - 1);       // a skipped page may have shortened the list
    const step = steps[m.step];
    const isLast = m.step === steps.length - 1;
    const fields = this.fieldsOf(step, m);

    const parts = [];
    const errorNodes = new Map();
    const fieldNodes = new Map();
    const repaint = () => this.paintStep(m, body);

    if (steps.length > 1) parts.push(this.stepIndicator(spec, m, steps));
    if (step.title) parts.push(el('h4', 'mx-step-title', step.title));
    if (step.review) parts.push(this.summaryEl(m, body));

    const refreshVisibility = () => fields.forEach(f => {
      if (f.showWhen) fieldNodes.get(f.name).hidden = !f.showWhen(m.values);
    });

    for (const f of fields) {
      const node = this.fieldEl(f, m, errorNodes, repaint);
      fieldNodes.set(f.name, node);
      parts.push(node);
    }

    const footer = isLast
      ? this.finalFooter(m, spec, errorNodes, fieldNodes, fields, body)
      : this.stepFooter(m, spec, errorNodes, fieldNodes, fields, body);
    parts.push(footer);

    body.replaceChildren(...parts);
    refreshVisibility();
  }

  /**
   * The review page: everything answered so far, each row jumping back to the
   * page it came from.
   */
  summaryEl(m, body) {
    const spec = FORMS[m.formId];
    const steps = this.stepsOf(spec, m);
    const box = el('div', 'mx-summary mx-summary--review');

    steps.forEach((step, idx) => {
      if (step.review) return;
      for (const f of this.fieldsOf(step, m)) {
        if (f.type === 'notice' || f.type === 'pool') continue;
        if (f.showWhen && !f.showWhen(m.values)) continue;
        const value = this.displayValue(m.values[f.name]);
        if (!value) continue;
        const row = el('div');
        const jump = el('button', 'mx-editlink', 'Edit');
        jump.type = 'button';
        jump.setAttribute('aria-label', `Edit ${f.label}`);
        jump.addEventListener('click', () => { m.step = idx; this.paintStep(m, body); });
        row.append(el('span', 'k', f.label), el('span', 'v', value), jump);
        box.append(row);
      }
    });
    return box;
  }

  displayValue(raw) {
    if (raw == null) return '';
    if (Array.isArray(raw)) {
      return raw.map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean).join(', ');
    }
    return String(raw).trim();
  }

  stepIndicator(spec, m, steps) {
    const total = spec.totalSteps || steps.length;
    const bar = el('div', 'mx-steps');
    for (let i = 0; i < total; i++) {
      const seg = el('i');
      if (i <= m.step) seg.classList.add('is-on');
      bar.append(seg);
    }
    bar.append(el('span', null, `${m.step + 1} of ${total}`));
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', `Step ${m.step + 1} of ${total}: ${steps[m.step].title || ''}`);
    return bar;
  }

  /* ── Field rendering ─────────────────────────────────────────── */

  fieldEl(f, m, errorNodes, repaint) {
    const field = el('div', 'mx-field');
    const id = `${m.id}-${f.name}`;

    // Display-only blocks carry no label or error slot.
    if (f.type === 'notice') {
      const box = el('div', 'mx-notice');
      box.append(icon('alert-circle', true), el('p', null, f.text));
      field.append(box);
      errorNodes.set(f.name, el('p'));
      return field;
    }
    if (f.type === 'pool') {
      field.append(this.poolEl(vaccineBy(m.values.vaccine)));
      errorNodes.set(f.name, el('p'));
      return field;
    }

    const label = el('label', 'mx-label');
    label.htmlFor = id;
    label.append(document.createTextNode(f.label));
    if (f.required) {
      const star = el('span', 'mx-req', ' *');
      star.setAttribute('aria-hidden', 'true');
      label.append(star);
    }
    field.append(label);

    const error = el('p', 'mx-err');
    error.id = `${id}-error`;
    error.hidden = true;
    errorNodes.set(f.name, error);

    const touched = () => { error.hidden = true; };
    const commit = value => { m.values[f.name] = value; touched(); if (f.rebuild) repaint(); };

    if (f.type === 'radio' || f.type === 'yesno') {
      label.removeAttribute('for');
      label.id = id;
      const group = el('div');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-labelledby', id);
      if (f.type === 'yesno') group.className = 'mx-yesno';
      (f.type === 'yesno' ? ['Yes', 'No'] : f.options).forEach((opt, i) => {
        const row = el('label', 'mx-radio');
        const radio = el('input');
        radio.type = 'radio';
        radio.name = id;
        radio.value = opt;
        radio.checked = m.values[f.name] === opt;
        radio.addEventListener('change', () => commit(opt));
        row.append(radio, document.createTextNode(opt));
        group.append(row);
      });
      field.append(group);

    } else if (f.type === 'days') {
      label.removeAttribute('for');
      label.id = id;
      const group = el('div');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-labelledby', id);
      (vaccineBy(m.values.vaccine)?.days || []).forEach(day => {
        const row = el('label', 'mx-radio mx-radio--day');
        const radio = el('input');
        radio.type = 'radio';
        radio.name = id;
        radio.value = day.label;
        radio.checked = m.values[f.name] === day.label;
        radio.addEventListener('change', () => commit(day.label));
        const text = el('span');
        text.append(el('span', null, day.label),
                    el('span', 'mx-size', `${day.doses} doses available`));
        row.append(radio, text);
        group.append(row);
      });
      field.append(group);

    } else if (f.type === 'select') {
      const select = el('select', 'mx-control');
      select.id = id;
      const blank = el('option', null, f.placeholder || 'Choose one');
      blank.value = '';
      select.append(blank);
      f.options.forEach(opt => {
        const o = el('option', null, opt);
        o.value = opt;
        select.append(o);
      });
      select.value = m.values[f.name] || '';
      select.addEventListener('change', e => commit(e.target.value));
      field.append(select);

    } else if (f.type === 'textarea') {
      const area = el('textarea', 'mx-control');
      area.id = id;
      area.rows = 3;
      area.value = m.values[f.name] || '';
      area.addEventListener('input', e => { m.values[f.name] = e.target.value; touched(); });
      field.append(area);

    } else if (f.type === 'file') {
      const input = el('input');
      input.type = 'file';
      input.id = id;
      input.hidden = true;
      input.multiple = true;
      input.accept = f.accept || 'image/*,application/pdf';

      const drop = el('button', 'mx-drop');
      drop.type = 'button';
      drop.append(icon('upload'), el('b', null, 'Take a photo or choose a file'),
                  el('small', null, 'JPG, PNG or PDF'));
      drop.addEventListener('click', () => input.click());

      const list = el('div', 'mx-chips');
      const paintList = () => {
        list.replaceChildren(...(m.values[f.name] || []).map((file, i) => {
          const remove = el('button', 'mx-remove');
          remove.type = 'button';
          remove.setAttribute('aria-label', `Remove ${file.name}`);
          remove.append(icon('x', true));
          remove.addEventListener('click', () => {
            if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
            m.values[f.name].splice(i, 1);
            paintList();
          });
          if (file.previewUrl) {
            const thumb = el('div', 'mx-thumb');
            const img = el('img');
            img.src = file.previewUrl;
            img.alt = file.name;
            thumb.append(img, remove);
            return thumb;
          }
          const doc = el('div', 'mx-doc');
          doc.append(icon('file-text', true), el('span', null, file.name),
                     el('span', 'mx-size', fmtSize(file.size)), remove);
          return doc;
        }));
      };

      input.addEventListener('change', async e => {
        m.values[f.name] = m.values[f.name] || [];
        for (const raw of [...e.target.files]) {
          if (raw.size > MAX_BYTES) { error.textContent = `${raw.name} is ${fmtSize(raw.size)}. Please attach a file under ${fmtSize(MAX_BYTES)}.`; error.hidden = false; continue; }
          const ready = await shrinkImage(raw);
          m.values[f.name].push({
            file: ready, name: raw.name, size: ready.size, type: ready.type,
            previewUrl: isImage(ready.type) ? URL.createObjectURL(ready) : null
          });
        }
        e.target.value = '';
        touched();
        paintList();
      });

      paintList();
      field.append(input, drop, list);

    } else if (f.type === 'list') {
      m.values[f.name] = m.values[f.name] || [''];
      const rows = el('div');
      const paintRows = () => {
        rows.replaceChildren(...m.values[f.name].map((val, i) => {
          const row = el('div', 'mx-listrow');
          const input = el('input', 'mx-control');
          input.type = 'text';
          input.id = i === 0 ? id : `${id}-${i}`;
          input.value = val;
          input.setAttribute('aria-label', `${f.label} ${i + 1}`);
          input.addEventListener('input', e => { m.values[f.name][i] = e.target.value; touched(); });
          row.append(input);
          if (m.values[f.name].length > 1) {
            const del = el('button', 'mx-iconbtn');
            del.type = 'button';
            del.setAttribute('aria-label', `Remove entry ${i + 1}`);
            del.append(icon('x', true));
            del.addEventListener('click', () => { m.values[f.name].splice(i, 1); paintRows(); });
            row.append(del);
          }
          return row;
        }));
      };
      paintRows();
      const add = el('button', 'mx-add');
      add.type = 'button';
      add.append(icon('plus', true), document.createTextNode(f.addLabel));
      add.addEventListener('click', () => { m.values[f.name].push(''); paintRows(); });
      field.append(rows, add);

    } else {
      const input = el('input', 'mx-control');
      input.type = f.type;
      input.id = id;
      input.value = m.values[f.name] || '';
      if (f.autocomplete) input.autocomplete = f.autocomplete;
      input.setAttribute('aria-describedby', error.id);
      input.addEventListener('input', e => { m.values[f.name] = e.target.value; touched(); });
      field.append(input);
    }

    if (f.hint) field.append(el('p', 'mx-hint', f.hint));
    field.append(error);
    return field;
  }

  /** "4 out of 6 patients needed", drawn as the brand's paper discs. */
  poolEl(vac) {
    const box = el('div', 'mx-pool');
    const needed = vac.perVial - vac.joined;
    box.append(el('p', null, `${vac.joined} out of ${vac.perVial} patients needed`));
    const dots = el('div', 'mx-pool__dots');
    for (let i = 0; i < vac.perVial; i++) {
      const dot = el('i');
      if (i < vac.joined) dot.classList.add('is-on');
      dots.append(dot);
    }
    box.append(dots);
    box.append(el('p', 'mx-hint', needed > 0
      ? `We need ${needed} more ${needed === 1 ? 'patient' : 'patients'} before we can schedule a clinic day. We\u2019ll email you a proposed date and you\u2019ll have 24 hours to confirm, change or decline.`
      : 'This vial is full. We\u2019ll propose a clinic day shortly.'));
    return box;
  }

  /* ── Footers ─────────────────────────────────────────────────── */

  stepFooter(m, spec, errorNodes, fieldNodes, fields, body) {
    const nav = el('div', 'mx-nav');
    if (m.step > 0) {
      const back = el('button', 'mx-back', 'Back');
      back.type = 'button';
      back.addEventListener('click', () => { m.step--; this.paintStep(m, body); });
      nav.append(back);
    }
    const next = el('button', 'mx-submit', 'Continue');
    next.type = 'button';
    next.addEventListener('click', () => {
      if (!this.validate(m, fields, errorNodes, fieldNodes)) return;
      m.step++;
      this.paintStep(m, body);
      this.forms.get(m.id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    nav.append(next);
    return nav;
  }

  finalFooter(m, spec, errorNodes, fieldNodes, fields, body) {
    const frag = el('div');

    // Consent and trust badge are always the last two elements before submit.
    const consentWrap = el('label', 'mx-consent');
    const consentBox = el('input');
    consentBox.type = 'checkbox';
    consentBox.checked = !!m.consent;
    consentWrap.append(consentBox, consentBlock(this.$('name').textContent, this.opts.country));

    const consentError = el('p', 'mx-err');
    consentError.hidden = true;

    const c = COUNTRY[this.opts.country] || COUNTRY.Canada;
    const trust = el('p', 'mx-trust');
    trust.append(icon('lock', true),
      el('span', null, `Your information is transmitted securely via ${c.platform} — ${c.law} compliant`));

    const nav = el('div', 'mx-nav');
    const steps = this.stepsOf(spec, m);
    if (steps.length > 1 && m.step > 0) {
      const back = el('button', 'mx-back', 'Back');
      back.type = 'button';
      back.addEventListener('click', () => { m.step--; this.paintStep(m, body); });
      nav.append(back);
    }

    const label = spec.submitFor ? spec.submitFor(m.values) : spec.submit;
    const submit = el('button', 'mx-submit', label);
    submit.type = 'button';
    submit.disabled = !m.consent;                 // stays disabled until consent is given
    submit.addEventListener('click', () => {
      if (!this.validate(m, fields, errorNodes, fieldNodes)) return;
      // An earlier page could have been edited and left incomplete — go back to it.
      const gap = this.firstIncompleteStep(m);
      if (gap !== null) {
        m.step = gap;
        this.paintStep(m, body);
        this.$('announce').textContent = 'Something earlier still needs an answer.';
        return;
      }
      this.submitForm(m);
    });
    nav.append(submit);

    // A disabled button swallows clicks, so the wrapper explains why it's disabled.
    const guard = el('div');
    guard.append(nav);
    guard.addEventListener('click', () => {
      if (!consentBox.checked) {
        consentError.textContent = CONSENT_ERROR;
        consentError.hidden = false;
        consentBox.focus();
      }
    });

    consentBox.addEventListener('change', () => {
      m.consent = consentBox.checked;
      submit.disabled = !consentBox.checked;
      if (consentBox.checked) consentError.hidden = true;
    });

    frag.append(consentWrap, consentError, trust, guard);
    return frag;
  }

  /* ── Validation and submission ───────────────────────────────── */

  /** Index of the first page still missing a required answer, or null. */
  firstIncompleteStep(m) {
    const steps = this.stepsOf(FORMS[m.formId], m);
    for (let i = 0; i < steps.length; i++) {
      for (const f of this.fieldsOf(steps[i], m)) {
        if (!f.required) continue;
        if (f.showWhen && !f.showWhen(m.values)) continue;
        const v = m.values[f.name];
        const empty = (f.type === 'list' || f.type === 'file')
          ? !(v || []).filter(x => (typeof x === 'string' ? x.trim() : x)).length
          : !String(v || '').trim();
        if (empty) return i;
      }
    }
    return null;
  }

  validate(m, fields, errorNodes, fieldNodes) {
    let firstBad = null;

    for (const f of fields) {
      if (f.type === 'notice' || f.type === 'pool') continue;
      if (f.showWhen && !f.showWhen(m.values)) continue;

      const value = m.values[f.name];
      let problem = null;

      if (f.type === 'list' || f.type === 'file') {
        if (f.required && !(value || []).filter(v => (typeof v === 'string' ? v.trim() : v)).length) {
          problem = f.type === 'file'
            ? 'Please add a photo or scan of your prescription.'
            : `Please add at least one ${f.label.toLowerCase()}.`;
        }
      } else if (f.required && !String(value || '').trim()) {
        problem = (f.type === 'radio' || f.type === 'yesno' || f.type === 'days' || f.type === 'select')
          ? 'Please choose one option.'
          : `Please enter your ${f.label.toLowerCase()}.`;
      } else if (f.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        problem = 'Please enter an email address we can reach you at.';
      } else if (f.type === 'tel' && value && !tenDigits(value)) {
        // api/submit.ts stores exactly ten digits. Catching it here puts the
        // error on the field instead of after a round trip.
        problem = 'Please enter a 10 digit mobile number.';
      }

      const node = errorNodes.get(f.name);
      if (node) { node.textContent = problem || ''; node.hidden = !problem; }
      const control = fieldNodes.get(f.name)?.querySelector('.mx-control');
      if (control) control.setAttribute('aria-invalid', problem ? 'true' : 'false');
      if (problem && !firstBad) firstBad = fieldNodes.get(f.name);
    }

    if (firstBad) {
      firstBad.querySelector('input, select, textarea')?.focus();
      this.$('announce').textContent = 'Some answers need fixing before this can be sent.';
      return false;
    }
    return true;
  }

  async submitForm(m) {
    const spec = FORMS[m.formId];

    // Files travel as blobs; everything else is plain values.
    const values = {};
    const blobs = [];
    for (const [k, v] of Object.entries(m.values)) {
      if (Array.isArray(v) && v[0]?.file) {
        values[k] = v.map(x => ({ name: x.name, size: x.size, type: x.type }));
        blobs.push(...v.map(x => x.file));
      } else {
        values[k] = v;
      }
    }

    const payload = {
      form: m.formId,
      values,
      blobs,
      consent: true,
      consentAt: new Date().toISOString()      // consent timestamp travels with the submission
    };

    try {
      await this.opts.transport?.submitForm?.(payload);
      m.submitted = true;
      m.submittedAt = Date.now();
      this.paintSubmitted(m);
      this.$('announce').textContent = spec.done(m.values).title;
      this.scrollDown();
    } catch (err) {
      console.error('[SecureChat] form submit failed', err);
      this.fail('We couldn\u2019t send your request. Check your connection and try again.');
    }
  }

  /** Collapses a submitted form into a read-only receipt. */
  paintSubmitted(m) {
    const spec = FORMS[m.formId];
    const outcome = spec.done(m.values);
    const card = this.forms.get(m.id).querySelector('.mx-form');

    const done = el('div', 'mx-done');
    done.append(icon('check', true), document.createTextNode(outcome.title));

    const summary = el('div', 'mx-summary');
    const allFields = this.stepsOf(spec, m).flatMap(s => this.fieldsOf(s, m));
    for (const f of allFields) {
      if (f.type === 'notice' || f.type === 'pool') continue;
      if (f.showWhen && !f.showWhen(m.values)) continue;
      const value = this.displayValue(m.values[f.name]);
      if (!value) continue;
      const row = el('div');
      row.append(el('span', 'k', f.label), el('span', 'v', value));
      summary.append(row);
    }

    card.replaceChildren(done, summary, el('p', 'mx-hint', outcome.note));
  }

  renderChips() {
    const box = this.$('chips');
    box.replaceChildren(...this.pending.map(p => {
      const remove = el('button', 'mx-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${p.name}`);
      remove.append(icon('x', true));
      remove.addEventListener('click', () => this.unstage(p.id));

      if (p.kind === 'voice') {
        const pill = el('div', 'mx-doc');
        pill.append(this.voiceEl(p), remove);
        return pill;
      }
      if (p.previewUrl) {
        const thumb = el('div', 'mx-thumb');
        const img = el('img');
        img.src = p.previewUrl;
        img.alt = p.name;
        thumb.append(img, remove);
        return thumb;
      }
      const doc = el('div', 'mx-doc');
      doc.append(icon('file-text', true), el('span', null, p.name), el('span', 'mx-size', fmtSize(p.size)), remove);
      return doc;
    }));
  }

  scrollDown(behavior) {
    const log = this.$('log');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    log.scrollTo({ top: log.scrollHeight, behavior: behavior || (reduce ? 'auto' : 'smooth') });
  }
}
