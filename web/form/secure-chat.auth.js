/* ══════════════════════════════════════════════════════════════════════
   Medixly · secure chat auth gate

   Two front doors, the way patients expect them:

     welcome  →  new here. Google, Apple, email, or guest.
     login    →  been here before. Email and password, or any of the above.

   Plus the screens that hang off them — email/SMS code, password reset,
   the patient-record link, passkey enrollment and the idle lock. Renders
   over the chat shell and reveals it only once there's a verified session.

   All I/O goes through the `auth` object — see the contract at the bottom.
   Nothing here trusts the client: every check is re-run server-side.
   ═══════════════════════════════════════════════════════════════════ */

const IDLE_MS = 5 * 60 * 1000;          // shared phones and counter tablets
const CODE_LENGTH = 6;

/* Length, not composition. NIST 800-63B dropped the character-class rules
   years ago: they push people towards P@ssw0rd1 and nothing else. The server
   is what enforces this — the check here only saves a round trip. */
const MIN_PASSWORD = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
    } catch { /* fall through to the front door */ }
    this.screen('welcome');
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
    // Someone signing out has an account, so send them to login, not welcome.
    this.screen('login');
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
      welcome: () => this.welcomeScreen(),
      signup:  () => this.signupScreen(),
      login:   () => this.loginScreen(),
      reset:   () => this.resetScreen(),
      code:    () => this.codeScreen(data),
      link:    () => this.linkScreen(),
      passkey: () => this.passkeyScreen(data),
      locked:  () => this.lockedScreen()
    }[name];
    this.back = data?.back || null;
    this.layer.replaceChildren(build());
    this.layer.scrollTop = 0;
    this.layer.querySelector('input, button')?.focus({ preventScroll: true });
  }

  /* ── Card parts ──────────────────────────────────────────────── */

  card(title, blurb, withMark) {
    const card = document.createElement('div');
    card.className = 'mx-gate__card';

    if (withMark) {
      const mark = document.createElement('div');
      mark.className = 'mx-gate__mark';
      mark.append(icon('pill'));
      mark.setAttribute('aria-hidden', 'true');
      card.append(mark);
    }

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

  /** A text link, for the switches between screens. */
  link(label, onClick) {
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'mx-gate__link';
    a.textContent = label;
    a.addEventListener('click', onClick);
    return a;
  }

  /** A labelled field. Returns the input so the caller can read it. */
  field(card, label, attrs = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'mx-gate__field';

    const id = 'mx-' + label.toLowerCase().replace(/[^a-z]+/g, '-') + '-' + Math.random().toString(16).slice(2, 8);
    const l = document.createElement('label');
    l.className = 'mx-label';
    l.textContent = label;
    l.htmlFor = id;

    const input = document.createElement('input');
    input.className = 'mx-control';
    input.id = id;
    Object.assign(input, attrs);

    wrap.append(l, input);
    card.append(wrap);
    return input;
  }

  /**
   * A password field with a reveal toggle. The toggle matters more than it
   * looks: without it people pick shorter passwords they can type blind.
   */
  passwordField(card, label, autocomplete) {
    const wrap = document.createElement('div');
    wrap.className = 'mx-gate__field';

    const id = 'mx-pw-' + Math.random().toString(16).slice(2, 8);
    const l = document.createElement('label');
    l.className = 'mx-label';
    l.textContent = label;
    l.htmlFor = id;

    const box = document.createElement('div');
    box.className = 'mx-gate__wrap';

    const input = document.createElement('input');
    input.className = 'mx-control mx-gate__pw';
    input.id = id;
    input.type = 'password';
    input.autocomplete = autocomplete;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mx-gate__reveal';
    toggle.setAttribute('aria-label', 'Show password');
    toggle.append(icon('eye', true));
    toggle.addEventListener('click', () => {
      const shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      toggle.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
      toggle.replaceChildren(icon(shown ? 'eye' : 'eye-off', true));
      input.focus();
    });

    box.append(input, toggle);
    wrap.append(l, box);
    card.append(wrap);
    return input;
  }

  rule(card, label) {
    const rule = document.createElement('div');
    rule.className = 'mx-gate__rule';
    const span = document.createElement('span');
    span.textContent = label;
    rule.append(span);
    card.append(rule);
    return rule;
  }

  /** The switch at the foot of a card: "Already have an account? Log in". */
  foot(card, sentence, label, onClick) {
    const p = document.createElement('p');
    p.className = 'mx-gate__foot';
    p.append(document.createTextNode(sentence + ' '), this.link(label, onClick));
    card.append(p);
    return p;
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
    this.anchor(card, box);
  }

  /**
   * Messages belong next to the main action, not at the bottom of the card.
   * Appending puts them under the trust line and the switch, where someone
   * who just failed to log in has stopped looking.
   */
  anchor(card, box) {
    const before = card.querySelector('.mx-gate__btn--primary') ||
                   card.querySelector('.mx-trust');
    if (before) card.insertBefore(box, before);
  }

  /** A one-line confirmation. Same slot as the error, different tone. */
  note(card, message) {
    let box = card.querySelector('.mx-gate__note');
    if (!box) {
      box = document.createElement('p');
      box.className = 'mx-gate__note';
      card.append(box);
    }
    box.textContent = message;
    box.hidden = false;
    this.anchor(card, box);
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

  /**
   * The methods that are the same on both front doors. A patient shouldn't
   * have to remember which screen offered Google.
   */
  federated(card) {
    card.append(this.button(`Continue with Google`, 'outline', async () => {
      try {
        this.afterIdentity(await this.auth.googleSignIn());
      } catch (err) {
        console.error('[auth] google', err);
        this.error(card, 'We couldn\u2019t finish signing you in with Google. Try again, or use a code instead.');
      }
    }));

    // Only offered where the server half exists — an Apple button that goes
    // nowhere is worse than no Apple button.
    if (this.auth.appleSignIn) {
      card.append(this.button('Continue with Apple', 'outline', async () => {
        try {
          this.afterIdentity(await this.auth.appleSignIn());
        } catch (err) {
          console.error('[auth] apple', err);
          this.error(card, 'We couldn\u2019t finish signing you in with Apple. Try again, or use a code instead.');
        }
      }));
    }

    card.append(this.button('Email or text me a code', 'ghost', () => this.screen('code')));

    if (this.canPasskey) {
      card.append(this.button('Use Face ID or fingerprint', 'ghost', async () => {
        try {
          this.afterIdentity(await this.auth.passkeyAuth());
        } catch (err) {
          console.error('[auth] passkey', err);
          this.error(card, 'That didn\u2019t work. Sign in with Google or a code, then try again.');
        }
      }, 'fingerprint'));
    }
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

  /* ── Front door: new here ────────────────────────────────────── */

  welcomeScreen() {
    const card = this.card(
      `Welcome to ${this.opts.pharmacyName}`,
      'Refills, transfers and a pharmacist you can message. Your conversation contains health information, so we need to know it\u2019s you.',
      true);

    card.append(this.button('Sign up with email', 'primary', () => this.screen('signup')));
    this.federated(card);

    this.rule(card, 'or');

    // Guest is intake only — no transcript, since that would expose health history.
    card.append(this.button('Continue as guest', 'ghost', () =>
      this.ready({ guest: true, name: '', email: '', phone: '' })));
    const note = document.createElement('p');
    note.className = 'mx-hint';
    note.textContent = 'As a guest you can send a prescription or transfer request, but you won\u2019t see your message history.';
    card.append(note);

    this.trust(card);
    this.foot(card, 'Already have an account?', 'Log in', () => this.screen('login'));
    return card;
  }

  signupScreen() {
    const card = this.card('Create your account',
      `We\u2019ll use this to reach you about your requests — nothing else.`, true);

    const name = this.field(card, 'Full name', { type: 'text', autocomplete: 'name' });
    const email = this.field(card, 'Email address', { type: 'email', autocomplete: 'email', inputMode: 'email' });
    const pw = this.passwordField(card, 'Password', 'new-password');

    const hint = document.createElement('p');
    hint.className = 'mx-hint';
    hint.textContent = `At least ${MIN_PASSWORD} characters. A short phrase you\u2019ll remember beats a scramble you won\u2019t.`;
    card.append(hint);

    const submit = this.button('Create account', 'primary', async () => {
      if (!name.value.trim()) return this.error(card, 'Please enter your name.');
      if (!EMAIL_RE.test(email.value.trim())) return this.error(card, 'Please check your email address.');
      if (pw.value.length < MIN_PASSWORD) {
        return this.error(card, `Please use at least ${MIN_PASSWORD} characters.`);
      }
      submit.disabled = true;
      try {
        this.afterIdentity(await this.auth.signUp({
          name: name.value.trim(), email: email.value.trim(), password: pw.value
        }));
      } catch (err) {
        console.error('[auth] signup', err);
        // Deliberately not "that email is taken" — that confirms who is a
        // patient here to anyone who can type an address.
        this.error(card, 'We couldn\u2019t create that account. Try logging in, or call us at [Phone Number].');
      } finally {
        submit.disabled = false;
      }
    });
    card.append(submit);

    this.trust(card);
    this.foot(card, 'Already have an account?', 'Log in', () => this.screen('login'));
    return card;
  }

  /* ── Front door: been here before ────────────────────────────── */

  loginScreen() {
    const card = this.card('Log in', `Welcome back to ${this.opts.pharmacyName}.`, true);

    const email = this.field(card, 'Email address', { type: 'email', autocomplete: 'email', inputMode: 'email' });
    const pw = this.passwordField(card, 'Password', 'current-password');

    const aux = document.createElement('div');
    aux.className = 'mx-gate__aux';
    aux.append(this.link('Forgot password?', () => this.screen('reset')));
    card.append(aux);

    const submit = this.button('Log in', 'primary', async () => {
      if (!EMAIL_RE.test(email.value.trim())) return this.error(card, 'Please check your email address.');
      if (!pw.value) return this.error(card, 'Please enter your password.');
      submit.disabled = true;
      try {
        this.afterIdentity(await this.auth.passwordSignIn({
          email: email.value.trim(), password: pw.value
        }));
      } catch (err) {
        console.error('[auth] login', err);
        // One message for a wrong address and a wrong password, so the screen
        // can't be used to find out who has an account.
        this.error(card, 'That email and password don\u2019t match. Check them, or reset your password.');
      } finally {
        submit.disabled = false;
      }
    });
    card.append(submit);

    // Enter submits, which is what a password field is expected to do.
    pw.addEventListener('keydown', e => { if (e.key === 'Enter') submit.click(); });

    this.rule(card, 'or');
    this.federated(card);

    this.trust(card);
    this.foot(card, 'New to Medixly?', 'Create an account', () => this.screen('welcome'));
    return card;
  }

  resetScreen() {
    const card = this.card('Reset your password',
      'We\u2019ll email you a link to set a new one. The link works once and expires in an hour.');

    const email = this.field(card, 'Email address', { type: 'email', autocomplete: 'email', inputMode: 'email' });

    const send = this.button('Send the link', 'primary', async () => {
      if (!EMAIL_RE.test(email.value.trim())) return this.error(card, 'Please check your email address.');
      send.disabled = true;
      try { await this.auth.requestPasswordReset({ email: email.value.trim() }); } catch (err) {
        console.error('[auth] reset', err);
      }
      // Same answer either way. Whether an address has an account here is
      // itself health information — it says someone is our patient.
      this.note(card, 'If that address has an account with us, the link is on its way.');
      send.disabled = false;
    });
    card.append(send);
    card.append(this.button('Back to log in', 'ghost', () => this.screen('login')));
    return this.trust(card);
  }

  codeScreen() {
    const card = this.card('Send me a code',
      'We\u2019ll send a six digit code to the phone or email on your pharmacy file.');

    const input = this.field(card, 'Email address or mobile number',
      { type: 'text', autocomplete: 'username' });

    const codeWrap = document.createElement('div');
    codeWrap.className = 'mx-gate__field';
    codeWrap.hidden = true;
    const codeLabel = document.createElement('label');
    codeLabel.className = 'mx-label';
    codeLabel.textContent = `${CODE_LENGTH} digit code`;
    const codeBox = document.createElement('input');
    codeBox.className = 'mx-control mx-gate__code';
    codeBox.id = 'mx-otp';
    codeBox.type = 'text';
    codeBox.inputMode = 'numeric';
    codeBox.autocomplete = 'one-time-code';
    codeBox.maxLength = CODE_LENGTH;
    codeBox.placeholder = '······';
    codeLabel.htmlFor = codeBox.id;
    codeWrap.append(codeLabel, codeBox);
    card.append(codeWrap);

    const send = this.button('Send code', 'primary', async () => {
      const to = input.value.trim();
      if (!to) return this.error(card, 'Please enter the email address or mobile number on your file.');
      try {
        await this.auth.requestCode({ to });
        codeWrap.hidden = false;
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
    card.append(this.button('Back', 'ghost', () => this.screen(this.profile ? 'login' : 'welcome')));
    return this.trust(card);
  }

  /**
   * A Google account, an Apple account, a password or a verified code proves
   * control of an address — not that the person is this patient. Linking
   * checks details only the patient and the pharmacy share before any
   * history is shown.
   */
  linkScreen() {
    const card = this.card('Confirm it\u2019s you',
      'Enter these once and we\u2019ll connect you to your pharmacy record.');

    const health = this.field(card, 'Health card number', { type: 'text' });
    const dob = this.field(card, 'Date of birth', { type: 'date' });

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

   currentSession()                      → { profile } | null
   signUp({ name, email, password })     → { profile } | { needsLink: true }
   passwordSignIn({ email, password })   → { profile } | { needsLink: true }
   requestPasswordReset({ email })       → { ok: true }
   googleSignIn()                        → { profile } | { needsLink: true }
   appleSignIn()                         → { profile } | { needsLink: true }   optional
   requestCode({ to })                   → { ok: true }
   verifyCode({ code })                  → { profile } | { needsLink: true }
   linkPatient({ healthCard, dob })      → { profile }
   passkeyRegister()                     → { ok: true }
   passkeyAuth()                         → { profile } | { needsLink: true }
   signOut()                             → { ok: true }

   `appleSignIn` is the only optional one — leave it off the object and the
   button doesn't render.

   profile = { id, name, email, phone, dob, healthCard, hasPasskey, guest }

   Non-negotiables for whoever builds the server half:

   1. Verify Google and Apple ID tokens server-side — signature, aud, iss and
      expiry. A client-side decode is not a check.
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

   And six more that only became due once there were passwords. A password
   is the one credential we store ourselves, so it is the one that can leak:

   7. Argon2id or scrypt. Never SHA-anything, never a fast hash, never a
      hash the database can compute in a SQL expression.
   8. Enforce MIN_PASSWORD server-side and check the candidate against a
      breached-password list. Length is the only composition rule.
   9. Rate-limit passwordSignIn per address *and* per IP, and return the same
      message and the same timing for an unknown address as for a wrong
      password. Otherwise the login form enumerates who is a patient here.
  10. Reset tokens: single use, one hour, hashed at rest, invalidated by a
      successful login or a second reset request. Never email the password.
  11. Rotate the session on login and on password change, and end every other
      session on a password change.
  12. A password alone should not be enough to read a transcript. Require the
      patient-record link (or a passkey) on a new device, exactly as the
      federated paths do.
   ═══════════════════════════════════════════════════════════════════ */
