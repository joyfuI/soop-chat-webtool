const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BITS = 128;
const TAG_BYTES = TAG_BITS / 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const importKey = async (secret: string): Promise<CryptoKey> => {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = Uint8Array.fromBase64(secret.trim());
  } catch {
    throw new TypeError(
      'AUTH_COOKIE_KEY must be a base64-encoded 32-byte key.',
    );
  }
  if (raw.byteLength !== KEY_BYTES) {
    throw new TypeError(
      'AUTH_COOKIE_KEY must be a base64-encoded 32-byte key.',
    );
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
};

export const encryptAuthTicket = async (
  authTicket: string,
  secret: string,
): Promise<string> => {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: TAG_BITS },
      key,
      encoder.encode(authTicket),
    ),
  );
  const value = new Uint8Array(iv.byteLength + encrypted.byteLength);
  value.set(iv);
  value.set(encrypted, iv.byteLength);
  return value.toBase64({ alphabet: 'base64url', omitPadding: true });
};

export const decryptAuthTicket = async (
  value: string,
  secret: string,
): Promise<string | undefined> => {
  const key = await importKey(secret);
  try {
    const encrypted = Uint8Array.fromBase64(value, { alphabet: 'base64url' });
    if (encrypted.byteLength < IV_BYTES + TAG_BYTES) {
      return;
    }
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: encrypted.subarray(0, IV_BYTES),
        tagLength: TAG_BITS,
      },
      key,
      encrypted.subarray(IV_BYTES),
    );
    return decoder.decode(decrypted) || undefined;
  } catch {
    return;
  }
};
