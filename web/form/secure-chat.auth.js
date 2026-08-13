/* ══════════════════════════════════════════════════════════════════════
   Medixly · secure chat auth gate

   Two front doors, the way patients expect them:

     welcome  →  new here. Google, Apple, email, or guest.
     login    →  been here before. Email and password, or any of the above.

   Plus the screens that hang off them — email/SMS code, password reset,
   passkey enrollment and the idle lock. Renders over the chat shell and
   reveals it only once there's a verified session.

   Nothing here asks for a health card number or a date of birth. See the
   note on afterIdentity() for what replaced that, and why.

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

/* Google and Apple both require their own mark on a sign-in button, and both
   forbid recolouring it — so these two are the one place in this client where
   a colour does not come from a token. Built as SVG rather than fetched, since
   nothing on this page may reach a third-party host: an asset request to
   Google would tell Google a patient is at a pharmacy's sign-in screen. */
const BRAND = {
  google: { box: '0 0 18 18', paths: [
    ['#4285F4', 'M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.615z'],
    ['#34A853', 'M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2581c-.8059.54-1.8368.859-3.0477.859-2.344 0-4.3282-1.5831-5.036-3.7104H.9574v2.3318C2.4382 15.9832 5.4818 18 9 18z'],
    ['#FBBC05', 'M3.964 10.71c-.18-.54-.2822-1.1168-.2822-1.71s.1023-1.17.2823-1.71V4.9582H.9573A8.9965 8.9965 0 000 9c0 1.4523.3477 2.8268.9573 4.0418L3.964 10.71z'],
    ['#EA4335', 'M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.6559 3.5795 9 3.5795z']
  ]},
  apple: { box: '0 0 24 24', paths: [
    ['#000', 'M17.05 12.536c-.024-2.51 2.05-3.716 2.143-3.775-1.167-1.706-2.98-1.94-3.622-1.966-1.542-.156-3.01.908-3.79.908-.782 0-1.988-.885-3.268-.861-1.68.025-3.23.977-4.093 2.48-1.745 3.026-.446 7.505 1.253 9.957.83 1.2 1.82 2.548 3.118 2.5 1.25-.05 1.723-.81 3.234-.81 1.51 0 1.937.81 3.26.785 1.346-.025 2.198-1.223 3.02-2.428.952-1.392 1.343-2.74 1.367-2.81-.03-.013-2.62-1.005-2.645-3.99zM14.6 4.9c.69-.837 1.156-2 1.029-3.16-.994.04-2.2.662-2.913 1.498-.64.74-1.2 1.925-1.05 3.06 1.11.086 2.243-.564 2.934-1.398z']
  ]}
};
const SVG_NS = 'http://www.w3.org/2000/svg';

function brandMark(name) {
  const spec = BRAND[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'mx-brand');
  svg.setAttribute('viewBox', spec.box);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [fill, d] of spec.paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', fill);
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

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
    // Both states hide the transcript: a guest has no record, and an
    // unlinked account has not been matched to one yet.
    this.host.classList.toggle('is-guest', !!profile.guest);
    this.host.classList.toggle('is-unlinked', !profile.guest && !profile.linked);
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
      signup:  () => this.signupScreen(data),
      login:   () => this.loginScreen(),
      reset:   () => this.resetScreen(),
      code:    () => this.codeScreen(data),
      passkey: () => this.passkeyScreen(data),
      locked:  () => this.lockedScreen()
    }[name];
    this.back = data?.back || null;
    this.layer.replaceChildren(build());
    this.layer.scrollTop = 0;
    this.layer.querySelector('input, button')?.focus({ preventScroll: true });
  }

  /* ── Card parts ──────────────────────────────────────────────── */

  /**
   * @param {string} title
   * @param {string} [blurb]
   * @param {'hero'|'small'} [art]  the pharmacist illustration, or nothing
   */
  card(title, blurb, art) {
    const card = document.createElement('div');
    card.className = 'mx-gate__card';

    if (art) {
      // Decorative, so `alt=""` rather than a description — a screen reader
      // announcing "pharmacist at a shelf of medicine" before the heading adds
      // nothing. The ink and paper of the drawing are baked to the palette's
      // own values; see the note in secure-chat.auth.css.
      const fig = document.createElement('img');
      fig.className = 'mx-gate__art' + (art === 'small' ? ' mx-gate__art--sm' : '');
      fig.src = 'img/pharmacist.png';
      fig.alt = '';
      fig.width = 600;
      fig.height = 568;
      card.append(fig);
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
    if (iconName) b.append(BRAND[iconName] ? brandMark(iconName) : icon(iconName, true));
    b.append(document.createTextNode(label));
    b.addEventListener('click', onClick);
    return b;
  }

  /** A text link, for the switches between screens. */
  link(label, onClick, arrow) {
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'mx-gate__link';
    a.append(document.createTextNode(label));
    if (arrow) a.append(icon('arrow-right', true));
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
  foot(card, sentence, label, onClick, arrow) {
    const p = document.createElement('p');
    p.className = 'mx-gate__foot';
    p.append(document.createTextNode(sentence + ' '), this.link(label, onClick, arrow));
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
   *
   * @param {boolean} [returning]  true on the screens for someone who already
   *   has an account. Gates the passkey offer, which is a *sign-in* method and
   *   nothing else: `passkeyAuth()` asks the device for a credential that was
   *   enrolled here earlier, so on a sign-up screen it can only ever fail.
   *   Enrollment is offered once, after the record link, on passkeyScreen().
   */
  federated(card, returning) {
    this.oauthRow(card);
    card.append(this.button('Email or text me a code', 'ghost', () => this.screen('code')));

    if (returning && this.canPasskey) {
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

  /**
   * Google and Apple, side by side. Two short labels read faster than two
   * full-width "Continue with ..." bars, and the marks do most of the work.
   * Falls back to one full-width button when Apple isn't wired up.
   */
  oauthRow(card) {
    const row = document.createElement('div');
    row.className = 'mx-gate__social';

    row.append(this.button('Google', 'outline', async () => {
      try {
        this.afterIdentity(await this.auth.googleSignIn());
      } catch (err) {
        console.error('[auth] google', err);
        this.error(card, 'We couldn\u2019t finish signing you in with Google. Try again, or use a code instead.');
      }
    }, 'google'));

    // Only offered where the server half exists \u2014 an Apple button that goes
    // nowhere is worse than no Apple button.
    if (this.auth.appleSignIn) {
      row.append(this.button('Apple', 'outline', async () => {
        try {
          this.afterIdentity(await this.auth.appleSignIn());
        } catch (err) {
          console.error('[auth] apple', err);
          this.error(card, 'We couldn\u2019t finish signing you in with Apple. Try again, or use a code instead.');
        }
      }, 'apple'));
    }

    card.append(row);
    return row;
  }

  /**
   * The agreement line under the front doors. Rendered as links only when
   * `opts.legal` carries real URLs: a sentence claiming someone agreed to
   * documents they cannot open is worse than no sentence, and these are the
   * documents PHIPA requires a custodian to publish.
   */
  legal(card) {
    const { terms, privacy } = this.opts.legal || {};
    const p = document.createElement('p');
    p.className = 'mx-gate__legal';

    const doc = (label, href) => {
      if (!href) return document.createTextNode(label);
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = label;
      return a;
    };

    if (!terms || !privacy) {
      console.warn('[SecureChat] no opts.legal.terms / opts.legal.privacy \u2014 ' +
        'the agreement line is showing without links to the documents it names.');
    }

    p.append(
      document.createTextNode('By continuing you agree to our '),
      doc('Terms of Use', terms),
      document.createTextNode(' and '),
      doc('Privacy Notice', privacy),
      document.createTextNode('. Message and data rates apply.'));
    card.append(p);
    return p;
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
      'Refills, transfers and a pharmacist you can message, right in your pocket.',
      'hero');

    // One field, either kind. People know their own number or their own
    // address; making them pick which one they are about to type is a
    // decision the screen can make for them.
    const to = this.field(card, 'Phone or email',
      { type: 'text', autocomplete: 'username',
        placeholder: 'Enter phone number or email' });

    const submit = this.button('Create my account', 'primary', () => {
      const value = to.value.trim();
      const phone = tenDigits(value);
      if (!phone && !EMAIL_RE.test(value)) {
        return this.error(card, 'Please enter a mobile number or an email address.');
      }
      this.screen('signup', { to: value });
    });
    card.append(submit);
    to.addEventListener('keydown', e => { if (e.key === 'Enter') submit.click(); });

    this.rule(card, 'or');
    // No passkey here: nobody arriving at a sign-up screen has one to use.
    this.oauthRow(card);

    // Guest is intake only \u2014 no transcript, since that would expose health history.
    card.append(this.button('Continue as guest', 'ghost', () =>
      this.ready({ guest: true, name: '', email: '', phone: '' })));
    const note = document.createElement('p');
    note.className = 'mx-hint';
    note.textContent = 'As a guest you can send a prescription or transfer request, but you won\u2019t see your message history.';
    card.append(note);

    this.trust(card);
    this.foot(card, 'Already have an account?', 'Log in', () => this.screen('login'), true);
    this.legal(card);
    return card;
  }

  /**
   * Second half of signing up. The identifier is already in hand from the
   * welcome screen, so this asks only for what is still missing.
   *
   * @param {{to?: string}} [data]  whatever was typed on the welcome screen
   */
  signupScreen(data) {
    const typed = String(data?.to || '').trim();
    const asPhone = tenDigits(typed);

    const card = this.card('Create your account',
      `We\u2019ll use this to reach you about your requests \u2014 nothing else.`, 'small');

    const name = this.field(card, 'Full name', { type: 'text', autocomplete: 'name' });
    const email = this.field(card, 'Email address',
      { type: 'email', autocomplete: 'email', inputMode: 'email',
        value: asPhone ? '' : typed });

    // Only asked for when they gave us one. The forms collect a number per
    // request anyway, so a second empty field here would be asking twice.
    const mobile = asPhone
      ? this.field(card, 'Mobile number',
          { type: 'tel', autocomplete: 'tel', inputMode: 'tel', value: typed })
      : null;

    const pw = this.passwordField(card, 'Password', 'new-password');

    const hint = document.createElement('p');
    hint.className = 'mx-hint';
    hint.textContent = `At least ${MIN_PASSWORD} characters. A short phrase you\u2019ll remember beats a scramble you won\u2019t.`;
    card.append(hint);

    const submit = this.button('Create account', 'primary', async () => {
      if (!name.value.trim()) return this.error(card, 'Please enter your name.');
      if (!EMAIL_RE.test(email.value.trim())) return this.error(card, 'Please check your email address.');
      if (mobile && !tenDigits(mobile.value)) {
        return this.error(card, 'Please check your mobile number.');
      }
      if (pw.value.length < MIN_PASSWORD) {
        return this.error(card, `Please use at least ${MIN_PASSWORD} characters.`);
      }
      submit.disabled = true;
      try {
        this.afterIdentity(await this.auth.signUp({
          name: name.value.trim(),
          email: email.value.trim(),
          phone: mobile ? tenDigits(mobile.value) : null,
          password: pw.value
        }));
      } catch (err) {
        console.error('[auth] signup', err);
        // Deliberately not "that email is taken" \u2014 that confirms who is a
        // patient here to anyone who can type an address.
        this.error(card, 'We couldn\u2019t create that account. Try logging in, or call us at [Phone Number].');
      } finally {
        submit.disabled = false;
      }
    });
    card.append(submit);

    card.append(this.button('Back', 'ghost', () => this.screen('welcome')));

    this.trust(card);
    this.foot(card, 'Already have an account?', 'Log in', () => this.screen('login'), true);
    this.legal(card);
    return card;
  }

  /* ── Front door: been here before ────────────────────────────── */

  loginScreen() {
    const card = this.card('Log in', `Welcome back to ${this.opts.pharmacyName}.`, 'small');

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
    this.federated(card, true);

    this.trust(card);
    this.foot(card, 'New to Medixly?', 'Create an account', () => this.screen('welcome'), true);
    this.legal(card);
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

  /**
   * Signing in proves control of an address. It does not prove the person is
   * a particular patient of this pharmacy, and there is no question this
   * screen could ask that would — a health card number and a date of birth
   * are exactly the details someone impersonating a patient is most likely to
   * have, and asking a new customer for them at the door is both frightening
   * and, per docs/PIA.md \u00a74, information this system does not collect.
   *
   * So the account opens either way, and `profile.linked` carries the answer:
   * false means no pharmacy record is attached yet, and the transcript stays
   * hidden exactly as it does for a guest. Requests still go through, because
   * every form collects and consents to its own identity fields. Linking is
   * the pharmacy's job, done from their side against a record they already
   * hold \u2014 not a quiz at the front door.
   */
  afterIdentity(res) {
    if (!res?.profile) return;
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
   signUp({ name, email, phone, password }) → { profile }
   passwordSignIn({ email, password })   → { profile }
   requestPasswordReset({ email })       → { ok: true }
   googleSignIn()                        → { profile }
   appleSignIn()                         → { profile }                optional
   requestCode({ to })                   → { ok: true }
   verifyCode({ code })                  → { profile }
   passkeyRegister()                     → { ok: true }
   passkeyAuth()                         → { profile }
   signOut()                             → { ok: true }

   `appleSignIn` is the only optional one — leave it off the object and the
   button doesn't render.

   profile = { id, name, email, phone, hasPasskey, guest, linked }

   `linked` is whether this account has been matched to a pharmacy record.
   The client shows no message history until it is true. There is no
   `healthCard` and no `dob`: the gate does not ask for either, and the server
   should not send them back.

   Non-negotiables for whoever builds the server half:

   1. Verify Google and Apple ID tokens server-side — signature, aud, iss and
      expiry. A client-side decode is not a check.
   2. Disable One Tap and auto-select on this surface. Auto-signing in the
      last account is wrong on a family phone or a counter tablet.
   3. Match patients on identity, not email address. If Google and SMS create
      two records for one person, their medication history splits in half.
   4. Keep a second factor enrolled alongside any passkey. A lost phone must
      not lock a patient out of their own records.
   5. Linking an account to a patient record happens on the pharmacy's side,
      against a person they have already identified. Never expose it as a
      self-serve endpoint the client can call with guessed details — that is a
      lookup against real patient records, and the reason the front door no
      longer asks for a health card number.
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
  12. A password alone should not be enough to read a transcript. On a new
      device require a second check — a passkey, or a code to the number on
      file — exactly as the federated paths do. `linked: true` says the account
      belongs to a patient; it does not say this device does.
   ═══════════════════════════════════════════════════════════════════ */
