// Builds a tiny, valid MaxMind-DB (.mmdb) file in memory so the geolocation code is tested against the real file format and the
// real reader — without shipping (or licensing) any real geolocation data. Every network and place used with it is fictional
// or a documentation range (RFC 5737 / RFC 3849). Format: https://maxmind.github.io/MaxMind-DB/ (24-bit records, IPv6 tree).
type Value = string | number | Value[] | { [key: string]: Value };

function sizeBytes(type: number, size: number): number[] {
  const t = type > 7 ? 0 : type;
  const ext = type > 7 ? [type - 7] : [];
  if (size < 29) return [(t << 5) | size, ...ext];
  if (size < 285) return [(t << 5) | 29, ...ext, size - 29];
  const s = size - 285;
  return [(t << 5) | 30, ...ext, (s >> 8) & 0xff, s & 0xff];
}

function uintBytes(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return out;
}

function encode(v: Value, kind?: "u16" | "u32" | "u64" | "double"): Buffer {
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([Buffer.from(sizeBytes(2, b.length)), b]);
  }
  if (typeof v === "number") {
    if (kind === "double" || !Number.isInteger(v)) {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(v);
      return Buffer.concat([Buffer.from(sizeBytes(3, 8)), b]);
    }
    const bytes = uintBytes(v);
    const type = kind === "u64" ? 9 : kind === "u32" ? 6 : 5;
    return Buffer.concat([Buffer.from(sizeBytes(type, bytes.length)), Buffer.from(bytes)]);
  }
  if (Array.isArray(v)) return Buffer.concat([Buffer.from(sizeBytes(11, v.length)), ...v.map((x) => encode(x))]);
  const entries = Object.entries(v);
  return Buffer.concat([Buffer.from(sizeBytes(7, entries.length)), ...entries.flatMap(([k, val]) => [encode(k), encode(val, hintFor(k))])]);
}

// Which numeric keys need which integer width (the reader doesn't care about width, but a faithful file uses sensible ones).
function hintFor(key: string): "u16" | "u32" | "u64" | "double" | undefined {
  if (key === "latitude" || key === "longitude") return "double";
  if (key === "build_epoch") return "u64";
  if (key === "node_count") return "u32";
  return "u16";
}

function parseIp(ip: string): number[] {
  if (ip.includes(".")) {
    const o = ip.split(".").map(Number);
    return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...o]; // IPv4 lives under ::/96 in an IPv6 tree
  }
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]);
}

function bitsOf(cidr: string): number[] {
  const [ip, lenText] = cidr.split("/");
  const len = Number(lenText) + (ip.includes(".") ? 96 : 0);
  const bytes = parseIp(ip);
  const bits: number[] = [];
  for (let i = 0; i < len; i++) bits.push((bytes[i >> 3] >> (7 - (i & 7))) & 1);
  return bits;
}

type Node = { child: [Node | null, Node | null]; data?: number };

export type CityRecord = {
  city?: string;
  subdivision?: { name: string; iso?: string };
  country?: { name: string; iso: string };
  location?: { latitude?: number; longitude?: number; time_zone?: string; accuracy_radius?: number };
};

export function buildCityDatabase(opts: { databaseType?: string; buildEpochSec?: number; entries: { cidr: string; record: CityRecord }[] }): Buffer {
  const databaseType = opts.databaseType ?? "DBIP-City-Lite";
  const buildEpoch = opts.buildEpochSec ?? Math.floor(Date.UTC(2026, 10, 1) / 1000);

  const dataChunks: Buffer[] = [];
  const offsets: number[] = [];
  let dataLen = 0;
  const root: Node = { child: [null, null] };
  for (const { cidr, record } of opts.entries) {
    const value: Record<string, Value> = {};
    if (record.city) value.city = { names: { en: record.city } };
    if (record.subdivision) value.subdivisions = [{ ...(record.subdivision.iso ? { iso_code: record.subdivision.iso } : {}), names: { en: record.subdivision.name } }];
    if (record.country) value.country = { iso_code: record.country.iso, names: { en: record.country.name } };
    if (record.location) value.location = record.location as Value;
    const chunk = encode(value);
    offsets.push(dataLen);
    dataChunks.push(chunk);
    dataLen += chunk.length;
    let node = root;
    const bits = bitsOf(cidr);
    bits.forEach((bit, i) => {
      if (i === bits.length - 1) {
        node.child[bit] = { child: [null, null], data: offsets.length - 1 };
      } else {
        node.child[bit] ??= { child: [null, null] };
        node = node.child[bit]!;
      }
    });
  }

  // Number the internal nodes breadth-first; a leaf is a data pointer, an absent child means "no data".
  const nodes: Node[] = [root];
  for (let i = 0; i < nodes.length; i++) for (const c of nodes[i].child) if (c && c.data === undefined) nodes.push(c);
  const nodeCount = nodes.length;
  const indexOf = new Map(nodes.map((n, i) => [n, i]));
  const recordValue = (c: Node | null) => (c === null ? nodeCount : c.data !== undefined ? nodeCount + 16 + offsets[c.data] : indexOf.get(c)!);
  const tree = Buffer.alloc(nodeCount * 6);
  nodes.forEach((n, i) => {
    const [l, r] = [recordValue(n.child[0]), recordValue(n.child[1])];
    tree.writeUIntBE(l, i * 6, 3);
    tree.writeUIntBE(r, i * 6 + 3, 3);
  });

  const metadata = encode({
    node_count: nodeCount,
    record_size: 24,
    ip_version: 6,
    database_type: databaseType,
    languages: ["en"],
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: buildEpoch,
    description: { en: "Fictional test database - not real geolocation data" },
  });
  return Buffer.concat([tree, Buffer.alloc(16), ...dataChunks, Buffer.from([0xab, 0xcd, 0xef]), Buffer.from("MaxMind.com"), metadata]);
}
