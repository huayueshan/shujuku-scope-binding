# js-sha256 0.11.1

Unmodified upstream source and MIT license:

- https://github.com/emn178/js-sha256/blob/v0.11.1/src/sha256.js
- https://github.com/emn178/js-sha256/blob/v0.11.1/LICENSE.txt

The online loader embeds this dependency and its license at build time. It runs
only when Web Crypto SHA-256 is unavailable (for example, an HTTP LAN origin).
Its exports stay in a local object; it makes no runtime network requests.
Input is TextEncoder UTF-8 bytes, matching the native digest path.
