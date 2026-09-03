/**
 * Minimal RouterOS API client.
 *
 * The published npm clients are unmaintained, and this protocol is small
 * and frozen, so we speak it directly rather than depend on abandoned code
 * in the path of a payment.
 *
 * Wire format: a "sentence" is a run of length-prefixed words terminated by
 * a zero-length word. Replies arrive as zero or more !re sentences followed
 * by !done, or a !trap / !fatal carrying an error.
 *
 * Assumes RouterOS >= 6.43 (plain login). Anything running v7 qualifies.
 */

const net = require('net');
const tls = require('tls');

/* ------------------------------------------------------------------ */
/* Length prefix codec                                                 */
/* ------------------------------------------------------------------ */

function encodeLength(len) {
  if (len < 0x80) {
    return Buffer.from([len]);
  }
  if (len < 0x4000) {
    return Buffer.from([(len >> 8) | 0x80, len & 0xff]);
  }
  if (len < 0x200000) {
    return Buffer.from([(len >> 16) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
  }
  if (len < 0x10000000) {
    return Buffer.from([
      (len >> 24) | 0xe0,
      (len >> 16) & 0xff,
      (len >> 8) & 0xff,
      len & 0xff,
    ]);
  }
  const b = Buffer.alloc(5);
  b[0] = 0xf0;
  b.writeUInt32BE(len, 1);
  return b;
}

/** Returns { length, bytes } or null when more data is needed. */
function decodeLength(buf, offset) {
  if (offset >= buf.length) return null;
  const c = buf[offset];

  if ((c & 0x80) === 0x00) return { length: c, bytes: 1 };

  if ((c & 0xc0) === 0x80) {
    if (offset + 1 >= buf.length) return null;
    return { length: ((c & 0x3f) << 8) | buf[offset + 1], bytes: 2 };
  }

  if ((c & 0xe0) === 0xc0) {
    if (offset + 2 >= buf.length) return null;
    return {
      length: ((c & 0x1f) << 16) | (buf[offset + 1] << 8) | buf[offset + 2],
      bytes: 3,
    };
  }

  if ((c & 0xf0) === 0xe0) {
    if (offset + 3 >= buf.length) return null;
    return {
      length:
        ((c & 0x0f) << 24) |
        (buf[offset + 1] << 16) |
        (buf[offset + 2] << 8) |
        buf[offset + 3],
      bytes: 4,
    };
  }

  if ((c & 0xf8) === 0xf0) {
    if (offset + 4 >= buf.length) return null;
    return { length: buf.readUInt32BE(offset + 1), bytes: 5 };
  }

  throw new Error(`Malformed RouterOS length prefix: 0x${c.toString(16)}`);
}

function encodeWord(word) {
  const payload = Buffer.from(word, 'utf8');
  return Buffer.concat([encodeLength(payload.length), payload]);
}

function encodeSentence(words) {
  return Buffer.concat([...words.map(encodeWord), Buffer.from([0x00])]);
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

class RouterOsError extends Error {
  constructor(message, category) {
    super(message);
    this.name = 'RouterOsError';
    this.category = category;
  }
}

class RouterOsClient {
  constructor({ host, port = 8728, user, password, tls: useTls = false, timeout = 10000 }) {
    Object.assign(this, { host, port, user, password, useTls, timeout });
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.words = [];
    this.pending = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const onFail = (err) => {
        this.destroy();
        reject(err);
      };

      const opts = { host: this.host, port: this.port };
      this.socket = this.useTls
        ? tls.connect({ ...opts, rejectUnauthorized: false })
        : net.connect(opts);

      this.socket.setTimeout(this.timeout);
      this.socket.once('error', onFail);
      this.socket.once('timeout', () =>
        onFail(new Error(`RouterOS connection to ${this.host}:${this.port} timed out`))
      );

      this.socket.once(this.useTls ? 'secureConnect' : 'connect', () => {
        this.socket.removeListener('error', onFail);
        this.socket.on('error', (err) => this.#failPending(err));
        this.socket.on('data', (chunk) => this.#onData(chunk));
        this.socket.on('close', () =>
          this.#failPending(new Error('RouterOS closed the connection'))
        );

        this.#login().then(resolve, onFail);
      });
    });
  }

  async #login() {
    const reply = await this.write('/login', [
      `=name=${this.user}`,
      `=password=${this.password}`,
    ]);
    return reply;
  }

  /** Send one command and resolve with its !re sentences as objects. */
  write(command, args = []) {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('RouterOS socket is not open'));
    }
    if (this.pending) {
      return Promise.reject(
        new Error('RouterOS client is single-flight; await the previous command')
      );
    }

    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, rows: [] };
      this.socket.write(encodeSentence([command, ...args]));
    });
  }

  #failPending(err) {
    const p = this.pending;
    this.pending = null;
    if (p) p.reject(err);
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const header = decodeLength(this.buffer, 0);
      if (!header) return;

      const total = header.bytes + header.length;
      if (this.buffer.length < total) return;

      if (header.length === 0) {
        // Zero-length word: the sentence is complete.
        this.buffer = this.buffer.subarray(1);
        const words = this.words;
        this.words = [];
        this.#onSentence(words);
        continue;
      }

      const word = this.buffer
        .subarray(header.bytes, total)
        .toString('utf8');
      this.buffer = this.buffer.subarray(total);
      this.words.push(word);
    }
  }

  #onSentence(words) {
    if (!words.length || !this.pending) return;

    const [type, ...rest] = words;
    const attrs = {};
    for (const w of rest) {
      if (w[0] !== '=') continue;
      const eq = w.indexOf('=', 1);
      if (eq === -1) attrs[w.slice(1)] = '';
      else attrs[w.slice(1, eq)] = w.slice(eq + 1);
    }

    switch (type) {
      case '!re':
        this.pending.rows.push(attrs);
        break;

      case '!done': {
        const p = this.pending;
        this.pending = null;
        if (Object.keys(attrs).length) p.rows.push(attrs);
        p.resolve(p.rows);
        break;
      }

      case '!trap':
      case '!fatal': {
        const p = this.pending;
        this.pending = null;
        p.reject(
          new RouterOsError(
            attrs.message || rest.join(' ') || 'RouterOS returned an error',
            attrs.category
          )
        );
        break;
      }

      default:
        break;
    }
  }

  destroy() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  close() {
    this.destroy();
  }
}

module.exports = {
  RouterOsClient,
  RouterOsError,
  // exported for tests
  encodeLength,
  decodeLength,
  encodeSentence,
};
