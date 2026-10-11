// Deterministic Ethernet fixture. RFC 5737 documentation IPs; locally administered MACs.
export function syntheticCapture() {
  const mac1 = Buffer.from('020000000001', 'hex'), mac2 = Buffer.from('020000000002', 'hex');
  const ip1 = Buffer.from([192, 0, 2, 10]), ip2 = Buffer.from([192, 0, 2, 20]);
  const ethernet = (type, body, source = mac1) => { const h = Buffer.alloc(14); mac2.copy(h); source.copy(h, 6); h.writeUInt16BE(type, 12); return Buffer.concat([h, body]); };
  const arp = mac => { const b = Buffer.alloc(28); b.writeUInt16BE(1); b.writeUInt16BE(0x800, 2); b[4] = 6; b[5] = 4; b.writeUInt16BE(2, 6); mac.copy(b, 8); ip1.copy(b, 14); mac2.copy(b, 18); ip2.copy(b, 24); return ethernet(0x806, b, mac); };
  const ip = (proto, payload) => { const h = Buffer.alloc(20); h[0] = 0x45; h.writeUInt16BE(20 + payload.length, 2); h[8] = 64; h[9] = proto; ip1.copy(h, 12); ip2.copy(h, 16); return ethernet(0x800, Buffer.concat([h, payload])); };
  const dns = Buffer.alloc(20); dns.writeUInt16BE(53); dns.writeUInt16BE(53000, 2); dns.writeUInt16BE(20, 4); dns.writeUInt16BE(123, 8); dns.writeUInt16BE(0x8183, 10);
  const tcp = (flags, data = '') => { const h = Buffer.alloc(20); h.writeUInt16BE(40000); h.writeUInt16BE(80, 2); h.writeUInt32BE(1, 4); h[12] = 0x50; h[13] = flags; h.writeUInt16BE(65535, 14); return ip(6, Buffer.concat([h, Buffer.from(data)])); };
  const packets = [arp(mac1), arp(mac2), ip(17, dns), tcp(0x18, 'PRIVATE_PAYLOAD_MARKER'), tcp(0x18, 'PRIVATE_PAYLOAD_MARKER'), tcp(0x14)];
  const header = Buffer.alloc(24); header.writeUInt32LE(0xa1b2c3d4); header.writeUInt16LE(2, 4); header.writeUInt16LE(4, 6); header.writeUInt32LE(65535, 16); header.writeUInt32LE(1, 20);
  return Buffer.concat([header, ...packets.flatMap((p, index) => { const h = Buffer.alloc(16); h.writeUInt32LE(1700000000 + index); h.writeUInt32LE(p.length, 8); h.writeUInt32LE(p.length, 12); return [h, p]; })]);
}
