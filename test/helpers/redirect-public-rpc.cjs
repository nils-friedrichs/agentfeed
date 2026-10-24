// test/helpers/redirect-public-rpc.cjs: preloaded (node --require) into a CHILD so a script that defaults to the free public mainnet RPC talks to a loopback server instead.
// Every fetch to api.mainnet-beta.solana.com goes to REDIRECT_PUBLIC_RPC; everything else is untouched. Tests only.
'use strict';
const target = process.env.REDIRECT_PUBLIC_RPC;
const orig = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = typeof input === 'string' ? input : (input && input.url) || String(input);
  let host = ''; try { host = new URL(u).host; } catch { /* relative */ }
  return host === 'api.mainnet-beta.solana.com' && target ? orig(target, init) : orig(input, init);
};
