/** A fake MikroTik that speaks the real RouterOS API wire protocol. */
const net = require('net');
const { decodeLength, encodeSentence } = require('../src/lib/routeros-api');

function readSentences(chunk, carry) {
  let b = Buffer.concat([carry.buf, chunk]);
  const out = [];

  for (;;) {
    const h = decodeLength(b, 0);
    if (!h) break;
    const total = h.bytes + h.length;
    if (b.length < total) break;

    if (h.length === 0) {
      b = b.subarray(1);
      out.push(carry.words.splice(0, carry.words.length));
      continue;
    }
    carry.words.push(b.subarray(h.bytes, total).toString('utf8'));
    b = b.subarray(total);
  }

  carry.buf = b;
  return out;
}

function startMockRouter(port) {
  const users = new Map();
  const log = [];

  const server = net.createServer((sock) => {
    const carry = { buf: Buffer.alloc(0), words: [] };

    sock.on('data', (chunk) => {
      for (const sentence of readSentences(chunk, carry)) {
        if (!sentence.length) continue;
        const [cmd, ...args] = sentence;
        log.push({ cmd, args });

        const attr = (k) => {
          const w = args.find((a) => a.startsWith(`=${k}=`));
          return w ? w.slice(k.length + 2) : undefined;
        };
        const query = (k) => {
          const w = args.find((a) => a.startsWith(`?${k}=`));
          return w ? w.slice(k.length + 2) : undefined;
        };
        const send = (...sentences) => {
          for (const s of sentences) sock.write(encodeSentence(s));
        };

        switch (cmd) {
          case '/login':
            send(['!done']);
            break;

          case '/ip/hotspot/user/print': {
            const u = users.get(query('name'));
            if (u) {
              send(['!re', `=.id=${u['.id']}`, `=name=${u.name}`,
                    `=limit-uptime=${u['limit-uptime']}`]);
            }
            send(['!done']);
            break;
          }

          case '/ip/hotspot/user/add': {
            const name = attr('name');
            if (users.has(name)) {
              send(['!trap', '=message=entry already exists']);
            } else {
              users.set(name, {
                '.id': `*${users.size + 1}`,
                name,
                'limit-uptime': attr('limit-uptime'),
                password: attr('password'),
                profile: attr('profile'),
              });
              send(['!done']);
            }
            break;
          }

          case '/ip/hotspot/user/set': {
            const id = attr('.id');
            for (const u of users.values()) {
              if (u['.id'] === id) {
                u['limit-uptime'] = attr('limit-uptime');
                if (attr('password')) u.password = attr('password');
              }
            }
            send(['!done']);
            break;
          }

          case '/ip/hotspot/active/login':
            send(['!done']);
            break;

          case '/system/identity/print':
            send(['!re', '=name=MikroTik'], ['!done']);
            break;

          case '/system/resource/print':
            send(['!re', '=version=7.24.1', '=board-name=hAP lite',
                  '=free-memory=9633792'], ['!done']);
            break;

          default:
            send(['!trap', '=message=no such command']);
        }
      }
    });

    sock.on('error', () => {});
  });

  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ server, users, log }))
  );
}

module.exports = { startMockRouter };
