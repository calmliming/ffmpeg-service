import fs from 'fs';

// libass 按字体族名选字体。服务器上没有 fontconfig 配置（Windows 构建、精简 Docker 镜像）时，
// 只有通过 fontsdir 加载的字体可用，而且样式里的 FontName 必须和字体文件里的族名一致才会被选中。
// 所以要从字体文件的 name 表读出族名（nameID 1），libass 匹配的也是 Windows 平台的这条记录

const MAX_FACES = 64;
const MAX_TABLES = 128;
const MAX_NAME_RECORDS = 1024;

type Reader = (offset: number, length: number) => Promise<Buffer>;

interface NameRecord {
  platform: number;
  language: number;
  value: Buffer;
}

function decodeName(record: NameRecord): string {
  // Windows 平台（3）和 Unicode 平台（0）是 UTF-16BE，Mac 平台（1）的 Roman 编码对 ASCII 名称等同 latin1
  if (record.platform === 3 || record.platform === 0) {
    const swapped = Buffer.from(record.value);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return record.value.toString('latin1');
}

async function readFaceFamily(read: Reader, faceOffset: number): Promise<string | undefined> {
  const header = await read(faceOffset, 12);
  const numTables = Math.min(header.readUInt16BE(4), MAX_TABLES);
  const tables = await read(faceOffset + 12, numTables * 16);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i++) {
    if (tables.toString('latin1', i * 16, i * 16 + 4) === 'name') {
      nameOffset = tables.readUInt32BE(i * 16 + 8);
      break;
    }
  }
  if (nameOffset < 0) return undefined;

  const nameHeader = await read(nameOffset, 6);
  const count = Math.min(nameHeader.readUInt16BE(2), MAX_NAME_RECORDS);
  const storage = nameOffset + nameHeader.readUInt16BE(4);
  const records = await read(nameOffset + 6, count * 12);
  const families: NameRecord[] = [];
  for (let i = 0; i < count; i++) {
    const base = i * 12;
    if (records.readUInt16BE(base + 6) !== 1) continue;
    const length = records.readUInt16BE(base + 8);
    const offset = records.readUInt16BE(base + 10);
    if (length === 0 || length > 512) continue;
    families.push({
      platform: records.readUInt16BE(base),
      language: records.readUInt16BE(base + 4),
      value: await read(storage + offset, length),
    });
  }
  // 优先英文名：中文族名（如「微软雅黑」）不能安全地写进 force_style
  const rank = (r: NameRecord) =>
    r.platform === 3 && r.language === 0x0409 ? 0 : r.platform === 3 ? 1 : r.platform === 0 ? 2 : 3;
  families.sort((a, b) => rank(a) - rank(b));
  for (const record of families) {
    const name = decodeName(record).trim();
    if (isSafeFamilyName(name)) return name;
  }
  return undefined;
}

/** 族名会写进 force_style，只放行字母数字、空格、点、下划线、短横线 */
export function isSafeFamilyName(name: string): boolean {
  return /^[A-Za-z0-9][\w .-]{0,63}$/.test(name);
}

/** 读出字体文件（ttf / otf / ttc）里每个字体的族名，读不出的 face 跳过 */
export async function readFontFamilies(file: string): Promise<string[]> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const read: Reader = async (offset, length) => {
      if (offset < 0 || offset + length > size) throw new Error('字体文件结构不完整');
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, offset);
      return buf;
    };
    const head = await read(0, 12);
    let faces = [0];
    if (head.toString('latin1', 0, 4) === 'ttcf') {
      const count = Math.min(head.readUInt32BE(8), MAX_FACES);
      const offsets = await read(12, count * 4);
      faces = Array.from({ length: count }, (_, i) => offsets.readUInt32BE(i * 4));
    }
    const result: string[] = [];
    for (const offset of faces) {
      const family = await readFaceFamily(read, offset).catch(() => undefined);
      if (family && !result.includes(family)) result.push(family);
    }
    return result;
  } finally {
    await handle.close();
  }
}

// 字体集合（如 Noto Sans CJK 的 ttc 同时有 JP / KR / SC / TC）里优先选简体中文，否则用第一个
function preferChinese(families: string[]): string | undefined {
  return families.find((f) => /\b(SC|CN|GB|Hans)\b/.test(f)) ?? families[0];
}

/** 字体文件的族名，字体集合里优先简体中文。拿不到族名时返回 undefined */
export async function pickFontFamily(file: string): Promise<string | undefined> {
  return preferChinese(await readFontFamilies(file).catch(() => []));
}

/**
 * 配置了字体文件时 libass 要用的族名：字体文件优先于字体名。
 * Docker 镜像默认带 FONT_NAME=Noto Sans CJK SC，挂载自定义字体再设 FONT_FILE 时，如果还按 FONT_NAME 选字，
 * libass 会通过 fontconfig 选中系统里的思源黑体，fontsdir 里的自定义字体永远用不上。
 * 所以 preferred（FONT_NAME）只在正好是文件里某个字体的族名时生效，用来在 ttc 字体集合里挑一个；
 * 文件里读不出可用的族名时返回 undefined
 */
export async function fontFileFamily(
  file: string,
  preferred?: string,
): Promise<string | undefined> {
  const families = await readFontFamilies(file).catch(() => []);
  const wanted = preferred?.toLowerCase();
  return families.find((f) => f.toLowerCase() === wanted) ?? preferChinese(families);
}
