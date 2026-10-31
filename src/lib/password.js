// The plaintext password never leaves this machine. Servers receive a PBKDF2-SHA256 derivation salted with
// the server URL and username, so a malicious server cannot learn the password or replay it elsewhere.
const ITERATIONS = 200000;

export async function derivePassword(serverUrl, username, password) {
  const enc = new TextEncoder();
  const salt = enc.encode(`cyberdeck/v1|${String(serverUrl).toLowerCase()}|${String(username).trim().toLowerCase()}`);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
