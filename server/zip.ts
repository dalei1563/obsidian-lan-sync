/** Small uncompressed ZIP writer for the three fixed plugin distribution files. */
export function pluginZip(files: {name: string; body: Buffer}[]): Buffer {
  const chunks: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  const crc32 = (body: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (const file of files) {
    const name = Buffer.from('lan-note-sync/' + file.name), crc = crc32(file.body);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(file.body.length, 18); local.writeUInt32LE(file.body.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(file.body.length, 20); central.writeUInt32LE(file.body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    chunks.push(local, name, file.body); directory.push(central, name); offset += local.length + name.length + file.body.length;
  }
  const index = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, index, end]);
}
