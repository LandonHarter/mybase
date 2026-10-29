import { isIP } from "node:net";
/** Conservative public egress policy: IPv4 unicast or ordinary IPv6 global unicast only. */
export function publicSandboxIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a,b,c] = ip.split(".").map(Number);
    return a! > 0 && a! < 224 && a !== 10 && a !== 127 && !(a === 100 && b! >= 64 && b! <= 127)
      && !(a === 169 && b === 254) && !(a === 172 && b! >= 16 && b! <= 31) && !(a === 192 && b === 168)
      && !(a === 192 && b === 0) && !(a === 192 && b === 88 && c === 99)
      && !(a === 198 && [18,19].includes(b!)) && !(a === 198 && b === 51 && c === 100) && !(a === 203 && b === 0 && c === 113);
  }
  if (isIP(ip) !== 6 || /[%\.]/.test(ip)) return false;
  const text = ip.toLowerCase();
  const halves = text.split("::");
  const start = halves[0] ? halves[0].split(":").map(x => parseInt(x,16)) : [];
  const end = halves.length === 2 && halves[1] ? halves[1].split(":").map(x => parseInt(x,16)) : [];
  const groups = [...start, ...Array(Math.max(0,8-start.length-end.length)).fill(0), ...end];
  if ((groups[0]! & 0xe000) !== 0x2000) return false;
  // Block transition/translation, IETF protocol assignments, documentation, and 6to4.
  if (groups[0] === 0x2002 || (groups[0] === 0x2001 && (groups[1]! < 0x200 || groups[1] === 0xdb8)) || (groups[0] === 0x3fff && (groups[1]! & 0xf000) === 0)) return false;
  return true;
}
