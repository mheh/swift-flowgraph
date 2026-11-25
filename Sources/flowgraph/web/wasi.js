'use strict';
// Runs a WebAssembly program that was built for WASI (preview 1) on files in memory. It has no clock to wait on, no network and no disk.
const FGWasi = (() => {
  const OK = 0, BADF = 8, EXIST = 20, INVAL = 28, ISDIR = 31, NOENT = 44, NOSYS = 52, NOTDIR = 54;
  const CHAR = 2, DIR = 3, FILE = 4;
  const UNUSED = ['fd_fdstat_set_flags', 'fd_filestat_set_size', 'fd_filestat_set_times', 'path_filestat_set_times', 'path_link',
    'path_remove_directory', 'path_rename', 'path_symlink', 'path_unlink_file', 'poll_oneoff'];
  class Exit extends Error { constructor(code) { super('exit ' + code); this.code = code; } }

  const sizeOf = f => f.size ?? f.length;
  const bytesOf = f => f instanceof Uint8Array ? f : new Uint8Array(new FileReaderSync().readAsArrayBuffer(f));
  const typeOf = node => node.dir ? DIR : FILE;

  /**
   * @param {WebAssembly.Module} module
   * @param {string[]} args The arguments, with the name of the program first.
   * @param {[string, File|Uint8Array][]} files Each file with its absolute path. A File is read when the program opens it.
   * @returns {{exit: number, log: string, written: Map<string, Uint8Array>}} `written` has each file that the program made.
   */
  function run(module, args, files) {
    const root = { dir: new Map() }, written = new Map(), text = new TextDecoder(), encoded = new TextEncoder();
    let log = '', memory;
    const child = (node, name, make) => {
      if (!node.dir.has(name) && make) node.dir.set(name, make());
      return node.dir.get(name);
    };
    for (const [path, file] of files) {
      const parts = path.split('/').filter(Boolean), name = parts.pop();
      parts.reduce((node, part) => child(node, part, () => ({ dir: new Map() })), root).dir.set(name, { file });
    }
    const fds = [{ type: CHAR }, { type: CHAR }, { type: CHAR }, { type: DIR, node: root, path: [] }];
    const view = () => new DataView(memory.buffer), u8 = () => new Uint8Array(memory.buffer);
    const string = (p, n) => text.decode(u8().subarray(p, p + n));

    /** The node of a path below an open directory, with its absolute parts. */
    function find(fd, p, n) {
      const from = fds[fd];
      if (!from?.node?.dir) return {};
      const parts = [...from.path];
      for (const part of string(p, n).split('/')) {
        if (part === '..') parts.pop();
        else if (part && part !== '.') parts.push(part);
      }
      let node = root;
      for (const part of parts) node = node?.dir?.get(part);
      return { node, parts };
    }
    // A directory has the date of its newest file, which is the date of the last build for a directory of an index.
    const modified = node => node.dir ? Math.max(0, ...[...node.dir.values()].map(n => n.dir ? 0 : n.file.lastModified ?? 0)) : node.file.lastModified ?? 0;
    function stat(node, p) {
      const v = view(), ns = BigInt(Math.round(modified(node))) * 1000000n;
      u8().fill(0, p, p + 64);
      v.setUint8(p + 16, typeOf(node));
      v.setBigUint64(p + 24, 1n, true);
      v.setBigUint64(p + 32, BigInt(node.dir ? 0 : sizeOf(node.file)), true);
      for (const at of [40, 48, 56]) v.setBigUint64(p + at, ns, true);
      return OK;
    }
    function vectors(iovs, count, each) {
      const v = view();
      let total = 0;
      for (let i = 0; i < count; i++) {
        const done = each(v.getUint32(iovs + 8 * i, true), v.getUint32(iovs + 8 * i + 4, true));
        total += done;
        if (done < v.getUint32(iovs + 8 * i + 4, true)) break;
      }
      return total;
    }
    function read(f, iovs, count, at) {
      f.bytes ??= bytesOf(f.node.file);
      return vectors(iovs, count, (p, n) => {
        const part = f.bytes.subarray(at, at + n);
        u8().set(part, p);
        at += part.length;
        return part.length;
      });
    }
    const put32 = (p, value) => (view().setUint32(p, value, true), OK);
    const put64 = (p, value) => (view().setBigUint64(p, BigInt(value), true), OK);

    const calls = {
      args_sizes_get: (count, size) => (put32(count, args.length), put32(size, args.reduce((sum, a) => sum + encoded.encode(a).length + 1, 0))),
      args_get(argv, buffer) {
        for (const [i, arg] of args.entries()) {
          const b = encoded.encode(arg + '\0');
          put32(argv + 4 * i, buffer);
          u8().set(b, buffer);
          buffer += b.length;
        }
        return OK;
      },
      environ_sizes_get: (count, size) => (put32(count, 0), put32(size, 0)),
      environ_get: () => OK,
      clock_res_get: (id, p) => put64(p, 1000000),
      clock_time_get: (id, precision, p) => put64(p, BigInt(Math.round(id === 0 ? Date.now() : performance.now())) * 1000000n),
      random_get: (p, n) => (crypto.getRandomValues(u8().subarray(p, p + n)), OK),
      proc_exit(code) { throw new Exit(code); },

      fd_close: fd => fds[fd] ? (fds[fd] = null, OK) : BADF,
      fd_fdstat_get(fd, p) {
        if (!fds[fd]) return BADF;
        u8().fill(0, p, p + 24);
        view().setUint8(p, fds[fd].type);
        view().setBigUint64(p + 8, ~0n & 0xffffffffn, true);
        view().setBigUint64(p + 16, ~0n & 0xffffffffn, true);
        return OK;
      },
      fd_filestat_get: (fd, p) => fds[fd]?.node ? stat(fds[fd].node, p) : fds[fd] ? (u8().fill(0, p, p + 64), view().setUint8(p + 16, CHAR), OK) : BADF,
      fd_prestat_get: (fd, p) => fd === 3 ? (put32(p, 0), put32(p + 4, 1)) : BADF,
      fd_prestat_dir_name: (fd, p) => fd === 3 ? (u8()[p] = 47, OK) : BADF,
      fd_read(fd, iovs, count, done) {
        const f = fds[fd];
        if (!f?.node) return f ? put32(done, 0) : BADF;
        if (f.node.dir) return ISDIR;
        const n = read(f, iovs, count, f.at);
        f.at += n;
        return put32(done, n);
      },
      fd_pread(fd, iovs, count, offset, done) {
        const f = fds[fd];
        if (!f?.node || f.node.dir) return BADF;
        return put32(done, read(f, iovs, count, Number(offset)));
      },
      fd_write(fd, iovs, count, done) {
        const f = fds[fd];
        if (!f) return BADF;
        return put32(done, vectors(iovs, count, (p, n) => {
          if (!f.node) log += text.decode(u8().slice(p, p + n), { stream: true });
          else f.node.parts.push(u8().slice(p, p + n));
          return n;
        }));
      },
      fd_seek(fd, offset, whence, p) {
        const f = fds[fd];
        if (!f?.node || f.node.dir) return BADF;
        f.at = Number(offset) + (whence === 1 ? f.at : whence === 2 ? sizeOf(f.node.file) : 0);
        return put64(p, f.at);
      },
      fd_tell: (fd, p) => fds[fd]?.node ? put64(p, fds[fd].at) : BADF,
      fd_sync: fd => fds[fd] ? OK : BADF,
      fd_readdir(fd, buffer, size, cookie, used) {
        const f = fds[fd];
        if (!f?.node?.dir) return BADF;
        const entries = [...f.node.dir], v = view();
        let at = 0;
        for (let i = Number(cookie); i < entries.length && at < size; i++) {
          const name = encoded.encode(entries[i][0]), entry = new Uint8Array(24 + name.length), e = new DataView(entry.buffer);
          e.setBigUint64(0, BigInt(i + 1), true);
          e.setUint32(16, name.length, true);
          e.setUint8(20, typeOf(entries[i][1]));
          entry.set(name, 24);
          const part = entry.subarray(0, size - at);
          u8().set(part, buffer + at);
          at += part.length;
        }
        return put32(used, at);
      },

      path_filestat_get(fd, flags, p, n, buffer) {
        const { node } = find(fd, p, n);
        return node ? stat(node, buffer) : NOENT;
      },
      path_open(fd, dirflags, p, n, oflags, rights, inheriting, fdflags, opened) {
        let { node, parts } = find(fd, p, n);
        if (!parts) return BADF;
        if (node && oflags & 4) return EXIST;
        if (!node || (oflags & 8 && !node.dir)) {
          if (!(oflags & 1) && !node) return NOENT;
          const holder = parts.slice(0, -1).reduce((at, part) => at?.dir?.get(part), root);
          if (!holder?.dir) return NOENT;
          // A file that the program writes is a list of parts until the program ends.
          node = { file: new Uint8Array(0), parts: [] };
          holder.dir.set(parts.at(-1), node);
          written.set('/' + parts.join('/'), node);
        }
        if (oflags & 2 && !node.dir) return NOTDIR;
        return put32(opened, fds.push({ type: typeOf(node), node, path: parts, at: 0 }) - 1);
      },
      path_create_directory(fd, p, n) {
        const { node, parts } = find(fd, p, n);
        if (node || !parts) return node ? EXIST : BADF;
        const holder = parts.slice(0, -1).reduce((at, part) => at?.dir?.get(part), root);
        return holder?.dir ? (holder.dir.set(parts.at(-1), { dir: new Map() }), OK) : NOENT;
      },
      path_readlink: (fd, p, n) => find(fd, p, n).node ? INVAL : NOENT,
    };
    for (const name of UNUSED) calls[name] = () => NOSYS;

    const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: calls });
    memory = instance.exports.memory;
    let exit = 0;
    try { instance.exports._start(); }
    catch (e) { if (!(e instanceof Exit)) throw e; exit = e.code; }
    for (const [path, node] of written) {
      const all = new Uint8Array(node.parts.reduce((sum, part) => sum + part.length, 0));
      node.parts.reduce((at, part) => (all.set(part, at), at + part.length), 0);
      written.set(path, all);
    }
    return { exit, log, written };
  }

  return { run };
})();
