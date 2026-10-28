import dns from 'node:dns';
import ipaddr from 'ipaddr.js';
import { unsafeUrl } from '../errors.js';

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];
const ALLOWED_PORTS = new Set(['', '80', '443']);

// Only globally routable unicast addresses are allowed. Everything else (loopback, RFC1918,
// link-local incl. 169.254.169.254 metadata, CGNAT, ULA, 6to4/Teredo wrappers, multicast) is rejected.
export function isPublicIp(address) {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
  return ip.range() === 'unicast';
}

// Static checks on the URL itself. DNS is checked again at connect time by safeFetch.
export function validatePublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw unsafeUrl('Not a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw unsafeUrl('Only http and https URLs are allowed');
  if (url.username || url.password) throw unsafeUrl('URLs with embedded credentials are not allowed');
  if (!ALLOWED_PORTS.has(url.port)) throw unsafeUrl('Only the default ports 80 and 443 are allowed');

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw unsafeUrl('Internal hostnames are not allowed');
  }
  if (ipaddr.isValid(host) && !isPublicIp(host)) throw unsafeUrl('Private or reserved IP addresses are not allowed');
  if (!ipaddr.isValid(host) && !host.includes('.')) throw unsafeUrl('Hostname must be a public domain');
  return url;
}

// Used as the socket lookup function, so the address actually connected to is the one that was checked.
export function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const opts = typeof options === 'number' ? { family: options } : options || {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const blocked = addresses.find((entry) => !isPublicIp(entry.address));
    if (blocked) {
      const error = new Error(`Blocked connection to non-public address ${blocked.address} (${hostname})`);
      error.code = 'EBLOCKEDADDR';
      return callback(error);
    }
    if (opts.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}
