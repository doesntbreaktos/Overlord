export type MessagePackPreflightLimits = {
  maxDepth: number;
  maxContainerItems: number;
};

export const DEFAULT_UNTRUSTED_MESSAGEPACK_LIMITS: Readonly<MessagePackPreflightLimits> =
  Object.freeze({
    maxDepth: 32,
    maxContainerItems: 0xffff_ffff,
  });

export class MessagePackPreflightError extends Error {
  constructor(message: string) {
    super(`Unsafe MessagePack payload: ${message}`);
    this.name = "MessagePackPreflightError";
  }
}

function positiveIntegerLimit(value: number | undefined, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(numeric));
}

function asBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

export function preflightMessagePack(
  input: Uint8Array | ArrayBuffer,
  limits: Partial<MessagePackPreflightLimits> = {},
): void {
  const bytes = asBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxDepth = positiveIntegerLimit(
    limits.maxDepth,
    DEFAULT_UNTRUSTED_MESSAGEPACK_LIMITS.maxDepth,
  );
  const maxContainerItems = positiveIntegerLimit(
    limits.maxContainerItems,
    DEFAULT_UNTRUSTED_MESSAGEPACK_LIMITS.maxContainerItems,
  );
  let offset = 0;
  let pendingValues = 1;
  const stack: Array<{ remaining: number; depth: number }> = [
    { remaining: 1, depth: 1 },
  ];

  const fail = (message: string): never => {
    throw new MessagePackPreflightError(message);
  };
  const requireBytes = (count: number, context: string): void => {
    if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - offset) {
      fail(`truncated ${context}`);
    }
  };
  const readUint8 = (context: string): number => {
    requireBytes(1, context);
    return view.getUint8(offset++);
  };
  const readUint16 = (context: string): number => {
    requireBytes(2, context);
    const value = view.getUint16(offset);
    offset += 2;
    return value;
  };
  const readUint32 = (context: string): number => {
    requireBytes(4, context);
    const value = view.getUint32(offset);
    offset += 4;
    return value;
  };
  const skip = (count: number, context: string): void => {
    requireBytes(count, context);
    offset += count;
  };
  const skipExtension = (length: number): void => {
    skip(1, "extension type");
    skip(length, "extension body");
  };

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.remaining === 0) {
      stack.pop();
      continue;
    }
    frame.remaining -= 1;
    pendingValues -= 1;
    if (frame.depth > maxDepth) fail("nesting depth limit exceeded");

    const prefix = readUint8("value header");
    let containerItems: number | null = null;
    let childValues = 0;

    if (prefix <= 0x7f || prefix >= 0xe0) {
    } else if (prefix >= 0x80 && prefix <= 0x8f) {
      containerItems = prefix & 0x0f;
      childValues = containerItems * 2;
    } else if (prefix >= 0x90 && prefix <= 0x9f) {
      containerItems = prefix & 0x0f;
      childValues = containerItems;
    } else if (prefix >= 0xa0 && prefix <= 0xbf) {
      skip(prefix & 0x1f, "fixed string body");
    } else {
      switch (prefix) {
        case 0xc0: // nil
        case 0xc2: // false
        case 0xc3: // true
          break;
        case 0xc1:
          fail("reserved 0xc1 prefix");
          break;
        case 0xc4:
          skip(readUint8("bin8 length"), "bin8 body");
          break;
        case 0xc5:
          skip(readUint16("bin16 length"), "bin16 body");
          break;
        case 0xc6:
          skip(readUint32("bin32 length"), "bin32 body");
          break;
        case 0xc7:
          skipExtension(readUint8("ext8 length"));
          break;
        case 0xc8:
          skipExtension(readUint16("ext16 length"));
          break;
        case 0xc9:
          skipExtension(readUint32("ext32 length"));
          break;
        case 0xca:
          skip(4, "float32 body");
          break;
        case 0xcb:
          skip(8, "float64 body");
          break;
        case 0xcc:
        case 0xd0:
          skip(1, "8-bit integer body");
          break;
        case 0xcd:
        case 0xd1:
          skip(2, "16-bit integer body");
          break;
        case 0xce:
        case 0xd2:
          skip(4, "32-bit integer body");
          break;
        case 0xcf:
        case 0xd3:
          skip(8, "64-bit integer body");
          break;
        case 0xd4:
          skipExtension(1);
          break;
        case 0xd5:
          skipExtension(2);
          break;
        case 0xd6:
          skipExtension(4);
          break;
        case 0xd7:
          skipExtension(8);
          break;
        case 0xd8:
          skipExtension(16);
          break;
        case 0xd9:
          skip(readUint8("str8 length"), "str8 body");
          break;
        case 0xda:
          skip(readUint16("str16 length"), "str16 body");
          break;
        case 0xdb:
          skip(readUint32("str32 length"), "str32 body");
          break;
        case 0xdc:
          containerItems = readUint16("array16 length");
          childValues = containerItems;
          break;
        case 0xdd:
          containerItems = readUint32("array32 length");
          childValues = containerItems;
          break;
        case 0xde:
          containerItems = readUint16("map16 length");
          childValues = containerItems * 2;
          break;
        case 0xdf:
          containerItems = readUint32("map32 length");
          childValues = containerItems * 2;
          break;
        default:
          fail(`unknown prefix 0x${prefix.toString(16).padStart(2, "0")}`);
      }
    }

    if (containerItems !== null) {
      if (containerItems > maxContainerItems) fail("per-container item limit exceeded");
      if (childValues > 0 && frame.depth >= maxDepth) {
        fail("nesting depth limit exceeded");
      }
      pendingValues += childValues;
      if (childValues > 0) {
        stack.push({ remaining: childValues, depth: frame.depth + 1 });
      }
    }
  }

  if (pendingValues !== 0) fail("truncated container");
  if (offset !== bytes.length) fail("trailing bytes after root value");
}
