/* ══════════════════════════════════════════════════════════════════════
   Medixly · secure chat auth gate

   Covers the sign-in screen, the patient-record link, passkey enrollment,
   guest intake and the idle lock. Renders over the chat shell and reveals
   it only once there's a verified session.

   All I/O goes through the `auth` object — see the contract at the bottom.
   Nothing here trusts the client: every check is re-run server-side.
   ═══════════════════════════════════════════════════════════════════ */

const IDLE_MS = 5 * 60 * 1000;          // shared phones and counter tablets
const CODE_LENGTH = 6;

/** Passkeys need a platform authenticator; hide the offer where there isn't one. */
async function passkeysAvailable() {
  try {
    return !!(window.PublicKeyCredential &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch { return false; }
}

class AuthGate {
  /**
   * @param {HTMLElement} host   the .mx-chat shell
   * @param {object} opts
   *   auth       the transport (see contract below)
   *   chat       the SecureChat instance, revealed once signed in
   *   pharmacyName
   *   onSession(profile)  called whenever the session changes; null on sign-out
   */
  constructor(host, opts) {
    this.host = host;
    this.opts = opts;
    this.auth = opts.auth;
    this.profile = null;
    this.canPasskey = false;

    this.layer = document.createElement('div');
    this.layer.className = 'mx-gate';
    host.append(this.layer);

    this.watchIdle();
    this.start();
  }

  /* ── Session lifecycle ───────────────────────────────────────── */

  async start() {
    this.canPasskey = await passkeysAvailable();
    this.screen('loading');
    try {
      const session = await this.auth.currentSession();
      if (session?.profile) return this.ready(session.profile);
    } catch { /* fall through to sign-in */ }
    this.screen('signin');
  }

  ready(profile) {
    this.profile = profile;
    this.opts.onSession?.(profile);
    this.opts.chat?.setProfile?.(profile);
    this.layer.hidden = true;
    this.host.classList.toggle('is-guest', !!profile.guest);
    this.touch();
  }

  async signOut() {
    try { await this.auth.signOut(); } catch { /* sign out locally regardless */ }
    this.profile = null;
    this.opts.onSession?.(null);
    this.layer.hidden = false;
    this.screen('signin');
  }

  /** Locks without dropping the session — unlock is a passkey or a code. */
  lock() {
    if (!this.profile || this.profile.guest || !this.layer.hidden) return;
    this.layer.hidden = false;
    this.screen('locked');
  }

  watchIdle() {
    const reset = () => this.touch();
    ['pointerdown', 'keydown', 'focusin'].forEach(e =>
      this.host.addEventListener(e, reset, { passive: true }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.hiddenAt = Date.now();
      else if (this.hiddenAt && Date.now() - this.hiddenAt > IDLE_MS) this.lock();
    });
  }
  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.lock(), IDLE_MS);
  }

  /* ── Screens ─────────────────────────────────────────────────── */

  screen(name, data) {
    const build = {
      loading: () => this.loadingScreen(),
      signin:  () => this.signinScreen(),
      code:    () => this.codeScreen(data),
      link:    () => this.linkScreen(),
      passkey: () => this.passkeyScreen(data),
      locked:  () => this.lockedScreen()
    }[name];
    this.layer.replaceChildren(build());
    this.layer.querySelector('input, button')?.focus({ preventScroll: true });
  }

  card(title, blurb) {
    const card = document.createElement('div');
    card.className = 'mx-gate__card';
    const h = document.createElement('h2');
    h.textContent = title;
    card.append(h);
    if (blurb) {
      const p = document.createElement('p');
      p.className = 'mx-gate__blurb';
      p.textContent = blurb;
      card.append(p);
    }
    return card;
  }

  button(label, variant, onClick, iconName) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `mx-gate__btn mx-gate__btn--${variant}`;
    if (iconName) b.append(icon(iconName, true));
    b.append(document.createTextNode(label));
    b.addEventListener('click', onClick);
    return b;
  }

  error(card, message) {
    let box = card.querySelector('.mx-gate__err');
    if (!box) {
      box = document.createElement('p');
      box.className = 'mx-gate__err mx-err';
      card.append(box);
    }
    box.textContent = message;
    box.hidden = false;
  }

  trust(card) {
    const c = COUNTRY[this.opts.country] || COUNTRY.Canada;
    const p = document.createElement('p');
    p.className = 'mx-trust';
    const span = document.createElement('span');
    span.textContent =
      `Your information is transmitted securely via ${c.platform} — ${c.law} compliant`;
    p.append(icon('lock', true), span);
    card.append(p);
    return card;
  }

  loadingScreen() {
    const card = this.card('Just a moment');
    const dots = document.createElement('div');
    dots.className = 'mx-typing';
    dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    card.append(dots);
    return card;
  }

  signinScreen() {
    const card = this.card(
      `Sign in to ${this.opts.pharmacyName}`,
      'Your messages contain health information, so we need to know it\u2019s you.');

    card.append(this.button('Continue with Google', 'primary', async () => {
      try {
        const res = await this.auth.googleSignIn();
        this.afterIdentity(res);
      } catch (err) {
        console.error('[auth] google', err);
        this.error(card, 'We couldn\u2019t finish signing you in with Google. Try again, or use a code instead.');
      }
    }));

    card.append(this.button('Email or text me a code', 'outline', () => this.screen('code')));

    if (this.canPasskey) {
      card.append(this.button('Use Face ID or fingerprint', 'ghost', async () => {
        try {
          const res = await this.auth.passkeyAuth();
          this.afterIdentity(res);
        } catch (err) {
          console.error('[auth] passkey', err);
          this.error(card, 'That didn\u2019t work. Sign in with Google or a code, then try again.');
        }
      }, 'fingerprint'));
    }

    const rule = document.createElement('div');
    rule.className = 'mx-gate__rule';
    const span = document.createElement('span');
    span.textContent = 'or';
    rule.append(span);
    card.append(rule);

    // Guest is intake only — no transcript, since that would expose health history.
    card.append(this.button('Continue as guest', 'ghost', () =>
      this.ready({ guest: true, name: '', email: '', phone: '' })));
    const note = document.createElement('p');
    note.className = 'mx-hint';
    note.textContent = 'As a guest you can send a prescription or transfer request, but you won\u2019t see your message history.';
    card.append(note);

    return this.trust(card);
  }

  codeScreen() {
    const card = this.card('Send me a code',
      'We\u2019ll send a six digit code to the phone or email on your pharmacy file.');

    const input = document.createElement('input');
    input.className = 'mx-control';
    input.type = 'email';
    input.placeholder = 'Email address or mobile number';
    input.setAttribute('aria-label', 'Email address or mobile number');
    card.append(input);

    const codeBox = document.createElement('input');
    codeBox.className = 'mx-control mx-gate__code';
    codeBox.type = 'text';
    codeBox.inputMode = 'numeric';
    codeBox.autocomplete = 'one-time-code';
    codeBox.maxLength = CODE_LENGTH;
    codeBox.placeholder = '······';
    codeBox.setAttribute('aria-label', `${CODE_LENGTH} digit code`);
    codeBox.hidden = true;
    card.append(codeBox);

    const send = this.button('Send code', 'primary', async () => {
      const to = input.value.trim();
      if (!to) return this.error(card, 'Please enter the email address or mobile number on your file.');
      try {
        await this.auth.requestCode({ to });
        codeBox.hidden = false;
        codeBox.focus();
        send.remove();
        card.insertBefore(verify, card.querySelector('.mx-trust'));
      } catch {
        this.error(card, 'We couldn\u2019t send a code to that address. Check it and try again.');
      }
    });

    const verify = this.button('Verify', 'primary', async () => {
      const code = codeBox.value.trim();
      if (code.length !== CODE_LENGTH) return this.error(card, `Please enter the ${CODE_LENGTH} digit code we sent you.`);
      try {
        this.afterIdentity(await this.auth.verifyCode({ code }));
      } catch {
        this.error(card, 'That code didn\u2019t match. Check it, or send a new one.');
      }
    });

    card.append(send);
    card.append(this.button('Back', 'ghost', () => this.screen('signin')));
    return this.trust(card);
  }

  /**
   * A Google account or a verified code proves control of an address — not
   * that the person is this patient. Linking checks details only the patient
   * and the pharmacy share before any history is shown.
   */
  linkScreen() {
    const card = this.card('Confirm it\u2019s you',
      'Enter these once and we\u2019ll connect you to your pharmacy record.');

    const health = document.createElement('input');
    health.className = 'mx-control';
    health.type = 'text';
    health.placeholder = 'Health card number';
    health.setAttribute('aria-label', 'Health card number');

    const dob = document.createElement('input');
    dob.className = 'mx-control';
    dob.type = 'date';
    dob.setAttribute('aria-label', 'Date of birth');

    card.append(health, dob);
    card.append(this.button('Confirm', 'primary', async () => {
      if (!health.value.trim() || !dob.value) {
        return this.error(card, 'Please enter both your health card number and date of birth.');
      }
      try {
        const res = await this.auth.linkPatient({ healthCard: health.value.trim(), dob: dob.value });
        if (!res?.profile) throw new Error('no profile');
        this.offerPasskey(res.profile);
      } catch {
        // Deliberately vague: a precise message would let someone probe records.
        this.error(card, 'Those details don\u2019t match a record we hold. Check them, or call us at [Phone Number].');
      }
    }));
    return this.trust(card);
  }

  passkeyScreen(profile) {
    const card = this.card('Skip this next time?',
      'Use Face ID or your fingerprint to open your messages. Your biometrics stay on your device — we only store a key.');
    card.append(this.button('Turn on Face ID', 'primary', async () => {
      try { await this.auth.passkeyRegister(); } catch (err) { console.error('[auth] enroll', err); }
      this.ready(profile);
    }, 'fingerprint'));
    card.append(this.button('Not now', 'ghost', () => this.ready(profile)));
    return card;
  }

  lockedScreen() {
    const card = this.card('Locked',
      `Your messages are hidden. Unlock to pick up where you left off.`);
    if (this.canPasskey) {
      card.append(this.button('Unlock', 'primary', async () => {
        try {
          await this.auth.passkeyAuth();
          this.layer.hidden = true;
          this.touch();
        } catch {
          this.error(card, 'That didn\u2019t work. Use a code instead.');
        }
      }, 'fingerprint'));
    }
    card.append(this.button('Use a code instead', 'outline', () => this.screen('code')));
    card.append(this.button('Sign out', 'ghost', () => this.signOut()));
    return card;
  }

  /* ── Routing after an identity check ─────────────────────────── */

  afterIdentity(res) {
    if (!res) return;
    if (res.needsLink || !res.profile) return this.screen('link');
    this.offerPasskey(res.profile);
  }

  offerPasskey(profile) {
    if (this.canPasskey && !profile.hasPasskey) return this.screen('passkey', profile);
    this.ready(profile);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   Auth transport contract — implement server-side and pass in as `auth`.

   currentSession()                 → { profile } | null
   googleSignIn()                   → { profile } | { needsLink: true }
   requestCode({ to })              → { ok: true }
   verifyCode({ code })             → { profile } | { needsLink: true }
   linkPatient({ healthCard, dob }) → { profile }
   passkeyRegister()                → { ok: true }
   passkeyAuth()                    → { profile } | { needsLink: true }
   signOut()                        → { ok: true }

   profile = { id, name, email, phone, dob, healthCard, hasPasskey, guest }

   Non-negotiables for whoever builds the server half:

   1. Verify Google ID tokens server-side — signature, aud, iss and expiry.
      A client-side decode is not a check.
   2. Disable One Tap and auto-select on this surface. Auto-signing in the
      last account is wrong on a family phone or a counter tablet.
   3. Match patients on identity, not email address. If Google and SMS create
      two records for one person, their medication history splits in half.
   4. Keep a second factor enrolled alongside any passkey. A lost phone must
      not lock a patient out of their own records.
   5. Rate-limit linkPatient and keep its failure message vague — it is a
      lookup against real patient records.
   6. Never prefill consent or the assessment signature from a profile. Each
      submission needs its own consent record and its own timestamp.
   ═══════════════════════════════════════════════════════════════════ */
