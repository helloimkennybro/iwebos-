// libkern object pretty-printer for guest memory (OSDictionary / OSArray / OSString / OSSymbol / OSData / OSNumber / OSBoolean)
function makeDumper(e) {
  const cpu = e.cpu;
  const rd = (a) => { try { return cpu.rd32(a >>> 0) >>> 0; } catch (x) { return 0; } };
  const rb = (a) => { try { return cpu.rd8(a >>> 0); } catch (x) { return 0; } };
  const cls = (o) => { const vt = rd(o); const s = e.symAt(vt); const m = s.match(/_ZTV(\d+)(\w+?)\+/); return m ? m[2].slice(0, +m[1]) : s; };
  const cstr = (a, n) => { let s = ''; for (let i = 0; i < Math.min(n, 200); i++) { const c = rb(a + i); if (!c) break; s += String.fromCharCode(c); } return s; };
  function dump(o, depth) {
    if (!o) return 'null';
    if (depth > 4) return '…';
    const c = cls(o);
    if (c === 'OSString' || c === 'OSSymbol') return JSON.stringify(cstr(rd(o + 16), rd(o + 12)));
    if (c === 'OSDictionary') { const n = rd(o + 20), arr = rd(o + 16), parts = []; for (let i = 0; i < Math.min(n, 30); i++) parts.push(dump(rd(arr + i * 8), depth + 1).replace(/^"|"$/g, '') + ': ' + dump(rd(arr + i * 8 + 4), depth + 1)); return '{' + parts.join(', ') + '}'; }
    if (c === 'OSArray' || c === 'OSOrderedSet') { const n = rd(o + 20), arr = rd(o + 16), parts = []; for (let i = 0; i < Math.min(n, 20); i++) parts.push(dump(rd(arr + i * 4), depth + 1)); return '[' + parts.join(', ') + ']'; }
    if (c === 'OSData') { const p = rd(o + 8), n = rd(o + 12); let h = ''; for (let i = 0; i < Math.min(n, 24); i++) h += rb(p + i).toString(16).padStart(2, '0'); return '<' + h + (n > 24 ? '…' : '') + '>'; }
    if (c === 'OSNumber') return '#' + rd(o + 16) + (rd(o + 20) ? '+hi' : '');
    if (c === 'OSBoolean') return 'bool@' + o.toString(16);
    return c + '@' + o.toString(16);
  }
  return dump;
}
module.exports = { makeDumper };
